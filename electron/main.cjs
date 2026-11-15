'use strict';

// Khada Jhin Electron 主进程。
// 职责：
// 1. 端口选择：默认从 3210 开始，被占用时自动 +1（最多尝试 50 个），窗口加载实际端口；
// 2. 以子进程方式托管本地 HTTP 服务（打包后同样可用）；
// 3. 单实例锁：重复启动时唤起已有窗口；
// 4. 系统托盘：打开控台 / 退出；关闭窗口只隐藏到托盘，不结束进程；
// 5. RIFTBRIDGE_SMOKE=1 时执行可自动断言的开机自检（CI / 打包验收用）。

const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const APP_ID = 'com.khadjhin.mvp';
const DEFAULT_PORT = 3210;
const PORT_SCAN_LIMIT = 50;
const SERVER_READY_TIMEOUT = 20000;
const SERVER_RESTART_MAX_ATTEMPTS = 5;
const SERVER_RESTART_BASE_MS = 500;
const SERVER_RESTART_MAX_MS = 15000;
const SMOKE = process.env.RIFTBRIDGE_SMOKE === '1';
const SMOKE_REPORT = process.env.RIFTBRIDGE_SMOKE_REPORT || '';

// Khada Jhin 应用图标（public/app-icon.png），同时用于窗口与托盘。
let mainWindow = null;
let tray = null;
let trayMenu = null;
let serverProcess = null;
let serverPort = null;
let dataRoot = null;
let serverRestartTimer = null;
let serverRestartAttempts = 0;
let lastServiceEvent = null;
let isQuitting = false;
let trayNoticeShown = false;

function log(...args) {
  console.log('[Khada Jhin]', ...args);
}

function report(line) {
  const message = `[SMOKE] ${line}`;
  console.log(message);
  if (SMOKE_REPORT) {
    try { fs.appendFileSync(SMOKE_REPORT, message + '\n', 'utf8'); } catch (error) { console.error('[SMOKE] report-write-failed', error.message); }
  }
}

function serverUrl() {
  return `http://127.0.0.1:${serverPort}/`;
}

// 用临时监听探测端口是否可用；只有 listen 成功才算空闲。
function probePort(port) {
  return new Promise(resolve => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', () => resolve(false));
    tester.listen(port, '127.0.0.1', () => tester.close(() => resolve(true)));
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + PORT_SCAN_LIMIT; port += 1) {
    if (await probePort(port)) return port;
  }
  throw new Error(`在 ${startPort}-${startPort + PORT_SCAN_LIMIT - 1} 范围内找不到可用端口`);
}

function dispatchServiceEvent(eventName, detail) {
  lastServiceEvent = eventName === 'service-down' ? { eventName, detail } : null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  try { contents.send(eventName, detail); } catch (error) { log('service-event-send 失败:', error.message); }
  const script = "window.dispatchEvent(new CustomEvent('riftbroadcast:" + eventName + "', { detail: " + JSON.stringify(detail) + " }));";
  contents.executeJavaScript(script, true).catch(() => {});
}
// 配置目录：打包安装目录通常不可写，统一迁到 userData；旧版本写在安装目录的 config/*.json、data/*.json 一次性搬过来（目标已存在则跳过）。
function prepareDataDir() {
  const root = app.getPath('userData');
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  try { fs.mkdirSync(configDir, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true }); } catch (error) { log('创建 userData 目录失败:', error.message); return root; }
  const legacyRoot = app.getAppPath();
  const moves = [[path.join(legacyRoot, 'config'), configDir], [path.join(legacyRoot, 'data'), dataDir]];
  for (const [srcDir, destDir] of moves) {
    let names = [];
    try { names = fs.readdirSync(srcDir).filter(name => name.endsWith('.json')); } catch { names = []; }
    for (const name of names) {
      const dest = path.join(destDir, name);
      if (fs.existsSync(dest)) continue;
      try { fs.copyFileSync(path.join(srcDir, name), dest); log('迁移配置:', name, '→', dest); } catch (error) { log('迁移配置失败:', name, error.message); }
    }
  }
  return root;
}

// 子进程日志落盘（此前 stdio:'ignore' 吞掉了全部诊断输出）；超过 1MB 滚动一代。
function openServiceLog() {
  try {
    const logDir = path.join(dataRoot, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'service.log');
    try { if (fs.statSync(logPath).size > 1024 * 1024) fs.renameSync(logPath, path.join(logDir, 'service.prev.log')); } catch {}
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    stream.on('error', () => {});
    return stream;
  } catch { return null; }
}

// 崩溃重启时重扫端口：原端口被残留进程占住（EADDRINUSE 反复失败的根因）时顺延到下一个空闲端口，并让窗口跟随新端口。
async function restartAfterPortCheck() {
  const preferred = serverPort;
  let port = preferred;
  if (!(await probePort(preferred))) {
    try { port = await findAvailablePort(preferred); } catch (error) { log('重扫端口失败:', error.message); port = preferred; }
  }
  if (port !== preferred) {
    log('端口 ' + preferred + ' 被残留进程占用，本地服务改用 ' + port);
    serverPort = port;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(serverUrl()).catch(() => {});
  }
  startLocalServer(port);
}

function scheduleServerRestart(reason) {
  if (isQuitting || serverRestartTimer) return;
  if (serverRestartAttempts >= SERVER_RESTART_MAX_ATTEMPTS) {
    dispatchServiceEvent('service-down', {
      retryable: false,
      attempt: serverRestartAttempts,
      message: '本地服务连续启动失败（已重试 5 次），请重启 Khada Jhin。'
    });
    return;
  }
  const delayMs = Math.min(SERVER_RESTART_BASE_MS * (2 ** serverRestartAttempts), SERVER_RESTART_MAX_MS);
  serverRestartAttempts += 1;
  dispatchServiceEvent('service-down', {
    retryable: true,
    attempt: serverRestartAttempts,
    delayMs,
    message: '本地服务已断开（' + reason + '），正在第 ' + serverRestartAttempts + ' 次重连…'
  });
  log('本地服务异常，' + delayMs + 'ms 后第 ' + serverRestartAttempts + ' 次重启');
  serverRestartTimer = setTimeout(() => {
    serverRestartTimer = null;
    if (isQuitting) return;
    restartAfterPortCheck();
  }, delayMs);
  if (typeof serverRestartTimer.unref === 'function') serverRestartTimer.unref();
}
function startLocalServer(port) {
  const appRoot = path.join(__dirname, '..');
  // 打包后 process.execPath 指向 Khada Jhin.exe；不注入 ELECTRON_RUN_AS_NODE 会再开一个窗口而不是跑 Node 服务。
  const logStream = openServiceLog();
  const child = spawn(process.execPath, [path.join(appRoot, 'src', 'main.js')], {
    cwd: appRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), ...(dataRoot ? { RB_DATA_DIR: dataRoot } : {}) }
  });
  if (logStream) {
    child.stdout.on('data', chunk => logStream.write(chunk));
    child.stderr.on('data', chunk => logStream.write('[stderr] ' + chunk));
    child.on('exit', () => logStream.end());
  }
  serverProcess = child;
  child.on('error', error => {
    log('本地服务进程启动失败:', error.message);
    if (!isQuitting && serverProcess === child) scheduleServerRestart('启动失败');
  });
  child.on('exit', (code, signal) => {
    if (isQuitting) return;
    log(`本地服务进程退出 code=${code} signal=${signal}`);
    if (serverProcess === child) { serverProcess = null; scheduleServerRestart('进程退出'); }
  });
  waitForServer(port, SERVER_READY_TIMEOUT).then(ready => {
    if (!ready || isQuitting || serverProcess !== child) return;
    serverRestartAttempts = 0;
    dispatchServiceEvent('service-up', { retryable: false, message: '本地服务已恢复' });
  }).catch(() => {});
}

function stopLocalServer() {
  const child = serverProcess;
  serverProcess = null;
  if (!child || child.pid == null) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = reason => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reason);
    };
    // taskkill 的 close/error 才是可靠完成信号；超时兜底只记录日志，不能卡住退出。
    const timer = setTimeout(() => {
      log('结束本地服务超时，继续退出');
      finish('timeout');
    }, 3000);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      if (process.platform === 'win32') {
        // /t 一并结束可能的子进程，避免退出 Electron 后端口仍被占用。
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', error => { log('taskkill 失败:', error.message); try { child.kill(); } catch {} finish('error'); });
        killer.once('close', code => finish('closed:' + code));
      } else {
        child.once('exit', () => finish('exit'));
        child.kill();
      }
    } catch (error) {
      log('结束本地服务失败:', error.message);
      try { child.kill(); } catch {}
      finish('error');
    }
  });
}

let shutdownPromise = null;
let shutdownComplete = false;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  if (serverRestartTimer) { clearTimeout(serverRestartTimer); serverRestartTimer = null; }
  shutdownPromise = stopLocalServer()
    .catch(error => log('结束本地服务异常:', error.message))
    .then(() => { shutdownComplete = true; app.exit(0); });
  return shutdownPromise;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function checkHealth(port) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth(port)) return true;
    await sleep(200);
  }
  return false;
}

function createWindow(url) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: '#050608',
    title: 'Khada Jhin 导播控台',
    icon: path.join(__dirname, '..', 'public', 'app-icon.png'),
    show: true,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(url);
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-fail-load', (event, code, description, validatedURL) => {
    log(`页面加载失败 code=${code} ${description} ${validatedURL}`);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (lastServiceEvent) dispatchServiceEvent(lastServiceEvent.eventName, lastServiceEvent.detail);
  });
  mainWindow.on('close', event => {
    // 关闭按钮只隐藏到托盘；真正退出走托盘菜单或 before-quit。
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (tray && process.platform === 'win32' && !trayNoticeShown) {
        trayNoticeShown = true;
        try {
          tray.displayBalloon({
            title: 'Khada Jhin',
            content: '程序已最小化到系统托盘，右键托盘图标可打开控台或退出。'
          });
        } catch (error) { /* 忽略不支持气泡提示的环境 */ }
      }
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (serverPort) createWindow(serverUrl());
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'public', 'app-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('Khada Jhin 导播控台');
  trayMenu = Menu.buildFromTemplate([
    { label: '打开控台', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() }
  ]);
  tray.setContextMenu(trayMenu);
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function runSmoke() {
  const finish = () => {
    isQuitting = true;
    app.quit();
  };
  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      report(`url=${mainWindow.webContents.getURL()}`);
      report(`title=${mainWindow.getTitle()}`);
      report(`port=${serverPort}`);
      report(`tray=${tray ? 'created' : 'missing'}`);
      report(`tray-menu=${trayMenu ? trayMenu.items.map(item => item.label).filter(Boolean).join('|') : 'missing'}`);
      const dom = await mainWindow.webContents.executeJavaScript(
        '({ readyState: document.readyState, hasBody: !!document.body, buttons: document.querySelectorAll("button").length })'
      );
      report(`dom=${JSON.stringify(dom)}`);
    } catch (error) {
      report(`dom-error=${error.message}`);
    }
    setTimeout(() => {
      mainWindow.close();
      setTimeout(() => {
        report(`close-to-tray destroyed=${mainWindow.isDestroyed()} visible=${mainWindow.isVisible()}`);
        finish();
      }, 500);
    }, 300);
  });
  mainWindow.webContents.once('did-fail-load', (event, code, description) => {
    report(`load-failed code=${code} ${description}`);
    finish();
  });
  setTimeout(() => {
    if (!isQuitting) {
      report('smoke-timeout');
      finish();
    }
  }, 30000);
}

async function bootstrap() {
  dataRoot = prepareDataDir();
  const preferred = Number(process.env.PORT || DEFAULT_PORT);
  const startPort = Number.isFinite(preferred) && preferred > 0 ? preferred : DEFAULT_PORT;
  serverPort = await findAvailablePort(startPort);
  log(`本地服务端口 ${serverPort}` + (serverPort === startPort ? '' : `（${startPort} 被占用，已自动顺延）`));
  startLocalServer(serverPort);
  const ready = await waitForServer(serverPort, SERVER_READY_TIMEOUT);
  if (!ready) {
    log('本地服务启动超时');
    if (!SMOKE) dialog.showErrorBox('Khada Jhin 启动失败', `本地服务未能在 ${SERVER_READY_TIMEOUT / 1000} 秒内启动，请检查端口 ${serverPort}。`);
  }
  try { createTray(); } catch (error) { log('托盘创建失败:', error.message); }
  createWindow(serverUrl());
  if (SMOKE) runSmoke();
}

app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  // 已有实例在运行：本进程直接退出，由已有实例接管。
  app.quit();
} else {
  app.on('second-instance', () => { if (app.isReady()) showMainWindow(); });
  app.whenReady().then(bootstrap).catch(error => {
    log('启动失败:', (error && error.stack) || error);
    if (!SMOKE) dialog.showErrorBox('Khada Jhin 启动失败', String((error && error.message) || error));
    app.quit();
  });
}

app.on('activate', () => showMainWindow());
// 托盘常驻：窗口全部关闭也不退出进程。
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (shutdownComplete) return;
  // 等 taskkill 真正结束再退出，避免 Electron 已退出但本地服务仍占用端口。
  event.preventDefault();
  isQuitting = true;
  shutdown();
});
app.on('will-quit', () => { if (!shutdownComplete) shutdown(); });
