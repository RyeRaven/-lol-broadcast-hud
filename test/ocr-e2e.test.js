'use strict';

// 采集脚本托管 e2e：用「node 当 python、js 假 worker」验证
// RB_OCR_SUPERVISE=1 时服务自动拉起 worker、崩溃后指数退避重启、
// 状态经 /api/state 暴露，进程退出时 worker 被一并回收。

const test = require('node:test');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function waitForOutput(run, pattern, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let text = '';
    const onData = chunk => {
      text += chunk;
      if (pattern.test(text)) { cleanup(); resolve(); }
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

// 假 worker：argv = [node, 本脚本, mode, ...]——mode 是 argv[2]（supervisor 传的 worker 名是
// run_ocr.py 的第一个参数；假 python=node 会把 scriptPath 当自己的 argv[1]）。
// 行为：报告 PID 后常驻；进程被外部杀掉即退出（exit 非 0），由托管器负责重启。
function writeFakeWorker(dir) {
  const p = path.join(dir, 'fake-worker.cjs');
  fs.writeFileSync(p, `const pid = process.pid;
console.log('WORKER', process.argv[2] || '?', pid);
setInterval(() => {}, 1000);`);
  return p;
}

// 假 python：node.exe 拷贝改名到 <runtimeDir>/python/python.exe（resolveRuntime 的捆绑布局）。
// supervisor 调用形如 python.exe <scriptPath> hp|econ --host ...，node 把 scriptPath
// 当自己的入口脚本执行，argv[2]=worker 名。
function writeFakePython(dir) {
  const p = path.join(dir, 'python.exe');
  fs.copyFileSync(process.execPath, p);
  return p;
}

test('ocr 托管 e2e：自动拉起 worker、崩溃重启、退出回收', { timeout: 60000 }, async () => {
  const rtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-e2e-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-data-'));
  fs.writeFileSync(path.join(rtDir, 'run_ocr.py'), '');
  fs.mkdirSync(path.join(rtDir, 'python'), { recursive: true });
  writeFakePython(path.join(rtDir, 'python'));
  const workerScript = writeFakeWorker(rtDir);
  const apiPort = await allocatePort();

  const app = { child: spawn(process.execPath, [path.join(__dirname, '..', 'src', 'main.js')], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(apiPort),
      LIVE_CLIENT_URL: 'http://127.0.0.1:1',
      RIOT_LCU_PORT: '9',
      RIOT_REMOTING_AUTH_TOKEN: '',
      RIOT_CLIENT_COMMAND_LINE: '',
      RIOT_LOCKFILE: '',
      RB_OCR_SUPERVISE: '1',
      RB_OCR_RUNTIME_DIR: rtDir,
      RB_OCR_SCRIPT: workerScript,
      RB_DATA_DIR: dataDir
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  }) };
  app.child.stdout.on('data', () => {});
  app.child.stderr.on('data', () => {});

  try {
    await waitForOutput(app, /Khada Jhin running at/);

    // 1) 托管启动：两个 worker 有 pid，状态出现在 /api/state
    const started = await waitFor('两个 worker 上报 pid', async () => {
      const { body } = await getJson(apiPort, '/api/state');
      const sup = body.ocrSupervisor;
      if (sup && sup.enabled && sup.workers.hp && sup.workers.hp.pid && sup.workers.econ && sup.workers.econ.pid) return sup;
      return null;
    });
    assert.equal(started.runtime, 'bundled');
    const firstHpPid = started.workers.hp.pid;
    const firstEconPid = started.workers.econ.pid;
    assert.notEqual(firstHpPid, firstEconPid);

    // 2) worker 崩溃 → 指数退避后重启，restarts 递增、pid 更新
    try { process.kill(firstHpPid); } catch { /* 已退出 */ }
    const restarted = await waitFor('hp worker 崩溃后重启', async () => {
      const { body } = await getJson(apiPort, '/api/state');
      const w = body.ocrSupervisor.workers.hp;
      if (w.restarts >= 1 && w.pid && w.pid !== firstHpPid) return w;
      return null;
    }, 30000);
    assert.ok(restarted.pid, '重启后应有新 pid');

    // 3) 服务退出 → worker 被一并回收
    await stopRun(app);
    await waitFor('econ worker 随服务退出', async () => {
      try { process.kill(firstEconPid, 0); return false; } catch { return true; }
    }, 8000);
  } finally {
    await stopRun(app).catch(() => {});
    fs.rmSync(rtDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
