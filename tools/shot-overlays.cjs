#!/usr/bin/env node
'use strict';

/**
 * RiftBroadcast 视觉验收截图工具（零新增依赖）
 *
 * 用法：
 *   node tools/shot-overlays.cjs --base-url http://127.0.0.1:3210 --out .tmp/shots
 *   node tools/shot-overlays.cjs --phase in_game --width 1920 --height 1080
 *
 * 也可以使用：npm run shot -- --base-url http://127.0.0.1:3211
 *
 * 说明：
 * - 本脚本本身用 node 启动，会通过 child_process 调起项目内 electron。
 * - 部分终端环境会设置 ELECTRON_RUN_AS_NODE=1，这会让 electron.exe 以 Node 模式运行，
 *   从而没有 BrowserWindow。脚本检测到该变量时会在子进程中清除它（等价于 env -u
 *   ELECTRON_RUN_AS_NODE）后重新 spawn 自身。
 * - 不读取游戏内存、不注入、不依赖 LCU token。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const PAGES = [
  { name: 'console', route: '/', file: 'console.png' },
  { name: 'overlay-bp', route: '/overlay/bp', file: 'overlay-bp.png' },
  { name: 'overlay-ingame-top', route: '/overlay/ingame-top', file: 'overlay-ingame-top.png' },
  { name: 'overlay-ingame-bottom', route: '/overlay/ingame-bottom', file: 'overlay-ingame-bottom.png' },
  { name: 'overlay-postgame', route: '/overlay/postgame', file: 'overlay-postgame.png' },
  { name: 'broadcast-bp', route: '/broadcast/bp', file: 'broadcast-bp.png', optional: true },
  { name: 'broadcast-hud', route: '/broadcast/hud', file: 'broadcast-hud.png', optional: true },
  { name: 'broadcast-result', route: '/broadcast/result', file: 'broadcast-result.png', optional: true }
];

const PHASES = ['draft', 'in_game', 'post_game'];

function routeToKey(route) {
  if (route === '/') return 'console';
  const key = route.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return key || 'page';
}

function buildPageList(rawPages) {
  if (!rawPages) return PAGES.map(page => ({ ...page }));
  const routes = rawPages.split(',').map(route => route.trim()).filter(Boolean);
  if (!routes.length) throw new Error('--pages 不能为空');
  const seen = new Set();
  return routes.map(route => {
    const normalized = (route.startsWith('/') ? route : '/' + route).replace(/\/+$/, '') || '/';
    const known = PAGES.find(page => page.route === normalized);
    if (known) return { ...known };
    const name = routeToKey(normalized);
    return { name, route: normalized, file: name + '.png' };
  }).filter(page => {
    if (seen.has(page.route)) return false;
    seen.add(page.route);
    return true;
  });
}

function debugLog(message) {
  if (!process.env.RIFTBRIDGE_SHOT_DEBUG) return;
  try {
    const dir = path.resolve(process.cwd(), '.tmp');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'shot-debug.log'), new Date().toISOString() + ' [' + (process.versions.electron ? 'electron' : 'node') + '] ' + message + '\n');
  } catch { /* 调试日志失败不影响主流程 */ }
}

function usage() {
  return [
    'RiftBroadcast 视觉验收截图工具',
    '',
    '选项：',
    '  --base-url <url>   服务地址（默认 http://127.0.0.1:3210）',
    '  --out <dir>        输出目录（默认 .tmp/shots）',
    '  --phase <phase>    截图前先 POST /api/phase，可选 draft|in_game|post_game',
    '  --width <px>       视口宽度（默认 1920）',
    '  --height <px>      视口高度（默认按 16:9 从宽度计算；1920 宽时为 1080）',
    '  --pages <routes>   逗号分隔的页面清单，覆盖默认值（如 /overlay/bp,/broadcast/bp）',
    '  --help             显示本帮助',
    '',
    '输出：PNG + manifest.json（每页 URL、标题、状态、大小、耗时；未实现的广播页记为 skipped）。',
    '任何页面重试 3 次仍失败时退出码为 1。'
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    baseUrl: 'http://127.0.0.1:3210',
    out: '.tmp/shots',
    phase: '',
    pages: '',
    width: 1920,
    height: 1080,
    help: false
  };
  let heightSpecified = false;

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    let key = raw;
    let inline;
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      key = raw.slice(0, eq);
      inline = raw.slice(eq + 1);
    }
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      return argv[i];
    };

    switch (key) {
      case '--base-url': opts.baseUrl = String(value() || ''); break;
      case '--out': opts.out = String(value() || ''); break;
      case '--phase': opts.phase = String(value() || ''); break;
      case '--pages': opts.pages = String(value() || ''); break;
      case '--width': opts.width = Number(value()); break;
      case '--height': opts.height = Number(value()); heightSpecified = true; break;
      case '--help':
      case '-h': opts.help = true; break;
      default:
        throw new Error('未知参数: ' + raw);
    }
  }

  if (!opts.baseUrl) throw new Error('--base-url 不能为空');
  let parsed;
  try {
    parsed = new URL(opts.baseUrl);
  } catch {
    throw new Error('--base-url 不是合法 URL: ' + opts.baseUrl);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('--base-url 只支持 http/https: ' + opts.baseUrl);
  }
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  if (opts.phase && !PHASES.includes(opts.phase)) {
    throw new Error('--phase 必须是 draft、in_game 或 post_game');
  }
  if (!heightSpecified) {
    // 只传 --width 时保持默认 16:9 视口比例（--width 1280 -> 1280x720）。
    opts.height = Math.round(opts.width * 9 / 16);
  }
  if (!Number.isInteger(opts.width) || opts.width < 1 || !Number.isInteger(opts.height) || opts.height < 1) {
    throw new Error('--width/--height 必须是正整数');
  }
  if (!opts.out) throw new Error('--out 不能为空');
  opts.outDir = path.resolve(process.cwd(), opts.out);
  opts.pageList = buildPageList(opts.pages);
  return opts;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' 超时 (' + ms + 'ms)')), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

function requestStatus(target, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method: 'GET', timeout }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode || 0));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function requestJson(target, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const transport = url.protocol === 'https:' ? https : http;
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = transport.request(url, {
      method: options.method || 'GET',
      timeout: options.timeout || 10000,
      headers: body
        ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length }
        : {}
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { /* 非 JSON 响应保留原文 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + raw.slice(0, 300)));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function electronExecutable() {
  const dist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
  const candidates = process.platform === 'win32'
    ? [path.join(dist, 'electron.exe')]
    : [path.join(dist, 'electron'), path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error('找不到项目内 Electron：' + candidates.join(' 或 '));
  }
  return found;
}

function respawnUnderElectron(argv) {
  const executable = electronExecutable();
  const childEnv = { ...process.env };
  const hadRunAsNode = Object.prototype.hasOwnProperty.call(childEnv, 'ELECTRON_RUN_AS_NODE');
  // env -u 的跨平台等价实现：从子进程环境中彻底移除该变量。
  delete childEnv.ELECTRON_RUN_AS_NODE;

  // `--` 终止 Electron/Chromium 的参数解析，后面全部原样交给应用。
  const childArgs = [__filename, '--', ...argv];
  let command = executable;
  let commandArgs = childArgs;

  // POSIX 上优先使用 env -u，和需求保持一致；Windows 没有标准 env 命令时使用清理后的环境。
  if (hadRunAsNode && process.platform !== 'win32') {
    command = 'env';
    commandArgs = ['-u', 'ELECTRON_RUN_AS_NODE', executable, ...childArgs];
  }

  console.log('[shot] 以 Electron 模式重新启动截图进程（ELECTRON_RUN_AS_NODE 已清除）');
  debugLog('respawning executable=' + executable + ' args=' + JSON.stringify(childArgs));
  const child = spawn(command, commandArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
    windowsHide: true
  });
  if (child.stdout) child.stdout.on('data', chunk => process.stdout.write(chunk));
  if (child.stderr) child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.on('error', error => {
    console.error('[shot] 启动 Electron 失败：' + error.message);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error('[shot] Electron 被信号终止：' + signal);
      process.exit(1);
    }
    process.exit(code === null ? 1 : code);
  });
}

function cliArgsFromProcess() {
  let args = process.argv.slice(2);
  // 跳过 Electron 的 `--` 分隔符，以及部分平台重复出现的脚本路径。
  if (args[0] === '--') args = args.slice(1);
  if (args.length && path.resolve(args[0]) === path.resolve(__filename)) args = args.slice(1);
  return args;
}

function writeManifest(opts, pages, extra = {}) {
  const manifest = {
    ok: false,
    generatedAt: new Date().toISOString(),
    baseUrl: opts.baseUrl,
    outDir: opts.outDir,
    phase: opts.phase || null,
    viewport: { width: opts.width, height: opts.height },
    pages,
    ...extra
  };
  if (!manifest.summary) {
    const skipped = pages.filter(page => page.skipped).length;
    const failed = pages.filter(page => !page.ok && !page.skipped).length;
    manifest.summary = { total: pages.length, succeeded: pages.length - skipped - failed, skipped, failed };
  }
  if (!Array.isArray(manifest.skipped)) {
    manifest.skipped = pages.filter(page => page.skipped).map(page => page.page);
  }
  const expectedTotal = Array.isArray(opts.pageList) ? opts.pageList.length : pages.length;
  manifest.ok = manifest.summary.failed === 0 && manifest.summary.total === expectedTotal;
  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(path.join(opts.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

async function captureAttempt(BrowserWindow, page, opts) {
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  try {
    win.setMenuBarVisibility(false);
    // Windows 会把 BrowserWindow 的初始宽度限制在屏幕工作区内；创建后显式设置内容尺寸，
    // 让离屏页面按请求的完整视口布局，而不是被系统压成 1600px 宽。
    win.setContentSize(opts.width, opts.height);
    const contentSize = win.getContentSize();
    if (contentSize[0] !== opts.width || contentSize[1] !== opts.height) {
      throw new Error('无法设置截图视口：期望 ' + opts.width + 'x' + opts.height +
        '，实际 ' + contentSize[0] + 'x' + contentSize[1]);
    }
    const target = opts.baseUrl + page.route;
    const status = await requestStatus(target, 10000);
    if (status < 200 || status >= 300) {
      const error = new Error('HTTP ' + status + ' loading ' + page.route);
      error.httpStatus = status;
      throw error;
    }
    await withTimeout(win.loadURL(target), 20000, '加载 ' + page.route);
    // 图片、字体、EventSource 首帧都需要时间，按要求固定等待 1.5 秒。
    await wait(1500);
    const image = await withTimeout(win.webContents.capturePage(), 15000, '截图 ' + page.route);
    const size = image.getSize();
    if (size.width !== opts.width || size.height !== opts.height) {
      throw new Error('截图尺寸不符：期望 ' + opts.width + 'x' + opts.height +
        '，实际 ' + size.width + 'x' + size.height);
    }
    const png = image.toPNG();
    if (!png || png.length === 0) throw new Error('capturePage 返回空图片');
    const filePath = path.join(opts.outDir, page.file);
    fs.writeFileSync(filePath, png);
    return { url: target, title: win.getTitle() || '', width: size.width, height: size.height, bytes: png.length };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function captureWithRetry(BrowserWindow, page, opts) {
  const startedAt = Date.now();
  const target = opts.baseUrl + page.route;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await captureAttempt(BrowserWindow, page, opts);
      return {
        page: page.route,
        url: result.url || target,
        name: page.name,
        file: page.file,
        title: result.title || '',
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        durationMs: Date.now() - startedAt,
        attempts: attempt,
        ok: true,
        skipped: false,
        status: 'ok'
      };
    } catch (error) {
      lastError = error;
      if (page.optional && error.httpStatus === 404) {
        return {
          page: page.route,
          url: target,
          name: page.name,
          file: page.file,
          title: null,
          width: opts.width,
          height: opts.height,
          bytes: 0,
          durationMs: Date.now() - startedAt,
          attempts: attempt,
          ok: false,
          skipped: true,
          status: 'skipped',
          error: '页面未实现（HTTP 404），已跳过'
        };
      }
      console.error('[shot] ' + page.route + ' 第 ' + attempt + '/3 次失败：' + error.message);
      if (attempt < 3) await wait(400);
    }
  }
  return {
    page: page.route,
    url: target,
    name: page.name,
    file: page.file,
    title: null,
    width: opts.width,
    height: opts.height,
    bytes: 0,
    durationMs: Date.now() - startedAt,
    attempts: 3,
    ok: false,
    skipped: false,
    status: 'failed',
    error: lastError ? lastError.message : '未知错误'
  };
}

async function run(BrowserWindow) {
  const opts = parseArgs(cliArgsFromProcess());
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const startedAt = Date.now();
  console.log('[shot] base=' + opts.baseUrl + ' out=' + opts.outDir + ' viewport=' + opts.width + 'x' + opts.height +
    (opts.phase ? ' phase=' + opts.phase : ''));

  try {
    await requestJson(opts.baseUrl + '/health', { timeout: 10000 });
  } catch (error) {
    const pages = opts.pageList.map(page => ({
      page: page.route, url: opts.baseUrl + page.route, name: page.name, file: page.file, title: null,
      width: opts.width, height: opts.height, bytes: 0, durationMs: 0, attempts: 0, ok: false,
      skipped: false, status: 'failed', error: '服务不可用：' + error.message
    }));
    writeManifest(opts, pages, {
      summary: { total: pages.length, succeeded: 0, skipped: 0, failed: pages.length },
      totalDurationMs: Date.now() - startedAt,
      error: '无法连接 ' + opts.baseUrl + '：' + error.message
    });
    console.error('[shot] 无法连接服务 ' + opts.baseUrl + '：' + error.message);
    return 1;
  }

  if (opts.phase) {
    try {
      const result = await requestJson(opts.baseUrl + '/api/phase', {
        method: 'POST',
        body: { phase: opts.phase },
        timeout: 10000
      });
      console.log('[shot] 已切换阶段：' + (result && result.phase ? result.phase : opts.phase));
    } catch (error) {
      const pages = opts.pageList.map(page => ({
        page: page.route, url: opts.baseUrl + page.route, name: page.name, file: page.file, title: null,
        width: opts.width, height: opts.height, bytes: 0, durationMs: 0, attempts: 0, ok: false,
        skipped: false, status: 'failed', error: '切换阶段失败：' + error.message
      }));
      writeManifest(opts, pages, {
        summary: { total: pages.length, succeeded: 0, skipped: 0, failed: pages.length },
        totalDurationMs: Date.now() - startedAt,
        error: '切换阶段失败：' + error.message
      });
      console.error('[shot] 切换阶段失败：' + error.message);
      return 1;
    }
  }

  const pages = [];
  for (const page of opts.pageList) {
    console.log('[shot] 截取 ' + page.route + ' ...');
    const result = await captureWithRetry(BrowserWindow, page, opts);
    pages.push(result);
    if (result.ok) {
      console.log('[shot] ✓ ' + page.route + ' -> ' + page.file + ' (' + result.width + 'x' + result.height +
        ', ' + result.bytes + ' bytes, ' + result.durationMs + 'ms, ' + result.attempts + ' 次尝试)');
    } else if (result.skipped) {
      console.log('[shot] - ' + page.route + ' skipped：' + result.error);
    } else {
      console.error('[shot] ✗ ' + page.route + '：' + result.error);
    }
  }

  const manifest = writeManifest(opts, pages, { totalDurationMs: Date.now() - startedAt });
  const requiredTotal = manifest.summary.total - manifest.summary.skipped;
  console.log('[shot] 完成：' + manifest.summary.succeeded + '/' + requiredTotal + ' 成功' +
    (manifest.summary.skipped ? '，' + manifest.summary.skipped + ' 个页面 skipped' : '') +
    '，manifest=' + path.join(opts.outDir, 'manifest.json'));
  return manifest.ok ? 0 : 1;
}

function startElectronApp() {
  debugLog('startElectronApp enter argv=' + JSON.stringify(process.argv));
  const { app, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  // 每个页面截完都会销毁 BrowserWindow；阻止 Electron 因窗口全部关闭而自动退出。
  app.on('window-all-closed', () => { /* 由 run() 结束时统一 app.exit() */ });

  app.whenReady().then(async () => {
    debugLog('app ready');
    let code = 1;
    try {
      code = await run(BrowserWindow);
    } catch (error) {
      console.error('[shot] 未捕获错误：' + (error && error.stack ? error.stack : error));
      const opts = {
        baseUrl: 'http://127.0.0.1:3210', outDir: path.resolve(process.cwd(), '.tmp/shots'),
        phase: '', pages: '', pageList: PAGES, width: 1920, height: 1080
      };
      try {
        writeManifest(opts, [], {
          summary: { total: 0, succeeded: 0, skipped: 0, failed: PAGES.length },
          error: String(error && error.message ? error.message : error)
        });
      } catch { /* 忽略二次错误 */ }
    }
    app.exit(code);
  }).catch(error => {
    console.error('[shot] Electron 启动失败：' + (error && error.stack ? error.stack : error));
    app.exit(1);
  });
}

debugLog('module loaded versions.electron=' + Boolean(process.versions.electron) + ' argv=' + JSON.stringify(process.argv));
if (!process.versions.electron) {
  try {
    respawnUnderElectron(cliArgsFromProcess());
  } catch (error) {
    console.error('[shot] ' + error.message);
    process.exit(1);
  }
} else {
  startElectronApp();
}
