'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ECON_OCR_TTL_MS,
  isLoopback,
  normalizeEconOcrPayload,
  createEconOcrStore,
  applyEconOcrToPlayers,
  handleEconOcrApi
} = require('../src/econ-ocr');
const { applyEconOcrAvailability, buildCapabilityMatrix, precisionOf } = require('../src/data-capability');
const { normalizeLiveState, buildItemIndex } = require('../src/live-data');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- 纯函数层 ----------

test('econ-ocr：合法包被接受，totalGold 归一化为整数，confidence 缺省为 null', () => {
  const parsed = normalizeEconOcrPayload({
    ts: 1794509940336,
    source: 'econ-ocr',
    rows: [
      { side: 'blue', rowIndex: 0, totalGold: 1457, confidence: 0.82 },
      { side: 'red', rowIndex: 4, totalGold: 1254 }
    ]
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].totalGold, 1457);
  assert.equal(parsed.rows[0].confidence, 0.82);
  assert.equal(parsed.rows[1].confidence, null);
});

test('econ-ocr：非法 side / rowIndex / totalGold / confidence 整包拒绝，且不产生任何状态', () => {
  const cases = [
    [{ side: 'blue', rowIndex: 0 }, /totalGold/], // 缺 totalGold 也是非法
    [{ side: 'green', rowIndex: 0, totalGold: 100 }, /side/],
    [{ side: 'blue', rowIndex: 5, totalGold: 100 }, /rowIndex/],
    [{ side: 'blue', rowIndex: 1.5, totalGold: 100 }, /rowIndex/],
    [{ side: 'blue', rowIndex: 0, totalGold: 'abc' }, /totalGold/],
    [{ side: 'blue', rowIndex: 0, totalGold: 100.5 }, /totalGold/],
    [{ side: 'blue', rowIndex: 0, totalGold: -1 }, /totalGold/],
    [{ side: 'blue', rowIndex: 0, totalGold: 1000000 }, /totalGold/],
    [{ side: 'blue', rowIndex: 0, totalGold: 100, confidence: 1.5 }, /confidence/]
  ];
  for (const [row, pattern] of cases) {
    const parsed = normalizeEconOcrPayload({ rows: [row] });
    assert.equal(parsed.ok, false, JSON.stringify(row) + ' 应被拒绝');
    if (pattern) assert.match(parsed.reason, pattern);
  }
  // 结构本身不合法也拒绝。
  assert.equal(normalizeEconOcrPayload(null).ok, false);
  assert.equal(normalizeEconOcrPayload({}).ok, false);
  assert.equal(normalizeEconOcrPayload({ rows: 'x' }).ok, false);
  assert.equal(normalizeEconOcrPayload({ rows: [], source: 'pixel' }).ok, false);
  // 同一 (side,rowIndex) 重复：无法判断哪个是真的，宁可拒绝也不猜。
  const duplicate = normalizeEconOcrPayload({ rows: [
    { side: 'blue', rowIndex: 0, totalGold: 100 },
    { side: 'blue', rowIndex: 0, totalGold: 200 }
  ] });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason, /重复/);
});

test('econ-ocr：单行丢帧沿用上次读数（保持窗口内不清值），超 TTL 才逐行失效', () => {
  let clock = 1000;
  const store = createEconOcrStore({ now: () => clock });
  store.commit([{ side: 'blue', rowIndex: 0, totalGold: 1457, confidence: null }]);
  let snapshot = store.snapshot();
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.rows.length, 1);
  clock += ECON_OCR_TTL_MS - 1;
  assert.equal(store.snapshot().active, true, 'TTL 内仍然有效');
  clock += 2;
  snapshot = store.snapshot();
  assert.equal(snapshot.active, false, '超过 TTL 必须失效');
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.rows.length, 0, '失效的读数不得出现在 rows 里');
  // 合并提交：这一轮没报的行沿用上一次读数（丢一帧不清），各行按自己最后被解析到的时间过 TTL。
  clock = 20000;
  store.commit([
    { side: 'blue', rowIndex: 0, totalGold: 1457 },
    { side: 'red', rowIndex: 0, totalGold: 1987 }
  ]);
  clock = 20001;
  store.commit([{ side: 'blue', rowIndex: 0, totalGold: 1500 }]);
  const held = store.snapshot();
  assert.equal(held.rows.length, 2, '红方这一轮没报也要沿用上一次读数');
  assert.equal(held.rows.find(r => r.side === 'red').totalGold, 1987, '沿用值必须原样保留');
  assert.equal(held.rows.find(r => r.side === 'blue').totalGold, 1500, '新读数覆盖旧读数');
  // 空包（整帧没解析到面板）也不清：读数按各自的最后更新时间过期。
  clock = 20002;
  store.commit([]);
  assert.equal(store.snapshot().rows.length, 2, '空包保持全部读数');
  clock = 20001 + ECON_OCR_TTL_MS;
  const half = store.snapshot();
  assert.equal(half.rows.length, 1, '红方（最后更新 20000）先过期');
  assert.equal(half.rows[0].side, 'blue');
  clock = 20002 + ECON_OCR_TTL_MS;
  const gone = store.snapshot();
  assert.equal(gone.active, false);
  assert.equal(gone.rows.length, 0);
  // 失效后重新提交要复活。
  store.commit([{ side: 'blue', rowIndex: 0, totalGold: 1600 }]);
  assert.equal(store.snapshot().rows.length, 1);
});

test('econ-ocr：rows 按 (team, 行序) 映射到玩家，稀疏行不覆盖未命中玩家', () => {
  const players = [
    { team: 'blue', name: 'B0', totalGold: 111, totalGoldPrecision: 'quantized' },
    { team: 'blue', name: 'B1' },
    { team: 'blue', name: 'B2' },
    { team: 'red', name: 'R0', totalGold: 222, totalGoldPrecision: 'quantized' },
    { team: 'red', name: 'R1' }
  ];
  applyEconOcrToPlayers(players, [
    { side: 'blue', rowIndex: 0, totalGold: 1457, confidence: 0.9 },
    { side: 'red', rowIndex: 1, totalGold: 1895, confidence: 0.8 }
  ]);
  assert.equal(players[0].econGold, 1457);
  assert.equal(players[0].totalGold, 1457);
  assert.equal(players[0].totalGoldPrecision, 'exact');
  assert.equal(players[1].econGold === undefined || players[1].econGold === null, true, '未命中的蓝 2 号不得被写值');
  assert.equal(players[1].totalGold, undefined);
  assert.equal(players[3].totalGold, 222, '红 1 号没命中时必须保留原（协议流）值，绝不清成空');
  assert.equal(players[4].econGold, 1895);
  // 第二轮该行没再报：上一轮 econ 写过的金币与标记必须一起清，不能留旧值冒充当前。
  applyEconOcrToPlayers(players, []);
  assert.equal(players[0].econGold, null);
  assert.equal(players[4].econGold, null);
  assert.equal(players[0].totalGold, null);
  assert.equal(players[0].totalGoldPrecision, null);
  assert.equal(players[3].totalGold, 222, '非 econ 来源的金币不由 econ 清理');
});

test('econ-ocr：契约把 totalGold 升为 exact(econ-ocr)，失效后立刻降回 unavailable', () => {
  const base = buildCapabilityMatrix('live-spectate', { liveClient: true, gameflowPhase: 'InProgress' });
  assert.equal(precisionOf(base, 'totalGold'), 'unavailable', '没有 OCR 时必须 unavailable');
  const withEcon = buildCapabilityMatrix('live-spectate', { liveClient: true, gameflowPhase: 'InProgress', econOcr: true });
  assert.equal(precisionOf(withEcon, 'totalGold'), 'exact');
  assert.equal(withEcon.fields.totalGold.source, 'econ-ocr');
  // 幂等 + 双向：失效后降级，恢复后升级，且不改动传入的矩阵（SSE 历史帧共享引用）。
  const off = applyEconOcrAvailability(withEcon, false);
  assert.equal(precisionOf(off, 'totalGold'), 'unavailable');
  assert.equal(precisionOf(withEcon, 'totalGold'), 'exact', '原矩阵不得被就地修改');
  const on = applyEconOcrAvailability(off, true);
  assert.equal(precisionOf(on, 'totalGold'), 'exact');
  assert.equal(applyEconOcrAvailability(on, true), on, '已经是 exact(econ-ocr) 时应直接返回原对象');
  // 失效方向只降 econ-ocr 来源：协议流/LCDA 的 totalGold 不归它管。
  const protoMatrix = buildCapabilityMatrix('live-spectate', {
    liveClient: true, gameflowPhase: 'InProgress', protocolDecode: true,
    protocolFields: { cs: true, gold: 'quantized', xp: 'exact' }
  });
  assert.equal(precisionOf(protoMatrix, 'totalGold'), 'quantized');
  assert.equal(applyEconOcrAvailability(protoMatrix, false), protoMatrix, '非 econ 来源的失效必须是幂等无操作');
});

test('econ-ocr：normalizeLiveState 回填 totalGold 并输出 econOcr', () => {
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
    econOcr: {
      active: true,
      updatedAt: 1794509940336,
      stale: false,
      rows: [
        { side: 'blue', rowIndex: 0, totalGold: 1457, confidence: 0.9 },
        { side: 'red', rowIndex: 0, totalGold: 1987, confidence: 0.9 }
      ]
    }
  });
  assert.equal(live.players[0].totalGold, 1457);
  assert.equal(live.players[0].totalGoldPrecision, 'exact');
  assert.equal(live.players[1].totalGold, 1987);
  assert.equal(live.econOcr.active, true);
  assert.equal(live.econOcr.updatedAt, 1794509940336);
  assert.equal(live.capability.fields.totalGold.precision, 'exact');
  assert.equal(live.capability.fields.totalGold.source, 'econ-ocr');
  // 没有读数时字段保持 null 且契约回到 unavailable。
  const bare = normalizeLiveState(payload, { itemIndex });
  assert.equal(bare.players[0].totalGold, null);
  assert.equal(bare.econOcr.active, false);
  assert.equal(bare.capability.fields.totalGold.precision, 'unavailable');
  // 失效的读数（active=false）即使还带着旧 rows 也不许回填。
  const stale = normalizeLiveState(payload, {
    itemIndex,
    econOcr: { active: false, updatedAt: 1, stale: true, rows: [{ side: 'blue', rowIndex: 0, totalGold: 99999 }] }
  });
  assert.equal(stale.players[0].totalGold, null, '失效读数绝不能冒充当前金币');
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

test('econ-ocr：非本机来源 403，且写接口响应不带 Access-Control-Allow-Origin', async () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('10.0.0.5'), false);
  assert.equal(isLoopback(undefined), false);

  const store = createEconOcrStore();
  const { req, res } = fakeExchange({ remoteAddress: '10.0.0.5' });
  const handled = handleEconOcrApi(req, res, { pathname: '/api/econ-ocr' }, { store });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden_source');
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined, '内部写接口绝不能开 CORS');
  assert.equal(store.snapshot().active, false, '被拒绝的请求不得写入状态');

  // 本机合法请求：200，同样不带 CORS 头。
  const ok = fakeExchange();
  const handledOk = handleEconOcrApi(ok.req, ok.res, { pathname: '/api/econ-ocr' }, { store });
  assert.equal(handledOk, true);
  ok.emit('data', JSON.stringify({ rows: [{ side: 'blue', rowIndex: 0, totalGold: 1457 }] }));
  ok.emit('end');
  await delay(30);
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.res.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(store.snapshot().active, true);

  // 非法包：400 且状态不变（还是上一包的内容）。
  const before = JSON.stringify(store.snapshot().rows);
  const bad = fakeExchange();
  handleEconOcrApi(bad.req, bad.res, { pathname: '/api/econ-ocr' }, { store });
  bad.emit('data', JSON.stringify({ rows: [{ side: 'blue', rowIndex: 0, totalGold: -5 }] }));
  bad.emit('end');
  await delay(30);
  assert.equal(bad.res.statusCode, 400);
  assert.equal(JSON.parse(bad.res.body).error, 'invalid_econ_ocr');
  assert.equal(JSON.stringify(store.snapshot().rows), before, '非法包不得污染状态');
});

// ---------- 端到端（真实服务，与 pixel-bars 同一 harness 模式） ----------

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function spawnNode(script, args, extraEnv) {
  const child = spawn(process.execPath, [script].concat(args), {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

function waitForOutput(run, pattern, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let text = '';
    const onData = chunk => {
      text += chunk;
      if (pattern.test(text)) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('等待输出超时：' + pattern + '；输出=' + text)); }, timeoutMs);
    function cleanup() { clearTimeout(timer); run.child.stdout.off('data', onData); }
    run.child.stdout.on('data', onData);
  });
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
      response.on('end', () => resolve({ status: response.statusCode, body }));
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

// ---------- 解析器（tools/pixel-bars/econ_ocr.py，环境门控，缺图/缺 python 自动 skip） ----------

const REAL_IMAGE = process.env.ECON_OCR_TEST_IMAGE || '';
const REAL_PYTHON = process.env.ECON_OCR_TEST_PYTHON || '';

test('econ-ocr：econ_ocr.py --image 解析真实截图（设置 ECON_OCR_TEST_IMAGE/ECON_OCR_TEST_PYTHON 才跑）', { timeout: 60000 }, async () => {
  if (!REAL_IMAGE || !REAL_PYTHON) {
    assert.ok(true, 'skip：未设置 ECON_OCR_TEST_IMAGE / ECON_OCR_TEST_PYTHON');
    return;
  }
  assert.ok(fs.existsSync(REAL_IMAGE), '测试截图不存在：' + REAL_IMAGE);
  const out = await new Promise((resolve, reject) => {
    const child = spawn(REAL_PYTHON, [path.join(__dirname, '..', 'tools', 'pixel-bars', 'econ_ocr.py'), '--image', REAL_IMAGE], { cwd: path.join(__dirname, '..') });
    let stdout = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stdout += c; });
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error('econ_ocr.py 退出码 ' + code + '：' + stdout)));
  });
  const rows = JSON.parse(out.slice(out.indexOf('{'))).rows;
  const blue = rows.filter(r => r.side === 'blue').map(r => r.totalGold);
  // 用户截图真值：107(1457) 782(2582) 331(2031) 566(1716) 468(1418)
  assert.deepEqual(blue, [1457, 2582, 2031, 1716, 1418]);
});

// ---------- 回归：协议流失效保护不得清掉 econ-ocr 保持期内的 totalGold ----------

test('econ-ocr：协议流失效时 OCR 保持期内的 totalGold 不被清掉（防每秒闪回 —），过期后正常失效', { timeout: 90000 }, async t => {
  const livePort = await allocatePort();
  const live = { child: spawnNode('tools/fake-live-server.js', [String(livePort)], {}) };
  t.after(() => stopRun(live));
  await waitForOutput(live, /fake live client on \d+/);
  const port = await allocatePort();
  const app = { child: spawnNode('src/main.js', [], {
    PORT: String(port),
    LIVE_CLIENT_URL: 'http://127.0.0.1:' + livePort,
    RIOT_LCU_PORT: '9',
    RIOT_REMOTING_AUTH_TOKEN: '',
    RIOT_CLIENT_COMMAND_LINE: '',
    RIOT_LOCKFILE: ''
  }) };
  t.after(() => stopRun(app));
  await waitForOutput(app, /Khada Jhin running at http:\/\/127\.0\.0\.1:\d+/);

  const inGame = await waitFor('进入局内阶段', async () => {
    const response = await getJson(port, '/api/state');
    return response.body.mode === 'live' && response.body.players.length === 10 ? response.body : null;
  });
  assert.equal(inGame.players.filter(p => p.team === 'blue')[0].totalGold, null, 'OCR 读数到达前必须是 null');

  // OCR 正常上报（协议流自始至终不活跃——假 LCDA 不带协议字段）。
  const posted = await request(port, '/api/econ-ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ts: Date.now(), source: 'econ-ocr', rows: [
      { side: 'blue', rowIndex: 0, totalGold: 1457 },
      { side: 'red', rowIndex: 0, totalGold: 1987 }
    ] })
  });
  assert.equal(posted.status, 200);
  const applied = await waitFor('玩家拿到 OCR 金币', async () => {
    const response = await getJson(port, '/api/state');
    const blue = response.body.players.filter(p => p.team === 'blue')[0];
    const red = response.body.players.filter(p => p.team === 'red')[0];
    return blue && blue.totalGold === 1457 && red && red.totalGold === 1987 ? response.body : null;
  });
  assert.equal(applied.econOcr.active, true);

  // 关键回归窗口：跨过多个 tick（refreshProtocolFeed 每秒跑一次），OCR 不再上报但仍在 6s 保持期内。
  // 修复前：refreshProtocolFeed 每秒把 totalGold 清成 null，约 0.2s 后才被轮询恢复——HUD 每秒闪一次。
  // 持续高频采样，任何一次采到 null 都算回归。
  const holdMs = 2400;
  const started = Date.now();
  let samples = 0;
  while (Date.now() - started < holdMs) {
    const response = await getJson(port, '/api/state');
    const blue = response.body.players.filter(p => p.team === 'blue')[0];
    const red = response.body.players.filter(p => p.team === 'red')[0];
    samples += 1;
    assert.equal(blue.totalGold, 1457, '保持期内协议流失效不得清掉 OCR 金币（蓝）');
    assert.equal(red.totalGold, 1987, '保持期内协议流失效不得清掉 OCR 金币（红）');
    await delay(150);
  }
  assert.ok(samples >= 8, '回归窗口必须采到足够多的样本：' + samples);

  // 超过 6s 保持期：OCR 读数真正失效，字段清空、契约降级（协议流依旧不活跃，也不许伪造别的值）。
  const expired = await waitFor('OCR 保持期过后读数失效', async () => {
    const response = await getJson(port, '/api/state');
    const blue = response.body.players.filter(p => p.team === 'blue')[0];
    return blue && blue.econGold === null && blue.totalGold === null ? response.body : null;
  }, 12000);
  assert.equal(expired.econOcr.active, false);
  assert.equal(expired.capability.fields.totalGold.available, false, '过期后契约必须降回 unavailable');
});
