'use strict';

// 系列赛接口回归测试（真实本地 HTTP 服务，隔离数据目录）。
// 起因：修「结束这轮比赛」时把 /api/series 的分支挂进了自己新增的 if/else 链，
// 结果 end 只改了标志位没真的收尾，客户端却收到 ok 弹出「这轮比赛已结束」。
// 这里把 start/end/game/next/reset 与模拟模式收尾都钉成契约。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-series-'));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let port = 3231; port <= 3239; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error('没有空闲测试端口（3231-3239）');
}

function request(port, pathname, method, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: method || 'GET',
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('HTTP 超时：' + pathname)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 每个用例起一个独立服务，但从「真实模式 + 空系列赛」开始：数据目录里的 config.json 必须显式写 live，
// 否则默认会进模拟模式，进模拟就会自动开一轮演示系列赛，start 直接报 series_in_progress。
function writeLiveConfig() {
  fs.mkdirSync(path.join(DATA_DIR, 'data'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'data', 'config.json'), JSON.stringify({ mode: 'live', phase: 'draft', tournamentName: 'SERIES CUP' }));
  fs.rmSync(path.join(DATA_DIR, 'data', 'series.json'), { force: true });
}

async function boot() {
  writeLiveConfig();
  const port = await pickPort();
  const child = spawn(process.execPath, [path.join(ROOT, 'src/main.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), RB_DATA_DIR: DATA_DIR }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { err += chunk; });
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error('服务提前退出：' + err);
    try {
      const health = await request(port, '/health');
      if (health.status === 200) {
        assert.equal(health.body.mode, 'live', '测试必须从真实模式起跑');
        break;
      }
    } catch { /* 还没起来 */ }
    if (Date.now() - started > 15000) throw new Error('等待服务启动超时：' + err);
    await delay(100);
  }
  return { port, child, stop: () => new Promise((resolve) => { child.once('exit', resolve); try { child.kill(); } catch { resolve(); } }) };
}

test('系列赛接口：一局没打就结束 = 取消这轮，不进已完成场次', async (t) => {
  const server = await boot();
  t.after(() => server.stop());
  const start = await request(server.port, '/api/series/start', 'POST', { bestOf: 3, tournament: 'API CUP' });
  assert.equal(start.body.series.status, 'running');
  const end = await request(server.port, '/api/series/end', 'POST', {});
  assert.equal(end.status, 200);
  assert.equal(end.body.series.status, 'idle', 'end 必须把当前轮收尾，不能只返回 ok');
  assert.equal(end.body.series.history.length, 0, '建了比赛又不想打了，不该留下一条 0:0 的战绩');
  const again = await request(server.port, '/api/series/end', 'POST', {});
  assert.equal(again.status, 400, '已经收尾的系列赛再点结束要说清楚');
  assert.equal(again.body.error, 'series_not_running');
});

test('系列赛接口：记过一局再结束才进已完成场次', async (t) => {
  const server = await boot();
  t.after(() => server.stop());
  await request(server.port, '/api/series/start', 'POST', { bestOf: 3, tournament: 'GAME CUP' });
  await request(server.port, '/api/series/game', 'POST', { winner: 'blue', blueKills: 20, redKills: 10, duration: 1800 });
  const end = await request(server.port, '/api/series/end', 'POST', {});
  assert.equal(end.body.series.status, 'idle');
  assert.equal(end.body.series.history.length, 1);
  assert.equal(end.body.series.history[0].tournament, 'GAME CUP');
  assert.equal(end.body.series.history[0].scores.blue, 1);
});

test('系列赛接口：打完 BO 后再 end 仍然可以收尾', async (t) => {
  const server = await boot();
  t.after(() => server.stop());
  await request(server.port, '/api/series/start', 'POST', { bestOf: 3, tournament: 'BO CUP' });
  await request(server.port, '/api/series/game', 'POST', { winner: 'blue', blueKills: 20, redKills: 10, duration: 1800 });
  await request(server.port, '/api/series/next', 'POST', {});
  const second = await request(server.port, '/api/series/game', 'POST', { winner: 'blue', blueKills: 22, redKills: 11, duration: 1900 });
  assert.equal(second.body.series.decided, true, 'BO3 先拿两局即决出胜负');
  const next = await request(server.port, '/api/series/next', 'POST', {});
  assert.equal(next.status, 400, '已决出胜负不该再开下一局');
  assert.equal(next.body.error, 'series_decided');
  const end = await request(server.port, '/api/series/end', 'POST', {});
  assert.equal(end.status, 200, '决出胜负之后必须还能收尾（原来客户端在这里形成死循环）');
  assert.equal(end.body.series.status, 'idle');
  assert.equal(end.body.series.history.length, 1);
  assert.equal(end.body.series.history[0].winner, 'blue');
});

test('系列赛接口：reset 清空当前轮但保留历史', async (t) => {
  const server = await boot();
  t.after(() => server.stop());
  await request(server.port, '/api/series/start', 'POST', { bestOf: 3, tournament: 'RESET CUP' });
  await request(server.port, '/api/series/game', 'POST', { winner: 'red', blueKills: 5, redKills: 9, duration: 1500 });
  await request(server.port, '/api/series/end', 'POST', {});
  await request(server.port, '/api/series/start', 'POST', { bestOf: 3, tournament: 'RESET CUP 2' });
  const reset = await request(server.port, '/api/series/reset', 'POST', {});
  assert.equal(reset.body.series.status, 'idle');
  assert.equal(reset.body.series.scores.blue + reset.body.series.scores.red, 0);
  assert.equal(reset.body.series.history.length, 1, 'reset 只清当前轮，不该抹掉已完成场次');
});

test('模拟模式：手动结束之后剧本推进不再把系列赛复活', async (t) => {
  const server = await boot();
  t.after(() => server.stop());
  const mockStart = await request(server.port, '/api/mock/start', 'POST', {});
  assert.equal(mockStart.body.mode, 'mock');
  assert.equal(mockStart.body.series.status, 'running');
  const end = await request(server.port, '/api/series/end', 'POST', {});
  assert.equal(end.body.series.status, 'idle');
  await request(server.port, '/api/demo', 'POST', { action: 'seek', at: 155000 });
  await delay(400);
  const after = await request(server.port, '/api/mock');
  assert.equal(after.body.series.status, 'idle', '手动结束过就不许自动开新一场（否则点完几秒又冒出「第 1 局 0:0」）');
  await request(server.port, '/api/demo', 'POST', { action: 'seek', at: 22000 });
  await delay(400);
  const again = await request(server.port, '/api/mock');
  assert.equal(again.body.series.status, 'idle');
});
