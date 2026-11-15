'use strict';

// 广播 cue 单元 + 真实 HTTP 路由测试：不依赖 3210，只使用 3212-3219 临时端口。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { state, applyBroadcastCue, BROADCAST_CUE_TYPES } = require('../src/app-state');

const ROOT = path.resolve(__dirname, '..');

function isPortFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let port = 3212; port <= 3219; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error('没有可用的 3212-3219 测试端口');
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: options.headers || {} }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.setTimeout(8000, () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function getJson(port, pathname) {
  const response = await request(port, pathname);
  return { status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

function waitForOutput(run, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (pattern.test(run.stdout)) { clearInterval(timer); resolve(); }
      else if (run.exit) { clearInterval(timer); reject(new Error('child exited: ' + run.stderr)); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('wait output timeout')); }
    }, 50);
  });
}

function stopChild(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

test('applyBroadcastCue 校验类型、递增 seq 且只保留一个 cue', () => {
  state.broadcastCue = { type: '', payload: null, seq: 0, at: null };
  assert.deepEqual(BROADCAST_CUE_TYPES, ['bp-in', 'hud-in', 'result-in', 'wipe', 'reset']);
  const first = applyBroadcastCue('bp-in', { round: 1 });
  assert.equal(first.type, 'bp-in');
  assert.deepEqual(first.payload, { round: 1 });
  assert.equal(first.seq, 1);
  assert.equal(typeof first.at, 'number');
  const second = applyBroadcastCue('wipe');
  assert.equal(second.seq, 2);
  assert.equal(second.payload, null);
  for (let i = 0; i < 50; i += 1) applyBroadcastCue('hud-in', { i });
  assert.equal(state.broadcastCue.seq, 52);
  assert.deepEqual(Object.keys(state.broadcastCue).sort(), ['at', 'payload', 'seq', 'type']);
  assert.throws(() => applyBroadcastCue('unknown'), /invalid_cue_type/);
});

test('HTTP /api/broadcast/cue 写 state、广播 SSE 且 cloneState 包含 broadcastConfig', { timeout: 30000 }, async t => {
  // 用临时配置文件隔离，避免断言依赖真实 config/broadcast.json（用户可随时改队伍）。
  const tempConfig = path.join(os.tmpdir(), 'rb-broadcast-cue-test-' + process.pid + '.json');
  fs.writeFileSync(tempConfig, JSON.stringify({
    teams: {
      blue: { name: '蓝方学院', shortName: 'BLUE', region: 'CN', rank: '', logo: '', color: '#3B82F6' },
      red: { name: '红方社群', shortName: 'RED', region: 'CN', rank: '', logo: '', color: '#EF4444' }
    }
  }), 'utf8');
  t.after(() => { try { fs.unlinkSync(tempConfig); } catch {} });
  const port = await pickPort();
  const child = spawn(process.execPath, [path.join(ROOT, 'src/main.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      RB_BROADCAST_CONFIG: tempConfig,
      NODE_USE_ENV_PROXY: '',
      RIOT_CLIENT_COMMAND_LINE: '',
      RIOT_LOCKFILE: '',
      RIOT_LCU_PORT: '1',
      RIOT_REMOTING_AUTH_TOKEN: 'test-token',
      LIVE_CLIENT_URL: 'http://127.0.0.1:9'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const run = { child, stdout: '', stderr: '', exit: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { run.stdout += chunk; });
  child.stderr.on('data', chunk => { run.stderr += chunk; });
  child.on('exit', (code, signal) => { run.exit = { code, signal }; });
  t.after(() => stopChild(child));

  await waitForOutput(run, /Khada Jhin running/);
  const events = [];
  const sseRequest = http.get({ host: '127.0.0.1', port, path: '/events' }, response => {
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', chunk => {
      buffer += chunk;
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) if (line.indexOf('data: ') === 0) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
        boundary = buffer.indexOf('\n\n');
      }
    });
  });
  sseRequest.on('error', () => {});
  t.after(() => sseRequest.destroy());

  const before = await getJson(port, '/api/state');
  assert.ok(before.body.broadcastConfig, 'state 应包含 broadcastConfig');
  assert.equal(before.body.broadcastConfig.teams.blue.name, '蓝方学院');

  const posted = await request(port, '/api/broadcast/cue', { method: 'POST', body: { type: 'bp-in', payload: { round: 1 } } });
  assert.equal(posted.status, 200);
  const cue = JSON.parse(posted.body).cue;
  assert.equal(cue.type, 'bp-in');
  assert.equal(cue.seq, before.body.broadcastCue.seq + 1);
  assert.equal(typeof cue.at, 'number');

  const after = await getJson(port, '/api/state');
  assert.equal(after.body.broadcastCue.seq, cue.seq);
  assert.deepEqual(after.body.broadcastCue.payload, { round: 1 });

  const postedAgain = await request(port, '/api/broadcast/cue', { method: 'POST', body: { type: 'result-in' } });
  assert.equal(JSON.parse(postedAgain.body).cue.seq, cue.seq + 1);
  const invalid = await request(port, '/api/broadcast/cue', { method: 'POST', body: { type: 'not-a-cue' } });
  assert.equal(invalid.status, 400);
  assert.equal(JSON.parse(invalid.body).error, 'invalid_cue_type');

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !events.some(event => event.broadcastCue && event.broadcastCue.seq === cue.seq + 1)) {
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok(events.some(event => event.broadcastCue && event.broadcastCue.seq === cue.seq + 1), 'SSE 应携带最新 cue');
});
