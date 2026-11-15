'use strict';

// B1' 回归测试：/api/obs/connect 等路由遇到超大/畸形请求体时不得打挂本地服务。
// 真实拉起 src/main.js（PORT 由内核分配空闲端口，绝不触碰 3210/3211 上正在运行的实例），
// 断言 HTTP 响应形状与进程存活；修复前该用例会让子进程以未处理 rejection 退出。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// node --test 并行跑多个测试文件，固定端口段会和 e2e / broadcast-cue 抢端口，
// 所以这里让内核分配空闲端口，并在 EADDRINUSE 时换端口重试。
const SPAWN_ATTEMPTS = 5;
// 超过 src/main.js 的 MAX_BODY_BYTES(1024 * 1024)。
const OVERSIZE_BYTES = 2 * 1024 * 1024;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 向内核要一个空闲端口（listen(0) 后立即释放），避免与并行测试文件抢固定端口段。
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

function spawnServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src/main.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      // 绝不连真实 Live Client / 真实 LCU：不可达端口 + 空锁文件路径。
      LIVE_CLIENT_URL: 'http://127.0.0.1:9',
      RIOT_LCU_PORT: '9',
      RIOT_REMOTING_AUTH_TOKEN: '',
      RIOT_CLIENT_COMMAND_LINE: '',
      RIOT_LOCKFILE: ''
    }),
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

// 等待监听成功。端口被并行测试抢占时进程不会退出（有 uncaughtException 兜底），
// 只会把 EADDRINUSE 记进 stderr，所以这里显式识别并抛出可重试的错误。
async function waitForListening(run, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (/Khada Jhin running at http:\/\/127\.0\.0\.1:\d+/.test(run.stdout)) return;
    if (run.exit) throw new Error('服务提前退出（code=' + run.exit.code + '）：' + run.stderr);
    if (/EADDRINUSE/.test(run.stderr)) {
      const retryable = new Error('端口被占用：' + run.stderr);
      retryable.code = 'EADDRINUSE';
      throw retryable;
    }
    await delay(100);
  }
  throw new Error('等待服务启动超时：' + run.stderr);
}

// 起一个可用的服务实例：内核分配端口 + EADDRINUSE 时换端口重试。
async function startServer(t) {
  let lastError = null;
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt += 1) {
    const port = await allocatePort();
    const run = spawnServer(port);
    t.after(() => stopRun(run));
    try {
      await waitForListening(run);
      return { port, run };
    } catch (error) {
      await stopRun(run);
      lastError = error;
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError || new Error('无法启动测试服务');
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
    const requestHandle = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      // 服务端在响应中途断开时 response 也会报错，不接住就会变成测试进程里的未捕获异常。
      response.on('error', reject);
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    requestHandle.setTimeout(options.timeoutMs || 10000, () => requestHandle.destroy(new Error('HTTP 请求超时：' + pathname)));
    requestHandle.on('error', reject);
    if (options.body !== undefined) requestHandle.write(options.body);
    requestHandle.end();
  });
}

// 声明并真的写入 2MB 请求体。服务端可能先回 413 再关连接，所以写侧错误按预期忽略。
function rawOversizedRequest(port, pathname) {
  return new Promise((resolve, reject) => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const requestHandle = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': String(OVERSIZE_BYTES) }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      // 修复前服务进程被打挂，客户端在响应流上只会看到 ECONNRESET，这里转成 rejection 交给外层包装解释。
      response.on('error', reject);
      response.on('data', data => { body += data; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    requestHandle.setTimeout(10000, () => requestHandle.destroy(new Error('HTTP 请求超时：' + pathname)));
    requestHandle.on('error', error => {
      // 服务端提前响应并关闭连接时客户端会看到 EPIPE/ECONNRESET，响应体仍可能已经到达。
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') return;
      reject(error);
    });
    for (let sent = 0; sent < OVERSIZE_BYTES; sent += chunk.length) {
      try { requestHandle.write(chunk); } catch { break; }
    }
    requestHandle.end();
  });
}

// 修复前这条路径会让子进程以未处理 rejection 退出，客户端只会看到 ECONNRESET，
// 看不出到底发生了什么；这里把「进程是否还活着」写进错误消息，让失败原因一眼可读。
async function oversizedRequest(port, pathname, run) {
  try {
    return await rawOversizedRequest(port, pathname);
  } catch (error) {
    const state = run && run.exit
      ? '服务进程已退出（code=' + run.exit.code + '，signal=' + run.exit.signal + '）'
      : '服务进程仍在运行';
    throw new Error(
      '请求体超限时没有拿到 HTTP 响应（' + error.message + '），' + state +
      '；stderr=' + String((run && run.stderr) || '').trim()
    );
  }
}

async function getJson(port, pathname) {
  const response = await request(port, pathname);
  return { status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

// 客户端先看到 ECONNRESET 时，子进程的 'exit' 事件往往还没派发到本进程；
// 短暂等一等，才能把「进程已退出（code=1）」写进断言消息，而不是只报一个莫名的连接重置。
async function waitForExit(run, timeoutMs = 1000) {
  const started = Date.now();
  while (!run.exit && Date.now() - started < timeoutMs) await delay(50);
  return run.exit;
}

async function assertAlive(port, run) {
  // 修复前进程已经被未处理 rejection 打挂，/health 根本连不上；先把「进程死了」这件事说清楚，
  // 否则测试只会报一个看不出因果的 ECONNRESET。
  let health;
  try {
    health = await getJson(port, '/health');
  } catch (error) {
    await waitForExit(run);
    assert.equal(
      run.exit,
      null,
      '服务进程已退出（code=' + (run.exit && run.exit.code) + '，signal=' + (run.exit && run.exit.signal) + '），' +
        '/health 无法访问：' + error.message + '；stderr=' + String(run.stderr || '').trim()
    );
    throw error;
  }
  assert.equal(health.status, 200, '服务必须仍然可访问');
  assert.equal(health.body.ok, true);
  assert.equal(run.exit, null, '服务进程不得退出：' + run.stderr);
  assert.doesNotMatch(run.stderr, /unhandledRejection|uncaughtException/, '兜底处理器不应被触发到崩溃');
}

// 客户端在超限请求上的报错（ECONNRESET / EPIPE）本身看不出原因；
// 修复前真正发生的是子进程被未处理 rejection 打挂，所以先断言进程存活，让失败信息指向根因。
async function expectSurvives(promise, port, run) {
  try {
    return await promise;
  } catch (error) {
    await waitForExit(run);
    await assertAlive(port, run);
    throw error;
  }
}

test('B1\' 回归：POST /api/obs/connect 的 2MB 请求体返回 413 且服务存活', { timeout: 60000 }, async t => {
  const { port, run } = await startServer(t);

  const response = await expectSurvives(oversizedRequest(port, '/api/obs/connect', run), port, run);
  assert.equal(response.status, 413);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'payload_too_large' });
  await assertAlive(port, run);
});

test('B1\' 回归：POST /api/obs/connect 的畸形 JSON 返回确定的错误且服务存活', { timeout: 60000 }, async t => {
  const { port, run } = await startServer(t);

  // readBody 对无法解析的 JSON 会退化成 {}，随后连接默认地址（本机 4455 未开）失败。
  const response = await request(port, '/api/obs/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'this is not json {{{'
  });
  assert.ok(response.status >= 400 && response.status <= 599, '必须回确定的 4xx/5xx，实际 ' + response.status);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, false);
  assert.equal(typeof payload.error, 'string');
  assert.ok(payload.error.length > 0);
  await assertAlive(port, run);
});

test('B1\' 回归：其余 /api/obs/* POST 的超大请求体也不会让服务退出', { timeout: 60000 }, async t => {
  const { port, run } = await startServer(t);

  const paths = ['/api/obs/record', '/api/obs/stream', '/api/obs/replay-buffer', '/api/obs/sources', '/api/obs/scene-package'];
  for (const pathname of paths) {
    const response = await expectSurvives(oversizedRequest(port, pathname, run), port, run);
    // 未连接 OBS 时这些路由先短路成 obs_not_connected；关键是必须有响应而不是进程消失。
    assert.ok(response.status >= 200 && response.status <= 599, pathname + ' 必须返回响应，实际 ' + response.status);
    const payload = JSON.parse(response.body);
    assert.equal(payload.ok, false, pathname + ' 不应成功');
  }

  // 非 obs 路由的 413 路径同样只影响单个请求。
  const phase = await expectSurvives(oversizedRequest(port, '/api/phase', run), port, run);
  assert.equal(phase.status, 413);
  assert.deepEqual(JSON.parse(phase.body), { ok: false, error: 'payload_too_large' });
  await assertAlive(port, run);
});

test('进程入口保留 unhandledRejection / uncaughtException 兜底', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  assert.match(source, /process\.on\('unhandledRejection'/);
  assert.match(source, /process\.on\('uncaughtException'/);
});
