'use strict';

// RiftBroadcast 端到端测试：假 LCU + 假 Live Client + 真实本地 HTTP 服务。
// 覆盖 BP -> 局内 -> 赛后三阶段完整链路，以及 5 个页面、SSE 与数据源探测。
// 只监听 3212-3219 的临时端口，绝不触碰 3210 / 3211 上可能存在的他人服务。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createFakeLcu, DRAFT_SESSION } = require('../tools/fake-lcu');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = ['local', 'fake', 'lcu'].join('-');
// 隔离数据目录：绝不读写开发者本机的 data/config.json。
// 这里显式给一份 mode=live 的初始配置，测试不依赖本机上一次运行的持久状态。
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-e2e-'));
// 每个用例起服务前重写一次：上一个用例的进程被 kill 时可能正写到一半，不能把脏配置留给下一个用例。
// 真实配置落在 <RB_DATA_DIR>/data/config.json（见 src/app-state.js）。
function resetTestConfig() {
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'data'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DATA_DIR, 'data', 'config.json'), JSON.stringify({ mode: 'live', phase: 'draft', tournamentName: 'E2E CUP' }));
}
resetTestConfig();
const PORT_RANGE_START = 3212;
const PORT_RANGE_END = 3219;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function pickPorts(count) {
  const ports = [];
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END && ports.length < count; port += 1) {
    if (await isPortFree(port)) ports.push(port);
  }
  assert.equal(ports.length, count, '可用测试端口不足：需要 ' + count + ' 个，范围 ' + PORT_RANGE_START + '-' + PORT_RANGE_END);
  return ports;
}

function httpRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.setTimeout(options.timeoutMs || 8000, () => request.destroy(new Error('HTTP 请求超时：' + pathname)));
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

async function getJson(port, pathname) {
  const response = await httpRequest(port, pathname);
  return { status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

function lcuRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, options.headers || {});
    if (options.token) headers.Authorization = 'Basic ' + Buffer.from('riot:' + options.token).toString('base64');
    const request = https.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      rejectUnauthorized: false,
      headers
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.setTimeout(5000, () => request.destroy(new Error('HTTPS 请求超时：' + pathname)));
    request.on('error', reject);
    if (options.body !== undefined) request.write(JSON.stringify(options.body));
    request.end();
  });
}

function spawnNode(scriptRelative, args, env) {
  const child = spawn(process.execPath, [path.join(ROOT, scriptRelative)].concat(args), {
    cwd: ROOT,
    env: Object.assign({}, process.env, env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const run = { child, stdout: '', stderr: '', exit: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { run.stdout += chunk; });
  child.stderr.on('data', chunk => { run.stderr += chunk; });
  child.on('exit', (code, signal) => { run.exit = { code, signal }; });
  return run;
}

async function waitForOutput(run, pattern, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pattern.test(run.stdout)) return run.stdout;
    if (run.exit) throw new Error('子进程提前退出（code=' + run.exit.code + '）：' + run.stderr);
    await delay(100);
  }
  throw new Error('等待子进程输出超时：' + pattern + '；stderr=' + run.stderr);
}

function stopRun(run) {
  return new Promise(resolve => {
    if (!run || !run.child || run.child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    run.child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { run.child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

async function waitFor(description, probe, timeoutMs = 20000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error('等待超时（' + timeoutMs + 'ms）：' + description + (lastError ? '；最后错误：' + lastError.message : ''));
}

function openSse(port) {
  const messages = [];
  let buffer = '';
  const request = http.get({ host: '127.0.0.1', port, path: '/events', headers: { Accept: 'text/event-stream' } }, response => {
    response.setEncoding('utf8');
    response.on('data', chunk => {
      buffer += chunk;
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (line.indexOf('data: ') === 0) {
            try { messages.push(JSON.parse(line.slice(6))); } catch { /* 忽略半帧 */ }
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    });
  });
  request.on('error', () => {});
  return { messages, close() { request.destroy(); } };
}

test('e2e：假 LCU 驱动 draft -> in_game -> post_game 全链路', { timeout: 90000 }, async t => {
  const [appPort, lcuPort, livePort] = await pickPorts(3);
  const lcu = spawnNode('tools/fake-lcu.js', [String(lcuPort), '--token', TOKEN], {});
  resetTestConfig();
  const app = spawnNode('src/main.js', [], {
    RB_DATA_DIR: TEST_DATA_DIR,
    PORT: String(appPort),
    RIOT_LCU_PORT: String(lcuPort),
    RIOT_REMOTING_AUTH_TOKEN: TOKEN,
    LIVE_CLIENT_URL: 'http://127.0.0.1:' + livePort,
    RIOT_CLIENT_COMMAND_LINE: '',
    RIOT_LOCKFILE: ''
  });
  let live = null;
  let sse = null;
  t.after(async () => {
    if (sse) sse.close();
    await stopRun(live);
    await stopRun(app);
    await stopRun(lcu);
  });

  await waitForOutput(lcu, /fake lcu listening on \d+/);
  await waitForOutput(app, /Khada Jhin running at http:\/\/127\.0\.0\.1:\d+/);
  sse = openSse(appPort);
  // 一个客户端中途断开不能影响其他 SSE 观众。
  const droppedSse = openSse(appPort);
  await delay(120);
  droppedSse.close();
  await delay(120);

  // 1) BP 阶段：LCU 处于 ChampSelect，解析出 5+5 选人与 3+3 ban
  const draftState = await waitFor('进入 BP 阶段', async () => {
    const response = await getJson(appPort, '/api/state');
    return response.body.phase === 'draft' && response.body.draft.bluePicks.length === 5 ? response.body : null;
  });
  assert.equal(draftState.mode, 'live');
  assert.equal(draftState.draft.bluePicks.length, 5);
  assert.equal(draftState.draft.redPicks.length, 5);
  assert.equal(draftState.draft.blueBans.length, 3);
  assert.equal(draftState.draft.redBans.length, 3);
  assert.equal(draftState.draft.round, '选人阶段');
  assert.equal(draftState.draft.timer, 21);
  assert.equal(draftState.live.lcu.connected, true);
  assert.equal(draftState.live.lcu.phase, 'ChampSelect');
  assert.equal(draftState.live.lcu.discovery, 'environment');
  assert.equal(draftState.live.draft.source, 'lcu');
  assert.equal(draftState.live.draft.parsed, true);
  assert.equal(draftState.live.draft.actions, 16);
  assert.equal(draftState.postGame, null);

  // SSE 首帧契约（确定性）：连接建立即下发当前快照，draft 阶段同理。
  const draftSse = openSse(appPort);
  try {
    const draftFirst = await waitFor('SSE 首帧为 draft 快照', () => (draftSse.messages.length > 0 ? draftSse.messages[0] : null), 8000);
    assert.equal(draftFirst.phase, 'draft');
    assert.equal(draftFirst.mode, 'live');
  } finally { draftSse.close(); }

  // 2) 数据源探测：环境变量发现的 LCU 连接可用
  const sources = await getJson(appPort, '/api/sources');
  assert.equal(sources.status, 200);
  assert.ok(Array.isArray(sources.body.results) && sources.body.results.length === 2);
  const lcuProbe = sources.body.results[0];
  const liveProbe = sources.body.results[1];
  assert.equal(lcuProbe.ok, true);
  assert.equal(lcuProbe.source, 'lcu');
  assert.equal(lcuProbe.phase, 'ChampSelect');
  assert.equal(lcuProbe.discovery, 'environment');
  assert.equal(liveProbe.source, 'live_client');
  const refreshSources = await getJson(appPort, '/api/sources?refresh=1');
  assert.equal(refreshSources.status, 200);
  assert.equal(refreshSources.body.results[0].ok, true);

  // 3) 局内阶段：启动假 Live Client，把 LCU 切到 InProgress
  live = spawnNode('tools/fake-live-server.js', [String(livePort)], {});
  await waitForOutput(live, /fake live client on \d+/);
  const switchToGame = await lcuRequest(lcuPort, '/__control/phase', { method: 'POST', body: { phase: 'InProgress' }, token: TOKEN });
  assert.equal(switchToGame.status, 200);

  const inGameState = await waitFor('进入局内阶段', async () => {
    const response = await getJson(appPort, '/api/state');
    return response.body.phase === 'in_game' && response.body.mode === 'live' && response.body.players.length === 10 && response.body.timeline.length >= 4 ? response.body : null;
  });
  assert.equal(inGameState.gameTime, 812);
  assert.equal(inGameState.live.game.source, 'live_client');
  assert.equal(inGameState.live.game.parsed, true);
  assert.equal(inGameState.live.game.players, 10);
  assert.equal(inGameState.live.game.events, 4);
  assert.equal(inGameState.players[0].name, 'TopStar');
  assert.equal(inGameState.players[0].team, 'blue');
  assert.equal(inGameState.blue.score, 10);
  assert.equal(inGameState.red.score, 11);
  assert.equal(inGameState.timeline.length, 4);
  assert.equal(inGameState.timeline[3].type, 'tower');

  // 3.0) 数据可用性契约（t20）必须随 /api/state 与 /events 一起下发：
  // 实时观战下 CS 只能算量化值，金币/经验不可用，页面据此画占位而不是编数字。
  assert.equal(inGameState.capability.mode, 'live-spectate');
  assert.deepEqual(inGameState.capability.quantized, ['cs']);
  assert.equal(inGameState.capability.fields.cs.quantum, 10);
  assert.ok(inGameState.capability.unavailable.includes('totalGold'));
  assert.ok(inGameState.capability.unavailable.includes('xp'));
  assert.equal(inGameState.capability.fields.totalGold.available, false);

  // 3.0.1) 同一份契约也必须随 /events 下发给 SSE 观众。这里新开一条连接：
  // 服务端在连接建立时立即把当前快照写为首帧（src/main.js 的 /events 分支），
  // 因此首帧可确定性断言；长连接的历史帧可能还停留在 mock 阶段（那时契约本来就不存在）。
  const contractSse = openSse(appPort);
  try {
    const firstFrame = await waitFor('SSE 首帧携带 capability', () => (contractSse.messages.length > 0 ? contractSse.messages[0] : null), 8000);
    assert.equal(firstFrame.phase, 'in_game');
    assert.ok(firstFrame.capability, 'SSE 首帧应携带 capability');
    assert.equal(firstFrame.capability.mode, 'live-spectate');
    assert.deepEqual(firstFrame.capability.quantized, ['cs']);
    assert.equal(firstFrame.capability.fields.cs.precision, 'quantized');
    assert.equal(firstFrame.capability.fields.cs.quantum, 10);
    assert.equal(firstFrame.capability.fields.totalGold.available, false);
    assert.equal(firstFrame.capability.fields.xp.available, false);
  } finally {
    contractSse.close();
  }

  // 3.1) 精彩事件：state.highlights 与 GET /api/highlights 同步可读
  assert.ok(Array.isArray(inGameState.highlights));
  assert.ok(inGameState.highlights.length >= 3);
  assert.ok(inGameState.highlights.every(entry => entry && typeof entry.score === 'number' && entry.score > 0));
  const highlightsResponse = await getJson(appPort, '/api/highlights');
  assert.equal(highlightsResponse.status, 200);
  assert.equal(highlightsResponse.body.ok, true);
  assert.equal(highlightsResponse.body.count, inGameState.highlights.length);
  assert.equal(highlightsResponse.body.highlights[0].score, 30);
  assert.ok(highlightsResponse.body.summary.topScore >= 30);

  // 4) 5 个页面都必须 200，并渲染各自的根节点
  const pages = [
    ['/', 'console-shell'],
    ['/overlay/bp', 'bp-board'],
    ['/overlay/ingame-top', 'ingame-top'],
    ['/overlay/ingame-bottom', 'ingame-bottom'],
    ['/overlay/postgame', 'postgame-table']
  ];
  for (const page of pages) {
    const response = await httpRequest(appPort, page[0]);
    assert.equal(response.status, 200, page[0] + ' 应返回 200');
    assert.ok(response.body.indexOf('id="' + page[1] + '"') >= 0, page[0] + ' 应包含根节点 #' + page[1]);
  }

  // 4.1) 请求体超过 1MB 必须返回 413，且不会写坏配置
  const oversized = await httpRequest(appPort, '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tournamentName: 'x'.repeat(1024 * 1024 + 128) })
  });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.parse(oversized.body).error, 'payload_too_large');
  const badPhase = await httpRequest(appPort, '/api/phase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'nope' }) });
  assert.equal(badPhase.status, 400);
  assert.equal(JSON.parse(badPhase.body).error, 'invalid_phase');
  const badMode = await httpRequest(appPort, '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'x' }) });
  assert.equal(badMode.status, 400);
  assert.equal(JSON.parse(badMode.body).error, 'invalid_mode');
  const badConfig = await httpRequest(appPort, '/api/broadcast-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' });
  assert.equal(badConfig.status, 400);
  assert.equal(JSON.parse(badConfig.body).error, 'invalid_config');

  // 5) 赛后阶段：LCU 切到 PreEndOfGame，eog-stats-block 生效
  const switchToPost = await lcuRequest(lcuPort, '/__control/phase', { method: 'POST', body: { phase: 'PreEndOfGame' }, token: TOKEN });
  assert.equal(switchToPost.status, 200);
  const postGameState = await waitFor('进入赛后阶段', async () => {
    const response = await getJson(appPort, '/api/state');
    return response.body.phase === 'post_game' && response.body.postGame && response.body.postGame.players.length === 10 ? response.body : null;
  });
  const postGame = postGameState.postGame;
  assert.equal(postGame.source, 'eog');
  assert.equal(postGame.gameLength, 1520);
  assert.equal(postGame.gameMode, 'CLASSIC');
  assert.equal(postGame.isWin, true);
  assert.equal(postGame.blue.towers, 8);
  assert.equal(postGame.red.towers, 3);
  assert.equal(postGame.blue.score, 25);
  assert.equal(postGame.red.score, 10);
  assert.equal(postGame.players.length, 10);
  assert.equal(postGame.players[0].name, 'BlueTop');
  assert.ok(postGame.players[0].damagePct > 0);
  // 赛后数据不能被仍在运行的 :2999 实时数据覆盖（玩家/比分/时长都以 EOG 为准）
  assert.equal(postGameState.players[0].name, 'BlueTop');
  assert.equal(postGameState.gameTime, 1520);
  assert.equal(postGameState.blue.score, 25);

  // 赛后 SSE 首帧（确定性）：快照必须携带完整赛后数据与高光列表。
  const postSse = openSse(appPort);
  try {
    const postFirst = await waitFor('SSE 首帧为 post_game 快照', () => (postSse.messages.length > 0 ? postSse.messages[0] : null), 8000);
    assert.equal(postFirst.phase, 'post_game');
    assert.ok(postFirst.postGame && postFirst.postGame.players.length === 10, '赛后首帧应携带 postGame');
    assert.ok(Array.isArray(postFirst.highlights) && postFirst.highlights.length > 0, '赛后首帧应携带 highlights');
  } finally { postSse.close(); }

  // 6) SSE：长连接持续收到广播帧。三阶段覆盖不再依赖长连接的历史帧 backlog
  // （负载下广播间隔可能正好落在阶段窗口之外，历史上偶发 flake），
  // 改由三段确定性首帧断言：draftSse（BP 段）/ contractSse（局内段）/ postSse（赛后段）。
  await waitFor('SSE 至少 2 条消息', () => sse.messages.length >= 2 ? true : null, 8000);
  assert.ok(sse.messages.length >= 2, 'SSE 消息数应 >= 2，实际 ' + sse.messages.length);
  for (const message of sse.messages) assert.equal(typeof message.updatedAt, 'number');
  // 契约下发由 3.0.1 段用独立连接做确定性断言（见上），这里不再对长连接的历史帧设限。

  // 7) 假 LCU 自身：没有鉴权失败，且接口被真实轮询过
  const lcuState = await lcuRequest(lcuPort, '/__control/state', { token: TOKEN });
  assert.equal(lcuState.status, 200);
  const lcuStats = JSON.parse(lcuState.body);
  assert.equal(lcuStats.authFailures, 0);
  assert.ok(lcuStats.requests.gameflow >= 2, 'gameflow-phase 至少被轮询 2 次');
  assert.ok(lcuStats.requests.session >= 1, 'champ-select session 至少被读取 1 次');
  assert.ok(lcuStats.requests.eog >= 1, 'eog-stats-block 至少被读取 1 次');
});

test('e2e：空 BP session 仍进入 draft，post_game 后新局 InProgress 清空赛后并切回局内', { timeout: 45000 }, async t => {
  const [appPort, lcuPort] = await pickPorts(2);
  const savedDraft = {
    myTeam: DRAFT_SESSION.myTeam,
    theirTeam: DRAFT_SESSION.theirTeam,
    actions: DRAFT_SESSION.actions
  };
  const fake = await createFakeLcu({ port: lcuPort, token: TOKEN, phase: 'ChampSelect' });
  DRAFT_SESSION.myTeam = [];
  DRAFT_SESSION.theirTeam = [];
  DRAFT_SESSION.actions = [];
  resetTestConfig();
  const app = spawnNode('src/main.js', [], {
    RB_DATA_DIR: TEST_DATA_DIR,
    PORT: String(appPort),
    RIOT_LCU_PORT: String(lcuPort),
    RIOT_REMOTING_AUTH_TOKEN: TOKEN,
    LIVE_CLIENT_URL: 'http://127.0.0.1:9',
    RIOT_CLIENT_COMMAND_LINE: '',
    RIOT_LOCKFILE: ''
  });
  t.after(async () => {
    await stopRun(app);
    await fake.close();
    DRAFT_SESSION.myTeam = savedDraft.myTeam;
    DRAFT_SESSION.theirTeam = savedDraft.theirTeam;
    DRAFT_SESSION.actions = savedDraft.actions;
  });
  await waitForOutput(app, /Khada Jhin running at http:\/\/127\.0\.0\.1:\d+/);

  // 刚进房间时 session 为空，但 ChampSelect 本身必须让 phase=draft（parsed 只是展示状态）。
  const draftState = await waitFor('空 session 进入 draft', async () => {
    const response = await getJson(appPort, '/api/state');
    return response.body.phase === 'draft' ? response.body : null;
  });
  assert.equal(draftState.mode, 'live');
  assert.equal(draftState.postGame, null);
  assert.deepEqual(draftState.players, []);
  assert.equal(draftState.draft.bluePicks.length, 0);
  await waitFor('读取空 session', () => fake.getState().requests.session >= 1 ? true : null, 8000);

  fake.setPhase('PreEndOfGame');
  const postState = await waitFor('赛后数据生成', async () => {
    const response = await getJson(appPort, '/api/state');
    return response.body.phase === 'post_game' && response.body.postGame && response.body.postGame.players.length === 10 ? response.body : null;
  });
  assert.equal(postState.postGame.gameId, 900001);
  assert.equal(postState.players.length, 10);

  fake.setPhase('InProgress');
  const nextGame = await waitFor('新局 InProgress 切回局内', async () => {
    const response = await getJson(appPort, '/api/state');
    return response.body.phase === 'in_game' && response.body.postGame === null ? response.body : null;
  });
  assert.equal(nextGame.mode, 'live');
  assert.deepEqual(nextGame.players, []);
  assert.equal(nextGame.blue.score, 0);
  assert.equal(nextGame.blue.gold, null);
  assert.equal(nextGame.goldEstimated, false);

  // 连续第二局：再次回到 BP 再进局内，上一局的赛后数据仍然不能泄漏。
  fake.setPhase('ChampSelect');
  await waitFor('第二局 BP', async () => {
    const response = await getJson(appPort, '/api/state');
    return response.body.phase === 'draft' ? response.body : null;
  });
  fake.setPhase('InProgress');
  const secondGame = await waitFor('第二局局内', async () => {
    const response = await getJson(appPort, '/api/state');
    return response.body.phase === 'in_game' ? response.body : null;
  });
  assert.equal(secondGame.postGame, null);
  assert.deepEqual(secondGame.players, []);
  assert.equal(secondGame.blue.score, 0);
  assert.equal(secondGame.blue.gold, null);
  assert.equal(secondGame.goldEstimated, false);
});

test('e2e：session 404 不抛错，离开 ChampSelect 清空 BP 数据', { timeout: 45000 }, async t => {
  const [appPort, lcuPort] = await pickPorts(2);
  const fake = await createFakeLcu({ port: lcuPort, token: TOKEN, phase: 'ChampSelect', sessionMissing: true });
  resetTestConfig();
  const app = spawnNode('src/main.js', [], {
    RB_DATA_DIR: TEST_DATA_DIR,
    PORT: String(appPort),
    RIOT_LCU_PORT: String(lcuPort),
    RIOT_REMOTING_AUTH_TOKEN: TOKEN,
    LIVE_CLIENT_URL: 'http://127.0.0.1:9',
    RIOT_CLIENT_COMMAND_LINE: '',
    RIOT_LOCKFILE: ''
  });
  t.after(async () => {
    await stopRun(app);
    await fake.close();
  });
  await waitForOutput(app, /Khada Jhin running at http:\/\/127\.0\.0\.1:\d+/);

  // session 404 时仍进入 BP 阶段，但 BP 数据必须为空且标记 parsed=false。
  const empty = await waitFor('session 404 仍进入 draft', async () => {
    const response = await getJson(appPort, '/api/state');
    return response.body.phase === 'draft' && response.body.live.draft && response.body.live.draft.parsed === false ? response.body : null;
  });
  assert.equal(empty.mode, 'live');
  assert.equal(empty.draft.bluePicks.length, 0);
  assert.equal(empty.draft.redPicks.length, 0);
  assert.equal(empty.live.draft.source, 'lcu');
  assert.match(empty.live.draft.error, /404|not available/i);

  // session 恢复后正常展示 pick/ban。
  fake.setSessionMissing(false);
  const parsed = await waitFor('session 恢复后展示 BP', async () => {
    const response = await getJson(appPort, '/api/state');
    return response.body.live.draft && response.body.live.draft.parsed === true && response.body.draft.bluePicks.length === 5 ? response.body : null;
  });
  assert.equal(parsed.draft.redPicks.length, 5);

  // 离开 ChampSelect 后必须退出 BP 并清空旧阵容，不能继续显示上一局。
  fake.setPhase('Lobby');
  const lobby = await waitFor('离开 ChampSelect 清空 BP', async () => {
    const response = await getJson(appPort, '/api/state');
    return response.body.phase === 'lobby' && response.body.draft.bluePicks.length === 0 ? response.body : null;
  });
  assert.equal(lobby.draft.redPicks.length, 0);
  assert.equal(lobby.draft.blueBans.length, 0);
  assert.equal(lobby.live.draft.parsed, false);
});

test('e2e：fake LCU 脚本模式按顺序切换相位并校验鉴权', { timeout: 30000 }, async t => {
  const [port] = await pickPorts(1);
  const fake = await createFakeLcu({ port, token: TOKEN, script: ['ChampSelect', 'InProgress', 'PreEndOfGame'], advanceDelayMs: 0 });
  t.after(async () => { await fake.close(); });

  const first = await lcuRequest(port, '/lol-gameflow/v1/gameflow-phase', { token: TOKEN });
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body), 'ChampSelect');
  const session = await lcuRequest(port, '/lol-champ-select/v1/session', { token: TOKEN });
  assert.equal(session.status, 200);
  const sessionBody = JSON.parse(session.body);
  assert.equal(sessionBody.actions.length, 2);
  assert.equal(sessionBody.timer.phase, 'BAN_PICK');

  const second = await lcuRequest(port, '/lol-gameflow/v1/gameflow-phase', { token: TOKEN });
  assert.equal(JSON.parse(second.body), 'InProgress');
  const missingSession = await lcuRequest(port, '/lol-champ-select/v1/session', { token: TOKEN });
  assert.equal(missingSession.status, 404);

  const third = await lcuRequest(port, '/lol-gameflow/v1/gameflow-phase', { token: TOKEN });
  assert.equal(JSON.parse(third.body), 'PreEndOfGame');
  const eog = await lcuRequest(port, '/lol-end-of-game/v1/eog-stats-block', { token: TOKEN });
  assert.equal(eog.status, 200);
  assert.equal(JSON.parse(eog.body).teams.length, 2);

  const fourth = await lcuRequest(port, '/lol-gameflow/v1/gameflow-phase', { token: TOKEN });
  assert.equal(JSON.parse(fourth.body), 'PreEndOfGame', '脚本走到最后一项后应保持');

  const unauthorized = await lcuRequest(port, '/lol-gameflow/v1/gameflow-phase', {});
  assert.equal(unauthorized.status, 401);
  const stats = await lcuRequest(port, '/__control/state', { token: TOKEN });
  assert.equal(JSON.parse(stats.body).authFailures, 1);
});
