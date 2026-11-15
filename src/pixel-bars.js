'use strict';

// 像素读条接入层（t23）。
//
// 背景：血量/资源条的**绝对数值永远拿不到**——Live Client Data 的 allPlayers 不含 health/maxHealth，
// 协议流的 gold/xp 已证明解不出真值，OpenProcess 读游戏内存被反作弊拒绝（也绝不做）。
// 唯一可行的是同机独立进程截屏读条（.tmp/spectator/pixel/hp_bars.py，1px≈1.96%），
// 把「这一条现在填了百分之几」通过本地 HTTP 喂给主进程。
//
// 因此这里的契约只有百分比：
//   fillPercent 0..100  读到了
//   fillPercent null    没读到（**不等于 0%**，页面必须画 unknown 占位）
//   status absent       该条不存在（例如无资源英雄、死亡时）
//   status unsupported  该英雄的资源条形态没被像素工具支持
// 任何情况下都不允许把缺失值补成 0% 或满条。

const MAX_BODY_BYTES = 1024 * 1024;
// 超过这个时间没收到新读数的 bar 一律视为失效：宁可画占位，也不能拿旧值冒充当前血量。
const PIXEL_BAR_TTL_MS = 2000;
// 原生血条满宽（@1920x1080），与 src/pages/hud-broadcast.js 的 PIXEL_BAR_FULL_PX 保持一致，
// 用于把盾的像素宽度折算成「占满条的百分比」。
const PIXEL_BAR_FULL_PX = 38;

const SIDES = Object.freeze(['blue', 'red']);
const KINDS = Object.freeze(['hp', 'resource']);
const STATUSES = Object.freeze(['ok', 'ok_pale', 'absent', 'unsupported']);
const ROW_MIN = 0;
const ROW_MAX = 4;
// 只允许本机回环地址写入：这是内部数据通道，不是公开接口。
const LOOPBACK_ADDRESSES = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']);

function isLoopback(address) {
  return LOOPBACK_ADDRESSES.includes(String(address || ''));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeColor(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const rgb = value.slice(0, 3).map(channel => {
    const number = finiteNumber(channel);
    return number === null ? null : Math.max(0, Math.min(255, Math.round(number)));
  });
  return rgb.some(channel => channel === null) ? null : rgb;
}

// 单条 bar 的校验：任何字段非法都返回 { ok:false, reason }，由调用方整包拒绝。
function normalizeBar(raw, position) {
  const where = 'bars[' + position + ']';
  if (!raw || typeof raw !== 'object') return { ok: false, reason: where + ' 不是对象' };
  const side = String(raw.side || '');
  if (!SIDES.includes(side)) return { ok: false, reason: where + '.side 必须是 blue/red' };
  const kind = String(raw.kind || '');
  if (!KINDS.includes(kind)) return { ok: false, reason: where + '.kind 必须是 hp/resource' };
  const rowIndex = finiteNumber(raw.rowIndex);
  if (rowIndex === null || !Number.isInteger(rowIndex) || rowIndex < ROW_MIN || rowIndex > ROW_MAX) {
    return { ok: false, reason: where + '.rowIndex 必须是 0..4 的整数' };
  }
  // fillPercent 只接受 0..100 的有限数或 null；字符串、NaN、越界一律整包拒绝。
  let fillPercent = null;
  if (raw.fillPercent !== null && raw.fillPercent !== undefined) {
    const value = Number(raw.fillPercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return { ok: false, reason: where + '.fillPercent 必须是 0..100 的有限数或 null' };
    }
    fillPercent = value;
  }
  const status = raw.status === undefined || raw.status === null ? 'ok' : String(raw.status);
  if (!STATUSES.includes(status)) return { ok: false, reason: where + '.status 必须是 ' + STATUSES.join('/') };
  const shieldPx = finiteNumber(raw.shieldPx);
  if (raw.shieldPx !== undefined && raw.shieldPx !== null && (shieldPx === null || shieldPx < 0)) {
    return { ok: false, reason: where + '.shieldPx 必须是非负有限数' };
  }
  let dominantColor = null;
  if (raw.dominantColor !== undefined && raw.dominantColor !== null) {
    dominantColor = normalizeColor(raw.dominantColor);
    if (dominantColor === null) return { ok: false, reason: where + '.dominantColor 必须是 [r,g,b]' };
  }
  // absent/unsupported 的条即使带了 fillPercent 也不能当真：一律置 null。
  const usable = status === 'ok' || status === 'ok_pale';
  return {
    ok: true,
    bar: {
      side,
      rowIndex,
      kind,
      fillPercent: usable ? fillPercent : null,
      status,
      shieldPx: shieldPx === null ? 0 : shieldPx,
      dominantColor
    }
  };
}

// 整包校验：先全量验证再提交，保证「非法包 400 且不污染状态」。
function normalizePixelBarPayload(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!source) return { ok: false, reason: '请求体必须是 JSON 对象' };
  if (!Array.isArray(source.bars)) return { ok: false, reason: 'bars 必须是数组' };
  if (source.source !== undefined && source.source !== 'pixel') return { ok: false, reason: "source 必须是 'pixel'" };
  const bars = [];
  for (let i = 0; i < source.bars.length; i += 1) {
    const result = normalizeBar(source.bars[i], i);
    if (!result.ok) return { ok: false, reason: result.reason };
    bars.push(result.bar);
  }
  // 同一 (side,rowIndex,kind) 出现两次视为非法：无法判断哪个是真的，宁可拒绝也不猜。
  const seen = new Set();
  for (const bar of bars) {
    const key = bar.side + ':' + bar.rowIndex + ':' + bar.kind;
    if (seen.has(key)) return { ok: false, reason: '重复的 bar：' + key };
    seen.add(key);
  }
  return { ok: true, bars };
}

// 读数缓存：按 (side,rowIndex,kind) 存最后一条，超过 ttl 即失效。
function createPixelBarStore(options = {}) {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : PIXEL_BAR_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let entries = new Map();
  let lastCommitAt = null;
  let commits = 0;

  function commit(bars) {
    const at = now();
    const next = new Map();
    for (const bar of Array.isArray(bars) ? bars : []) {
      next.set(bar.side + ':' + bar.rowIndex + ':' + bar.kind, { ...bar, at });
    }
    // 整包替换而不是合并：某一条这一轮没报，就说明它这轮没读到，不能留上一轮的值。
    entries = next;
    lastCommitAt = at;
    commits += 1;
    return snapshot();
  }

  function snapshot() {
    const current = now();
    const fresh = [];
    for (const entry of entries.values()) {
      if (current - entry.at > ttlMs) continue;
      fresh.push({
        side: entry.side,
        rowIndex: entry.rowIndex,
        kind: entry.kind,
        fillPercent: entry.fillPercent,
        status: entry.status,
        shieldPx: entry.shieldPx,
        dominantColor: entry.dominantColor
      });
    }
    const active = fresh.length > 0;
    return {
      active,
      // 只要收到过数据就给出最后一次提交时间（即使已经失效），诊断接口用它判断「多久没更新」。
      updatedAt: lastCommitAt,
      stale: entries.size > 0 && !active,
      bars: fresh,
      ttlMs,
      commits
    };
  }

  function clear() {
    entries = new Map();
    lastCommitAt = null;
  }

  return { commit, snapshot, clear, ttlMs, get commits() { return commits; } };
}

function percentOf(bar) {
  if (!bar || (bar.status !== 'ok' && bar.status !== 'ok_pale')) return null;
  const value = finiteNumber(bar.fillPercent);
  if (value === null) return null;
  return Math.max(0, Math.min(100, value));
}

function shieldPercentOf(bar) {
  if (!bar) return null;
  const px = finiteNumber(bar.shieldPx);
  if (px === null || px <= 0) return null;
  return Math.max(0, Math.min(100, (px / PIXEL_BAR_FULL_PX) * 100));
}

function nestedBar(bar) {
  if (!bar) return null;
  return {
    fillPercent: percentOf(bar),
    status: bar.status,
    shieldPx: finiteNumber(bar.shieldPx) === null ? 0 : Math.max(0, finiteNumber(bar.shieldPx)),
    dominantColor: bar.dominantColor || null
  };
}

// 把 bar 映射到玩家：依据是 Live Client Data 的队伍（team）与**该队伍内的出场顺序**，
// 不按屏幕坐标猜——观战 UI 的排列顺序可能与 allPlayers 不同，猜错就会把 A 的血条画到 B 身上。
// 超出 5 行的 bar 直接丢弃，绝不错位复用。
function applyBarsToPlayers(players, bars) {
  if (!Array.isArray(players) || !players.length) return players;
  const index = new Map();
  for (const bar of Array.isArray(bars) ? bars : []) {
    if (!bar || !SIDES.includes(bar.side) || !KINDS.includes(bar.kind)) continue;
    const row = Number(bar.rowIndex);
    if (!Number.isInteger(row) || row < ROW_MIN || row > ROW_MAX) continue;
    index.set(bar.side + ':' + row + ':' + bar.kind, bar);
  }
  const rows = { blue: 0, red: 0 };
  for (const player of players) {
    if (!player || typeof player !== 'object') continue;
    const side = player.team === 'blue' ? 'blue' : player.team === 'red' ? 'red' : null;
    if (!side) continue;
    const row = rows[side];
    rows[side] += 1;
    if (row > ROW_MAX) continue;
    const hp = index.get(side + ':' + row + ':hp') || null;
    const resource = index.get(side + ':' + row + ':resource') || null;
    // 每轮都重写全部像素字段：这一轮没读到的条必须是 null，不能留上一轮的旧值。
    player.hpPercent = percentOf(hp);
    player.resourcePercent = percentOf(resource);
    player.shieldPercent = shieldPercentOf(hp);
    player.resourceColor = resource && resource.dominantColor ? resource.dominantColor : null;
    player.pixelBars = hp || resource ? { hp: nestedBar(hp), resource: nestedBar(resource) } : null;
  }
  return players;
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    let done = false;
    const fail = error => { if (done) return; done = true; reject(error); };
    const declared = Number(req.headers && req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return fail(Object.assign(new Error('payload_too_large'), { statusCode: 413 }));
    }
    req.on('data', chunk => {
      if (done) return;
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) return fail(Object.assign(new Error('payload_too_large'), { statusCode: 413 }));
      raw += chunk;
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('invalid_json'), { statusCode: 400 })); }
    });
    req.on('error', error => fail(error));
  });
}

// 内部写接口：绝不写 Access-Control-Allow-Origin，浏览器页面无法跨源调用它。
function writeJson(res, statusCode, body) {
  if (!res || res.headersSent) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function handlePixelBarsApi(req, res, url, context = {}) {
  const store = context.store;
  const onUpdate = typeof context.onUpdate === 'function' ? context.onUpdate : null;
  const pathname = url && url.pathname ? url.pathname : '';

  if (pathname === '/api/pixel-bars/status') {
    if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
    const snapshot = store ? store.snapshot() : { active: false, updatedAt: null, stale: false, bars: [] };
    writeJson(res, 200, {
      ok: true,
      active: snapshot.active === true,
      updatedAt: snapshot.updatedAt,
      stale: snapshot.stale === true,
      ttlMs: snapshot.ttlMs,
      lastBars: snapshot.bars
    });
    return true;
  }

  if (pathname !== '/api/pixel-bars') return false;
  if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
  // 只接受本机来源。先判来源再读 body，避免外部请求白读 1MB。
  const remote = req.socket && req.socket.remoteAddress;
  if (!isLoopback(remote)) {
    writeJson(res, 403, { ok: false, error: 'forbidden_source' });
    return true;
  }
  readJsonBody(req, MAX_BODY_BYTES)
    .then(body => {
      const parsed = normalizePixelBarPayload(body);
      if (!parsed.ok) { writeJson(res, 400, { ok: false, error: 'invalid_pixel_bars', detail: parsed.reason }); return; }
      const snapshot = store ? store.commit(parsed.bars) : null;
      if (onUpdate && snapshot) onUpdate(snapshot);
      writeJson(res, 200, {
        ok: true,
        active: snapshot ? snapshot.active === true : false,
        updatedAt: snapshot ? snapshot.updatedAt : null,
        bars: parsed.bars.length
      });
    })
    .catch(error => {
      const status = error && error.statusCode ? error.statusCode : 500;
      writeJson(res, status, { ok: false, error: error && error.message ? error.message : 'pixel_bars_error' });
    });
  return true;
}

module.exports = {
  MAX_BODY_BYTES,
  PIXEL_BAR_TTL_MS,
  PIXEL_BAR_FULL_PX,
  SIDES,
  KINDS,
  STATUSES,
  isLoopback,
  normalizePixelBarPayload,
  createPixelBarStore,
  applyBarsToPlayers,
  handlePixelBarsApi
};
