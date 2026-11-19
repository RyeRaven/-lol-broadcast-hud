'use strict';

// obs-websocket 5.x 客户端（零依赖，Node 22 自带 WebSocket）。
// 除连接/鉴权、场景列表与切换外，还覆盖录制、推流、回放缓冲和浏览器源场景包。
const crypto = require('crypto');

const DEFAULT_BROWSER_WIDTH = 1920;
const DEFAULT_BROWSER_HEIGHT = 1080;
// 所有场景包 Browser Source 共用的采集参数：1920×1080、透明背景、不因场景隐藏而卸载/重载。
const BROWSER_SOURCE_SETTINGS = Object.freeze({
  width: DEFAULT_BROWSER_WIDTH,
  height: DEFAULT_BROWSER_HEIGHT,
  css: 'html, body { background: transparent !important; margin: 0; overflow: hidden; }',
  shutdown_when_not_visible: false,
  restart_when_active: false
});
const SCENE_PACKAGE = {
  collectionName: 'Khada Jhin',
  autoSwitch: { draft: 'RB-BP', in_game: 'RB-HUD', post_game: 'RB-RESULT', mvp: 'RB-MVP' },
  scenes: [
    { sceneName: 'RB-BP', sourceName: 'Khada Jhin BP', overlay: 'bp-broadcast' },
    { sceneName: 'RB-HUD', sourceName: 'Khada Jhin HUD', overlay: 'hud-broadcast' },
    { sceneName: 'RB-RESULT', sourceName: 'Khada Jhin Result', overlay: 'result-broadcast' },
    { sceneName: 'RB-MVP', sourceName: 'Khada Jhin MVP', overlay: 'mvp-broadcast' },
    { sceneName: 'RB-TRANSITION', sourceName: 'Khada Jhin Transition', overlay: 'transition' }
  ]
};

function authString(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(String(password) + String(salt)).digest('base64');
  return crypto.createHash('sha256').update(secret + String(challenge)).digest('base64');
}

function mapRecordStatus(data = {}) {
  const outputActive = Boolean(data.outputActive);
  const outputPaused = Boolean(data.outputPaused);
  const outputTimecode = data.outputTimecode || '00:00:00.000';
  const outputDuration = Number(data.outputDuration || 0);
  const outputBytes = Number(data.outputBytes || 0);
  return {
    active: outputActive,
    paused: outputPaused,
    timecode: outputTimecode,
    duration: outputDuration,
    bytes: outputBytes,
    outputActive,
    outputPaused,
    outputTimecode,
    outputDuration,
    outputBytes
  };
}

function mapStreamStatus(data = {}) {
  const outputActive = Boolean(data.outputActive);
  const outputReconnecting = Boolean(data.outputReconnecting);
  const outputTimecode = data.outputTimecode || '00:00:00.000';
  const outputDuration = Number(data.outputDuration || 0);
  const outputCongestion = Number(data.outputCongestion || 0);
  const outputBytes = Number(data.outputBytes || 0);
  const outputSkippedFrames = Number(data.outputSkippedFrames || 0);
  const outputTotalFrames = Number(data.outputTotalFrames || 0);
  return {
    active: outputActive,
    reconnecting: outputReconnecting,
    timecode: outputTimecode,
    duration: outputDuration,
    congestion: outputCongestion,
    bytes: outputBytes,
    skippedFrames: outputSkippedFrames,
    totalFrames: outputTotalFrames,
    outputActive,
    outputReconnecting,
    outputTimecode,
    outputDuration,
    outputCongestion,
    outputBytes,
    outputSkippedFrames,
    outputTotalFrames
  };
}

function mapReplayBufferStatus(data = {}) {
  const outputActive = Boolean(data.outputActive);
  const outputSaved = Boolean(data.outputSaved);
  return { active: outputActive, saved: outputSaved, outputActive, outputSaved };
}

const BRAND_LEGACY_NAME = 'RiftBroadcast';
const BRAND_CURRENT_NAME = 'Khada Jhin';

// 判定 URL 是否指向本机（127.0.0.1 / localhost / [::1]）。
function isLocalUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(String(url || ''));
}

// 旧版默认源名（RiftBroadcast…）→ 新品牌名（Khada Jhin…）；不含旧名返回 null。
function rebrandInputName(name) {
  const value = String(name || '');
  return value.indexOf(BRAND_LEGACY_NAME) === -1 ? null : value.split(BRAND_LEGACY_NAME).join(BRAND_CURRENT_NAME);
}

function normalizeSceneSpecs(scenes) {
  const list = Array.isArray(scenes) && scenes.length ? scenes : SCENE_PACKAGE.scenes;
  return list.map((scene, index) => {
    const fallback = SCENE_PACKAGE.scenes[index] || {};
    const sceneName = String(scene.sceneName || scene.name || fallback.sceneName || '').trim();
    const overlay = String(scene.overlay || fallback.overlay || '').replace(/^\/+/, '');
    const sourceName = String(scene.sourceName || fallback.sourceName || ('Khada Jhin ' + sceneName)).trim();
    return { sceneName, sourceName, overlay: overlay || 'bp' };
  }).filter(scene => scene.sceneName);
}

class ObsClient {
  constructor() {
    this.ws = null;
    this.pending = new Map();
    this.seq = 0;
    this.options = null;
    this.manualClose = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.connectTimer = null;
    this.connectReject = null;
    this.status = {
      configured: false,
      connected: false,
      url: null,
      currentScene: null,
      scenes: [],
      sceneCollection: null,
      record: null,
      stream: null,
      replayBuffer: null,
      inputs: [],
      error: null
    };
  }

  snapshot() {
    return {
      ...this.status,
      scenes: this.status.scenes.slice(),
      inputs: Array.isArray(this.status.inputs) ? this.status.inputs.slice() : [],
      record: this.status.record ? { ...this.status.record } : null,
      stream: this.status.stream ? { ...this.status.stream } : null,
      replayBuffer: this.status.replayBuffer ? { ...this.status.replayBuffer } : null
    };
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.op === 7) {
      const data = message.d || {};
      const pending = this.pending.get(data.requestId);
      if (!pending) return;
      this.pending.delete(data.requestId);
      clearTimeout(pending.timer);
      if (data.requestStatus && data.requestStatus.result) pending.resolve(data.responseData || {});
      else pending.reject(new Error((data.requestStatus && data.requestStatus.comment) || 'OBS 请求失败'));
    } else if (message.op === 5) {
      const event = message.d || {};
      const eventType = event.eventType;
      // obs-websocket 5 的载荷在 d.eventData 里，顶层只有 eventType/eventIntent；兼容扁平旧形状。
      const eventData = event.eventData || event;
      if (eventType === 'CurrentProgramSceneChanged') {
        this.status.currentScene = eventData.sceneName || null;
      } else if (eventType === 'SceneListChanged') {
        this.refresh().catch(() => {});
      } else if (eventType === 'RecordStateChanged') {
        this.status.record = mapRecordStatus({ ...(this.status.record || {}), ...eventData });
      } else if (eventType === 'StreamStateChanged') {
        this.status.stream = mapStreamStatus({ ...(this.status.stream || {}), ...eventData });
      } else if (eventType === 'ReplayBufferStateChanged') {
        this.status.replayBuffer = mapReplayBufferStatus({ ...(this.status.replayBuffer || {}), ...eventData });
      }
    }
  }

  scheduleReconnect(socket) {
    if (this.manualClose || !this.options || this.options.autoReconnect === false) return;
    if (socket && this.ws !== socket) return;
    clearTimeout(this.reconnectTimer);
    // 指数退避：1s→2s→4s→…封顶 30s；成功建连（op 2 Identified）后清零。
    this.reconnectAttempts += 1;
    const delayMs = Math.min(1000 * (2 ** (this.reconnectAttempts - 1)), 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose || !this.options) return;
      if (socket && this.ws !== socket) return;
      this.connect(this.options).catch(() => {});
    }, delayMs);
    if (this.reconnectTimer && typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  connect(options = {}) {
    const previousAutoReconnect = this.options ? this.options.autoReconnect !== false : true;
    const autoReconnect = options.autoReconnect === undefined ? previousAutoReconnect : options.autoReconnect !== false;
    const url = String(options.url || this.options?.url || 'ws://127.0.0.1:4455');
    const password = String(options.password ?? this.options?.password ?? '');
    const WebSocketImpl = options.WebSocket || this.options?.WebSocket || globalThis.WebSocket;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 6000;
    this.disconnect();
    this.manualClose = false;
    this.options = { url, password, WebSocket: options.WebSocket || null, autoReconnect };
    this.status = { ...this.status, configured: true, connected: false, url, error: null };
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      let timer = null;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer && this.connectTimer === timer) {
          clearTimeout(timer);
          this.connectTimer = null;
          this.connectReject = null;
        }
        fn(value);
      };
      try { ws = new WebSocketImpl(url); } catch (error) {
        this.status.error = 'OBS 地址无效: ' + error.message;
        this.scheduleReconnect();
        return reject(new Error(this.status.error));
      }
      this.ws = ws;
      this.connectReject = error => settle(reject, error);
      timer = setTimeout(() => {
        if (settled) return;
        if (this.ws !== ws) {
          settle(reject, new Error('OBS 连接已取消'));
          return;
        }
        try { ws.close(); } catch {}
        this.status.error = '连接 OBS 超时';
        settle(reject, new Error(this.status.error));
        this.scheduleReconnect(ws);
      }, timeoutMs);
      this.connectTimer = timer;

      ws.onmessage = event => {
        if (this.ws !== ws) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.op === 0) {
          const hello = message.d || {};
          const identify = { rpcVersion: 1 };
          if (hello.authentication) {
            identify.authentication = authString(password, hello.authentication.salt, hello.authentication.challenge);
          }
          ws.send(JSON.stringify({ op: 1, d: identify }));
        } else if (message.op === 2) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.connectTimer = null;
          this.connectReject = null;
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
          this.reconnectAttempts = 0;
          this.status.connected = true;
          this.status.error = null;
          this.refresh().then(() => resolve(this.snapshot())).catch(() => resolve(this.snapshot()));
        } else {
          this.handleMessage(message);
        }
      };
      ws.onerror = () => {
        if (this.ws !== ws) return;
        this.status.error = '无法连接 OBS（确认 OBS 已开启 WebSocket 服务器）';
        settle(reject, new Error(this.status.error));
        this.scheduleReconnect(ws);
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.status.connected = false;
        for (const [, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error('OBS 连接已断开')); }
        this.pending.clear();
        settle(reject, new Error('OBS 连接已断开'));
        this.scheduleReconnect(ws);
      };
    });
  }

  disconnect() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    const rejectConnect = this.connectReject;
    this.connectReject = null;
    if (rejectConnect) rejectConnect(new Error('OBS 连接已取消'));
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch {}
    }
    for (const [, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error('OBS 连接已断开')); }
    this.pending.clear();
    this.status.connected = false;
  }

  request(requestType, requestData) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('OBS 未连接'));
    const requestId = 'r' + (++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('OBS 请求超时: ' + requestType));
      }, 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData: requestData || {} } }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  async getSceneList() {
    return this.request('GetSceneList');
  }

  async refresh() {
    const [sceneList, current] = await Promise.all([
      this.getSceneList(),
      this.request('GetCurrentProgramScene').catch(() => ({})),
      this.getRecordStatus().catch(() => null),
      this.getStreamStatus().catch(() => null),
      this.getReplayBufferStatus().catch(() => null)
    ]);
    const scenes = Array.isArray(sceneList.scenes)
      ? sceneList.scenes.map(scene => (typeof scene === 'string' ? scene : scene && scene.sceneName)).filter(Boolean)
      : [];
    this.status.scenes = scenes;
    this.status.currentScene = current.currentProgramSceneName || current.sceneName || sceneList.currentProgramSceneName || null;
    return this.snapshot();
  }

  async setScene(sceneName) {
    await this.request('SetCurrentProgramScene', { sceneName: String(sceneName) });
    this.status.currentScene = String(sceneName);
    return this.snapshot();
  }

  async getRecordStatus() {
    const data = await this.request('GetRecordStatus');
    this.status.record = mapRecordStatus(data);
    return this.status.record;
  }

  async startRecord() {
    const data = await this.request('StartRecord');
    this.status.record = { ...(this.status.record || mapRecordStatus({})), active: true, outputActive: true };
    return data;
  }

  async stopRecord() {
    const data = await this.request('StopRecord');
    this.status.record = { ...(this.status.record || mapRecordStatus({})), active: false, outputActive: false };
    return data;
  }

  async getStreamStatus() {
    const data = await this.request('GetStreamStatus');
    this.status.stream = mapStreamStatus(data);
    return this.status.stream;
  }

  async getReplayBufferStatus() {
    const data = await this.request('GetReplayBufferStatus');
    this.status.replayBuffer = mapReplayBufferStatus(data);
    return this.status.replayBuffer;
  }

  async startStream() {
    const data = await this.request('StartStream');
    this.status.stream = { ...(this.status.stream || mapStreamStatus({})), active: true, outputActive: true };
    return data;
  }

  async stopStream() {
    const data = await this.request('StopStream');
    this.status.stream = { ...(this.status.stream || mapStreamStatus({})), active: false, outputActive: false };
    return data;
  }

  async saveReplayBuffer() {
    return this.request('SaveReplayBuffer');
  }

  async getInputList() {
    const data = await this.request('GetInputList');
    const inputs = Array.isArray(data.inputs) ? data.inputs.map(input => ({
      inputName: input.inputName,
      inputKind: input.inputKind || '',
      unversionedInputKind: input.unversionedInputKind || ''
    })) : [];
    this.status.inputs = inputs;
    return inputs;
  }

  async createInput(optionsOrName, inputKind = 'browser_source', inputSettings = {}, sceneName) {
    const options = typeof optionsOrName === 'object' && optionsOrName !== null
      ? optionsOrName
      : { inputName: optionsOrName, inputKind, inputSettings, sceneName };
    const inputName = String(options.inputName || options.name || '');
    const payload = {
      inputName,
      inputKind: String(options.inputKind || 'browser_source'),
      inputSettings: options.inputSettings || {}
    };
    if (options.sceneName) payload.sceneName = String(options.sceneName);
    const data = await this.request('CreateInput', payload);
    return { ...data, inputName, inputKind: payload.inputKind, sceneName: payload.sceneName || null };
  }

  async createBrowserSource(optionsOrSceneName, sourceName, url, options = {}) {
    const optionsObject = typeof optionsOrSceneName === 'object' && optionsOrSceneName !== null;
    const sceneName = optionsObject ? optionsOrSceneName.sceneName : optionsOrSceneName;
    const name = optionsObject ? (optionsOrSceneName.sourceName || optionsOrSceneName.inputName) : sourceName;
    const sourceUrl = optionsObject ? optionsOrSceneName.url : url;
    const extra = optionsObject ? (optionsOrSceneName.inputSettings || {}) : (options.inputSettings || {});
    const width = Number((optionsObject ? optionsOrSceneName.width : options.width) || DEFAULT_BROWSER_WIDTH);
    const height = Number((optionsObject ? optionsOrSceneName.height : options.height) || DEFAULT_BROWSER_HEIGHT);
    return this.createInput({
      inputName: name,
      inputKind: 'browser_source',
      inputSettings: { url: String(sourceUrl), width, height, ...extra },
      sceneName
    });
  }

  // 一键换源：本机浏览器源 URL 重指到当前端口，源名含旧品牌的改成新品牌名。幂等。
  async rebrandSources(options = {}) {
    const port = Number(options && options.port) > 0 ? Number(options.port) : null;
    const inputs = await this.getInputList();
    const browserInputs = Array.isArray(inputs) ? inputs.filter(input => input && input.inputKind === 'browser_source') : [];
    const enriched = [];
    for (const input of browserInputs) {
      let url = null;
      try {
        const data = await this.getInputSettings(input.inputName);
        const raw = (data && (data.inputSettings || data.settings)) || {};
        url = raw.url || null;
      } catch {
        url = null;
      }
      enriched.push({ inputName: input.inputName, url });
    }
    const existingNames = new Set(inputs.map(input => input && input.inputName).filter(Boolean));
    const renamed = [];
    const repointed = [];
    const skipped = [];
    for (const item of enriched) {
      const newName = rebrandInputName(item.inputName);
      if (!newName && !isLocalUrl(item.url)) continue;
      const targetUrl = item.url && isLocalUrl(item.url) && port
        ? item.url.replace(/^https?:\/\/[^/]+/i, 'http://127.0.0.1:' + port)
        : null;
      // SetInputSettings 是 merge 语义，只传 url 不会清掉宽高等其它设置。
      if (targetUrl && targetUrl !== item.url) {
        await this.setInputSettings(item.inputName, { url: targetUrl });
        repointed.push({ name: item.inputName, from: item.url, to: targetUrl });
      }
      if (newName) {
        if (existingNames.has(newName)) {
          skipped.push({ name: item.inputName, reason: '目标名称已存在: ' + newName });
        } else {
          await this.request('SetInputName', { inputName: item.inputName, newName });
          existingNames.delete(item.inputName);
          existingNames.add(newName);
          renamed.push({ from: item.inputName, to: newName });
        }
      }
    }
    await this.refresh().catch(() => {});
    return { checked: browserInputs.length, renamed, repointed, skipped };
  }

  async getSceneItemList(sceneName) {
    return this.request('GetSceneItemList', { sceneName: String(sceneName) });
  }

  async getSceneCollectionList() {
    const data = await this.request('GetSceneCollectionList');
    const sceneCollections = Array.isArray(data.sceneCollections) ? data.sceneCollections.slice() : [];
    const currentSceneCollectionName = data.currentSceneCollectionName || null;
    this.status.sceneCollection = currentSceneCollectionName;
    return { sceneCollections, currentSceneCollectionName };
  }

  async createSceneCollection(sceneCollectionName) {
    const name = String(sceneCollectionName);
    const data = await this.request('CreateSceneCollection', { sceneCollectionName: name });
    this.status.sceneCollection = name;
    return data;
  }

  async setCurrentSceneCollection(sceneCollectionName) {
    const name = String(sceneCollectionName);
    const data = await this.request('SetCurrentSceneCollection', { sceneCollectionName: name });
    this.status.sceneCollection = name;
    return data;
  }

  async createScene(sceneName) {
    const name = String(sceneName);
    const data = await this.request('CreateScene', { sceneName: name });
    return data;
  }

  async setInputSettings(inputName, inputSettings) {
    return this.request('SetInputSettings', { inputName: String(inputName), inputSettings: inputSettings || {} });
  }

  async getInputSettings(inputName) {
    return this.request('GetInputSettings', { inputName: String(inputName) });
  }

  async createSceneItem(sceneName, sourceName) {
    return this.request('CreateSceneItem', { sceneName: String(sceneName), sourceName: String(sourceName), sceneItemEnabled: true });
  }

  async ensureSceneItem(sceneName, sourceName) {
    const data = await this.getSceneItemList(sceneName);
    const items = Array.isArray(data.sceneItems) ? data.sceneItems : [];
    const present = items.some(item => item && (item.sourceName === sourceName || item.inputName === sourceName));
    if (!present) await this.createSceneItem(sceneName, sourceName);
  }

  async createScenePackage(options = {}) {
    const collectionName = String(options.collectionName || SCENE_PACKAGE.collectionName);
    const specs = normalizeSceneSpecs(options.scenes);
    const baseUrl = String(options.baseUrl || 'http://127.0.0.1:3210').replace(/\/+$/, '');
    const autoSwitch = { ...SCENE_PACKAGE.autoSwitch, ...(options.autoSwitch && typeof options.autoSwitch === 'object' ? options.autoSwitch : {}) };
    const collections = await this.getSceneCollectionList();
    const createdCollection = !collections.sceneCollections.includes(collectionName);
    if (createdCollection) await this.createSceneCollection(collectionName);
    await this.setCurrentSceneCollection(collectionName);
    const activeCollection = await this.getSceneCollectionList();
    if (activeCollection.currentSceneCollectionName !== collectionName) {
      throw new Error('OBS 场景集合切换失败: 当前为 ' + (activeCollection.currentSceneCollectionName || 'unknown'));
    }

    const sceneList = await this.getSceneList();
    const existingScenes = new Set(Array.isArray(sceneList.scenes)
      ? sceneList.scenes.map(scene => (typeof scene === 'string' ? scene : scene && scene.sceneName)).filter(Boolean)
      : []);
    const createdScenes = [];
    for (const spec of specs) {
      if (!existingScenes.has(spec.sceneName)) {
        await this.createScene(spec.sceneName);
        existingScenes.add(spec.sceneName);
        createdScenes.push(spec.sceneName);
      }
    }

    const existingInputs = new Set((await this.getInputList()).map(input => input.inputName));
    const sources = [];
    for (const spec of specs) {
      const url = baseUrl + '/overlay/' + spec.overlay;
      const browserSettings = {
        ...BROWSER_SOURCE_SETTINGS,
        ...(options.browserSettings && typeof options.browserSettings === 'object' ? options.browserSettings : {}),
        url,
        width: DEFAULT_BROWSER_WIDTH,
        height: DEFAULT_BROWSER_HEIGHT,
        shutdown_when_not_visible: false,
        restart_when_active: false
      };
      if (existingInputs.has(spec.sourceName)) {
        await this.setInputSettings(spec.sourceName, browserSettings);
      } else {
        await this.createInput({
          inputName: spec.sourceName,
          inputKind: 'browser_source',
          inputSettings: browserSettings,
          sceneName: spec.sceneName
        });
        existingInputs.add(spec.sourceName);
      }
      await this.ensureSceneItem(spec.sceneName, spec.sourceName);
      sources.push({ inputName: spec.sourceName, sceneName: spec.sceneName, url, width: DEFAULT_BROWSER_WIDTH, height: DEFAULT_BROWSER_HEIGHT, settings: browserSettings });
    }
    return { collectionName, createdCollection, createdScenes, scenes: specs.map(spec => spec.sceneName), sources, autoSwitch };
  }
}

function bodyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function validText(value, maxLength = 128) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength && !/[\r\n]/.test(value);
}

function handleObsApi(req, res, url, context) {
  const { obs, json, readBody, broadcast, state, port, getObsConfig, setObsConfig, saveConfig, onObsConnected, onObsConfigChanged } = context;
  const notConnected = () => { json(res, 200, { ok: false, error: 'obs_not_connected' }); return true; };
  const fail = error => {
    const message = error && error.message ? error.message : 'obs_error';
    if (/未连接|not connected/i.test(message)) return notConnected();
    return json(res, error.statusCode || 500, { ok: false, error: message });
  };
  const run = (action, extras) => {
    Promise.resolve().then(action).then(result => {
      const payload = typeof extras === 'function' ? extras(result) : {};
      state.obs = obs.snapshot();
      broadcast();
      json(res, 200, { ok: true, ...payload });
    }).catch(fail);
  };

  if (url.pathname === '/api/obs/connect' && req.method === 'POST') {
    readBody(req, res).then(body => {
      const payload = bodyObject(body);
      if (payload.url !== undefined && (!validText(payload.url, 256) || !/^wss?:\/\//i.test(payload.url.trim()))) {
        return json(res, 400, { ok: false, error: 'invalid_url' });
      }
      if (payload.password !== undefined && (typeof payload.password !== 'string' || payload.password.length > 256)) {
        return json(res, 400, { ok: false, error: 'invalid_password' });
      }
      const saved = typeof getObsConfig === 'function' ? getObsConfig() || {} : {};
      const targetUrl = String(payload.url || saved.url || 'ws://127.0.0.1:4455').trim();
      const password = payload.password === undefined || payload.password === null || payload.password === '' ? String(saved.password || '') : String(payload.password);
      // 采集源名选填：传空串 = 恢复自动识别；非法字符整单拒绝。
      const ocrSource = payload.ocrSource === undefined || payload.ocrSource === null ? '' : String(payload.ocrSource).trim();
      if (ocrSource && !validText(ocrSource, 128)) {
        return json(res, 400, { ok: false, error: 'invalid_ocr_source' });
      }
      return obs.connect({ url: targetUrl, password, autoReconnect: true }).then(snapshot => {
        if (typeof setObsConfig === 'function') setObsConfig({ url: targetUrl, password, ocrSource });
        if (typeof onObsConfigChanged === 'function') { try { onObsConfigChanged(); } catch { /* 重建失败不影响连接 */ } }
        state.obs = snapshot;
        if (typeof onObsConnected === 'function') onObsConnected();
        broadcast();
        json(res, 200, { ok: true, obs: snapshot });
      }).catch(error => {
        state.obs = obs.snapshot();
        broadcast();
        json(res, 500, { ok: false, error: error.message });
      });
    }).catch(fail);
    return true;
  }

  if (url.pathname === '/api/obs/record' || url.pathname === '/api/obs/stream') {
    const isRecord = url.pathname === '/api/obs/record';
    if (req.method === 'GET') {
      if (!obs.status.connected) return notConnected();
      run(() => isRecord ? obs.getRecordStatus() : obs.getStreamStatus(), value => isRecord ? { record: value } : { stream: value });
      return true;
    }
    if (req.method === 'POST') {
      if (!obs.status.connected) return notConnected();
      readBody(req, res).then(body => {
        const payload = bodyObject(body);
        const action = String(payload.action || url.searchParams.get('action') || '').trim();
        if (action !== 'start' && action !== 'stop') return json(res, 400, { ok: false, error: 'invalid_action' });
        if (!obs.status.connected) return notConnected();
        run(() => action === 'start'
          ? (isRecord ? obs.startRecord() : obs.startStream())
          : (isRecord ? obs.stopRecord() : obs.stopStream()), result => ({ action, result }));
      }).catch(fail);
      return true;
    }
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  if (url.pathname === '/api/obs/replay-buffer' && req.method === 'POST') {
    if (!obs.status.connected) return notConnected();
    run(() => obs.saveReplayBuffer(), () => ({ saved: true }));
    return true;
  }

  if (url.pathname === '/api/obs/sources') {
    if (!obs.status.connected) return notConnected();
    if (req.method === 'GET') {
      run(() => obs.getInputList(), sources => ({ sources }));
      return true;
    }
    if (req.method === 'POST') {
      readBody(req, res).then(body => {
        const payload = bodyObject(body);
        const rawName = payload.inputName === undefined ? payload.name : payload.inputName;
        if (!validText(rawName, 128)) return json(res, 400, { ok: false, error: 'invalid_input_name' });
        const inputName = rawName.trim();
        const inputKind = payload.inputKind === undefined ? 'browser_source' : payload.inputKind;
        if (!validText(inputKind, 64)) return json(res, 400, { ok: false, error: 'invalid_input_kind' });
        if (payload.sceneName !== undefined && !validText(payload.sceneName, 128)) {
          return json(res, 400, { ok: false, error: 'invalid_scene_name' });
        }
        if (payload.url !== undefined && (typeof payload.url !== 'string' || !validText(payload.url, 2048) || !/^https?:\/\//i.test(payload.url.trim()))) {
          return json(res, 400, { ok: false, error: 'invalid_url' });
        }
        if (payload.inputSettings !== undefined && (typeof payload.inputSettings !== 'object' || payload.inputSettings === null || Array.isArray(payload.inputSettings))) {
          return json(res, 400, { ok: false, error: 'invalid_input_settings' });
        }
        if (!obs.status.connected) return notConnected();
        if (payload.url) {
          return run(() => obs.createBrowserSource({
            sceneName: payload.sceneName && payload.sceneName.trim(),
            sourceName: inputName,
            url: payload.url.trim(),
            width: payload.width,
            height: payload.height,
            inputSettings: payload.inputSettings || {}
          }), source => ({ source }));
        }
        return run(() => obs.createInput({
          inputName,
          inputKind: inputKind.trim(),
          inputSettings: payload.inputSettings || {},
          sceneName: payload.sceneName && payload.sceneName.trim()
        }), source => ({ source }));
      }).catch(fail);
      return true;
    }
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  if (url.pathname === '/api/obs/rebrand' && req.method === 'POST') {
    if (!obs.status.connected) return notConnected();
    run(() => obs.rebrandSources({ port }), rebrand => ({ rebrand }));
    return true;
  }
  if (url.pathname === '/api/obs/scene-package' && req.method === 'POST') {
    if (!obs.status.connected) return notConnected();
    readBody(req, res).then(body => {
      const payload = bodyObject(body);
      if (payload.collectionName !== undefined && !validText(payload.collectionName, 128)) {
        return json(res, 400, { ok: false, error: 'invalid_collection_name' });
      }
      if (payload.baseUrl !== undefined && (!validText(payload.baseUrl, 2048) || !/^https?:\/\//i.test(payload.baseUrl.trim()))) {
        return json(res, 400, { ok: false, error: 'invalid_base_url' });
      }
      if (payload.scenes !== undefined && (!Array.isArray(payload.scenes) || payload.scenes.length > 20)) {
        return json(res, 400, { ok: false, error: 'invalid_scenes' });
      }
      return run(() => obs.createScenePackage({
        baseUrl: payload.baseUrl && payload.baseUrl.trim() || ('http://127.0.0.1:' + port),
        collectionName: payload.collectionName && payload.collectionName.trim(),
        scenes: payload.scenes,
        autoSwitch: payload.autoSwitch
      }), packageInfo => {
        const mapping = packageInfo.autoSwitch && typeof packageInfo.autoSwitch === 'object' ? packageInfo.autoSwitch : {};
        state.autoSwitch = { draft: '', in_game: '', post_game: '', mvp: '', ...(state.autoSwitch || {}), ...mapping };
        if (typeof saveConfig === 'function') saveConfig();
        return { package: packageInfo, autoSwitch: state.autoSwitch };
      });
    }).catch(fail);
    return true;
  }

  json(res, 404, { ok: false, error: 'not_found' });
  return true;
}

// 启动时连接已保存的 OBS 参数；失败按 retryMs 重试，成功后停止。
function startObsAutoConnect(options = {}) {
  const { obs, getObsConfig, setObsConfig, onChange, retryMs = 5000 } = options;
  if (!obs || typeof obs.connect !== 'function' || typeof getObsConfig !== 'function') {
    throw new Error('startObsAutoConnect requires obs and getObsConfig');
  }
  const timers = options.timers || { setTimeout, clearTimeout };
  let timer = null;
  let connecting = false;
  let stopped = false;
  let attempts = 0;
  const schedule = () => {
    if (stopped || timer) return;
    // 指数退避：首次重试仍按 retryMs（保持既有契约），之后翻倍封顶 60s；成功建连后清零。
    attempts += 1;
    const delayMs = Math.min(retryMs * (2 ** (attempts - 1)), 60000);
    timer = timers.setTimeout(() => { timer = null; attempt(); }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  const attempt = () => {
    if (stopped || connecting) return Promise.resolve(null);
    const config = getObsConfig() || {};
    connecting = true;
    return Promise.resolve()
      .then(() => obs.connect({ url: config.url, password: config.password, autoReconnect: false }))
      .then(snapshot => {
        connecting = false;
        attempts = 0;
        if (stopped) return null;
        if (obs.options) obs.options.autoReconnect = true;
        try { if (typeof setObsConfig === 'function') setObsConfig({ url: config.url, password: config.password }); } catch {}
        try { if (typeof onChange === 'function') onChange(snapshot); } catch {}
        return snapshot;
      })
      .catch(() => {
        connecting = false;
        if (stopped) return null;
        try { if (typeof onChange === 'function') onChange(obs.snapshot()); } catch {}
        schedule();
        return null;
      });
  };
  attempt();
  return { attempt, stop() { stopped = true; if (timer) { timers.clearTimeout(timer); timer = null; } } };
}

module.exports = { ObsClient, authString, mapRecordStatus, mapStreamStatus, mapReplayBufferStatus, SCENE_PACKAGE, handleObsApi, startObsAutoConnect, isLocalUrl, rebrandInputName };
