'use strict';

// t23 回归测试：像素读条（POST /api/pixel-bars）接入层。
// 三条铁律在这里被钉死：
//   1) fillPercent 只接受 0..100 有限数或 null，非法包整包 400 且**不污染状态**；
//   2) 只接受本机来源，且写接口不设 Access-Control-Allow-Origin；
//   3) 超过 2000ms 没更新的读数必须变 null —— 绝不拿旧百分比冒充当前血量。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const {
  PIXEL_BAR_TTL_MS,
  isLoopback,
  normalizePixelBarPayload,
  createPixelBarStore,
  applyBarsToPlayers,
  handlePixelBarsApi
} = require('../src/pixel-bars');
const vm = require('node:vm');
const { normalizeLiveState, buildItemIndex } = require('../src/live-data');
const { hudBroadcastPage } = require('../src/pages/hud-broadcast');
const { buildCapabilityMatrix, applyPixelBarsAvailability, precisionOf } = require('../src/data-capability');

const ROOT = path.resolve(__dirname, '..');
const OVERSIZE_BYTES = 2 * 1024 * 1024;
const SPAWN_ATTEMPTS = 5;

// t27：真实像素脚本与离线截图都在本机时，才跑真实脚本用例（缺失则跳过，绝不伪造读数）。
const REAL_PIXEL_SCRIPT = process.env.PIXEL_BARS_SCRIPT
  || 'C:/Users/RyeRaven/Documents/deepseek-harness/default-workspace/.tmp/spectator/pixel/hp_bars.py';
const REAL_PIXEL_IMAGE = process.env.PIXEL_BARS_IMAGE || 'C:/Temp/spec1.png';
const REAL_PYTHON_CANDIDATES = [
  process.env.PYTHON,
  'C:/Users/RyeRaven/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
  'python'
].filter(Boolean);

function realPixelScript() { return REAL_PIXEL_SCRIPT; }
function realPixelImage() { return REAL_PIXEL_IMAGE; }
function realPython() {
  return REAL_PYTHON_CANDIDATES.find(candidate => candidate === 'python' || fs.existsSync(candidate)) || 'python';
}
function hasRealPixelScript() {
  return fs.existsSync(REAL_PIXEL_SCRIPT) && fs.existsSync(REAL_PIXEL_IMAGE) && realPython() !== 'python';
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function allocatePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
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

async function waitForOutput(run, pattern, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pattern.test(run.stdout)) return run.stdout;
    if (run.exit) throw new Error('子进程提前退出（code=' + run.exit.code + '）：' + run.stderr);
    if (/EADDRINUSE/.test(run.stderr)) {
      const retryable = new Error('端口被占用：' + run.stderr);
      retryable.code = 'EADDRINUSE';
      throw retryable;
    }
    await delay(100);
  }
  throw new Error('等待输出超时：' + pattern + '；stderr=' + run.stderr);
}

function stopRun(run) {
  return new Promise(resolve => {
    if (!run || !run.child || run.child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    run.child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { run.child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const handle = http.request({
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
    handle.setTimeout(options.timeoutMs || 8000, () => handle.destroy(new Error('HTTP 超时：' + pathname)));
    handle.on('error', reject);
    if (options.body !== undefined) handle.write(options.body);
    handle.end();
  });
}

async function getJson(port, pathname) {
  const response = await request(port, pathname);
  return { status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

async function postBars(port, payload) {
  return request(port, '/api/pixel-bars', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// 超过 MAX_BODY_BYTES 的请求体：写入端主动忽略 EPIPE（服务端已经回 413 并停止读取）。
function oversizedPost(port, pathname) {
  return new Promise((resolve, reject) => {
    const handle = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(OVERSIZE_BYTES) } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    handle.setTimeout(15000, () => handle.destroy(new Error('超时')));
    handle.on('error', reject);
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < OVERSIZE_BYTES) {
        sent += chunk.length;
        if (!handle.write(chunk)) { handle.once('drain', pump); return; }
      }
      handle.end();
    };
    pump();
  });
}

function openSse(port) {
  const messages = [];
  let buffer = '';
  const handle = http.get({ host: '127.0.0.1', port, path: '/events', headers: { Accept: 'text/event-stream' } }, response => {
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
  handle.on('error', () => {});
  return { messages, close() { handle.destroy(); } };
}

async function waitFor(description, probe, timeoutMs = 20000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(120);
  }
  throw new Error('等待超时（' + timeoutMs + 'ms）：' + description + (lastError ? '；最后错误：' + lastError.message : ''));
}

// 一个可用的服务实例：内核分配端口 + EADDRINUSE 重试，绝不碰 3210/3211。
async function startStack(t) {
  const livePort = await allocatePort();
  const live = spawnNode('tools/fake-live-server.js', [String(livePort)], {});
  t.after(() => stopRun(live));
  await waitForOutput(live, /fake live client on \d+/);
  let lastError = null;
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt += 1) {
    const port = await allocatePort();
    const app = spawnNode('src/main.js', [], {
      PORT: String(port),
      LIVE_CLIENT_URL: 'http://127.0.0.1:' + livePort,
      RIOT_LCU_PORT: '9',
      RIOT_REMOTING_AUTH_TOKEN: '',
      RIOT_CLIENT_COMMAND_LINE: '',
      RIOT_LOCKFILE: ''
    });
    t.after(() => stopRun(app));
    try {
      await waitForOutput(app, /Khada Jhin running at http:\/\/127\.0\.0\.1:\d+/);
      return { port, app, live };
    } catch (error) {
      await stopRun(app);
      lastError = error;
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError || new Error('无法启动测试服务');
}

// HUD 页面脚本没有导出，按 test/live-roster.test.js 的方式在 vm 里跑一遍拿到渲染函数。
function loadHud() {
  const html = hudBroadcastPage();
  const script = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(script, 'HUD 应包含内联脚本');
  const start = script[1].indexOf('(function hudScript()');
  assert.ok(start > 0, 'HUD 页面脚本应存在');
  let page = script[1].slice(start);
  const cut = page.lastIndexOf('  buildShell();');
  assert.ok(cut > 0, 'HUD 页面脚本应以 buildShell 收尾');
  page = page.slice(0, cut) + [
    '  window.__hud = {',
    '    setState: function (value) { state = value; },',
    '    setConfig: function (value) { config = value; },',
    '    playerList: playerList,',
    '    barCells: barCells,',
    '    capUsable: capUsable',
    '  };',
    '})();'
  ].join('\n');
  const root = { innerHTML: '', classList: { add() {} } };
  const context = {
    window: {},
    document: {
      getElementById(id) { return id === 'hud-broadcast' ? root : null; },
      body: { classList: { add() {} } },
      documentElement: { classList: { add() {} } }
    },
    console, JSON, Math, Date, Array, Object, String, Number,
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  vm.createContext(context);
  vm.runInContext(page, context, { filename: 'hud-broadcast-pixel-test.js' });
  assert.ok(context.window.__hud, 'HUD 测试钩子应已安装');
  return context.window.__hud;
}

// ---------- 纯函数层 ----------

test('t23：合法包被接受，fillPercent 归一化为 0..100，absent 的条一律置 null', () => {
  const parsed = normalizePixelBarPayload({
    ts: 1794509940336,
    source: 'pixel',
    bars: [
      { side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 42.5, shieldPx: 5, dominantColor: [40, 200, 90], status: 'ok' },
      { side: 'blue', rowIndex: 0, kind: 'resource', fillPercent: null, status: 'absent' },
      { side: 'red', rowIndex: 4, kind: 'hp', fillPercent: 100, status: 'ok_pale' }
    ]
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.bars.length, 3);
  assert.equal(parsed.bars[0].fillPercent, 42.5);
  assert.equal(parsed.bars[0].shieldPx, 5);
  assert.deepEqual([...parsed.bars[0].dominantColor], [40, 200, 90]);
  // absent 的条即使带了数字也不能当真。
  assert.equal(parsed.bars[1].fillPercent, null);
  assert.equal(parsed.bars[2].fillPercent, 100);
});

test('t23：非法 fillPercent / side / rowIndex / kind 整包拒绝，且不产生任何状态', () => {
  const cases = [
    [{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 120 }, /fillPercent/],
    [{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: -1 }, /fillPercent/],
    [{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 'abc' }, /fillPercent/],
    [{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: Infinity }, /fillPercent/],
    [{ side: 'green', rowIndex: 0, kind: 'hp', fillPercent: 10 }, /side/],
    [{ side: 'blue', rowIndex: 5, kind: 'hp', fillPercent: 10 }, /rowIndex/],
    [{ side: 'blue', rowIndex: 1.5, kind: 'hp', fillPercent: 10 }, /rowIndex/],
    [{ side: 'blue', rowIndex: 0, kind: 'mana', fillPercent: 10 }, /kind/],
    [{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 10, status: 'weird' }, /status/],
    [{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 10, dominantColor: [1, 2] }, /dominantColor/]
  ];
  for (const [bar, pattern] of cases) {
    const parsed = normalizePixelBarPayload({ bars: [bar] });
    assert.equal(parsed.ok, false, JSON.stringify(bar) + ' 应被拒绝');
    assert.match(parsed.reason, pattern);
  }
  // 结构本身不合法也拒绝。
  assert.equal(normalizePixelBarPayload(null).ok, false);
  assert.equal(normalizePixelBarPayload({}).ok, false);
  assert.equal(normalizePixelBarPayload({ bars: 'x' }).ok, false);
  assert.equal(normalizePixelBarPayload({ bars: [], source: 'mouse' }).ok, false);
  // 同一 (side,rowIndex,kind) 重复：无法判断哪个是真的，宁可拒绝也不猜。
  const duplicate = normalizePixelBarPayload({ bars: [
    { side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 10 },
    { side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 20 }
  ] });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason, /重复/);
});

test('t23：单条丢帧沿用上次读数（保持窗口内不清值），超 TTL 才逐条失效', () => {
  let clock = 1000;
  const store = createPixelBarStore({ now: () => clock });
  store.commit([{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 61, status: 'ok', shieldPx: 0, dominantColor: null }]);
  let snapshot = store.snapshot();
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.bars.length, 1);
  clock += PIXEL_BAR_TTL_MS - 1;
  assert.equal(store.snapshot().active, true, 'TTL 内仍然有效');
  clock += 2;
  snapshot = store.snapshot();
  assert.equal(snapshot.active, false, '超过 TTL 必须失效');
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.bars.length, 0, '失效的读数不得出现在 bars 里');
  // 合并保持：下一轮只报蓝方，红方沿用上次读数；各条按自己最后一次上报时间过 TTL。
  clock = 5000;
  store.commit([
    { side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 30, status: 'ok', shieldPx: 0, dominantColor: null },
    { side: 'red', rowIndex: 0, kind: 'hp', fillPercent: 70, status: 'ok', shieldPx: 0, dominantColor: null }
  ]);
  clock = 5001;
  store.commit([{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 33, status: 'ok', shieldPx: 0, dominantColor: null }]);
  const after = store.snapshot();
  assert.equal(after.bars.length, 2, '丢帧的红方沿用上次读数，不闪没');
  assert.equal(after.bars.find(b => b.side === 'blue').fillPercent, 33, '蓝方被新读数覆盖');
  assert.equal(after.bars.find(b => b.side === 'red').fillPercent, 70, '红方保持旧值');
  clock = 11001;
  const half = store.snapshot();
  assert.equal(half.bars.length, 1, '红方先过期（最后一次上报更早）');
  assert.equal(half.bars[0].side, 'blue');
  clock = 11002;
  assert.equal(store.snapshot().active, false, '全部过期后整体失效');
  // 重新上报立即复活。
  clock = 11003;
  store.commit([{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 40, status: 'ok', shieldPx: 0, dominantColor: null }]);
  assert.equal(store.snapshot().active, true, '重新 commit 立即复活');
});

test('t23：bars 按 (team, 行序) 映射到玩家，不按屏幕位置猜', () => {
  const players = [
    { team: 'blue', name: 'B0' }, { team: 'blue', name: 'B1' }, { team: 'blue', name: 'B2' },
    { team: 'red', name: 'R0' }, { team: 'red', name: 'R1' }
  ];
  applyBarsToPlayers(players, [
    { side: 'blue', rowIndex: 1, kind: 'hp', fillPercent: 55, status: 'ok', shieldPx: 0, dominantColor: null },
    { side: 'blue', rowIndex: 1, kind: 'resource', fillPercent: 20, status: 'ok', shieldPx: 0, dominantColor: [10, 20, 30] },
    { side: 'red', rowIndex: 0, kind: 'hp', fillPercent: 90, status: 'ok', shieldPx: 3.8, dominantColor: null }
  ]);
  assert.equal(players[0].hpPercent, null, '没读到的玩家必须是 null，不是 0');
  assert.equal(players[1].hpPercent, 55);
  assert.equal(players[1].resourcePercent, 20);
  assert.deepEqual([...players[1].resourceColor], [10, 20, 30]);
  assert.equal(players[3].hpPercent, 90);
  assert.equal(players[3].shieldPercent, 10, '38px 满宽时 3.8px 盾 = 10%');
  assert.equal(players[4].hpPercent, null);
  // 第二轮该玩家没有读数时必须回到 null，不能留上一轮的血量。
  applyBarsToPlayers(players, []);
  assert.equal(players[1].hpPercent, null);
  assert.equal(players[3].shieldPercent, null);
});

test('t23：契约把生命/资源条从 unavailable 升为 estimated(pixel-bars)，失效后立刻降回', () => {
  const base = buildCapabilityMatrix('live-spectate', { liveClient: true, gameflowPhase: 'InProgress' });
  assert.equal(precisionOf(base, 'hpPercent'), 'unavailable', '没有像素读数时必须 unavailable');
  const withPixel = buildCapabilityMatrix('live-spectate', { liveClient: true, gameflowPhase: 'InProgress', pixelBars: true });
  assert.equal(precisionOf(withPixel, 'hpPercent'), 'estimated');
  assert.equal(withPixel.fields.hpPercent.source, 'pixel-bars');
  assert.equal(precisionOf(withPixel, 'resourcePercent'), 'estimated');
  // 幂等 + 双向：失效后降级，恢复后升级，且不改动传入的矩阵（SSE 历史帧共享引用）。
  const off = applyPixelBarsAvailability(withPixel, false);
  assert.equal(precisionOf(off, 'hpPercent'), 'unavailable');
  assert.equal(precisionOf(withPixel, 'hpPercent'), 'estimated', '原矩阵不得被就地修改');
  const on = applyPixelBarsAvailability(off, true);
  assert.equal(precisionOf(on, 'hpPercent'), 'estimated');
  assert.equal(applyPixelBarsAvailability(on, true), on, '已经是 estimated 时应直接返回原对象');
});

test('t23：normalizeLiveState 回填 hpPercent/resourcePercent 并输出 pixelBars', () => {
  const payload = {
    gameData: { gameTime: 600, gameMode: 'CLASSIC', mapName: 'Map11' },
    allPlayers: [
      { summonerName: 'BlueTop', team: 'ORDER', championName: 'Jayce', level: 9, scores: { kills: 1, deaths: 0, assists: 2, creepScore: 80 } },
      { summonerName: 'RedTop', team: 'CHAOS', championName: 'Renekton', level: 8, scores: { kills: 0, deaths: 1, assists: 1, creepScore: 70 } }
    ],
    events: { Events: [] }
  };
  const itemIndex = buildItemIndex({}, 'test');
  const live = normalizeLiveState(payload, {
    itemIndex,
    pixelBars: {
      active: true,
      updatedAt: 1794509940336,
      stale: false,
      bars: [
        { side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 64, status: 'ok', shieldPx: 0, dominantColor: null },
        { side: 'blue', rowIndex: 0, kind: 'resource', fillPercent: 12, status: 'ok', shieldPx: 0, dominantColor: [59, 127, 212] },
        { side: 'red', rowIndex: 0, kind: 'hp', fillPercent: 31, status: 'ok', shieldPx: 0, dominantColor: null }
      ]
    }
  });
  assert.equal(live.players[0].hpPercent, 64);
  assert.equal(live.players[0].resourcePercent, 12);
  assert.deepEqual([...live.players[0].resourceColor], [59, 127, 212]);
  assert.equal(live.players[1].hpPercent, 31);
  assert.equal(live.pixelBars.active, true);
  assert.equal(live.pixelBars.updatedAt, 1794509940336);
  assert.equal(live.capability.fields.hpPercent.precision, 'estimated');
  // 没有读数时字段必须是 null 且契约回到 unavailable。
  const bare = normalizeLiveState(payload, { itemIndex });
  assert.equal(bare.players[0].hpPercent, null);
  assert.equal(bare.pixelBars.active, false);
  assert.equal(bare.capability.fields.hpPercent.precision, 'unavailable');
  // 失效的读数（active=false）即使还带着旧 bars 也不许回填。
  const stale = normalizeLiveState(payload, {
    itemIndex,
    pixelBars: { active: false, updatedAt: 1, stale: true, bars: [{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 99, status: 'ok', shieldPx: 0, dominantColor: null }] }
  });
  assert.equal(stale.players[0].hpPercent, null, '失效读数绝不能冒充当前血量');
});

// ---------- HTTP 层（in-process） ----------

function fakeExchange(options = {}) {
  const req = {
    method: options.method || 'POST',
    socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
    headers: options.headers || {}
  };
  const listeners = {};
  req.on = (event, handler) => { (listeners[event] = listeners[event] || []).push(handler); return req; };
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body === undefined ? '' : String(body); }
  };
  return { req, res, emit: (event, value) => (listeners[event] || []).forEach(handler => handler(value)) };
}

test('t23：非本机来源 403，且写接口响应不带 Access-Control-Allow-Origin', async () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('10.0.0.5'), false);
  assert.equal(isLoopback('192.168.1.20'), false);
  assert.equal(isLoopback(undefined), false);

  const store = createPixelBarStore();
  const { req, res } = fakeExchange({ remoteAddress: '10.0.0.5' });
  const handled = handlePixelBarsApi(req, res, { pathname: '/api/pixel-bars' }, { store });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden_source');
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined, '内部写接口绝不能开 CORS');
  assert.equal(store.snapshot().active, false, '被拒绝的请求不得写入状态');

  // 本机合法请求：200，同样不带 CORS 头。
  const ok = fakeExchange();
  const handledOk = handlePixelBarsApi(ok.req, ok.res, { pathname: '/api/pixel-bars' }, { store });
  assert.equal(handledOk, true);
  ok.emit('data', JSON.stringify({ bars: [{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 50 }] }));
  ok.emit('end');
  await delay(30);
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.res.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(store.snapshot().active, true);

  // 非法包：400 且状态不变（还是上一包的内容）。
  const before = JSON.stringify(store.snapshot().bars);
  const bad = fakeExchange();
  handlePixelBarsApi(bad.req, bad.res, { pathname: '/api/pixel-bars' }, { store });
  bad.emit('data', JSON.stringify({ bars: [{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 400 }] }));
  bad.emit('end');
  await delay(30);
  assert.equal(bad.res.statusCode, 400);
  assert.equal(JSON.parse(bad.res.body).error, 'invalid_pixel_bars');
  assert.equal(JSON.stringify(store.snapshot().bars), before, '非法包不得污染状态');
});

// ---------- 端到端 ----------

test('t23：真实服务 —— 合法包 200、/events 出现 hpPercent、非法包 400 不改状态、陈旧后变 null', { timeout: 90000 }, async t => {
  const { port, app } = await startStack(t);
  const inGame = await waitFor('进入局内阶段', async () => {
    const response = await getJson(port, '/api/state');
    return response.body.mode === 'live' && response.body.players.length === 10 ? response.body : null;
  });
  const blueFirst = inGame.players.filter(player => player.team === 'blue')[0];
  assert.equal(blueFirst.hpPercent, null, '没有像素读数时必须是 null，不是 0');
  assert.equal(inGame.pixelBars.active, false);
  assert.equal(inGame.capability.fields.hpPercent.available, false, '没有读数时契约必须 unavailable');

  const sse = openSse(port);
  t.after(() => sse.close());

  const valid = await postBars(port, {
    ts: Date.now(),
    source: 'pixel',
    bars: [
      { side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 42.5, shieldPx: 5, dominantColor: [40, 200, 90], status: 'ok' },
      { side: 'blue', rowIndex: 0, kind: 'resource', fillPercent: 88, status: 'ok' },
      { side: 'red', rowIndex: 2, kind: 'hp', fillPercent: 12, status: 'ok' },
      { side: 'red', rowIndex: 2, kind: 'resource', fillPercent: null, status: 'absent' }
    ]
  });
  assert.equal(valid.status, 200);
  const validBody = JSON.parse(valid.body);
  assert.equal(validBody.ok, true);
  assert.equal(validBody.bars, 4);

  // 玩家字段与契约都要跟着变。
  const applied = await waitFor('玩家拿到像素读数', async () => {
    const response = await getJson(port, '/api/state');
    const player = response.body.players.filter(entry => entry.team === 'blue')[0];
    return player && player.hpPercent === 42.5 ? response.body : null;
  });
  const bluePlayer = applied.players.filter(player => player.team === 'blue')[0];
  assert.equal(bluePlayer.hpPercent, 42.5);
  assert.equal(bluePlayer.resourcePercent, 88);
  assert.equal(bluePlayer.shieldPercent, 100 * 5 / 38);
  assert.equal(applied.pixelBars.active, true);
  assert.equal(applied.capability.fields.hpPercent.precision, 'estimated');
  assert.equal(applied.capability.fields.hpPercent.source, 'pixel-bars');
  // absent 的条必须是 null，绝不能补成 0%。
  const redThird = applied.players.filter(player => player.team === 'red')[2];
  assert.equal(redThird.resourcePercent, null, 'absent 的资源条必须是 null');

  // SSE 观众也要收到 hpPercent（HUD 靠 SSE 重绘，不能只靠 /api/state）。
  const frame = await waitFor('SSE 帧里出现 hpPercent', () => {
    for (const message of sse.messages) {
      const players = Array.isArray(message.players) ? message.players : [];
      if (players.some(player => player && player.hpPercent === 42.5)) return message;
    }
    return null;
  }, 12000);
  assert.equal(frame.pixelBars.active, true);

  // 非法包 400，且状态与玩家字段都不变。
  const beforeState = await getJson(port, '/api/state');
  const bad = await postBars(port, { bars: [{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 150 }] });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).error, 'invalid_pixel_bars');
  const afterBad = await getJson(port, '/api/state');
  assert.equal(afterBad.body.players.filter(player => player.team === 'blue')[0].hpPercent, beforeState.body.players.filter(player => player.team === 'blue')[0].hpPercent, '非法包不得改动玩家数据');
  assert.equal(afterBad.body.pixelBars.updatedAt, beforeState.body.pixelBars.updatedAt, '非法包不得刷新时间戳');

  // 状态接口可诊断。
  const status = await getJson(port, '/api/pixel-bars/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.active, true);
  assert.ok(Array.isArray(status.body.lastBars));
  assert.equal(status.body.lastBars.length, 4);

  // 陈旧保护：超过 6000ms 没有新读数，字段必须变 null、契约回到 unavailable。
  const stale = await waitFor('读数过期后 hpPercent 变 null', async () => {
    const response = await getJson(port, '/api/state');
    const player = response.body.players.filter(entry => entry.team === 'blue')[0];
    return player && player.hpPercent === null && response.body.pixelBars.active === false ? response.body : null;
  }, 12000);
  assert.equal(stale.capability.fields.hpPercent.precision, 'unavailable', '过期后契约必须降级');
  assert.equal(stale.pixelBars.stale, true);
});

test('t23：POST /api/pixel-bars 的 2MB 请求体返回 413，服务存活', { timeout: 60000 }, async t => {
  const { port } = await startStack(t);
  const response = await oversizedPost(port, '/api/pixel-bars');
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).error, 'payload_too_large');
  // 服务必须还活着：超限请求不能把进程打挂。
  const health = await getJson(port, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  const status = await getJson(port, '/api/pixel-bars/status');
  assert.equal(status.status, 200, '超限请求不得影响像素接口本身');
});

test('t23：像素桥在脚本缺失时显式降级，不伪造任何读数', () => {
  const bridge = require('../tools/pixel-bars-bridge.cjs');
  assert.equal(typeof bridge.parseArgs, 'function');
  // 数组形态与完整包形态都要能识别。
  const fromArray = bridge.toPayload(JSON.stringify([{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 50 }]));
  assert.equal(fromArray.source, 'pixel');
  assert.equal(fromArray.bars.length, 1);
  assert.ok(Number.isFinite(fromArray.ts));
  const fromObject = bridge.toPayload(JSON.stringify({ ts: 1234, bars: [] }));
  assert.equal(fromObject.ts, 1234);
  // 不认识的行返回 null（丢弃），绝不猜成 0%。
  assert.equal(bridge.toPayload('not json'), null);
  assert.equal(bridge.toPayload(''), null);
  assert.equal(bridge.toPayload(JSON.stringify({ nope: 1 })), null);
  // 频率被夹在 1..10。
  assert.equal(bridge.parseArgs(['--rate', '0']).rate, 1);
  assert.equal(bridge.parseArgs(['--rate', '99']).rate, 10);
  // 脚本不存在时直接返回退出码 2，且不 spawn 任何进程。
  const missing = path.join(ROOT, '.tmp', 'definitely-not-a-pixel-script.py');
  assert.equal(fs.existsSync(missing), false);
  const errors = [];
  const run = bridge.runBridge({ script: missing, python: 'python', rate: 5, port: 1 }, { error: message => errors.push(message) });
  return run.promise.then(code => {
    assert.equal(code, 2);
    assert.ok(errors.some(message => message.includes(missing)), '必须打印缺失脚本的绝对路径');
  });
});

test('t23：HUD 只在契约允许且真有百分比时画条，null 一律画 unknown 占位', () => {
  const hud = loadHud();
  hud.setConfig({ players: [] });
  // 形状与 normalizeLiveState 的实际输出一致：扁平字段 + pixelBars 嵌套（护盾像素宽度只在嵌套里）。
  const player = {
    team: 'blue', name: 'BlueTop', champion: '杰斯', level: 10, cs: 100,
    hpPercent: 42.5, resourcePercent: 88, shieldPercent: 13.2, resourceColor: [59, 127, 212],
    pixelBars: {
      hp: { fillPercent: 42.5, status: 'ok', shieldPx: 5, dominantColor: null },
      resource: { fillPercent: 88, status: 'ok', shieldPx: 0, dominantColor: [59, 127, 212] }
    }
  };
  const live = buildCapabilityMatrix('live-spectate', { liveClient: true, gameflowPhase: 'InProgress', pixelBars: true });
  hud.setState({ mode: 'live', players: [player], blue: {}, red: {}, capability: live });
  const bars = hud.barCells(player);
  assert.ok(bars.includes('hb-bar hp'), '生命条必须画出来');
  assert.ok(bars.includes('width:42.5%'), '生命条长度取 hpPercent');
  assert.ok(bars.includes('width:88.0%'), '资源条长度取 resourcePercent');
  assert.ok(bars.includes('background:rgb(59,127,212)'), '资源条用读到的 dominantColor');
  assert.equal(bars.includes('hb-bar-shield'), false, '原生观战 UI 不显示护盾段（shieldPx 仅保留在 payload schema，不上屏）');

  // 契约说不可用（例如读数过期）时，即使对象上还留着旧百分比也不许画。
  const off = applyPixelBarsAvailability(live, false);
  hud.setState({ mode: 'live', players: [player], blue: {}, red: {}, capability: off });
  const hidden = hud.barCells(player);
  assert.ok(hidden.includes('hb-bar hp unknown'), '契约不可用时生命条必须画 unknown 占位');
  assert.equal(hidden.includes('width:42.5%'), false, '不可用时绝不能画旧百分比');

  // fillPercent 为 null（没读到，≠ 0%）同样只能画占位。
  const blank = { ...player, hpPercent: null, resourcePercent: null, shieldPercent: null, pixelBars: { hp: { fillPercent: null, status: 'absent', shieldPx: 0, dominantColor: null }, resource: { fillPercent: null, status: 'absent', shieldPx: 0, dominantColor: null } } };
  hud.setState({ mode: 'live', players: [blank], blue: {}, red: {}, capability: live });
  const empty = hud.barCells(blank);
  assert.ok(empty.includes('hb-bar hp unknown'));
  // 占位条本身带 width:0%（长度为零），关键是不能出现任何非零宽度——那就是把 null 画成了实心条。
  const widths = empty.match(/width:([0-9.]+)%/g) || [];
  assert.ok(widths.length > 0, '占位条应有显式的 0 宽度');
  assert.equal(widths.every(item => item === 'width:0%'), true, 'null 不能画成任何非零长度的条，实际：' + widths.join(','));
});

test('t23：像素桥把 NDJSON 行转成合法请求体（数组形态与完整包形态都支持）', async () => {
  const bridge = require('../tools/pixel-bars-bridge.cjs');
  // 用一个假「像素脚本」（本进程 node 跑一个立即输出的内联脚本），把 post 换成内存收集器，
  // 验证桥的解析/转发链路；不碰真实端口，也不会留下僵尸进程。
  const scriptPath = path.join(ROOT, '.tmp', 'fake-pixel-script-test.js');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, [
    "'use strict';",
    "process.stdout.write(JSON.stringify([{ side: 'blue', rowIndex: 0, kind: 'hp', fillPercent: 55 }]) + '\\n');",
    "process.stdout.write(JSON.stringify({ ts: 777, bars: [{ side: 'red', rowIndex: 1, kind: 'resource', fillPercent: 20 }] }) + '\\n');",
    "process.stdout.write('this is not json\\n');",
    'setTimeout(() => process.exit(0), 60);'
  ].join('\n'));
  const sent = [];
  const errors = [];
  const run = bridge.runBridge(
    { script: scriptPath, python: process.execPath, rate: 5, port: 1 },
    { post: payload => { sent.push(payload); return Promise.resolve({ status: 200, body: '{"ok":true}' }); }, error: m => errors.push(m) }
  );
  try {
    await delay(600);
    assert.equal(sent.length, 2, '两行合法输出应各转发一次，无法解析的行必须丢弃');
    assert.equal(sent[0].source, 'pixel');
    assert.equal(sent[0].bars[0].fillPercent, 55);
    assert.equal(sent[1].ts, 777);
    assert.equal(sent[1].bars[0].kind, 'resource');
    assert.ok(errors.some(m => m.includes('无法解析')), '无法解析的行必须显式记日志，不能静默吞掉');
  } finally {
    run.stop();
    try { fs.unlinkSync(scriptPath); } catch {}
  }
});

test('t27：像素桥把 hp_bars.py 的 L/R 与 detail[] 归一化成主进程认识的 blue/red', () => {
  const bridge = require('../tools/pixel-bars-bridge.cjs');
  // 真实 hp_bars.py 的 --json 输出形态：side 是 L/R，逐条读数在 detail[] 里。
  const real = JSON.stringify({
    seq: 1,
    ms: 13.182,
    bars: { L1: 0.6667, L4: 0 },
    mana: { L1: null },
    detail: [
      { side: 'L', rowIndex: 0, kind: 'hp', fillPercent: 66.7, confidence: 0.98, dominantColor: [13, 182, 67], shieldPx: 0, status: 'ok' },
      { side: 'R', rowIndex: 4, kind: 'resource', fillPercent: null, confidence: 0, dominantColor: null, shieldPx: 0, status: 'unsupported', reason: 'grey placeholder' },
      { side: 'L', rowIndex: 1, kind: 'mana', fillPercent: 78.4, status: 'ok' }
    ]
  });
  const payload = bridge.toPayload(real);
  assert.ok(payload, 'detail[] 形态必须能解析');
  assert.equal(payload.source, 'pixel');
  assert.equal(payload.bars.length, 3);
  assert.deepEqual(payload.bars.map(bar => [bar.side, bar.rowIndex, bar.kind, bar.fillPercent]), [
    ['blue', 0, 'hp', 66.7],
    ['red', 4, 'resource', null],
    ['blue', 1, 'resource', 78.4]
  ]);
  // 归一化后的包必须能直接通过服务端校验，否则桥转发必然 400。
  assert.equal(normalizePixelBarPayload(payload).ok, true);

  // 认不出的 side / 越界 rowIndex 一律丢弃；整行都认不出时返回 null（不发空包清状态）。
  assert.equal(bridge.toPayload(JSON.stringify([{ side: 'X', rowIndex: 0, kind: 'hp', fillPercent: 1 }])), null);
  assert.equal(bridge.toPayload(JSON.stringify([{ side: 'L', rowIndex: 9, kind: 'hp', fillPercent: 1 }])), null);
});

test('t27：--image 驱动每轮跑一次脚本并持续转发，不会一轮就退出', async () => {
  const bridge = require('../tools/pixel-bars-bridge.cjs');
  const scriptPath = path.join(ROOT, '.tmp', 'fake-pixel-image-test.js');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  // 忽略 --image 参数，模拟「离线喂图跑一次就退出」的脚本。
  fs.writeFileSync(scriptPath, [
    "'use strict';",
    "process.stdout.write(JSON.stringify({ detail: [{ side: 'L', rowIndex: 0, kind: 'hp', fillPercent: 42.5, status: 'ok' }] }) + '\\n');",
    'process.exit(0);'
  ].join('\n'));
  const sent = [];
  const run = bridge.runBridge(
    { script: scriptPath, python: process.execPath, rate: 10, port: 1, drive: 'image', image: scriptPath },
    { post: payload => { sent.push(payload); return Promise.resolve({ status: 200, body: '{"ok":true}' }); }, error: () => {} }
  );
  try {
    await delay(700);
    assert.ok(sent.length >= 3, '图像模式必须按 --rate 持续采样，实际只转发了 ' + sent.length + ' 包');
    assert.equal(sent.every(item => item.bars[0].fillPercent === 42.5), true);
    assert.equal(sent[0].bars[0].side, 'blue');
  } finally {
    run.stop();
    try { fs.unlinkSync(scriptPath); } catch {}
  }
});

test('t27：--image 隐含 image 驱动，--geometry 透传，非法 --drive 直接报错', () => {
  const bridge = require('../tools/pixel-bars-bridge.cjs');
  const withImage = bridge.parseArgs(['--port', '3313', '--image', 'C:/Temp/spec1.png']);
  assert.equal(withImage.drive, 'image');
  assert.equal(withImage.rate, 5);
  const scan = bridge.parseArgs(['--port', '3313', '--geometry', 'C:/g/1920x1080.json']);
  assert.equal(scan.drive, 'scan');
  assert.equal(scan.geometry, path.resolve('C:/g/1920x1080.json'));
  assert.throws(() => bridge.parseArgs(['--drive', 'bogus']), /--drive/);
  assert.throws(() => bridge.parseArgs(['--drive', 'image']), /--image/);
  assert.equal(bridge.parseArgs(['--rate', '99']).rate, 10);
  assert.equal(bridge.parseArgs(['--rate', '0']).rate, 1);
});

test('t27：真实 hp_bars.py 在离线截图上给出 10 条 hp + 10 条 resource', { skip: !hasRealPixelScript() && '真实 hp_bars.py / 截图不存在，跳过真实脚本用例' }, () => {
  const bridge = require('../tools/pixel-bars-bridge.cjs');
  const python = realPython();
  const output = execFileSync(python, [realPixelScript(), '--image', realPixelImage(), '--json'], { cwd: path.dirname(realPixelScript()), encoding: 'utf8', timeout: 120000 });
  const parsed = JSON.parse(output.trim().split(/\r?\n/).pop());
  assert.equal(Array.isArray(parsed.detail), true);
  assert.equal(parsed.detail.filter(bar => bar.kind === 'hp').length, 10);
  assert.equal(parsed.detail.filter(bar => bar.kind === 'resource').length, 10);
  const payload = bridge.toPayload(output.trim().split(/\r?\n/).pop());
  assert.ok(payload, '真实脚本输出必须能被桥解析');
  assert.equal(payload.bars.length, 20);
  assert.equal(normalizePixelBarPayload(payload).ok, true, '真实读数必须能通过服务端校验');
  const sides = new Set(payload.bars.map(bar => bar.side));
  assert.deepEqual([...sides].sort(), ['blue', 'red']);
  // 阵亡玩家 hp=0 是真实读数（0% 表示条是空的），null 才是「没读到」，两者不能混。
  assert.equal(payload.bars.some(bar => bar.kind === 'hp' && bar.fillPercent === 0), true);
});
