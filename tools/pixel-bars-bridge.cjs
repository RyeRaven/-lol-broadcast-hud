#!/usr/bin/env node
'use strict';

// 像素读条桥（t23 建立 / t27 对接真实脚本）：把同机像素进程的读数转发给 RiftBroadcast 主进程。
//
// 为什么要有这一层：
//   像素读数必须由独立进程截屏（python + 图像处理），主进程只管 HTTP 与状态，绝不直接调 GDI；
//   两边用 NDJSON（每行一个 JSON）解耦，像素脚本怎么实现都行，只要按行吐数据。
//
// 三种驱动模式（--drive）：
//   scan   常驻脚本 + 按 --rate 向 stdin 写 'scan'（hp_bars.py 的常驻协议，默认）
//   none   脚本自己循环输出，桥只读 stdout
//   image  每轮跑一次 '脚本 --image <png>'（离线帧喂图，用来在没有对局时验证真链路）
//
// 用法：
//   node tools/pixel-bars-bridge.cjs --port 3210 --rate 5
//   node tools/pixel-bars-bridge.cjs --script C:/.../.tmp/spectator/pixel/hp_bars.py --python C:/.../python.exe
//   node tools/pixel-bars-bridge.cjs --drive image --image C:/Temp/spec1.png --rate 1
//
// 像素脚本输出（每行一个 JSON，三选一）：
//   {"seq":1,"ms":13.2,"bars":{...},"mana":{...},"detail":[{...}]}   // hp_bars.py 原生形态（side 是 L/R）
//   {"ts":1794509940336,"bars":[{...}]}                              // 完整包，原样转发
//   [{...},{...}]                                                    // 只有 bars 数组，桥自动包成 {ts,bars,source:'pixel'}
//
// 两条 t27 修掉的真差异：
//   1) hp_bars.py 的 side 是 'L'/'R'，主进程 /api/pixel-bars 只认 'blue'/'red' → 这里做归一化；
//   2) hp_bars.py 常驻模式是 stdin 命令协议（scan / bench N / geometry / quit），不认 --rate
//      → 这里按 --rate 周期性向 stdin 写 'scan'，逐行读 stdout（--drive none 可关闭）。
//
// 退出码：0 正常停止；2 像素脚本不存在（显式降级，绝不假装有数据）；其它为运行期失败。

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SCRIPT = path.join(ROOT, '.tmp', 'spectator', 'pixel', 'hp_bars.py');
const MIN_RATE = 1;
const MAX_RATE = 10;
const MAX_BACKOFF_MS = 15000;
const POST_TIMEOUT_MS = 1000;
const DRIVES = Object.freeze(['scan', 'none', 'image']);

// 像素脚本的 side 与主进程契约的映射。L/R 是观战 HUD 的左/右；观战界面左侧就是蓝方、
// 右侧就是红方，与 Live Client Data 的 team 顺序一致（这一点由 /events 的队伍顺序交叉验证）。
const SIDE_ALIASES = Object.freeze({
  L: 'blue', R: 'red',
  l: 'blue', r: 'red',
  left: 'blue', right: 'red',
  blue: 'blue', red: 'red'
});
const KIND_ALIASES = Object.freeze({
  hp: 'hp', health: 'hp',
  resource: 'resource', mana: 'resource', energy: 'resource'
});

function parseArgs(argv) {
  const options = {
    port: Number(process.env.PORT || 3210),
    rate: 5,
    script: process.env.PIXEL_BARS_SCRIPT || DEFAULT_SCRIPT,
    python: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    host: '127.0.0.1',
    geometry: process.env.LOL_PIXEL_GEOM || null,
    image: process.env.PIXEL_BARS_IMAGE || null,
    drive: process.env.PIXEL_BARS_IMAGE ? 'image' : 'scan',
    once: false,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i + 1];
    if (arg === '--port') { options.port = Number(next()); i += 1; }
    else if (arg === '--rate') { options.rate = Number(next()); i += 1; }
    else if (arg === '--script') { options.script = path.resolve(next()); i += 1; }
    else if (arg === '--python') { options.python = next(); i += 1; }
    else if (arg === '--host') { options.host = next(); i += 1; }
    else if (arg === '--geometry') { options.geometry = path.resolve(next()); i += 1; }
    else if (arg === '--image') { options.image = path.resolve(next()); options.drive = 'image'; i += 1; }
    else if (arg === '--drive') { options.drive = String(next()); i += 1; }
    else if (arg === '--once') options.once = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  if (!Number.isFinite(options.port) || options.port <= 0) throw new Error('--port 必须是正整数');
  // 1Hz~10Hz：低于 1Hz 血条会明显跳变，高于 10Hz 对 1Hz 刷新的 HUD 没有意义还浪费 CPU。
  if (!Number.isFinite(options.rate)) options.rate = 5;
  options.rate = Math.max(MIN_RATE, Math.min(MAX_RATE, options.rate));
  if (!DRIVES.includes(options.drive)) throw new Error('--drive 必须是 ' + DRIVES.join('/'));
  // 图像模式必须给图：否则每轮都会白跑一次 python。
  if (options.drive === 'image' && !options.image) throw new Error('--drive image 需要 --image <png>');
  return options;
}

function usage() {
  return [
    '用法: node tools/pixel-bars-bridge.cjs [选项]',
    '  --port <n>      RiftBroadcast 端口（默认 $PORT 或 3210）',
    '  --rate <hz>     采样频率 1..10（默认 5）',
    '  --script <p>    像素脚本路径（默认 <项目根>/.tmp/spectator/pixel/hp_bars.py）',
    '  --python <p>    python 可执行文件（默认 python；Windows 商店别名 stub 不可用，需指定真实解释器）',
    '  --geometry <p>  几何文件，透传给像素脚本 --geometry-file',
    '  --drive <mode>  scan=按频率向 stdin 写 scan（hp_bars.py 常驻模式）；none=脚本自己循环；image=每轮喂一张图',
    '  --image <p>     离线图片路径（隐含 --drive image，用于没有对局时验证真链路）',
    '  --once          只转发一包就退出（自检用）'
  ].join('\n');
}

function postBars(options, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: options.host,
      port: options.port,
      path: '/api/pixel-bars',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: POST_TIMEOUT_MS
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: raw }));
    });
    request.on('timeout', () => request.destroy(new Error('POST /api/pixel-bars 超时')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

// 单条 bar 归一化：side 做 L/R -> blue/red，kind 只留主进程认识的两种。
// 认不出来的返回 null（丢弃该条），绝不猜成 0%。
function toBar(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const side = SIDE_ALIASES[String(raw.side === undefined || raw.side === null ? '' : raw.side).trim()] || null;
  const kind = KIND_ALIASES[String(raw.kind === undefined || raw.kind === null ? '' : raw.kind).trim().toLowerCase()] || null;
  if (!side || !kind) return null;
  const rowIndex = Number(raw.rowIndex);
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex > 4) return null;
  const bar = {
    side,
    rowIndex,
    kind,
    fillPercent: raw.fillPercent === undefined ? null : raw.fillPercent,
    status: raw.status === undefined || raw.status === null ? 'ok' : String(raw.status)
  };
  if (raw.shieldPx !== undefined && raw.shieldPx !== null) bar.shieldPx = raw.shieldPx;
  if (Array.isArray(raw.dominantColor)) bar.dominantColor = raw.dominantColor;
  return bar;
}

// 像素脚本的一行输出 -> 合法请求体。任何不认识的行都返回 null（丢弃并记日志），不猜。
function toPayload(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  let rawBars = null;
  if (Array.isArray(parsed)) rawBars = parsed;
  else if (parsed && typeof parsed === 'object') {
    // hp_bars.py 原生形态：detail[] 才是逐条读数，bars/mana 是它的压缩映射。
    if (Array.isArray(parsed.detail)) rawBars = parsed.detail;
    else if (Array.isArray(parsed.bars)) rawBars = parsed.bars;
  }
  if (!rawBars) return null;
  const bars = [];
  for (const raw of rawBars) {
    const bar = toBar(raw);
    if (bar) bars.push(bar);
  }
  // 有输入却一条都认不出来：这是解析失败，不是「没有读数」，必须丢弃而不是发空包把状态清掉。
  if (rawBars.length > 0 && bars.length === 0) return null;
  return {
    ts: parsed && !Array.isArray(parsed) && Number.isFinite(Number(parsed.ts)) ? Number(parsed.ts) : Date.now(),
    bars,
    source: 'pixel'
  };
}

function runBridge(options, deps = {}) {
  const log = deps.log || (message => console.log('[pixel-bars-bridge] ' + message));
  const error = deps.error || (message => console.error('[pixel-bars-bridge] ' + message));
  const send = deps.post || (payload => postBars(options, payload));
  const intervalMs = Math.max(50, Math.round(1000 / (options.rate || 5)));
  let child = null;
  let stopped = false;
  let backoff = 1000;
  let buffer = '';
  let forwarded = 0;
  let pollTimer = null;
  let nextTimer = null;

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; }
  }

  function stop() {
    stopped = true;
    stopPolling();
    if (child) { try { child.kill(); } catch {} }
  }

  function handleLine(line) {
    const payload = toPayload(line);
    if (!payload) { error('忽略无法解析的输出行：' + String(line).slice(0, 120)); return; }
    // 全 absent 也要照发：主进程据此把三条状态条降级为 unknown，而不是继续用旧值。
    send(payload)
      .then(result => {
        forwarded += 1;
        if (result && result.status !== 200) error('主进程拒绝了读数：HTTP ' + result.status + ' ' + String(result.body || '').slice(0, 120));
      })
      .catch(err => error('转发失败：' + err.message));
  }

  function readLines(stream) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });
  }

  function scriptArgs(extra) {
    const args = [options.script].concat(extra || []);
    if (options.geometry) args.push('--geometry-file', options.geometry);
    return args;
  }

  // hp_bars.py 常驻模式只在收到 stdin 的 scan 命令时才采一帧，所以必须由桥按频率驱动。
  function writeScan() {
    if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return;
    try { child.stdin.write('scan\n'); } catch { /* 脚本已退出：等 exit 事件重启 */ }
  }

  function startPolling() {
    stopPolling();
    if (options.drive === 'none') return;
    writeScan();
    pollTimer = setInterval(writeScan, intervalMs);
  }

  function scheduleNext(wait) {
    if (stopped) return;
    nextTimer = setTimeout(launchImage, Math.max(0, wait));
  }

  // 图像模式：每轮独立跑一次 '脚本 --image <png>'，读完一行就结束进程，再排下一轮。
  // 这条路径是「没有对局也能验证真链路」的唯一手段：像素来自真实截图，读数来自真实脚本。
  function launchImage() {
    if (stopped) return;
    nextTimer = null;
    const started = Date.now();
    child = spawn(options.python, scriptArgs(['--image', options.image]), { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    readLines(child.stdout);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => error('像素脚本 stderr：' + String(chunk).trim().slice(0, 300)));
    child.on('error', err => { error('无法启动像素脚本：' + err.message); });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopped) return;
      if (code !== 0) {
        // 失败才退避；成功的一轮按 --rate 节奏继续。
        const wait = backoff;
        backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
        error('像素脚本退出（code=' + code + ', signal=' + signal + '），' + wait + 'ms 后重试');
        scheduleNext(wait);
        return;
      }
      backoff = 1000;
      const elapsed = Date.now() - started;
      scheduleNext(Math.max(0, intervalMs - elapsed));
    });
  }

  function launch() {
    if (stopped) return;
    child = spawn(options.python, scriptArgs(), {
      cwd: ROOT,
      // stdin 必须可写：像素脚本用 scan 命令驱动；只读 stdout 的脚本会忽略这些行。
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // 脚本不读 stdin（或已经退出）时写入会 EPIPE，这里必须吞掉，否则整个桥会被一次写入打挂。
    child.stdin.on('error', () => {});
    readLines(child.stdout);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => error('像素脚本 stderr：' + String(chunk).trim().slice(0, 300)));
    child.on('error', err => { error('无法启动像素脚本：' + err.message); });
    child.on('exit', (code, signal) => {
      child = null;
      stopPolling();
      if (stopped) return;
      // 崩溃自动重启，但必须退避：像素脚本反复失败时不能把 CPU 打满。
      const wait = backoff;
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
      error('像素脚本退出（code=' + code + ', signal=' + signal + '），' + wait + 'ms 后重启');
      nextTimer = setTimeout(() => { if (!stopped) launch(); }, wait);
    });
    startPolling();
  }

  if (!fs.existsSync(options.script)) {
    error('找不到像素脚本：' + options.script);
    error('先运行 t15 的像素读条工具，或用 --script 指定路径；此桥在缺脚本时不会伪造任何读数。');
    return { stop, promise: Promise.resolve(2), get forwarded() { return forwarded; } };
  }

  if (options.drive === 'image') launchImage();
  else launch();
  const promise = new Promise(resolve => {
    const timer = setInterval(() => {
      if (stopped) { clearInterval(timer); resolve(0); }
    }, 200);
  });
  return { stop, promise, get forwarded() { return forwarded; }, get running() { return child !== null; } };
}

function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(1); }
  if (options.help) { console.log(usage()); return; }
  const bridge = runBridge(options);
  const shutdown = () => { bridge.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (options.once) {
    setTimeout(() => { bridge.stop(); process.exit(bridge.forwarded > 0 ? 0 : 3); }, 3000);
  }
  bridge.promise.then(code => process.exit(code));
}

if (require.main === module) main();

module.exports = { parseArgs, toPayload, toBar, runBridge, postBars, DEFAULT_SCRIPT, MIN_RATE, MAX_RATE, SIDE_ALIASES, KIND_ALIASES, DRIVES };
