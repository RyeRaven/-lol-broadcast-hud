'use strict';

// t36：四段链路端到端回归。假 LCDA -> src/main.js 轮询归一化 -> 协议流快照 + 像素条
// -> /events SSE -> HUD 页面脚本。所有端口都用内核分配，绝不写死 3210/3211/3212-3219。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SPAWN_ATTEMPTS = 5;
const GOLD_KEY = 'totalGold';

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

function postJson(port, pathname, payload) {
  return request(port, pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
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

// 从真实 /broadcast/hud 响应里取页面脚本，注入和 test/live-roster.test.js 相同的 __hud 测试钩子。
function loadHudFromHtml(html) {
  const script = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(script, 'HUD 页面应包含内联脚本');
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
    '    csMarkup: csMarkup,',
    '    capUsable: capUsable,',
    '    capPrecision: capPrecision',
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
  vm.runInContext(page, context, { filename: 'hud-broadcast-pipeline-test.js' });
  assert.ok(context.window.__hud, 'HUD 测试钩子应已安装');
  return context.window.__hud;
}

test('t36：假LCDA→协议流→像素条→SSE→HUD 四段链路端到端回归', { timeout: 120000 }, async t => {
  const { port, app } = await startStack(t);
  const initial = await waitFor('假 LCDA 进入局内且出现 10 名玩家', async () => {
    const response = await getJson(port, '/api/state');
    const state = response.body;
    return state && state.mode === 'live' && Array.isArray(state.players) && state.players.length === 10 ? state : null;
  });
  assert.equal(initial.players[0].champion, 'Jayce', '假 LCDA 的第一名玩家应是 Jayce');

  const sse = openSse(port);
  t.after(() => sse.close());

  const HP = { blue: [12, 34, 56, 78, 90], red: [90, 78, 56, 34, 12] };
  const RES = { blue: [34, 56, 78, 90, 12], red: [78, 56, 34, 12, 90] };

  const bars = [];
  for (const side of ['blue', 'red']) {
    for (let row = 0; row < 5; row += 1) {
      bars.push({ side, rowIndex: row, kind: 'hp', fillPercent: HP[side][row], status: 'ok', shieldPx: 0, dominantColor: [13, 182, 67] });
      bars.push({ side, rowIndex: row, kind: 'resource', fillPercent: RES[side][row], status: 'ok', shieldPx: 0, dominantColor: [49, 138, 232] });
    }
  }

  const counters = { blue: 0, red: 0 };
  const feedPlayers = initial.players.map((player, index) => {
    const side = player.team === 'red' ? 'red' : 'blue';
    const row = counters[side];
    counters[side] += 1;
    const record = {
      participantId: index + 1,
      championName: player.champion,
      team: side,
      kills: index % 4,
      deaths: index % 3,
      assists: index % 5,
      cs: 100 + index,
      xp: 9000 + index * 50,
      asOf: 600,
      precision: {
        kills: 'exact',
        deaths: 'exact',
        assists: 'exact',
        cs: 'exact',
        xp: 'exact'
      }
    };
    record[GOLD_KEY] = 10000 + index * 1000;
    record.precision[GOLD_KEY] = 'exact';
    record.row = row;
    return record;
  });

  const gameId = 'PIPELINE-E2E-' + process.pid + '-' + Date.now();
  const feedPayload = { source: 'live', gameId, gameTime: 600, players: feedPlayers };
  const barPayload = { ts: Date.now(), source: 'pixel', bars };

  const feedResponse = await postJson(port, '/api/protocol-feed', feedPayload);
  assert.equal(feedResponse.status, 200, '协议流包应被接受：' + feedResponse.body);
  assert.equal(JSON.parse(feedResponse.body).players, 10);

  const barResponse = await postJson(port, '/api/pixel-bars', barPayload);
  assert.equal(barResponse.status, 200, '像素条包应被接受：' + barResponse.body);
  assert.equal(JSON.parse(barResponse.body).bars, 20);

  const applied = await waitFor('协议流与像素条同时生效', async () => {
    const response = await getJson(port, '/api/state');
    const state = response.body;
    const jayce = state.players.find(player => player.champion === 'Jayce');
    const active = state.protocolDecode === true
      && jayce && jayce.csExact === 100 && jayce[GOLD_KEY] === 10000 && jayce.xp === 9000
      && jayce.hpPercent === 12 && jayce.resourcePercent === 34;
    return active ? state : null;
  }, 10000);

  // 逐玩家核对协议流精确值与像素条百分比都按 (team, 队伍内出场顺序) 落到正确的人。
  const feedByChampion = new Map(feedPlayers.map(record => [record.championName, record]));
  const expectedCounters = { blue: 0, red: 0 };
  for (const player of applied.players) {
    const expected = feedByChampion.get(player.champion);
    assert.ok(expected, player.champion + ' 应能在协议流包中找到');
    assert.equal(player.csExact, expected.cs, player.champion + ' 的 csExact');
    assert.equal(player[GOLD_KEY], expected[GOLD_KEY], player.champion + ' 的 ' + GOLD_KEY);
    assert.equal(player.xp, expected.xp, player.champion + ' 的 xp');
    assert.equal(player.csAsOf, 600);
    assert.equal(player.xpAsOf, 600);
    const side = player.team === 'red' ? 'red' : 'blue';
    const row = expectedCounters[side];
    expectedCounters[side] += 1;
    assert.equal(player.hpPercent, HP[side][row], player.champion + ' 的 hpPercent');
    assert.equal(player.resourcePercent, RES[side][row], player.champion + ' 的 resourcePercent');
  }

  assert.equal(applied.protocolDecode, true);
  assert.equal(applied.capability.fields.csExact.precision, 'exact');
  assert.equal(applied.capability.fields.csExact.source, 'spectator-protocol');
  assert.equal(applied.capability.fields.hpPercent.precision, 'estimated');
  assert.equal(applied.capability.fields.hpPercent.source, 'pixel-bars');
  assert.equal(applied.capability.fields.resourcePercent.precision, 'estimated');

  // /events SSE 必须把同一份数据送出去（不能只有 /api/state 有）。
  const sseFrames = await waitFor('SSE 至少 3 帧且包含精确值与像素百分比', () => {
    if (sse.messages.length < 3) return null;
    const hit = sse.messages.find(message => {
      if (!Array.isArray(message.players)) return false;
      return message.players.some(player => player.champion === 'Jayce'
        && player.csExact === 100 && player[GOLD_KEY] === 10000 && player.xp === 9000
        && player.hpPercent === 12 && player.resourcePercent === 34);
    });
    return hit ? sse.messages.slice() : null;
  }, 10000);
  assert.ok(sseFrames.length >= 3, 'SSE 至少应收到 3 帧，实际 ' + sseFrames.length);
  const hitFrame = sseFrames.find(message => Array.isArray(message.players)
    && message.players.some(player => player.champion === 'Jayce' && player.csExact === 100 && player.hpPercent === 12));
  assert.ok(hitFrame, 'SSE 必须有一帧同时带 csExact=100 与 hpPercent=12');
  assert.equal(hitFrame.protocolDecode, true, 'SSE 帧必须带 protocolDecode');

  // 取真实 /broadcast/hud 页面，在 vm 沙箱里用实际 /api/state 快照渲染。
  const hudResponse = await request(port, '/broadcast/hud');
  assert.equal(hudResponse.status, 200);
  const hud = loadHudFromHtml(hudResponse.body);
  hud.setConfig({ players: [] });
  hud.setState(applied);
  const jayce = applied.players.find(player => player.champion === 'Jayce');
  const cells = hud.barCells(jayce);
  assert.ok(cells.includes('hb-bar hp'), 'HUD 应画生命条');
  assert.ok(cells.includes('width:12.0%'), '生命条宽度必须等于投递的 12%，实际：' + cells);
  assert.ok(cells.includes('hb-bar res'), 'HUD 应画资源条');
  assert.ok(cells.includes('width:34.0%'), '资源条宽度必须等于投递的 34%，实际：' + cells);
  assert.ok(cells.includes('background:rgb(49,138,232)'), '资源条必须使用像素条投递的 dominantColor');
  assert.ok(cells.includes('hb-bar xp'), 'HUD 应保留经验条');
  // t39：协议流 xp 精确时 xpProgress 契约必须同步升为 exact，经验条画真实进度而不是 unknown 斜纹。
  // Jayce level=11（XP_TABLE[11]=7300、XP_TABLE[12]=8580），xp=9000 已超过 12 级阈值 → 100.0%。
  assert.equal(applied.capability.fields.xpProgress.precision, 'exact', '协议流 xp 精确时 xpProgress 必须是 exact');
  assert.equal(applied.capability.fields.xpProgress.available, true, '协议流 xp 精确时 xpProgress 必须可用');
  assert.equal(applied.capability.fields.xpProgress.source, 'spectator-protocol');
  assert.equal(cells.includes('hb-bar xp unknown'), false, 'xpProgress 可用时经验条不能画 unknown 占位');
  assert.ok(cells.includes('width:100.0%'), '经验条宽度必须按 xp/等级阈值算出真实进度，实际：' + cells);
  assert.equal(hud.csMarkup(jayce), '100', 'CS 必须显示协议流的精确值 100');
  assert.equal(hud.csMarkup(jayce).startsWith('≈'), false, '精确 CS 绝不能用 ≈ 量化符号');

  // 停掉像素条（不再 POST）等 2.5s：hpPercent 必须归 null，HUD 只能画 unknown 而不是 0% 实心条。
  const stale = await waitFor('像素条过期后 hpPercent 归 null 且契约降级', async () => {
    const response = await getJson(port, '/api/state');
    const state = response.body;
    const target = state.players.find(player => player.champion === 'Jayce');
    const expired = state.pixelBars && state.pixelBars.active === false && state.pixelBars.stale === true
      && target && target.hpPercent === null && target.resourcePercent === null
      && state.capability.fields.hpPercent.precision === 'unavailable';
    return expired ? state : null;
  }, 12000);
  hud.setState(stale);
  const staleCells = hud.barCells(stale.players.find(player => player.champion === 'Jayce'));
  assert.ok(staleCells.includes('hb-bar hp unknown'), '过期后 HUD 生命条必须是 unknown 占位');
  // t39：协议流同样 2000ms 过期（xp 归 null），xpProgress 必须立即回 unavailable、经验条回到 unknown。
  assert.equal(stale.capability.fields.xpProgress.precision, 'unavailable', '协议流过期后 xpProgress 必须回落 unavailable');
  assert.ok(staleCells.includes('hb-bar xp unknown'), '协议流过期后经验条必须回到 unknown 占位');
  assert.equal(staleCells.includes('width:12.0%'), false, '过期后绝不能继续画旧百分比');
  const staleWidths = staleCells.match(/width:([0-9.]+)%/g) || [];
  assert.ok(staleWidths.length > 0, 'unknown 占位条应有显式 0 宽度');
  assert.equal(staleWidths.every(item => item === 'width:0%'), true, 'null 不能画成任何非零长度：' + staleWidths.join(','));

  assert.equal(app.exit, null, '服务必须存活');
  assert.equal(/unhandledRejection|uncaughtException/.test(app.stderr), false, 'stderr 不得出现进程兜底异常：' + app.stderr);
});
