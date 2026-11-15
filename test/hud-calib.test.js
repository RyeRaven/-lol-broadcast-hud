'use strict';

// /api/hud-calib 标定接口 + /overlay/hud-calibrate 页面测试。
// 真实拉起 src/main.js（端口只用 3212-3219 的空闲端口，绝不触碰 3210 / 3211），
// 数据文件通过 HUD_CALIB_PATH 指向临时目录，测试结束自动清理，不会污染仓库 data/。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  DEFAULT_HUD_CALIB,
  DEFAULT_ROW_OFFSETS,
  normalizeHudCalib,
  normalizeRowOffsets,
  normalizeHudCalibPayload,
  handleHudCalibApi
} = require('../src/pages/hud-calibrate');

const ROOT = path.resolve(__dirname, '..');
const PORT_RANGE_START = 3212;
const PORT_RANGE_END = 3219;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function isPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

const usedPorts = new Set();

async function pickPort() {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) {
    if (usedPorts.has(port)) continue;
    if (await isPortFree(port)) { usedPorts.add(port); return port; }
  }
  throw new Error('3212-3219 没有空闲测试端口');
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
    request.setTimeout(10000, () => request.destroy(new Error('HTTP 请求超时：' + pathname)));
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function waitForOutput(run, pattern, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (pattern.test(run.stdout)) { clearInterval(timer); resolve(run.stdout); }
      else if (run.exit) { clearInterval(timer); reject(new Error('子进程提前退出（code=' + run.exit.code + '）：' + run.stderr)); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('等待服务启动超时：' + run.stderr)); }
    }, 100);
  });
}

async function startServer(calibPath) {
  let lastError = null;
  // 端口在「探测空闲」与「真正监听」之间可能被并行测试文件抢走，失败就换下一个端口重试。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await pickPort();
    const child = spawn(process.execPath, [path.join(ROOT, 'src/main.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(port), HUD_CALIB_PATH: calibPath }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const run = { child, stdout: '', stderr: '', exit: null };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { run.stdout += chunk; });
    child.stderr.on('data', chunk => { run.stderr += chunk; });
    child.on('exit', (code, signal) => { run.exit = { code, signal }; });
    try {
      await waitForOutput(run, /Khada Jhin running/);
      return { port, run };
    } catch (error) {
      lastError = error;
      try { child.kill(); } catch { /* 已退出 */ }
      await delay(200);
    }
  }
  throw lastError || new Error('测试服务启动失败');
}

function stopServer(run) {
  return new Promise(resolve => {
    if (run.exit) return resolve();
    run.child.once('exit', () => resolve());
    run.child.kill();
    setTimeout(() => { try { run.child.kill('SIGKILL'); } catch {} resolve(); }, 4000);
  });
}

function tempCalibPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riftbroadcast-hud-calib-'));
  return { dir, file: path.join(dir, 'hud-calib.json') };
}

function fakeRes() {
  return {
    headersSent: false,
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code; this.headersSent = true; },
    end(text) { this.body = text; this.headersSent = true; }
  };
}

test('DEFAULT_HUD_CALIB 8 个字段等于 HUD 广播内置默认', () => {
  assert.deepEqual(DEFAULT_HUD_CALIB, {
    itemSize: 24, itemPitch: 25.6, rowPitch: 43.4, row1CenterY: 876.5,
    blueX: 643, redX: 1140, trinketBlueX: 619, trinketRedX: 1294
  });
  assert.equal(normalizeHudCalib(DEFAULT_HUD_CALIB).itemSize, 24);
  assert.equal(normalizeHudCalib(Object.assign({}, DEFAULT_HUD_CALIB, { itemSize: '24' })), null);
  assert.equal(normalizeHudCalib(Object.assign({}, DEFAULT_HUD_CALIB, { itemSize: 3 })), null);
  assert.equal(normalizeHudCalib(Object.assign({}, DEFAULT_HUD_CALIB, { extra: 1 })), null);
  assert.deepEqual(DEFAULT_ROW_OFFSETS, [0, 0, 0, 0, 0]);
  assert.deepEqual(normalizeRowOffsets(undefined), [0, 0, 0, 0, 0]);
  assert.equal(normalizeRowOffsets([0, 1, 2, 3]), null);
  assert.equal(normalizeRowOffsets([0, 1, 2, 3, '4']), null);
  assert.equal(normalizeRowOffsets([0, 1, 2, 3, 5000]), null);
  assert.deepEqual(normalizeHudCalibPayload(Object.assign({}, DEFAULT_HUD_CALIB, { rowOffsets: [1, 2, 3, 4, 5] })), {
    calibration: DEFAULT_HUD_CALIB,
    rowOffsets: [1, 2, 3, 4, 5]
  });
});

test('GET /api/hud-calib 无文件返回内置默认 source=default', async () => {
  const tmp = tempCalibPath();
  const server = await startServer(tmp.file);
  try {
    const response = await httpRequest(server.port, '/api/hud-calib');
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.ok, true);
    assert.equal(body.source, 'default');
    assert.deepEqual(body.calibration, DEFAULT_HUD_CALIB);
    assert.deepEqual(body.rowOffsets, [0, 0, 0, 0, 0]);
    for (const [key, value] of Object.entries(DEFAULT_HUD_CALIB)) assert.equal(body.calibration[key], value);
  } finally {
    await stopServer(server.run);
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('POST 合法标定 200 且再 GET source=file，原子写不留临时文件', async () => {
  const tmp = tempCalibPath();
  const server = await startServer(tmp.file);
  const next = Object.assign({}, DEFAULT_HUD_CALIB, { itemSize: 24.5, itemPitch: 26.4, rowPitch: 42.7, blueX: 700.5 });
  const rowOffsets = [0, 2.5, -1, 3, 4.5];
  try {
    const response = await httpRequest(server.port, '/api/hud-calib', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, next, { rowOffsets }))
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).ok, true);
    assert.ok(fs.existsSync(tmp.file), '标定文件应已写盘');
    const saved = JSON.parse(fs.readFileSync(tmp.file, 'utf8'));
    assert.equal(saved.calibration.itemSize, 24.5);
    assert.deepEqual(saved.rowOffsets, rowOffsets);
    const leftovers = fs.readdirSync(tmp.dir).filter(name => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '不应残留临时文件');
    const again = await httpRequest(server.port, '/api/hud-calib');
    const body = JSON.parse(again.body);
    assert.equal(body.source, 'file');
    assert.deepEqual(body.calibration, next);
    assert.deepEqual(body.rowOffsets, rowOffsets);
  } finally {
    await stopServer(server.run);
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('POST itemSize=3 越界返回 400 且旧文件保留', async () => {
  const tmp = tempCalibPath();
  const saved = Object.assign({}, DEFAULT_HUD_CALIB, { itemSize: 23.5 });
  fs.writeFileSync(tmp.file, JSON.stringify({ version: 1, calibration: saved }, null, 2));
  const server = await startServer(tmp.file);
  try {
    const response = await httpRequest(server.port, '/api/hud-calib', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, saved, { itemSize: 3 }))
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error, 'invalid_calibration');
    const after = JSON.parse(fs.readFileSync(tmp.file, 'utf8'));
    assert.equal(after.calibration.itemSize, 23.5);
  } finally {
    await stopServer(server.run);
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('POST rowOffsets 长度或类型非法返回 400', async () => {
  const tmp = tempCalibPath();
  const server = await startServer(tmp.file);
  try {
    for (const bad of [[0, 1, 2], [0, 1, 2, 3, '4'], [0, 1, 2, 3, 5000]]) {
      const response = await httpRequest(server.port, '/api/hud-calib', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, DEFAULT_HUD_CALIB, { rowOffsets: bad }))
      });
      assert.equal(response.status, 400);
      assert.equal(JSON.parse(response.body).error, 'invalid_calibration');
    }
  } finally {
    await stopServer(server.run);
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('POST 非回环地址返回 403 且不读 body', async () => {
  const res = fakeRes();
  const req = { method: 'POST', socket: { remoteAddress: '192.168.1.9' }, headers: {}, on() {} };
  const handled = await handleHudCalibApi(req, res, new URL('http://127.0.0.1/api/hud-calib'));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden');
});

test('POST 超过 1KB 返回 413 且服务仍存活', async () => {
  const tmp = tempCalibPath();
  const server = await startServer(tmp.file);
  try {
    const payload = JSON.stringify({ padding: 'x'.repeat(2000) });
    const response = await httpRequest(server.port, '/api/hud-calib', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
      body: payload
    });
    assert.equal(response.status, 413);
    assert.equal(JSON.parse(response.body).error, 'payload_too_large');
    const health = await httpRequest(server.port, '/health');
    assert.equal(health.status, 200);
  } finally {
    await stopServer(server.run);
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('GET /overlay/hud-calibrate 页面含 10 个孔元素与 8 个参数输入', async () => {
  const tmp = tempCalibPath();
  const server = await startServer(tmp.file);
  try {
    const response = await httpRequest(server.port, '/overlay/hud-calibrate');
    assert.equal(response.status, 200);
    assert.ok(response.body.includes('<!doctype html'));
    const holes = response.body.match(/class="calib-hole[ "]/g) || [];
    assert.equal(holes.length, 10);
    const params = response.body.match(/data-param="/g) || [];
    assert.equal(params.length, 8);
    assert.ok(response.body.includes("fetch('/api/hud-calib'"));
    assert.ok(response.body.includes('calib-hint'));
  } finally {
    await stopServer(server.run);
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});
