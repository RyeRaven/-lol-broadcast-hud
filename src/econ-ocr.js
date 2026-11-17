'use strict';

// 屏幕经济面板 OCR 接入层。
//
// 背景：Live Client Data 没有逐玩家金币字段，0xdd 解码已证明无法用真值锚定（t17），
// 但游戏自带的经济面板（观战 HUD 底部 X 面板）每行白字「当前(总)」括号里的总金币
// 与 LCU timeline 的 totalGold 真值逐格一致（2560x1440 实测十格全对）。
// 唯一可行的实时逐人金币来源 = 同机独立进程截屏 + 结构锚点 + 字形模板匹配
// （tools/pixel-bars/econ_ocr.py），把解析出的总金币经本地 HTTP 喂给主进程。
//
// 契约只有总金币（用户定案：当前金币不采，软件要通用不钉分辨率/坐标）：
//   rows:[{side, rowIndex, totalGold, confidence}]
//   某行没上报 = 这轮没解析到（HUD 对该玩家回退估算并标「估算」），绝不伪造数值。
// 整帧没有可信面板 = 不上报 rows，store 过 TTL 后整体失效，契约降回 unavailable。

const MAX_BODY_BYTES = 1024 * 1024;
// 超过这个时间没收到新解析结果一律视为失效：宁可回退估算，也不能拿上一帧的金币冒充当前值。
const ECON_OCR_TTL_MS = 2000;

const SIDES = Object.freeze(['blue', 'red']);
const ROW_MIN = 0;
const ROW_MAX = 4;
// 只允许本机回环地址写入：这是内部数据通道，不是公开接口。
const LOOPBACK_ADDRESSES = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']);

function isLoopback(address) {
  return LOOPBACK_ADDRESSES.includes(String(address || ''));
}

// 单行解析结果的校验：任何字段非法都返回 { ok:false, reason }，由调用方整包拒绝。
function normalizeRow(raw, position) {
  const where = 'rows[' + position + ']';
  if (!raw || typeof raw !== 'object') return { ok: false, reason: where + ' 不是对象' };
  const side = String(raw.side || '');
  if (!SIDES.includes(side)) return { ok: false, reason: where + '.side 必须是 blue/red' };
  const rowIndex = Number(raw.rowIndex);
  if (!Number.isInteger(rowIndex) || rowIndex < ROW_MIN || rowIndex > ROW_MAX) {
    return { ok: false, reason: where + '.rowIndex 必须是 0..4 的整数' };
  }
  const totalGold = Number(raw.totalGold);
  if (!Number.isInteger(totalGold) || totalGold < 0 || totalGold > 999999) {
    return { ok: false, reason: where + '.totalGold 必须是 0..999999 的整数' };
  }
  let confidence = null;
  if (raw.confidence !== undefined && raw.confidence !== null) {
    const value = Number(raw.confidence);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return { ok: false, reason: where + '.confidence 必须是 0..1 的有限数' };
    }
    confidence = value;
  }
  return {
    ok: true,
    row: { side, rowIndex, totalGold, confidence }
  };
}

// 整包校验：先全量验证再提交，保证「非法包 400 且不污染状态」。
function normalizeEconOcrPayload(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!source) return { ok: false, reason: '请求体必须是 JSON 对象' };
  if (!Array.isArray(source.rows)) return { ok: false, reason: 'rows 必须是数组' };
  if (source.source !== undefined && source.source !== 'econ-ocr') return { ok: false, reason: "source 必须是 'econ-ocr'" };
  const rows = [];
  for (let i = 0; i < source.rows.length; i += 1) {
    const result = normalizeRow(source.rows[i], i);
    if (!result.ok) return { ok: false, reason: result.reason };
    rows.push(result.row);
  }
  // 同一 (side,rowIndex) 出现两次视为非法：无法判断哪个是真的，宁可拒绝也不猜。
  const seen = new Set();
  for (const row of rows) {
    const key = row.side + ':' + row.rowIndex;
    if (seen.has(key)) return { ok: false, reason: '重复的 row：' + key };
    seen.add(key);
  }
  return { ok: true, rows };
}

// 解析结果缓存：按 (side,rowIndex) 存最后一条，超过 ttl 即失效。
function createEconOcrStore(options = {}) {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : ECON_OCR_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let entries = new Map();
  let lastCommitAt = null;
  let commits = 0;

  function commit(rows) {
    const at = now();
    const next = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      next.set(row.side + ':' + row.rowIndex, { ...row, at });
    }
    // 整包替换而不是合并：某一行这一轮没报，就说明这轮没解析到，不能留上一帧的值。
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
        totalGold: entry.totalGold,
        confidence: entry.confidence
      });
    }
    const active = fresh.length > 0;
    return {
      active,
      // 只要收到过数据就给出最后一次提交时间（即使已经失效），诊断接口用它判断「多久没更新」。
      updatedAt: lastCommitAt,
      stale: entries.size > 0 && !active,
      rows: fresh,
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

// 把 OCR 行映射到玩家：依据是 Live Client Data 的队伍（team）与该队伍内的出场顺序，
// 与 applyBarsToPlayers 同构——观战面板的排列顺序按参与者序，不按屏幕坐标猜。
// 与像素读条不同，econ 行允许稀疏（某一行的字形没匹配上就不报）：只有命中行写入，
// 其它玩家不动（保留协议流/LCDA 原值），但上一轮 econ 写过的标记必须清掉，不能留旧值。
function applyEconOcrToPlayers(players, rows) {
  if (!Array.isArray(players) || !players.length) return players;
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !SIDES.includes(row.side)) continue;
    const rowIndex = Number(row.rowIndex);
    if (!Number.isInteger(rowIndex) || rowIndex < ROW_MIN || rowIndex > ROW_MAX) continue;
    if (!Number.isInteger(row.totalGold) || row.totalGold < 0) continue;
    index.set(row.side + ':' + rowIndex, row);
  }
  const cursor = { blue: 0, red: 0 };
  for (const player of players) {
    if (!player || typeof player !== 'object') continue;
    const hadEcon = player.econGold !== null && player.econGold !== undefined;
    const side = player.team === 'blue' ? 'blue' : player.team === 'red' ? 'red' : null;
    if (!side) continue;
    const row = cursor[side];
    cursor[side] += 1;
    const hit = row <= ROW_MAX ? (index.get(side + ':' + row) || null) : null;
    if (!hit) {
      // 上一轮 econ 写过而这一轮没命中：金币与标记必须一起清，不许留上一帧的值冒充当前。
      if (hadEcon) {
        player.econGold = null;
        player.totalGold = null;
        player.totalGoldPrecision = null;
      }
      continue;
    }
    player.econGold = hit.totalGold;
    // HUD 读的是 player.totalGold：直接写真值并标 exact，页面零改动就能画对。
    player.totalGold = hit.totalGold;
    player.totalGoldPrecision = 'exact';
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

function handleEconOcrApi(req, res, url, context = {}) {
  const store = context.store;
  const onUpdate = typeof context.onUpdate === 'function' ? context.onUpdate : null;
  const pathname = url && url.pathname ? url.pathname : '';

  if (pathname === '/api/econ-ocr/status') {
    if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
    const snapshot = store ? store.snapshot() : { active: false, updatedAt: null, stale: false, rows: [] };
    writeJson(res, 200, {
      ok: true,
      active: snapshot.active === true,
      updatedAt: snapshot.updatedAt,
      stale: snapshot.stale === true,
      ttlMs: snapshot.ttlMs,
      lastRows: snapshot.rows
    });
    return true;
  }

  if (pathname !== '/api/econ-ocr') return false;
  if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
  // 只接受本机来源。先判来源再读 body，避免外部请求白读 1MB。
  const remote = req.socket && req.socket.remoteAddress;
  if (!isLoopback(remote)) {
    writeJson(res, 403, { ok: false, error: 'forbidden_source' });
    return true;
  }
  readJsonBody(req, MAX_BODY_BYTES)
    .then(body => {
      const parsed = normalizeEconOcrPayload(body);
      if (!parsed.ok) { writeJson(res, 400, { ok: false, error: 'invalid_econ_ocr', detail: parsed.reason }); return; }
      const snapshot = store ? store.commit(parsed.rows) : null;
      if (onUpdate && snapshot) onUpdate(snapshot);
      writeJson(res, 200, {
        ok: true,
        active: snapshot ? snapshot.active === true : false,
        updatedAt: snapshot ? snapshot.updatedAt : null,
        rows: parsed.rows.length
      });
    })
    .catch(error => {
      const status = error && error.statusCode ? error.statusCode : 500;
      writeJson(res, status, { ok: false, error: error && error.message ? error.message : 'econ_ocr_error' });
    });
  return true;
}

module.exports = {
  MAX_BODY_BYTES,
  ECON_OCR_TTL_MS,
  SIDES,
  isLoopback,
  normalizeEconOcrPayload,
  createEconOcrStore,
  applyEconOcrToPlayers,
  handleEconOcrApi
};
