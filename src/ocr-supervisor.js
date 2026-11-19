'use strict';

// 采集脚本托管（hp_bars / econ_ocr）：由本服务拉起两个 Python worker，
// 崩溃按指数退避自动重启，进程退出时一并结束。数据链路不变——worker
// 仍以 HTTP POST /api/pixel-bars 与 /api/econ-ocr 推送读数。
//
// 运行时解析顺序：
//   1. RB_OCR_RUNTIME_DIR 环境变量指定的捆绑运行时（安装包 resources/ocr）
//   2. 安装目录同级 resources/ocr（src/main.js 位于 resources/app/src）
//   3. 仓库 build/ocr-runtime（开发机构建产物）
//   4. 系统 Python + tools/ocr/run_ocr.py（开发机兜底）
// 只有 RB_OCR_SUPERVISE=1 时才实际拉起 worker（Electron 壳注入）；
// 开发/测试直跑 node src/main.js 默认关闭，避免与手动脚本、测试假服务互扰。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKERS = [
  { name: 'hp', hz: 10 },
  { name: 'econ', hz: 1 }
];
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;

function parseObsEndpoint(obsConfig) {
  let host = '127.0.0.1';
  let port = 4455;
  const raw = String((obsConfig && obsConfig.url) || '').trim();
  try {
    const parsed = new URL(raw);
    if (parsed.hostname) host = parsed.hostname;
    if (parsed.port) port = Number(parsed.port);
  } catch { /* 地址非法时保持默认 */ }
  return { host, port: Number.isFinite(port) && port > 0 ? port : 4455 };
}

function buildWorkerArgs(worker, endpoint, obsConfig, apiPort) {
  return [
    '--host', endpoint.host,
    '--port-obs', String(endpoint.port),
    '--password', String((obsConfig && obsConfig.password) || ''),
    '--port-api', String(apiPort),
    '--hz', String(worker.hz)
  ];
}

function resolveRuntime(appRoot, env) {
  const scriptOverride = env.RB_OCR_SCRIPT || '';
  const dirs = [];
  if (env.RB_OCR_RUNTIME_DIR) dirs.push(env.RB_OCR_RUNTIME_DIR);
  dirs.push(path.join(appRoot, '..', 'ocr'));            // 安装版：resources/ocr
  dirs.push(path.join(appRoot, 'build', 'ocr-runtime')); // 开发机：仓库 build/ocr-runtime
  for (const dir of dirs) {
    if (!dir) continue;
    const pythonExe = path.join(dir, 'python', 'python.exe');
    const scriptPath = scriptOverride || path.join(dir, 'run_ocr.py');
    try {
      if (fs.existsSync(pythonExe) && fs.existsSync(scriptPath)) {
        return { kind: 'bundled', pythonExe, scriptPath, runtimeDir: dir };
      }
    } catch { /* 探测失败换下一个候选 */ }
  }
  // 系统 Python 兜底：只在显式开启托管时有意义（开发机）。
  const pythonExe = env.RB_OCR_PYTHON || 'python.exe';
  const scriptPath = scriptOverride || path.join(appRoot, 'tools', 'ocr', 'run_ocr.py');
  try {
    if (fs.existsSync(scriptPath)) return { kind: 'system', pythonExe, scriptPath, runtimeDir: null };
  } catch { /* fallthrough */ }
  return null;
}

function createOcrSupervisor({ state, port, getObsConfig, broadcast = () => {}, dataDir, appRoot = path.join(__dirname, '..'), env = process.env }) {
  const enabled = env.RB_OCR_SUPERVISE === '1';
  const runtime = resolveRuntime(appRoot, env);
  const calibDir = dataDir ? path.join(dataDir, 'ocr-calib') : null;
  const workers = new Map(WORKERS.map(def => [def.name, {
    def, child: null, timer: null, restarts: 0, lastExitAt: null, lastCode: null, stopping: false
  }]));

  function refreshStatus() {
    const snapshot = {
      enabled,
      runtime: runtime ? runtime.kind : null,
      runtimeDir: runtime ? runtime.runtimeDir : null,
      reason: runtime ? null : 'no-runtime',
      workers: {}
    };
    for (const [name, w] of workers) {
      snapshot.workers[name] = {
        pid: w.child && w.child.pid ? w.child.pid : null,
        running: Boolean(w.child && !w.stopping),
        restarts: w.restarts,
        lastExitAt: w.lastExitAt,
        lastExitCode: w.lastCode
      };
    }
    state.ocrSupervisor = snapshot;
    broadcast();
  }

  function logLine(name, chunk) {
    const text = String(chunk).replace(/\s+/g, ' ').trim();
    if (text) console.log('[ocr:' + name + ']', text.slice(0, 500));
  }

  function spawnWorker(w) {
    if (w.stopping || !runtime) return;
    const obsConfig = getObsConfig ? getObsConfig() : null;
    const args = [runtime.scriptPath, w.def.name, ...buildWorkerArgs(w.def, parseObsEndpoint(obsConfig), obsConfig, port)];
    let child;
    try {
      child = spawn(runtime.pythonExe, args, {
        cwd: runtime.runtimeDir || path.dirname(runtime.scriptPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          ...(calibDir ? { RB_PIXEL_CALIB_DIR: calibDir } : {})
        }
      });
    } catch (error) {
      console.error('[ocr:' + w.def.name + '] 启动失败:', error.message);
      w.lastCode = 'spawn-error';
      scheduleRestart(w);
      return;
    }
    w.child = child;
    child.stdout.on('data', chunk => logLine(w.def.name, chunk));
    child.stderr.on('data', chunk => logLine(w.def.name, chunk));
    child.on('error', error => console.error('[ocr:' + w.def.name + '] 进程错误:', error.message));
    child.on('exit', (code, signal) => {
      if (w.child === child) w.child = null;
      w.lastExitAt = Date.now();
      w.lastCode = code == null ? String(signal) : code;
      refreshStatus();
      if (!w.stopping) scheduleRestart(w);
    });
    refreshStatus();
  }

  function scheduleRestart(w) {
    if (w.stopping || w.timer || !runtime) return;
    // 指数退避封顶 30s：OBS 未开时 worker 连不上就退出，靠这轮询等 OBS 出现。
    const delay = Math.min(RESTART_BASE_MS * (2 ** Math.min(w.restarts, 10)), RESTART_MAX_MS);
    w.restarts += 1;
    console.log('[ocr:' + w.def.name + '] 退出 code=' + w.lastCode + '，' + delay + 'ms 后第 ' + w.restarts + ' 次重启');
    w.timer = setTimeout(() => { w.timer = null; spawnWorker(w); }, delay);
    if (typeof w.timer.unref === 'function') w.timer.unref();
  }

  function start() {
    // 延后到模块加载完再动手：main.js 在模块顶层调用 start()，此时 broadcast()
    // 还不能安全调用（其依赖的状态/引擎在后面才初始化）。
    setImmediate(runStart);
  }

  function runStart() {
    if (!enabled || !runtime) {
      state.ocrSupervisor = {
        enabled: false,
        runtime: runtime ? runtime.kind : null,
        reason: !runtime ? 'no-runtime' : 'disabled',
        workers: {}
      };
      broadcast();
      return;
    }
    try { if (calibDir) fs.mkdirSync(calibDir, { recursive: true }); } catch { /* 写不进就让脚本自己兜底 */ }
    for (const [, w] of workers) spawnWorker(w);
    console.log('[ocr] 采集脚本托管已启动（' + runtime.kind + '）：hp + econ → POST /api/pixel-bars、/api/econ-ocr');
  }

  function stopAll() {
    for (const [, w] of workers) {
      w.stopping = true;
      if (w.timer) { clearTimeout(w.timer); w.timer = null; }
      if (w.child && w.child.pid) {
        try { w.child.kill(); } catch { /* 退出路径尽力而为 */ }
      }
    }
  }

  return { start, stopAll, runtime };
}

module.exports = { createOcrSupervisor, parseObsEndpoint, buildWorkerArgs, resolveRuntime, WORKERS, RESTART_BASE_MS, RESTART_MAX_MS };
