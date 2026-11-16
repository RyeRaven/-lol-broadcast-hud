const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ObsClient, authString, mapRecordStatus, mapStreamStatus, mapReplayBufferStatus, handleObsApi, startObsAutoConnect, isLocalUrl, rebrandInputName } = require('../src/obs');

function fakeResponse() {
  return { statusCode: null, body: null, writeHead() {}, end() {} };
}

function callApi(client, method, path, body = {}, extra = {}) {
  const res = fakeResponse();
  const handled = handleObsApi({ method }, res, new URL('http://127.0.0.1:3210' + path), {
    obs: client,
    json: (r, code, value) => { r.statusCode = code; r.body = value; },
    readBody: () => Promise.resolve(body),
    broadcast: () => {},
    state: {},
    port: 3210,
    ...extra
  });
  return { handled, res };
}

class FakeObsWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.scenes = [{ sceneName: 'Scene' }];
    this.collections = ['2'];
    this.currentCollection = '2';
    this.currentScene = 'Scene';
    this.inputs = [];
    this.sceneItems = new Map([['Scene', []]]);
    this.inputSettings = new Map();
    FakeObsWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit({ op: 0, d: { rpcVersion: 1 } });
    });
  }

  emit(message) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(message) });
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.op === 1) return this.emit({ op: 2, d: { rpcVersion: 1 } });
      if (message.op !== 6) return;
      const { requestType, requestId, requestData } = message.d;
      const responseData = this.respond(requestType, requestData);
      if (responseData instanceof Error) {
        this.emit({ op: 7, d: { requestId, requestStatus: { result: false, comment: responseData.message } } });
      } else {
        this.emit({ op: 7, d: { requestId, requestStatus: { result: true }, responseData } });
      }
    });
  }

  respond(type, data = {}) {
    if (type === 'GetSceneList') return { scenes: this.scenes.slice(), currentProgramSceneName: this.currentScene };
    if (type === 'GetCurrentProgramScene') return { currentProgramSceneName: this.currentScene };
    if (type === 'SetCurrentProgramScene') { this.currentScene = data.sceneName; return {}; }
    if (type === 'GetSceneCollectionList') return { sceneCollections: this.collections.slice(), currentSceneCollectionName: this.currentCollection };
    if (type === 'CreateSceneCollection') { this.collections.push(data.sceneCollectionName); return {}; }
    if (type === 'SetCurrentSceneCollection') { this.currentCollection = data.sceneCollectionName; return {}; }
    if (type === 'CreateScene') {
      this.scenes.push({ sceneName: data.sceneName });
      this.sceneItems.set(data.sceneName, []);
      return {};
    }
    if (type === 'GetInputList') return { inputs: this.inputs.slice() };
    if (type === 'CreateInput') {
      this.inputs.push({ inputName: data.inputName, inputKind: data.inputKind });
      this.inputSettings.set(data.inputName, { ...(data.inputSettings || {}) });
      if (data.sceneName) {
        const items = this.sceneItems.get(data.sceneName) || [];
        items.push({ sourceName: data.inputName, sceneItemId: items.length + 1 });
        this.sceneItems.set(data.sceneName, items);
      }
      return { sceneItemId: 1 };
    }
    if (type === 'SetInputSettings') { this.inputSettings.set(data.inputName, { ...(data.inputSettings || {}) }); return {}; }
    if (type === 'SetInputName') {
      const input = this.inputs.find(item => item.inputName === data.inputName);
      if (input) input.inputName = data.newName;
      const settings = this.inputSettings.get(data.inputName);
      if (settings) { this.inputSettings.delete(data.inputName); this.inputSettings.set(data.newName, settings); }
      for (const items of this.sceneItems.values()) {
        for (const item of items) if (item.sourceName === data.inputName) item.sourceName = data.newName;
      }
      return {};
    }
    if (type === 'GetInputSettings') return { inputKind: 'browser_source', inputSettings: { ...(this.inputSettings.get(data.inputName) || {}) } };
    if (type === 'GetSceneItemList') return { sceneItems: (this.sceneItems.get(data.sceneName) || []).slice() };
    if (type === 'CreateSceneItem') {
      const items = this.sceneItems.get(data.sceneName) || [];
      if (!items.some(item => item.sourceName === data.sourceName)) items.push({ sourceName: data.sourceName, sceneItemId: items.length + 1 });
      this.sceneItems.set(data.sceneName, items);
      return { sceneItemId: items.length };
    }
    if (type === 'GetRecordStatus') return { outputActive: false, outputPaused: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputBytes: 0 };
    if (type === 'GetStreamStatus') return { outputActive: false, outputReconnecting: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputCongestion: 0, outputBytes: 0, outputSkippedFrames: 0, outputTotalFrames: 0 };
    if (type === 'GetReplayBufferStatus') return { outputActive: true, outputSaved: false };
    return {};
  }

  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
}

test('auth string follows obs-websocket v5 rule', () => {
  const value = authString('supersecret', 'saltvalue', 'challengevalue');
  assert.equal(value.length, 44);
  assert.match(value, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(value, authString('supersecret', 'saltvalue', 'challengevalue'));
  assert.notEqual(value, authString('other', 'saltvalue', 'challengevalue'));
});

test('snapshot exposes safe state without leaking internals', () => {
  const client = new ObsClient();
  const snapshot = client.snapshot();
  assert.equal(snapshot.connected, false);
  assert.deepEqual(snapshot.scenes, []);
  assert.deepEqual(snapshot.inputs, []);
  assert.equal(snapshot.ws, undefined);
  assert.equal(snapshot.pending, undefined);
});

test('record and stream status mappings normalize output fields', () => {
  assert.deepEqual(mapRecordStatus({
    outputActive: true,
    outputPaused: false,
    outputTimecode: '00:00:03.000',
    outputDuration: 3000,
    outputBytes: 1234
  }), {
    active: true, paused: false, timecode: '00:00:03.000', duration: 3000, bytes: 1234,
    outputActive: true, outputPaused: false, outputTimecode: '00:00:03.000', outputDuration: 3000, outputBytes: 1234
  });
  assert.equal(mapStreamStatus({ outputActive: true, outputReconnecting: true, outputCongestion: 0.12 }).active, true);
  assert.equal(mapStreamStatus({ outputActive: true, outputReconnecting: true }).reconnecting, true);
  assert.deepEqual(mapReplayBufferStatus({ outputActive: true, outputSaved: false }), { active: true, saved: false, outputActive: true, outputSaved: false });
  assert.deepEqual(mapReplayBufferStatus({}), { active: false, saved: false, outputActive: false, outputSaved: false });
});

test('request payloads use obs-websocket v5 op6 shape', async () => {
  const client = new ObsClient();
  const sent = [];
  client.ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
  client.status.connected = true;
  const start = client.startRecord();
  assert.deepEqual(sent[0], { op: 6, d: { requestType: 'StartRecord', requestId: 'r1', requestData: {} } });
  client.handleMessage({ op: 7, d: { requestId: 'r1', requestStatus: { result: true }, responseData: {} } });
  await start;
  const stop = client.stopRecord();
  assert.deepEqual(sent[1], { op: 6, d: { requestType: 'StopRecord', requestId: 'r2', requestData: {} } });
  client.handleMessage({ op: 7, d: { requestId: 'r2', requestStatus: { result: true }, responseData: { outputPath: 'C:/tmp/test.mkv' } } });
  await stop;
  const replay = client.saveReplayBuffer();
  assert.deepEqual(sent[2], { op: 6, d: { requestType: 'SaveReplayBuffer', requestId: 'r3', requestData: {} } });
  client.handleMessage({ op: 7, d: { requestId: 'r3', requestStatus: { result: true }, responseData: {} } });
  await replay;
  const source = client.createBrowserSource({ sceneName: 'BP', sourceName: 'RiftBroadcast BP', url: 'http://127.0.0.1:3210/overlay/bp' });
  assert.equal(sent[3].d.requestType, 'CreateInput');
  assert.equal(sent[3].d.requestData.inputKind, 'browser_source');
  assert.equal(sent[3].d.requestData.inputSettings.width, 1920);
  assert.equal(sent[3].d.requestData.inputSettings.height, 1080);
  assert.equal(sent[3].d.requestData.inputSettings.url, 'http://127.0.0.1:3210/overlay/bp');
  client.handleMessage({ op: 7, d: { requestId: 'r4', requestStatus: { result: true }, responseData: { sceneItemId: 1 } } });
  await source;
  const streamStart = client.startStream();
  assert.deepEqual(sent[4], { op: 6, d: { requestType: 'StartStream', requestId: 'r5', requestData: {} } });
  client.handleMessage({ op: 7, d: { requestId: 'r5', requestStatus: { result: true }, responseData: {} } });
  await streamStart;
  const streamStop = client.stopStream();
  assert.deepEqual(sent[5], { op: 6, d: { requestType: 'StopStream', requestId: 'r6', requestData: {} } });
  client.handleMessage({ op: 7, d: { requestId: 'r6', requestStatus: { result: true }, responseData: {} } });
  await streamStop;
});

test('fake obs-websocket connection completes handshake and scene package requests', async () => {
  FakeObsWebSocket.instances = [];
  const client = new ObsClient();
  const snapshot = await client.connect({ url: 'ws://127.0.0.1:4455', WebSocket: FakeObsWebSocket });
  assert.equal(snapshot.connected, true);
  assert.deepEqual(snapshot.scenes, ['Scene']);
  const packageInfo = await client.createScenePackage({ baseUrl: 'http://127.0.0.1:3210' });
  assert.equal(packageInfo.collectionName, 'Khada Jhin');
  assert.equal(packageInfo.createdCollection, true);
  assert.deepEqual(packageInfo.scenes, ['RB-BP', 'RB-HUD', 'RB-RESULT', 'RB-MVP', 'RB-TRANSITION']);
  assert.deepEqual(packageInfo.autoSwitch, { draft: 'RB-BP', in_game: 'RB-HUD', post_game: 'RB-RESULT', mvp: 'RB-MVP' });
  assert.equal(packageInfo.sources.length, 5);
  assert.equal(packageInfo.sources[0].url, 'http://127.0.0.1:3210/overlay/bp-broadcast');
  assert.equal(packageInfo.sources[3].url, 'http://127.0.0.1:3210/overlay/mvp-broadcast');
  assert.equal(packageInfo.sources[4].url, 'http://127.0.0.1:3210/overlay/transition');
  const fake = FakeObsWebSocket.instances[0];
  const requests = fake.sent.filter(message => message.op === 6).map(message => message.d.requestType);
  assert.ok(requests.includes('GetSceneCollectionList'));
  assert.ok(requests.includes('CreateSceneCollection'));
  assert.ok(requests.includes('SetCurrentSceneCollection'));
  assert.ok(requests.includes('CreateScene'));
  assert.ok(requests.includes('CreateInput'));
  assert.ok(requests.includes('GetInputList'));
  const createInput = fake.sent.find(message => message.op === 6 && message.d.requestType === 'CreateInput');
  assert.equal(createInput.d.requestData.inputSettings.width, 1920);
  assert.equal(createInput.d.requestData.inputSettings.height, 1080);
  assert.match(createInput.d.requestData.inputSettings.css, /background\s*:\s*transparent/i);
  assert.equal(createInput.d.requestData.inputSettings.shutdown_when_not_visible, false);
  assert.equal(createInput.d.requestData.inputSettings.restart_when_active, false);
  assert.ok(requests.includes('GetSceneItemList'));
  for (const source of packageInfo.sources) {
    assert.ok(fake.sceneItems.get(source.sceneName).some(item => item.sourceName === source.inputName), source.sceneName + ' 缺少来源 ' + source.inputName);
  }
  client.disconnect();
});

test('scene package API writes autoSwitch mapping and saves config', async () => {
  FakeObsWebSocket.instances = [];
  const client = new ObsClient();
  await client.connect({ url: 'ws://127.0.0.1:4455', WebSocket: FakeObsWebSocket });
  const state = {};
  let saveCount = 0;
  const { handled, res } = callApi(client, 'POST', '/api/obs/scene-package', {}, {
    state,
    saveConfig: () => { saveCount += 1; }
  });
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(state.autoSwitch, { draft: 'RB-BP', in_game: 'RB-HUD', post_game: 'RB-RESULT', mvp: 'RB-MVP' });
  assert.deepEqual(res.body.autoSwitch, state.autoSwitch);
  assert.equal(saveCount, 1);
  client.disconnect();
});

test('obs client reports configured state without leaking password', async () => {
  FakeObsWebSocket.instances = [];
  const client = new ObsClient();
  assert.equal(client.snapshot().configured, false);
  const snapshot = await client.connect({ url: 'ws://127.0.0.1:4455', password: 'unit-test-secret', WebSocket: FakeObsWebSocket });
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.password, undefined);
  assert.equal(client.options.password, 'unit-test-secret');
  client.disconnect();
});

test('obs client ignores late events from a replaced socket', async () => {
  FakeObsWebSocket.instances = [];
  const client = new ObsClient();
  await client.connect({ url: 'ws://127.0.0.1:4455', WebSocket: FakeObsWebSocket });
  const first = FakeObsWebSocket.instances[0];
  await client.connect({ url: 'ws://127.0.0.1:4455', WebSocket: FakeObsWebSocket });
  const second = FakeObsWebSocket.instances[1];
  assert.notEqual(first, second);
  assert.equal(client.ws, second);
  // 替换 socket 时旧 handler 必须被摘掉；旧连接迟到的 close 不能把新连接标成断开。
  assert.equal(first.onmessage, null);
  assert.equal(first.onerror, null);
  assert.equal(first.onclose, null);
  first.readyState = 3;
  if (first.onclose) first.onclose();
  assert.equal(client.status.connected, true);
  assert.equal(client.ws, second);
  client.disconnect();
});

test('obs connect API persists successful config and never echoes password', async () => {
  const client = new ObsClient();
  let captured = null;
  client.connect = async options => {
    captured = options;
    client.status.configured = true;
    client.status.connected = true;
    return client.snapshot();
  };
  const saved = [];
  const res = fakeResponse();
  const handled = handleObsApi({ method: 'POST' }, res, new URL('http://127.0.0.1:3210/api/obs/connect'), {
    obs: client,
    json: (r, code, value) => { r.statusCode = code; r.body = value; },
    readBody: () => Promise.resolve({ url: 'ws://127.0.0.1:4455', password: 'unit-test-secret' }),
    broadcast: () => {},
    state: {},
    port: 3210,
    getObsConfig: () => ({ url: 'ws://127.0.0.1:4455', password: '' }),
    setObsConfig: value => saved.push(value)
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(captured.password, 'unit-test-secret');
  assert.deepEqual(saved, [{ url: 'ws://127.0.0.1:4455', password: 'unit-test-secret' }]);
  assert.equal(JSON.stringify(res.body).includes('unit-test-secret'), false);
});

test('startObsAutoConnect retries every 5s and stops after success', async () => {
  let attempts = 0;
  const scheduled = [];
  const changes = [];
  const fakeObs = {
    options: {},
    connect: async ({ url, password, autoReconnect }) => {
      attempts += 1;
      assert.equal(url, 'ws://127.0.0.1:4455');
      assert.equal(password, 'unit-test-secret');
      assert.equal(autoReconnect, false);
      if (attempts === 1) throw new Error('obs down');
      return { configured: true, connected: true };
    },
    snapshot: () => ({ configured: true, connected: false })
  };
  const handle = startObsAutoConnect({
    obs: fakeObs,
    getObsConfig: () => ({ url: 'ws://127.0.0.1:4455', password: 'unit-test-secret' }),
    setObsConfig: () => {},
    onChange: value => changes.push(value),
    retryMs: 5000,
    timers: {
      setTimeout: (fn, ms) => { const timer = { fn, ms, unref() {} }; scheduled.push(timer); return timer; },
      clearTimeout: () => {}
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 5000);
  await scheduled[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(scheduled.length, 1);
  assert.equal(fakeObs.options.autoReconnect, true);
  assert.equal(changes.at(-1).connected, true);
  handle.stop();
});

test('app-state persists obs config without exposing password in state JSON', () => {
  const { state, configPath, normalizeObsConfig, getObsConfig, setObsConfig } = require('../src/app-state');
  assert.deepEqual(normalizeObsConfig({}), { url: 'ws://127.0.0.1:4455', password: '' });
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
  try {
    setObsConfig({ url: 'ws://127.0.0.1:4455', password: 'unit-test-secret' });
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // 密码只保存在进程内，绝不落盘；配置文件只留连接地址。
    assert.deepEqual(saved.obs, { url: 'ws://127.0.0.1:4455' });
    assert.equal(saved.obs.password, undefined);
    assert.deepEqual(getObsConfig(), { url: 'ws://127.0.0.1:4455', password: 'unit-test-secret' });
    assert.equal(JSON.stringify(state).includes('unit-test-secret'), false);
  } finally {
    if (original === null) { try { fs.unlinkSync(configPath); } catch {} }
    else fs.writeFileSync(configPath, original);
  }
});

test('obs refresh loads record, stream and replay-buffer status', async () => {
  FakeObsWebSocket.instances = [];
  const client = new ObsClient();
  const snapshot = await client.connect({ url: 'ws://127.0.0.1:4455', WebSocket: FakeObsWebSocket, autoReconnect: false });
  assert.equal(snapshot.record.active, false);
  assert.equal(snapshot.stream.active, false);
  assert.equal(snapshot.replayBuffer.active, true);
  const fake = FakeObsWebSocket.instances[0];
  const requests = fake.sent.filter(message => message.op === 6).map(message => message.d.requestType);
  assert.ok(requests.includes('GetRecordStatus'));
  assert.ok(requests.includes('GetStreamStatus'));
  assert.ok(requests.includes('GetReplayBufferStatus'));
  client.disconnect();
});

test('obs state changed events update record, stream and replay buffer', () => {
  const client = new ObsClient();
  client.handleMessage({ op: 5, d: { eventType: 'RecordStateChanged', outputActive: true, outputTimecode: '00:00:05.000' } });
  client.handleMessage({ op: 5, d: { eventType: 'StreamStateChanged', outputActive: true, outputReconnecting: true } });
  client.handleMessage({ op: 5, d: { eventType: 'ReplayBufferStateChanged', outputActive: true, outputSaved: true } });
  assert.equal(client.status.record.active, true);
  assert.equal(client.status.record.timecode, '00:00:05.000');
  assert.equal(client.status.stream.active, true);
  assert.equal(client.status.stream.reconnecting, true);
  assert.equal(client.status.replayBuffer.active, true);
  assert.equal(client.status.replayBuffer.saved, true);
});

test('obs connect handshake is cancelled by disconnect or a new connect', async () => {
  class SilentObsWebSocket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      SilentObsWebSocket.instances.push(this);
      queueMicrotask(() => { this.readyState = 1; });
    }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }

  SilentObsWebSocket.instances = [];
  const client = new ObsClient();
  const pending = client.connect({ url: 'ws://127.0.0.1:4455', WebSocket: SilentObsWebSocket, timeoutMs: 10000, autoReconnect: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(client.connectTimer, '握手期间应存在超时 timer');
  client.disconnect();
  await assert.rejects(pending, /OBS 连接已取消/);
  assert.equal(client.connectTimer, null);

  const first = client.connect({ url: 'ws://127.0.0.1:4455', WebSocket: SilentObsWebSocket, timeoutMs: 10000, autoReconnect: false });
  await new Promise(resolve => setImmediate(resolve));
  FakeObsWebSocket.instances = [];
  const second = client.connect({ url: 'ws://127.0.0.1:4455', WebSocket: FakeObsWebSocket, autoReconnect: false });
  await assert.rejects(first, /OBS 连接已取消/);
  const snapshot = await second;
  assert.equal(snapshot.connected, true);
  assert.equal(client.ws, FakeObsWebSocket.instances[0]);
  client.disconnect();
});

test('unconnected OBS API returns obs_not_connected for every new endpoint', () => {
  const client = new ObsClient();
  const cases = [
    ['GET', '/api/obs/record'],
    ['POST', '/api/obs/record', { action: 'start' }],
    ['GET', '/api/obs/stream'],
    ['POST', '/api/obs/stream', { action: 'stop' }],
    ['POST', '/api/obs/replay-buffer'],
    ['GET', '/api/obs/sources'],
    ['POST', '/api/obs/sources', { name: 'BP' }],
    ['POST', '/api/obs/scene-package']
  ];
  for (const [method, path, body] of cases) {
    const { handled, res } = callApi(client, method, path, body);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: false, error: 'obs_not_connected' });
  }
});

test('obs connect API converts a rejected body read into one JSON error without an unhandled rejection', async () => {
  const client = new ObsClient();
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    // 413 分支：readBody 已经回过 413 又 reject，外层必须有 catch 才能收敛。
    const tooLarge = fakeResponse();
    const handledLarge = handleObsApi({ method: 'POST' }, tooLarge, new URL('http://127.0.0.1:3210/api/obs/connect'), {
      obs: client,
      json: (r, code, value) => { r.statusCode = code; r.body = value; },
      readBody: () => Promise.reject(Object.assign(new Error('payload_too_large'), { statusCode: 413 })),
      broadcast: () => {},
      state: {},
      port: 3210
    });
    // req 触发 error 的分支：没有 statusCode，应回 500 而不是让进程崩掉。
    const socketError = fakeResponse();
    const handledError = handleObsApi({ method: 'POST' }, socketError, new URL('http://127.0.0.1:3210/api/obs/connect'), {
      obs: client,
      json: (r, code, value) => { r.statusCode = code; r.body = value; },
      readBody: () => Promise.reject(new Error('socket hang up')),
      broadcast: () => {},
      state: {},
      port: 3210
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(handledLarge, true);
    assert.equal(handledError, true);
    assert.equal(tooLarge.statusCode, 413);
    assert.deepEqual(tooLarge.body, { ok: false, error: 'payload_too_large' });
    assert.equal(socketError.statusCode, 500);
    assert.deepEqual(socketError.body, { ok: false, error: 'socket hang up' });
    assert.deepEqual(unhandled, [], '请求体读取失败不得产生未处理 rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('rebrandInputName and isLocalUrl helpers', () => {
  assert.equal(rebrandInputName('RiftBroadcast BP'), 'Khada Jhin BP');
  assert.equal(rebrandInputName('RiftBroadcast HUD / 左上'), 'Khada Jhin HUD / 左上');
  assert.equal(rebrandInputName('我的摄像头'), null);
  assert.equal(rebrandInputName('Khada Jhin BP'), null);
  assert.equal(isLocalUrl('http://127.0.0.1:3210/overlay/bp'), true);
  assert.equal(isLocalUrl('http://localhost:3210/overlay/bp'), true);
  assert.equal(isLocalUrl('http://192.168.1.5:3210/overlay/bp'), false);
  assert.equal(isLocalUrl(null), false);
});

test('rebrandSources renames legacy sources and repoints local urls', async () => {
  FakeObsWebSocket.instances = [];
  const client = new ObsClient();
  await client.connect({ url: 'ws://127.0.0.1:4455', WebSocket: FakeObsWebSocket });
  const fake = FakeObsWebSocket.instances[0];
  fake.inputs.push(
    { inputName: 'RiftBroadcast BP', inputKind: 'browser_source' },
    { inputName: 'RiftBroadcast HUD', inputKind: 'browser_source' },
    { inputName: '我的摄像头', inputKind: 'dshow_input' },
    { inputName: 'Custom Overlay', inputKind: 'browser_source' }
  );
  fake.inputSettings.set('RiftBroadcast BP', { url: 'http://127.0.0.1:3210/overlay/bp' });
  fake.inputSettings.set('RiftBroadcast HUD', { url: 'http://127.0.0.1:3210/overlay/hud' });
  fake.inputSettings.set('Custom Overlay', { url: 'http://127.0.0.1:3210/overlay/stage-broadcast' });

  const report = await client.rebrandSources({ port: 3314 });
  assert.equal(report.checked, 3);
  assert.deepEqual(report.renamed.map(item => item.to), ['Khada Jhin BP', 'Khada Jhin HUD']);
  assert.equal(report.repointed.length, 3);
  assert.ok(report.repointed.every(item => item.to.startsWith('http://127.0.0.1:3314/overlay/')));
  assert.deepEqual(report.skipped, []);

  // 幂等：源名与 URL 已更新后再次运行不应产生任何变更
  const second = await client.rebrandSources({ port: 3314 });
  assert.equal(second.renamed.length, 0);
  assert.equal(second.repointed.length, 0);
  assert.equal(second.skipped.length, 0);
});
