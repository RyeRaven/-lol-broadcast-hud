'use strict';

// tools/shot-hud.cjs —— HUD 广播页（/broadcast/hud）离屏截图 + 逐像素回归 diff（t28）。
//
// 为什么需要它：HUD 的数据可用性契约是纯视觉行为 —— 精确值 / 「≈」量化值 / 「—」不可用 /
// 像素条 unknown 斜纹占位 / hp 0% 与 null 的区别，只有真渲染出来逐像素比才靠得住。
// 本工具不碰 public/ 与 src/pages/ 一行代码：外面起一个假 Live Client Data 服务，
// 跑真的 src/main.js，用项目内 Electron 离屏截图，再用纯 Node 解 PNG 做 diff。
//
// 用法：
//   node tools/shot-hud.cjs --out .tmp/hud-shots/hud-full.png --state full
//   node tools/shot-hud.cjs --state degraded --out .tmp/hud-shots/hud-degraded.png
//   node tools/shot-hud.cjs --state edge --width 1920 --height 1080
//   node tools/shot-hud.cjs --diff test/visual-baseline/hud-full-1920x1080.png \
//        --actual .tmp/hud-shots/hud-full.png --out .tmp/hud-shots/diff.png
//   node tools/shot-hud.cjs --diff <baseline.png> --out <diff.png>   # 现拍一张同状态再比
//
// 零新增依赖：PNG 解码只用 node:zlib 与手写 CRC32 / filter 还原，编码同理。
// 端口：默认在 3300-3399 里找两个空闲端口，永远避开 3210/3311/3312/3313 与 e2e 的 3212-3219。

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.join(ROOT, 'test', 'fixtures', 'live-real-game.json');
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_OUT_DIR = path.join(ROOT, '.tmp', 'hud-shots');
const FORBIDDEN_PORTS = [3210, 3311, 3312, 3313];
const E2E_PORT_RANGE = [3212, 3219];
const PORT_RANGE = [3300, 3399];
const STATES = ['full', 'degraded', 'edge'];
const CAPTURE_TIMEOUT_MS = 25000;
const READY_TIMEOUT_MS = 15000;
// 同一状态两次截图会有 ≤15 单通道差的文字抗锯齿噪声；默认容差 16 让 --diff 对
// 「重拍同态」返回 0，同时仍能抓住任何真正颜色/布局变化（--threshold 0 可严格比较）。
const DEFAULT_DIFF_THRESHOLD = 16;

// ---------------------------------------------------------------------------
// PNG 编解码（只支持 8bit、非隔行的灰度/RGB/调色板/RGBA —— Electron capturePage 就产这些）
// ---------------------------------------------------------------------------

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  CRC_TABLE = table;
  return table;
}

function crc32(buf) {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// 把 PNG 解成 { width, height, channels, data }，data 统一展开成 RGBA 便于比较。
function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let offset = 8;
  let ihdr = null;
  const idat = [];
  let palette = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buffer.subarray(dataStart, dataStart + length);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12]
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  if (ihdr.bitDepth !== 8) throw new Error('只支持 8bit PNG，实际 ' + ihdr.bitDepth);
  if (ihdr.interlace !== 0) throw new Error('不支持隔行 PNG');
  const channelsOf = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsOf[ihdr.colorType];
  if (!channels) throw new Error('不支持的 PNG colorType ' + ihdr.colorType);
  if (!idat.length) throw new Error('PNG 缺少 IDAT');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[pos];
    pos += 1;
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = prev[i];
      const upLeft = i >= channels ? prev[i - channels] : 0;
      if (filterType === 1) line[i] = (line[i] + left) & 0xff;
      else if (filterType === 2) line[i] = (line[i] + up) & 0xff;
      else if (filterType === 3) line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
      else if (filterType === 4) line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
      else if (filterType !== 0) throw new Error('未知 PNG filter ' + filterType);
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      if (channels === 4) {
        out[dst] = line[src]; out[dst + 1] = line[src + 1]; out[dst + 2] = line[src + 2]; out[dst + 3] = line[src + 3];
      } else if (channels === 3) {
        out[dst] = line[src]; out[dst + 1] = line[src + 1]; out[dst + 2] = line[src + 2]; out[dst + 3] = 255;
      } else if (channels === 2) {
        out[dst] = line[src]; out[dst + 1] = line[src]; out[dst + 2] = line[src]; out[dst + 3] = line[src + 1];
      } else if (ihdr.colorType === 3) {
        const index = line[src] * 3;
        out[dst] = palette ? palette[index] : 0;
        out[dst + 1] = palette ? palette[index + 1] : 0;
        out[dst + 2] = palette ? palette[index + 2] : 0;
        out[dst + 3] = 255;
      } else {
        out[dst] = line[src]; out[dst + 1] = line[src]; out[dst + 2] = line[src]; out[dst + 3] = 255;
      }
    }
    prev = line;
  }
  return { width, height, channels, colorType: ihdr.colorType, data: out };
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// 逐像素比较：阈值是「单通道最大允许偏差」，超过就算这个像素变了。
function diffImages(baseline, actual, options) {
  const opts = options || {};
  const threshold = Number.isFinite(opts.threshold) ? Math.max(0, Math.min(255, Math.round(opts.threshold))) : 0;
  const sizeMatch = baseline.width === actual.width && baseline.height === actual.height;
  const width = Math.min(baseline.width, actual.width);
  const height = Math.min(baseline.height, actual.height);
  const totalPixels = baseline.width * baseline.height;
  let changedPixels = 0;
  let maxChannelDelta = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = (y * baseline.width + x) * 4;
      const b = (y * actual.width + x) * 4;
      const dr = Math.abs(baseline.data[a] - actual.data[b]);
      const dg = Math.abs(baseline.data[a + 1] - actual.data[b + 1]);
      const db = Math.abs(baseline.data[a + 2] - actual.data[b + 2]);
      const da = Math.abs(baseline.data[a + 3] - actual.data[b + 3]);
      const delta = Math.max(dr, dg, db, da);
      if (delta > maxChannelDelta) maxChannelDelta = delta;
      if (delta > threshold) {
        changedPixels += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!sizeMatch) {
    // 尺寸不同时，多出来/少掉的那块一律算变化，否则「裁掉一半」也能报 0%。
    changedPixels += Math.abs(totalPixels - actual.width * actual.height);
    minX = 0; minY = 0; maxX = Math.max(baseline.width, actual.width) - 1; maxY = Math.max(baseline.height, actual.height) - 1;
  }
  const boundingBox = maxX >= 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  const denominator = Math.max(totalPixels, actual.width * actual.height) || 1;
  return {
    ok: changedPixels === 0 && sizeMatch,
    width: baseline.width,
    height: baseline.height,
    actualWidth: actual.width,
    actualHeight: actual.height,
    sizeMatch,
    threshold,
    totalPixels,
    changedPixels,
    changedPercent: Math.round((changedPixels / denominator) * 100 * 1e6) / 1e6,
    boundingBox,
    maxChannelDelta
  };
}

// diff 图：基线降饱和做底，变化像素涂洋红，一眼看出改在哪。
function buildDiffImage(baseline, actual, threshold) {
  const width = Math.max(baseline.width, actual.width);
  const height = Math.max(baseline.height, actual.height);
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dst = (y * width + x) * 4;
      const insideBase = x < baseline.width && y < baseline.height;
      const insideActual = x < actual.width && y < actual.height;
      let changed = !insideBase || !insideActual;
      if (!changed) {
        const a = (y * baseline.width + x) * 4;
        const b = (y * actual.width + x) * 4;
        const delta = Math.max(
          Math.abs(baseline.data[a] - actual.data[b]),
          Math.abs(baseline.data[a + 1] - actual.data[b + 1]),
          Math.abs(baseline.data[a + 2] - actual.data[b + 2]),
          Math.abs(baseline.data[a + 3] - actual.data[b + 3])
        );
        changed = delta > threshold;
      }
      if (changed) {
        out[dst] = 255; out[dst + 1] = 0; out[dst + 2] = 255; out[dst + 3] = 255;
      } else {
        const a = (y * baseline.width + x) * 4;
        const lum = Math.round((baseline.data[a] * 0.299 + baseline.data[a + 1] * 0.587 + baseline.data[a + 2] * 0.114) * 0.45);
        out[dst] = lum; out[dst + 1] = lum; out[dst + 2] = lum; out[dst + 3] = 255;
      }
    }
  }
  return { width, height, data: out };
}

// ---------------------------------------------------------------------------
// 进程内小工具：等待、HTTP、端口
// ---------------------------------------------------------------------------

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error((label || '操作') + ' 超时 ' + ms + 'ms')), ms);
    })
  ]);
}

function requestJson(target, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    let url = null;
    try { url = new URL(target); } catch (error) { reject(error); return; }
    const body = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body), 'utf8');
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(body.length);
    }
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers,
      timeout: opts.timeout || 5000
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (error) { parsed = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body: parsed, raw });
        else reject(new Error('HTTP ' + res.statusCode + ' ' + url.pathname + '：' + raw.slice(0, 200)));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时：' + target)));
    if (body) req.write(body);
    req.end();
  });
}

async function waitUntil(fn, timeoutMs, label, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  const step = intervalMs || 100;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(step);
  }
  throw new Error((label || '等待') + ' 超时 ' + timeoutMs + 'ms' + (lastError ? '：' + lastError.message : ''));
}

function canBind(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function isForbiddenPort(port) {
  if (FORBIDDEN_PORTS.indexOf(port) !== -1) return true;
  return port >= E2E_PORT_RANGE[0] && port <= E2E_PORT_RANGE[1];
}

async function findFreePort() {
  for (let port = PORT_RANGE[0]; port <= PORT_RANGE[1]; port += 1) {
    if (isForbiddenPort(port)) continue;
    if (await canBind(port)) return port;
  }
  throw new Error('PORT_RANGE ' + PORT_RANGE[0] + '-' + PORT_RANGE[1] + ' 内没有空闲端口');
}

// ---------------------------------------------------------------------------
// 假 Live Client Data 服务：喂真 src/main.js 的 pollLiveClient
// ---------------------------------------------------------------------------

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

// edge 态只动两位选手的数值，制造「部分数据可用、部分缺失」的边界组合；
// CS 列已从 HUD 行移除，量化值断言随之退役（见 test/visual-baseline.test.js）。
function buildLcdPayload(state) {
  const payload = loadFixture();
  // fake LCDA 与真实接口对齐：wardScore 是整数，fixture 里那个浮点数会让 HUD 的
  // 视野格显示成 10.649405479431152 这种长串（页面 num() 不做取整），截图不可读。
  (payload.allPlayers || []).forEach(player => {
    if (player && player.scores && typeof player.scores.wardScore === 'number') {
      player.scores.wardScore = Math.round(player.scores.wardScore);
    }
  });
  if (state === 'edge') {
    payload.allPlayers[0].scores.creepScore = 142;
    payload.allPlayers[1].scores.creepScore = 147;
  }
  // 转播注记（仅演示截图）：下一只元素龙=风龙；红方持大龙 buff 剩 34 秒、buff 期经济差 -646G。
  if (state === 'full') {
    const gt = Number(payload.gameData && payload.gameData.gameTime) || 0;
    payload.nextDragonType = 'Air';
    // 演示：元素龙在场（30 秒前已刷新）→ 计时盒只显示图标不出倒计时
    payload.nextDragonSpawnAt = Math.round((gt - 30) * 10) / 10;
    payload.baronBuff = { side: 'red', startedAt: Math.round((gt - 146) * 10) / 10, goldDiffEarned: -646 };
    payload.elderBuff = { side: 'blue', startedAt: Math.round((gt - 80) * 10) / 10, goldDiffEarned: 512 };
  }
  return payload;
}

function startFakeLcd(payload) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url && req.url.indexOf('/liveclientdata/allgamedata') === 0) {
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length) });
        res.end(body);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"ok":false,"error":"not_found"}');
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, url: 'http://127.0.0.1:' + port, server, close: () => new Promise(done => server.close(done)) });
    });
  });
}

// ---------------------------------------------------------------------------
// 真 src/main.js 子进程（用项目内 Electron 的 ELECTRON_RUN_AS_NODE 当 node 用）
// ---------------------------------------------------------------------------

function startApp(port, liveUrl) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'main.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', PORT: String(port), LIVE_CLIENT_URL: liveUrl }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const logs = [];
  const collect = chunk => {
    logs.push(String(chunk).trim());
    if (logs.length > 200) logs.shift();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', code => { logs.push('[app exit ' + code + ']'); });
  return {
    child,
    port,
    url: 'http://127.0.0.1:' + port,
    logs,
    stop: () => { try { child.kill(); } catch (error) { /* 已退出 */ } }
  };
}

async function waitForApp(port) {
  return waitUntil(async () => {
    try {
      const res = await requestJson('http://127.0.0.1:' + port + '/health', { timeout: 1200 });
      return res.body && res.body.ok === true ? res.body : null;
    } catch (error) {
      return null;
    }
  }, 20000, '主进程 /health', 200);
}

// ---------------------------------------------------------------------------
// 降级态：把真实状态里的 capability 换成「全部 unavailable」的 offline 矩阵
// 走同源代理，只改 /api/state 与 /events 首帧，页面/CSS/渲染代码 100% 是生产代码。
// ---------------------------------------------------------------------------

function offlineCapability() {
  const capability = require(path.join(ROOT, 'src', 'data-capability.js'));
  return capability.buildCapabilityMatrix('offline', {});
}

function degradeState(state) {
  const next = JSON.parse(JSON.stringify(state));
  next.capability = offlineCapability();
  next.protocolDecode = false;
  next.pixelBars = { active: false, updatedAt: null, stale: false };
  next.players = (next.players || []).map(player => Object.assign({}, player, {
    level: null,
    cs: null,
    csExact: null,
    totalGold: null,
    xp: null,
    csAsOf: null,
    xpAsOf: null,
    items: [],
    runes: null,
    summoners: [],
    summonerSpellIds: [],
    wardScore: null,
    hpPercent: null,
    resourcePercent: null,
    shieldPercent: null,
    resourceColor: null,
    pixelBars: null
  }));
  ['blue', 'red'].forEach(side => {
    if (next[side] && typeof next[side] === 'object') next[side] = Object.assign({}, next[side], { gold: null });
  });
  return next;
}

function upstreamOptions(req, targetPort) {
  return {
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + targetPort })
  };
}

function pipeRequest(req, res, targetPort) {
  const upstream = http.request(upstreamOptions(req, targetPort), upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('proxy_error');
  });
  req.pipe(upstream);
}

function proxyJson(req, res, targetPort, transform) {
  const upstream = http.request(upstreamOptions(req, targetPort), upstreamRes => {
    const chunks = [];
    upstreamRes.on('data', chunk => chunks.push(chunk));
    upstreamRes.on('end', () => {
      let text = Buffer.concat(chunks).toString('utf8');
      try { text = JSON.stringify(transform(JSON.parse(text))); } catch (error) { /* 解析失败就原样透传 */ }
      const body = Buffer.from(text, 'utf8');
      const headers = Object.assign({}, upstreamRes.headers);
      delete headers['content-length'];
      headers['content-length'] = String(body.length);
      res.writeHead(upstreamRes.statusCode || 200, headers);
      res.end(body);
    });
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('proxy_error');
  });
  req.pipe(upstream);
}

function proxyEvents(req, res, targetPort, transform) {
  const upstream = http.request(upstreamOptions(req, targetPort), upstreamRes => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    let buffer = '';
    let sent = false;
    upstreamRes.setEncoding('utf8');
    upstreamRes.on('data', chunk => {
      if (sent) return;
      buffer += chunk;
      const index = buffer.indexOf('\n\n');
      if (index === -1) return;
      const block = buffer.slice(0, index);
      let output = block;
      const match = /^data: ([\s\S]*)$/.exec(block);
      if (match) {
        try { output = 'data: ' + JSON.stringify(transform(JSON.parse(match[1]))); } catch (error) { output = block; }
      }
      res.write(output + '\n\n');
      sent = true;
      // 只放行首帧：后续 tick 广播是未改写的真实状态，不能让它覆盖降级画面。
      upstreamRes.destroy();
    });
    upstreamRes.on('error', () => {});
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('proxy_error');
  });
  req.pipe(upstream);
  res.on('close', () => upstream.destroy());
}

function startOverlayProxy(targetPort, transform) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const pathname = String(req.url || '/').split('?')[0];
      if (pathname === '/events') { proxyEvents(req, res, targetPort, transform); return; }
      if (pathname === '/api/state') { proxyJson(req, res, targetPort, transform); return; }
      pipeRequest(req, res, targetPort);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, url: 'http://127.0.0.1:' + port, server, close: () => new Promise(done => server.close(done)) });
    });
  });
}

// ---------------------------------------------------------------------------
// 数据注入：协议流（cs/gold/xp/KDA 精确值）与像素条（hp/resource 百分比）
// ---------------------------------------------------------------------------

function protocolPayload() {
  const fixture = loadFixture();
  const players = fixture.allPlayers.map((player, index) => {
    const scores = player.scores || {};
    return {
      netid: '0x400000' + (index + 1).toString(16).padStart(2, '0'),
      participantId: index + 1,
      team: String(player.team || '').toUpperCase() === 'CHAOS' ? 'red' : 'blue',
      kills: scores.kills,
      deaths: scores.deaths,
      assists: scores.assists,
      cs: (Number(scores.creepScore) || 0) + 3,
      // 每路经济差方向故意混合（蓝领先 2 路 / 红领先 3 路），截图能同时看到两种旗标。
      totalGold: [8600, 12400, 7100, 13900, 10200, 10400, 9200, 11800, 8300, 13400][index] || 9800,
      xp: 7200 + index * 410,
      asOf: 812.4,
      championName: player.championName,
      precision: { kills: 'exact', deaths: 'exact', assists: 'exact', cs: 'exact', totalGold: 'exact', xp: 'exact' }
    };
  });
  return { source: 'live', gameId: 'HUD-SHOT-1', gameTime: 812.4, players, events: [] };
}

// 假 pixel-bars feed 的资源条颜色按英雄资源类型取（与真机 pixel-bars-bridge 读到的
// 像素色同源：data/resource-bar-spec.json），不再按队伍硬编码——旧实现红侧恒绿色，
// 合成图上红方资源条全员「血条绿」，看着像 bug。
let RESOURCE_SPEC_CACHE = null;
function resourceSpecs() {
  if (RESOURCE_SPEC_CACHE === null) {
    try {
      RESOURCE_SPEC_CACHE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'resource-bar-spec.json'), 'utf8')).champions || {};
    } catch (err) {
      RESOURCE_SPEC_CACHE = {};
    }
  }
  return RESOURCE_SPEC_CACHE;
}

let CHAMPION_ALIAS_CACHE = null;
function championKeyByAlias() {
  if (CHAMPION_ALIAS_CACHE === null) {
    const map = {};
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'champions-16.22.1.json'), 'utf8')).data || {};
      Object.keys(data).forEach((key) => {
        const info = data[key];
        map[info.name] = key;
        map[info.title] = key;
        map[info.id] = key;
      });
    } catch (err) {
      // 表缺失时按 championName 原值兜底
    }
    CHAMPION_ALIAS_CACHE = map;
  }
  return CHAMPION_ALIAS_CACHE;
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!match) return [56, 132, 255];
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function pixelBarsPayload(state) {
  const fullSpec = {
    hp: [[100, 'ok', 0], [88.2, 'ok', 0], [64.7, 'ok', 0], [43.1, 'ok', 0], [21.6, 'ok', 0]],
    resource: [[92.2, 'ok', 0], [78.4, 'ok', 0], [61.2, 'ok', 0], [45.1, 'ok', 0], [30.5, 'ok', 0]]
  };
  // 边界态：hp 100% / hp 0% / resource 全 null 三种读法都要出现在同一帧里。
  const edgeSpec = {
    hp: [[100, 'ok', 0], [0, 'ok', 0], [55.6, 'ok', 0], [0.8, 'ok', 0], [100, 'ok', 0]],
    resource: [[100, 'ok', 0], [null, 'absent', 0], [null, 'unsupported', 0], [11.8, 'ok', 0], [null, 'absent', 0]]
  };
  const spec = state === 'edge' ? edgeSpec : fullSpec;
  const specs = resourceSpecs();
  const aliasMap = championKeyByAlias();
  const roster = loadFixture().allPlayers || [];
  const bars = [];
  ['blue', 'red'].forEach((side, sideIndex) => {
    for (let row = 0; row < 5; row += 1) {
      const hp = spec.hp[row];
      const resource = spec.resource[row];
      // 资源条颜色按该行英雄的资源类型着色；class D（无资源条）直接置空。
      const player = roster[sideIndex * 5 + row] || null;
      const champKey = player ? (aliasMap[player.championName] || player.championName) : null;
      const resSpec = champKey ? specs[champKey] : null;
      const noBar = !!(resSpec && resSpec.class === 'D');
      const fill = noBar ? [null, 'absent', 0] : resource;
      const resColor = noBar ? [0, 0, 0] : hexToRgb(resSpec && resSpec.barColor);
      bars.push({ side, rowIndex: row, kind: 'hp', fillPercent: hp[0], status: hp[1], shieldPx: hp[2], dominantColor: [64, 200, 96] });
      bars.push({ side, rowIndex: row, kind: 'resource', fillPercent: fill[0], status: fill[1], shieldPx: fill[2], dominantColor: resColor });
    }
  });
  return { source: 'pixel', bars };
}

// 2000ms TTL 意味着注入必须持续到截图结束，不能只发一次。
function startFeeds(port, state) {
  const base = 'http://127.0.0.1:' + port;
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    const jobs = [];
    if (state === 'full') jobs.push(requestJson(base + '/api/protocol-feed', { method: 'POST', body: protocolPayload() }).catch(() => null));
    jobs.push(requestJson(base + '/api/pixel-bars', { method: 'POST', body: pixelBarsPayload(state) }).catch(() => null));
    await Promise.all(jobs);
    if (!stopped) timer = setTimeout(tick, 700);
  };
  tick();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

// ---------------------------------------------------------------------------
// SSE 首帧：证明 /events 真的下发了状态（不是靠固定 sleep 猜的）
// ---------------------------------------------------------------------------

function firstSseFrame(target) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Accept: 'text/event-stream' }
    }, res => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        const index = buffer.indexOf('\n\n');
        if (index === -1) return;
        const block = buffer.slice(0, index);
        const match = /^data: ([\s\S]*)$/.exec(block);
        res.destroy();
        req.destroy();
        if (!match) { reject(new Error('SSE 首帧不是 data: 帧')); return; }
        try { resolve(JSON.parse(match[1])); } catch (error) { reject(error); }
      });
      res.on('error', () => {});
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    req.setTimeout(15000, () => req.destroy(new Error('SSE 首帧超时')));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 页面 ready 判据：DOM 结构 + 字体 + 非无限动画结束 + 顶栏时钟有值
// ---------------------------------------------------------------------------

const READY_FN = function () {
  var root = document.getElementById('hud-broadcast');
  var rows = Array.prototype.slice.call(document.querySelectorAll('.hb-row'));
  var rects = rows.map(function (row) {
    var box = row.getBoundingClientRect();
    return { id: row.id, x: box.x, y: box.y, width: box.width, height: box.height };
  });
  var visible = rects.filter(function (rect) {
    return rect.width > 0 && rect.height > 0 && rect.y >= -1 && rect.y + rect.height <= window.innerHeight + 1 && rect.x >= -1 && rect.x + rect.width <= window.innerWidth + 1;
  });
  var loading = document.querySelector('.hb-loading');
  var running = 0;
  if (document.getAnimations) {
    document.getAnimations().forEach(function (animation) {
      var timing = animation.effect && animation.effect.getComputedTiming ? animation.effect.getComputedTiming() : null;
      var infinite = timing && timing.iterations === Infinity;
      if (!infinite && animation.playState === 'running') running += 1;
    });
  }
  var clock = document.getElementById('hb-clock');
  var cells = rows.map(function (row) {
    var suffix = String(row.id || '').replace(/^hb-row-/, '');
    var cs = document.getElementById('hb-vision-' + suffix);
    var kda = document.getElementById('hb-kda-' + suffix);
    var bars = document.getElementById('hb-bars-' + suffix);
    var barFills = bars ? Array.prototype.slice.call(bars.querySelectorAll('.hb-bar-fill')) : [];
    return {
      id: row.id,
      vision: cs ? String(cs.textContent || '').trim() : null,
      kda: kda ? String(kda.textContent || '').trim() : null,
      fillPx: barFills.map(function (fill) { return Math.round(fill.getBoundingClientRect().width * 10) / 10; })
    };
  });
  return {
    ready: !!(root && root.classList.contains('hb-ready')),
    rows: rows.length,
    visibleRows: visible.length,
    loadingHidden: !loading || getComputedStyle(loading).display === 'none',
    fonts: document.fonts ? document.fonts.status : 'loaded',
    running: running,
    // 比分从 0 跳到真实值会触发 0.72s 的 hb-flash（整块半场提亮）。如果截图撞上它，
    // 同一状态的两次截图会差出整片背景色 —— 必须等这些一次性特效退场。
    effects: document.querySelectorAll('.hb-flash, .hb-bump').length,
    clock: clock ? String(clock.textContent || '').trim() : '',
    rects: rects,
    cells: cells
  };
};

// ---------------------------------------------------------------------------
// 浏览器引导：Electron GUI 在本机 DSH 环境起不来（app.whenReady 不 resolve，
// 退出码 2147483651，缓存目录拒绝访问），改用 Chrome/Edge headless + CDP。
// 下面这个适配器把 CDP 包装成 captureWindow 用到的 electron API 形状，
// 因此截图逻辑（captureWindow/captureState/run/runDiff）保持原样。
// ---------------------------------------------------------------------------

function findBrowserExecutable() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] || '';
  candidates.push(
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  );
  if (localAppData) candidates.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chrome 或 Edge，可用环境变量 CHROME_PATH 指定浏览器路径');
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (!message || typeof message.id !== 'number') return;
      const slot = this.pending.get(message.id);
      if (!slot) return;
      this.pending.delete(message.id);
      if (message.error) slot.reject(new Error('CDP ' + message.error.message));
      else slot.resolve(message.result || {});
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new CdpClient(socket)));
      socket.addEventListener('error', () => reject(new Error('CDP 连接失败：' + url)));
    });
  }

  send(method, params, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    try { this.socket.close(); } catch (error) { /* 已关闭 */ }
  }
}

async function openBrowser() {
  const executable = findBrowserExecutable();
  const profileDir = path.join(ROOT, '.tmp', 'hud-shots', 'browser-profile-' + Date.now() + '-' + Math.floor(Math.random() * 1000));
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-device-scale-factor=1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const logs = [];
  child.stderr.on('data', chunk => {
    logs.push(String(chunk));
    if (logs.length > 40) logs.shift();
  });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const endpoint = await waitUntil(() => {
    try {
      const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/).filter(Boolean);
      if (lines.length >= 2) return { port: Number(lines[0]), path: lines[1] };
    } catch (error) { /* 端口文件还没写出来 */ }
    return null;
  }, 20000, '浏览器 DevToolsActivePort', 100);
  const client = await CdpClient.connect('ws://127.0.0.1:' + endpoint.port + endpoint.path);
  return {
    executable,
    profileDir,
    logs,
    client,
    close() {
      client.close();
      try { child.kill(); } catch (error) { /* 已退出 */ }
    }
  };
}

function createBrowserAdapter(browser) {
  const client = browser.client;
  function BrowserWindow(options) {
    const size = { width: options.width || DEFAULT_WIDTH, height: options.height || DEFAULT_HEIGHT };
    const handle = { targetId: null, sessionId: null };
    return {
      setMenuBarVisibility() {},
      setContentSize(width, height) { size.width = width; size.height = height; },
      getContentSize() { return [size.width, size.height]; },
      async loadURL(url) {
        const created = await client.send('Target.createTarget', { url: 'about:blank' });
        handle.targetId = created.targetId;
        const attached = await client.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
        handle.sessionId = attached.sessionId;
        await client.send('Page.enable', {}, handle.sessionId);
        // 外部图标一律拦掉：ddragon 的 champion/item/spell 图标会随网络状态
        // 忽有忽无（实测同一状态两次截图，一个头像 36x36 整块不同）。页面本身
        // 有「首字母」兜底，因此断网渲染结果是确定的。
        await client.send('Network.enable', {}, handle.sessionId);
        await client.send('Network.setBlockedURLs', { urls: ['*://ddragon.leagueoflegends.com/*'] }, handle.sessionId);
        // 页面是给 OBS 用的透明叠加层；headless 截图默认把透明画成白色，会把
        // 「原生装备栏挖孔」显示成一块块白条。统一垫一层不透明黑底，等价于游戏画面在最底层。
        await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 1 } }, handle.sessionId);
        await client.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false }, handle.sessionId);
        await client.send('Page.navigate', { url }, handle.sessionId);
      },
      webContents: {
        async executeJavaScript(expression) {
          const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, handle.sessionId);
          if (result.exceptionDetails) throw new Error('页面脚本异常：' + JSON.stringify(result.exceptionDetails).slice(0, 300));
          return result.result ? result.result.value : null;
        },
        async capturePage() {
          const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true }, handle.sessionId);
          const png = Buffer.from(shot.data, 'base64');
          return { toPNG: () => png, getSize: () => ({ width: size.width, height: size.height }) };
        }
      },
      async destroy() {
        if (!handle.targetId) return;
        try { await client.send('Target.closeTarget', { targetId: handle.targetId }); } catch (error) { /* 已关闭 */ }
      }
    };
  }
  return {
    session: {
      fromPartition() {
        return {
          webRequest: { onBeforeRequest() {} },
          async clearStorageData() {}
        };
      }
    },
    BrowserWindow
  };
}

async function captureWindow(electron, options) {
  const width = options.width;
  const height = options.height;
  const partition = 'shot-hud-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const ses = electron.session.fromPartition(partition);
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    let host = '';
    try { host = new URL(details.url).hostname; } catch (error) { host = ''; }
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') { callback({}); return; }
    // 截图必须可复现：ddragon 图标等外网请求一律拦掉，页面自带「首字母」兜底。
    callback({ cancel: true });
  });
  const win = new electron.BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition
    }
  });
  win.setMenuBarVisibility(false);
  win.setContentSize(width, height);
  const contentSize = win.getContentSize();
  try {
    await withTimeout(win.loadURL(options.url), CAPTURE_TIMEOUT_MS, 'loadURL');
    const info = await waitUntil(async () => {
      const snapshot = await win.webContents.executeJavaScript('(' + READY_FN.toString() + ')()', true);
      if (!snapshot || !snapshot.ready) return null;
      if (snapshot.rows !== 10 || snapshot.visibleRows !== 10) return null;
      if (!snapshot.loadingHidden) return null;
      if (snapshot.fonts !== 'loaded') return null;
      if (snapshot.running !== 0) return null;
      if (snapshot.effects !== 0) return null;
      if (!/\d+:\d\d/.test(snapshot.clock)) return null;
      return snapshot;
    }, READY_TIMEOUT_MS, 'HUD 首次布局 ready');
    // 无限循环动画（计时器脉冲）在任意相位都会让像素不同；暂停并拨回 0 相位，
    // 让同一状态多次截图可复现。一次性动画此时已全部结束。
    await win.webContents.executeJavaScript('(function(){ if(!document.getAnimations) return 0; var n=0; document.getAnimations().forEach(function(a){ var t=a.effect&&a.effect.getComputedTiming?a.effect.getComputedTiming():null; if(t&&t.iterations===Infinity){ try{a.pause(); a.currentTime=0; n+=1;}catch(e){} } }); return n; })()', true);
    const image = await withTimeout(win.webContents.capturePage(), 15000, 'capturePage');
    const png = image.toPNG();
    const size = image.getSize();
    return { png, size, contentSize, ready: info };
  } finally {
    try { win.destroy(); } catch (error) { /* 已销毁 */ }
    try { await ses.clearStorageData(); } catch (error) { /* 忽略 */ }
  }
}

// ---------------------------------------------------------------------------
// 场景编排
// ---------------------------------------------------------------------------

async function captureState(electron, state, options) {
  const width = options.width || DEFAULT_WIDTH;
  const height = options.height || DEFAULT_HEIGHT;
  const appPort = await findFreePort();
  const lcd = await startFakeLcd(buildLcdPayload(state));
  let app = null;
  let feeds = null;
  let proxy = null;
  try {
    app = startApp(appPort, lcd.url);
    try {
      await waitForApp(appPort);
    } catch (error) {
      throw new Error('主进程没有起来（PORT=' + appPort + '）：' + error.message + '\n' + app.logs.join('\n'));
    }
    await requestJson('http://127.0.0.1:' + appPort + '/api/config', { method: 'POST', body: { mode: 'live' } });
    await waitUntil(async () => {
      const res = await requestJson('http://127.0.0.1:' + appPort + '/api/state');
      const snapshot = res.body;
      if (!snapshot || snapshot.mode !== 'live') return null;
      if (!Array.isArray(snapshot.players) || snapshot.players.length !== 10) return null;
      // 左信息塔的 PATCH 文案来自 state.patch：初始值是 '25.21'，champions.js 异步
      // 加载完后才会变成 DEFAULT_VERSION/远端版本。不等它会把启动瞬间的 25.21 截进基线，
      // 同一状态第二次截图就变成 16.22.1（实测差 467 像素）。
      if (snapshot.patch === '25.21') return null;
      return snapshot;
    }, 15000, 'live 状态（10 名玩家）');

    if (state === 'full' || state === 'edge') {
      feeds = startFeeds(appPort, state);
      await waitUntil(async () => {
        const res = await requestJson('http://127.0.0.1:' + appPort + '/api/state');
        const fields = res.body && res.body.capability ? res.body.capability.fields : null;
        if (!fields || !fields.hpPercent || fields.hpPercent.available !== true) return null;
        // full 态必须等协议流也落地：只等像素条会让 CS/gold 仍是 LCDA 的粗略值，
        // 同一状态两次截图会差出一排数字（实测 1234 像素）。
        if (state === 'full') {
          // 只等 csExact：FIELD_KEYS 里没有 gold 键（capUsable('gold') 恒 true），
          // 等它永远等不到。csExact 落地就代表整包协议流已经被 main.js 接收。
          if (!fields.csExact || fields.csExact.available !== true) return null;
        }
        return true;
      }, 8000, '像素条 capability');
    }

    let baseUrl = 'http://127.0.0.1:' + appPort;
    if (state === 'degraded') {
      proxy = await startOverlayProxy(appPort, degradeState);
      baseUrl = proxy.url;
    }

    const firstFrame = await firstSseFrame(baseUrl + '/events');
    if (!firstFrame || !Array.isArray(firstFrame.players) || firstFrame.players.length !== 10) {
      throw new Error('SSE 首帧里没有 10 名玩家');
    }

    const shot = await captureWindow(electron, { url: baseUrl + '/broadcast/hud', width, height });
    const outFile = options.outFile;
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, shot.png);
    const bytes = fs.statSync(outFile).size;
    if (bytes < 20 * 1024) throw new Error('截图只有 ' + bytes + 'B，低于 20KB 门槛');
    return {
      state,
      file: outFile,
      bytes,
      width: shot.size.width,
      height: shot.size.height,
      contentSize: shot.contentSize,
      rows: shot.ready.rows,
      visibleRows: shot.ready.visibleRows,
      clock: shot.ready.clock,
      ssePlayers: firstFrame.players.length,
      rects: shot.ready.rects,
      cells: shot.ready.cells,
      capturedAt: new Date().toISOString()
    };
  } finally {
    if (feeds) feeds.stop();
    if (proxy) await proxy.close();
    if (app) app.stop();
    await lcd.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log([
    '用法：',
    '  node tools/shot-hud.cjs --out <png> [--state full|degraded|edge] [--width 1920 --height 1080]',
    '  node tools/shot-hud.cjs --state all --out .tmp/hud-shots   # 三态各拍一张',
    '  node tools/shot-hud.cjs --diff <baseline.png> --out <diff.png> [--actual <png>] [--threshold 0]',
    '',
    '说明：',
    '  内部起假 Live Client Data 服务 + 真 src/main.js；等 /events 首帧与 HUD 首次布局 ready 才截图。',
    '  端口只在 3300-3399 里挑，永远避开 3210/3311/3312/3313 与 e2e 的 3212-3219。'
  ].join('\n'));
}

function parseArgs(argv) {
  const options = {
    state: 'full',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    out: null,
    diff: null,
    actual: null,
    threshold: DEFAULT_DIFF_THRESHOLD,
    json: false,
    help: false,
    stateExplicit: false
  };
  const valueOf = (index) => {
    if (index + 1 >= argv.length || String(argv[index + 1]).indexOf('--') === 0) throw new Error(argv[index] + ' 需要一个值');
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') { options.out = valueOf(i); i += 1; }
    else if (arg === '--state') { options.state = valueOf(i); options.stateExplicit = true; i += 1; }
    else if (arg === '--width') { options.width = Number(valueOf(i)); i += 1; }
    else if (arg === '--height') { options.height = Number(valueOf(i)); i += 1; }
    else if (arg === '--diff') { options.diff = valueOf(i); i += 1; }
    else if (arg === '--actual') { options.actual = valueOf(i); i += 1; }
    else if (arg === '--threshold') { options.threshold = Number(valueOf(i)); i += 1; }
    else if (arg === '--json') { options.json = true; }
    else if (arg === '--help' || arg === '-h') { options.help = true; }
    else throw new Error('未知参数：' + arg);
  }
  if (STATES.indexOf(options.state) === -1 && options.state !== 'all') throw new Error('--state 必须是 ' + STATES.join('/') + '/all');
  if (!Number.isFinite(options.width) || options.width < 320) throw new Error('--width 必须是 >=320 的数字');
  if (!Number.isFinite(options.height) || options.height < 240) throw new Error('--height 必须是 >=240 的数字');
  if (!Number.isFinite(options.threshold) || options.threshold < 0) throw new Error('--threshold 必须是非负数字');
  return options;
}

function defaultOutFile(state, width, height) {
  return path.join(DEFAULT_OUT_DIR, 'hud-' + state + '-' + width + 'x' + height + '.png');
}

function resolveOutFile(options, state, many) {
  if (!options.out) return defaultOutFile(state, options.width, options.height);
  if (!many && options.state !== 'all') return path.resolve(options.out);
  if (path.extname(options.out).toLowerCase() === '.png') return path.join(path.dirname(path.resolve(options.out)), 'hud-' + state + '-' + options.width + 'x' + options.height + '.png');
  return path.join(path.resolve(options.out), 'hud-' + state + '-' + options.width + 'x' + options.height + '.png');
}

function readConfigText() {
  try { return fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'); } catch (error) { return null; }
}

function restoreConfig(text) {
  if (text === null) return;
  try { fs.writeFileSync(path.join(ROOT, 'data', 'config.json'), text); } catch (error) { /* 尽力恢复 */ }
}

function inferStateFromBaseline(file) {
  const base = path.basename(String(file || '')).toLowerCase();
  for (const state of STATES) {
    if (base.indexOf('hud-' + state + '-') === 0) return state;
  }
  return null;
}

async function runDiff(electron, options) {
  const baseline = decodePng(fs.readFileSync(options.diff));
  const width = options.width !== DEFAULT_WIDTH ? options.width : baseline.width;
  const height = options.height !== DEFAULT_HEIGHT ? options.height : baseline.height;
  // --diff <baseline> 不带 --state 时从 baselines 的命名推断场景；否则三张基线都会
  // 被当成 full 态重拍，degraded/edge 的 diff 必然整片全红。
  const state = options.stateExplicit ? options.state : (inferStateFromBaseline(options.diff) || options.state);
  let actualPath = options.actual;
  if (!actualPath) {
    actualPath = path.join(DEFAULT_OUT_DIR, '_actual-' + state + '-' + baseline.width + 'x' + baseline.height + '.png');
    await captureState(electron, state, { width: baseline.width, height: baseline.height, outFile: actualPath });
  }
  const actual = decodePng(fs.readFileSync(actualPath));
  const result = diffImages(baseline, actual, { threshold: options.threshold });
  const diffImage = buildDiffImage(baseline, actual, result.threshold);
  const outFile = options.out ? path.resolve(options.out) : path.join(DEFAULT_OUT_DIR, 'diff.png');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, encodePng(diffImage.width, diffImage.height, diffImage.data));
  const summary = Object.assign({ baseline: path.resolve(options.diff), actual: actualPath, diff: outFile }, result);
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function run(electron, options) {
  if (options.diff) return runDiff(electron, options);
  const states = options.state === 'all' ? STATES.slice() : [options.state];
  const startedAt = Date.now();
  const shots = [];
  for (const state of states) {
    const outFile = resolveOutFile(options, state, states.length > 1);
    const result = await captureState(electron, state, { width: options.width, height: options.height, outFile });
    shots.push(result);
    console.log('[shot-hud] ' + state + ' -> ' + outFile + ' (' + result.bytes + 'B, ' + result.width + 'x' + result.height + ', rows ' + result.visibleRows + '/10)');
  }
  const manifest = {
    ok: shots.length === states.length,
    generatedAt: new Date().toISOString(),
    viewport: { width: options.width, height: options.height },
    totalDurationMs: Date.now() - startedAt,
    shots
  };
  const manifestDir = path.dirname(shots[0].file);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (options.json) console.log(JSON.stringify(manifest));
  return manifest;
}

// ---------------------------------------------------------------------------
// 进程入口（纯 Node，浏览器由 openBrowser 拉起）
// ---------------------------------------------------------------------------

function cliArgsFromProcess() {
  const args = process.argv.slice(2);
  if (args[0] === '--') return args.slice(1);
  return args;
}

async function main() {
  const options = parseArgs(cliArgsFromProcess());
  if (options.help) {
    usage();
    return 0;
  }
  const previousConfig = readConfigText();
  let browser = null;
  try {
    browser = await openBrowser();
    const adapter = createBrowserAdapter(browser);
    await run(adapter, options);
    return 0;
  } catch (error) {
    console.error('[shot-hud] ' + (error && error.stack ? error.stack : String(error)));
    return 1;
  } finally {
    restoreConfig(previousConfig);
    if (browser) browser.close();
  }
}



module.exports = {
  crc32,
  decodePng,
  encodePng,
  diffImages,
  buildDiffImage,
  buildLcdPayload,
  buildProtocolPayload: protocolPayload,
  buildPixelBarsPayload: pixelBarsPayload,
  degradeState,
  parseArgs,
  STATES,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT
};

if (require.main === module) {
  main().then(code => process.exit(code)).catch(error => {
    console.error('[shot-hud] ' + (error && error.stack ? error.stack : String(error)));
    process.exit(1);
  });
}
