'use strict';

// 协议流接入层（t30）。
//
// 背景：观战协议流（0xdd 包）的逐玩家 cs / gold / xp / KDA 由外部解码器进程解出（t16/t19），
// 主进程绝不自己去碰协议流或游戏内存。解码器把结果按本文件的包格式 POST 到 /api/protocol-feed，
// 再由 src/live-data.js 归一化进 capability 与 /events，结构与像素读条（t23）完全同构。
//
// 三条铁律（与像素读条一致）：
//   1) 解不出的值必须是 null，绝不用 0 或 LCDA 的量化值顶替；
//   2) 整包校验，任何一项非法就 400 且不写状态，绝不留半包；
//   3) 超过 2000ms 没有新包就整体失效，逐玩家精确字段回 null、capability 回 unavailable。

const { isLoopback } = require('./pixel-bars');

const MAX_BODY_BYTES = 1024 * 1024;
const PROTOCOL_FEED_TTL_MS = 2000;
const FEED_SOURCES = Object.freeze(['live', 'corpus']);
const EVENT_TYPES = Object.freeze(['kill', 'death', 'assist']);
const PARTICIPANT_MIN = 1;
const PARTICIPANT_MAX = 10;
// 观战协议里的 netid（如 0x400000ae）；只认十六进制串，避免把任意字符串当身份。
// t31 起 netid 可选：语料/回放解码器（decode_0xdd.py）解不出 netid，不能逼生产者伪造。
const NETID_PATTERN = /^0x[0-9a-fA-F]+$/;
// 英雄名对齐键：语料/协议流常给内部名（DrMundo），LCDA 给显示名（Dr. Mundo）。
// 比较前去掉非字母数字，避免标点差异让精确对齐失败、退到队伍游标猜测。
function championKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// 精度词汇与 data-capability 保持一致：只有 exact 能进 csExact/gold/xp/kdaExact，其余一律按降级处理。
const PRECISIONS = Object.freeze(['exact', 'quantized', 'estimated', 'unavailable']);
const DEFAULT_PRECISION = 'estimated';
const PRECISION_FIELDS = Object.freeze(['kills', 'deaths', 'assists', 'cs', 'xp', 'totalGold']);
// 同一局内的时序判定阈值：小于 50ms 视为同一帧重复，倒退超过 50ms 才算 rewind/stale，前进超过 600s 记为 jump。
const DUPLICATE_EPSILON = 0.05;
const JUMP_THRESHOLD = 600;

function normalizeInteger(raw, where, field, options = {}) {
  const nullable = options.nullable === true;
  if (raw === undefined || raw === null) {
    return nullable ? { ok: true, value: null } : { ok: false, reason: where + '.' + field + ' 缺失' };
  }
  const min = Number.isFinite(Number(options.min)) ? Number(options.min) : 0;
  const max = Number.isFinite(Number(options.max)) ? Number(options.max) : null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || (max !== null && raw > max)) {
    const range = max === null ? '>= ' + min : min + '..' + max;
    return {
      ok: false,
      reason: where + '.' + field + ' 必须是 ' + range + ' 的整数' + (nullable ? '或 null' : '') + '（不接受字符串）'
    };
  }
  return { ok: true, value: raw };
}

function normalizeSide(raw, where) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (raw !== 'blue' && raw !== 'red') return { ok: false, reason: where + '.team 必须是 blue/red 或 null' };
  return { ok: true, value: raw };
}

function normalizePlayerRecord(raw, position) {
  const where = 'players[' + position + ']';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: where + ' 不是对象' };
  // netid 可选：没给就是 null（回放/语料解码的常态）；给了就必须是合法十六进制串。
  let netid = null;
  if (raw.netid !== undefined && raw.netid !== null && raw.netid !== '') {
    if (typeof raw.netid !== 'string' || !NETID_PATTERN.test(raw.netid.trim())) {
      return { ok: false, reason: where + '.netid 必须是 0x 开头的十六进制串（如 0x400000ae）或 null' };
    }
    netid = raw.netid.trim();
  }
  // puuid 是 netid 缺席时最强的稳定身份（语料里有），只校验形状，不猜。
  let puuid = null;
  if (raw.puuid !== undefined && raw.puuid !== null && raw.puuid !== '') {
    if (typeof raw.puuid !== 'string' || !raw.puuid.trim()) {
      return { ok: false, reason: where + '.puuid 必须是非空字符串或 null' };
    }
    puuid = raw.puuid.trim();
  }
  const participant = normalizeInteger(raw.participantId, where, 'participantId', { min: PARTICIPANT_MIN, max: PARTICIPANT_MAX });
  if (!participant.ok) return participant;
  const side = normalizeSide(raw.team, where);
  if (!side.ok) return side;
  // KDA 与 cs/gold/xp 都允许 null：解不出就是 null，绝不用 0 补齐。
  const counts = {};
  for (const field of ['kills', 'deaths', 'assists', 'cs', 'xp', 'totalGold']) {
    const result = normalizeInteger(raw[field], where, field, { nullable: true, min: 0 });
    if (!result.ok) return result;
    counts[field] = result.value;
  }
  let asOf = null;
  if (raw.asOf !== undefined && raw.asOf !== null) {
    if (typeof raw.asOf !== 'number' || !Number.isFinite(raw.asOf) || raw.asOf < 0) {
      return { ok: false, reason: where + '.asOf 必须是非负有限数或 null（该值对应的游戏时间，秒）' };
    }
    asOf = raw.asOf;
  }
  // championName 是可选的对齐线索：LCDA 的 allPlayers 没有 participantId，
  // 有英雄名时可以精确对齐，没有才退回「队伍 + 队伍内出场顺序」。
  let championName = null;
  if (raw.championName !== undefined && raw.championName !== null) {
    if (typeof raw.championName !== 'string' || !raw.championName.trim()) {
      return { ok: false, reason: where + '.championName 必须是非空字符串或 null' };
    }
    championName = raw.championName.trim();
  }
  // 每个字段的精度必须由生产者声明；没声明一律按 estimated（fail closed：没声明就不许标 exact）。
  const rawPrecision = raw.precision && typeof raw.precision === 'object' && !Array.isArray(raw.precision) ? raw.precision : {};
  const precision = {};
  for (const field of PRECISION_FIELDS) {
    const value = rawPrecision[field];
    if (value === undefined || value === null) { precision[field] = DEFAULT_PRECISION; continue; }
    if (!PRECISIONS.includes(value)) return { ok: false, reason: where + '.precision.' + field + ' 必须是 ' + PRECISIONS.join('/') };
    precision[field] = value;
  }
  return {
    ok: true,
    player: {
      netid,
      puuid,
      // 稳定身份：一条记录只能被一个玩家认领（见 createProtocolLookup 的 claimed）。
      identity: puuid ? 'puuid:' + puuid : netid ? 'netid:' + netid.toLowerCase() : 'participant:' + participant.value,
      participantId: participant.value,
      team: side.value,
      kills: counts.kills,
      deaths: counts.deaths,
      assists: counts.assists,
      cs: counts.cs,
      totalGold: counts.totalGold,
      xp: counts.xp,
      asOf,
      precision,
      championName
    }
  };
}

function normalizeEvent(raw, position) {
  const where = 'events[' + position + ']';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: where + ' 不是对象' };
  if (typeof raw.t !== 'number' || !Number.isFinite(raw.t) || raw.t < 0) {
    return { ok: false, reason: where + '.t 必须是非负有限数（游戏时间，秒）' };
  }
  if (!EVENT_TYPES.includes(raw.type)) {
    return { ok: false, reason: where + '.type 必须是 ' + EVENT_TYPES.join('/') };
  }
  const killer = normalizeInteger(raw.killer, where, 'killer', { nullable: true, min: PARTICIPANT_MIN, max: PARTICIPANT_MAX });
  if (!killer.ok) return killer;
  const victim = normalizeInteger(raw.victim, where, 'victim', { nullable: true, min: PARTICIPANT_MIN, max: PARTICIPANT_MAX });
  if (!victim.ok) return victim;
  const assists = [];
  if (raw.assists !== undefined && raw.assists !== null) {
    if (!Array.isArray(raw.assists)) return { ok: false, reason: where + '.assists 必须是 participantId 数组' };
    for (let i = 0; i < raw.assists.length; i += 1) {
      const id = normalizeInteger(raw.assists[i], where, 'assists[' + i + ']', { min: PARTICIPANT_MIN, max: PARTICIPANT_MAX });
      if (!id.ok) return id;
      assists.push(id.value);
    }
  }
  let confidence = null;
  if (raw.confidence !== undefined && raw.confidence !== null) {
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
      return { ok: false, reason: where + '.confidence 必须是 0..1 的有限数或 null' };
    }
    confidence = raw.confidence;
  }
  return { ok: true, event: { t: raw.t, type: raw.type, killer: killer.value, victim: victim.value, assists, confidence } };
}

// 整包校验：先全量验证再提交，保证「非法包 400 且不污染状态」。
function normalizeFeed(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!source) return { ok: false, reason: '请求体必须是 JSON 对象' };
  let feedSource = 'live';
  if (source.source !== undefined && source.source !== null) {
    if (!FEED_SOURCES.includes(source.source)) return { ok: false, reason: 'source 必须是 ' + FEED_SOURCES.join('/') };
    feedSource = source.source;
  }
  let gameTime = 0;
  if (source.gameTime !== undefined && source.gameTime !== null) {
    if (typeof source.gameTime !== 'number' || !Number.isFinite(source.gameTime) || source.gameTime < 0) {
      return { ok: false, reason: 'gameTime 必须是非负有限数' };
    }
    gameTime = source.gameTime;
  }
  let updatedAt = null;
  if (source.updatedAt !== undefined && source.updatedAt !== null) {
    if (typeof source.updatedAt !== 'number' || !Number.isFinite(source.updatedAt) || source.updatedAt < 0) {
      return { ok: false, reason: 'updatedAt 必须是非负有限数（毫秒时间戳）' };
    }
    updatedAt = source.updatedAt;
  }
  let gameId = null;
  if (source.gameId !== undefined && source.gameId !== null) {
    if (typeof source.gameId !== 'string' && typeof source.gameId !== 'number') {
      return { ok: false, reason: 'gameId 必须是字符串或数字' };
    }
    gameId = String(source.gameId).trim();
    if (!gameId) return { ok: false, reason: 'gameId 不能是空字符串' };
  }
  if (!Array.isArray(source.players)) return { ok: false, reason: 'players 必须是数组' };
  if (source.events !== undefined && source.events !== null && !Array.isArray(source.events)) {
    return { ok: false, reason: 'events 必须是数组' };
  }
  const players = [];
  for (let i = 0; i < source.players.length; i += 1) {
    const result = normalizePlayerRecord(source.players[i], i);
    if (!result.ok) return result;
    players.push(result.player);
  }
  // 同一 participantId / netid 出现两次视为非法：无法判断哪个是真的，宁可拒绝也不猜。
  const seenParticipant = new Set();
  const seenNetid = new Set();
  const seenPuuid = new Set();
  for (const player of players) {
    if (seenParticipant.has(player.participantId)) {
      return { ok: false, reason: '重复的 participantId：' + player.participantId };
    }
    if (player.netid !== null && seenNetid.has(player.netid.toLowerCase())) {
      return { ok: false, reason: '重复的 netid：' + player.netid };
    }
    if (player.puuid !== null && seenPuuid.has(player.puuid)) {
      return { ok: false, reason: '重复的 puuid：' + player.puuid };
    }
    seenParticipant.add(player.participantId);
    if (player.netid !== null) seenNetid.add(player.netid.toLowerCase());
    if (player.puuid !== null) seenPuuid.add(player.puuid);
  }
  const events = [];
  const eventList = Array.isArray(source.events) ? source.events : [];
  for (let i = 0; i < eventList.length; i += 1) {
    const result = normalizeEvent(eventList[i], i);
    if (!result.ok) return result;
    events.push(result.event);
  }
  return { ok: true, feed: { source: feedSource, gameId, gameTime, updatedAt, players, events } };
}

// 最近一包的缓存：超过 ttl 即整体失效（active=false），players/events 一并清空，
// 调用方拿到的就是「没有精确数据」，不可能拿旧包冒充当前对局。
function createProtocolFeedStore(options = {}) {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : PROTOCOL_FEED_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let latest = null;
  let commits = 0;

  // 乱序策略（t31 契约）：只判定「这一包相对上一包是什么」，不改状态。
  //   first     第一包
  //   reset     gameId 变了（跨局/换局）——接受并清空旧局
  //   duplicate 同一帧重发（1Hz 心跳）——只刷 TTL，不广播
  //   rewind    回放拖动（source=corpus）允许倒退
  //   stale_frame 实时源时间倒退——不接受、不清空，保持上一帧直到 TTL 过期
  //   jump      时间前进超过 600s——接受但记 jump（回放跳转）
  function classify(feed) {
    if (!latest) return { accepted: true, first: true, duplicate: false, rewind: false, reset: false, jump: false, reason: 'first_packet' };
    const previous = latest.feed;
    if (String(previous.gameId) !== String(feed.gameId)) {
      return { accepted: true, first: false, duplicate: false, rewind: false, reset: true, jump: false, reason: 'game_changed' };
    }
    const delta = feed.gameTime - previous.gameTime;
    if (Math.abs(delta) < DUPLICATE_EPSILON) {
      return { accepted: true, first: false, duplicate: true, rewind: false, reset: false, jump: false, reason: 'duplicate' };
    }
    if (delta < 0) {
      if (feed.source === 'corpus') {
        return { accepted: true, first: false, duplicate: false, rewind: true, reset: false, jump: false, reason: 'rewind' };
      }
      return { accepted: false, first: false, duplicate: false, rewind: false, reset: false, jump: false, reason: 'stale_frame' };
    }
    if (delta > JUMP_THRESHOLD) {
      return { accepted: true, first: false, duplicate: false, rewind: false, reset: false, jump: true, reason: 'jump' };
    }
    return { accepted: true, first: false, duplicate: false, rewind: false, reset: false, jump: false, reason: 'advance' };
  }

  function commit(feed) {
    const decision = classify(feed);
    if (!decision.accepted) {
      // stale_frame：不写 latest、不刷 at，也不改 commits——旧帧留在原地等 TTL。
      return Object.assign(snapshot(), decision, { committed: false });
    }
    latest = { feed, at: now() };
    commits += 1;
    return Object.assign(snapshot(), decision, { committed: true });
  }

  function snapshot() {
    const at = latest ? latest.at : null;
    const age = latest ? Math.max(0, now() - latest.at) : null;
    const active = !!latest && age <= ttlMs;
    const feed = active ? latest.feed : null;
    return {
      active,
      // 收到过就给最后一次提交时间（即使已失效），诊断接口用它判断「多久没更新」。
      updatedAt: at,
      ageMs: age,
      stale: !!latest && !active,
      ttlMs,
      commits,
      feed,
      players: feed ? feed.players : [],
      events: feed ? feed.events : [],
      gameId: feed ? feed.gameId : null,
      gameTime: feed ? feed.gameTime : null
    };
  }

  function clear() { latest = null; }

  return { commit, snapshot, clear, ttlMs, get commits() { return commits; } };
}

function sideOfTeam(value) {
  const side = String(value || '').toUpperCase();
  if (side === 'BLUE' || side === 'ORDER') return 'blue';
  if (side === 'RED' || side === 'CHAOS') return 'red';
  return null;
}

// LCDA 的 allPlayers 没有 participantId，只能对齐：优先英雄名（精确），
// 否则按「队伍 + 队伍内出场顺序」——与像素读条同一依据，不按屏幕坐标猜。
function createProtocolLookup(players) {
  const list = Array.isArray(players) ? players : [];
  const byChampion = new Map();
  const byTeamRow = new Map();
  const rows = { blue: 0, red: 0 };
  for (const record of list) {
    if (!record || typeof record !== 'object') continue;
    if (record.championName) byChampion.set(championKey(record.championName), record);
    const side = sideOfTeam(record.team);
    if (!side) continue;
    const row = rows[side];
    rows[side] += 1;
    byTeamRow.set(side + ':' + row, record);
  }
  const cursor = { blue: 0, red: 0 };
  // 一条协议流记录只能被一个玩家认领：否则英雄名匹配失败的玩家会顶替别人已经拿到的数据，
  // 两名玩家显示同一份 cs/gold/xp，比没有数据更糟。
  const claimed = new Set();
  const identityOf = record => (record.identity ? record.identity : record.puuid ? 'puuid:' + record.puuid : record.netid ? 'netid:' + record.netid.toLowerCase() : 'participant:' + record.participantId);
  return function resolve(player) {
    if (!player || typeof player !== 'object') return null;
    const champion = championKey(player.championName || player.champion);
    if (champion && byChampion.has(champion)) {
      const record = byChampion.get(champion);
      const key = identityOf(record);
      if (!claimed.has(key)) { claimed.add(key); return record; }
    }
    const side = sideOfTeam(player.team);
    if (!side) return null;
    while (cursor[side] <= PARTICIPANT_MAX) {
      const record = byTeamRow.get(side + ':' + cursor[side]);
      cursor[side] += 1;
      if (!record) continue;
      const identity = identityOf(record);
      if (claimed.has(identity)) continue;
      claimed.add(identity);
      return record;
    }
    return null;
  };
}

// 协议流这一轮到底给出了哪些字段：capability 只把「有值且生产者声明 exact」的字段标 exact。
// 没声明精度（默认 estimated）或声明了 quantized/estimated/unavailable 一律不算精确值。
function isExactField(record, key) {
  return !!record && record.precision && record.precision[key] === 'exact' && record[key] !== null && record[key] !== undefined;
}

function protocolPresence(players) {
  const list = Array.isArray(players) ? players : [];
  const has = key => list.some(record => isExactField(record, key));
  // 键名对齐 capability 语义（cs/gold/xp）：gold 即 totalGold 字段的 exact presence。
  return { cs: has('cs'), gold: has('totalGold'), xp: has('xp') };
}

// 把协议流读数写进（已归一化的）玩家：每轮重写，没匹配到或精度不足的必须是 null。
// 只有 precision === 'exact' 的字段才允许进 csExact/gold/xp/kdaExact；quantized/estimated 一律不冒充精确值。
function applyProtocolToPlayers(players, feedPlayers) {
  if (!Array.isArray(players) || !players.length) return players;
  const lookup = createProtocolLookup(feedPlayers);
  for (const player of players) {
    if (!player || typeof player !== 'object') continue;
    const record = lookup(player);
    const pickExact = key => (isExactField(record, key) ? record[key] : null);
    player.csExact = pickExact('cs');
    player.totalGold = pickExact('totalGold');
    player.xp = pickExact('xp');
    const asOf = record && record.asOf !== null && record.asOf !== undefined ? record.asOf : null;
    player.csAsOf = player.csExact === null ? null : asOf;
    player.xpAsOf = player.xp === null ? null : asOf;
    // KDA 三项都必须是 exact 且有值才覆盖 LCDA；缺一项/有一项不是 exact 就整组不覆盖，绝不用 0 补齐。
    // kdaExact 同步维护：页面/控台靠它判断这块 KDA 是协议流给的还是官方 REST 给的，
    // 不能出现「数值已经换成协议流、来源标记还写着 LCDA」的错位。
    if (isExactField(record, 'kills') && isExactField(record, 'deaths') && isExactField(record, 'assists')) {
      player.kills = record.kills;
      player.deaths = record.deaths;
      player.assists = record.assists;
      player.kdaExact = { kills: record.kills, deaths: record.deaths, assists: record.assists, asOf: asOf === null ? null : asOf };
    } else {
      player.kdaExact = null;
    }
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

function handleProtocolFeedApi(req, res, url, context = {}) {
  const store = context.store;
  const onUpdate = typeof context.onUpdate === 'function' ? context.onUpdate : null;
  const pathname = url && url.pathname ? url.pathname : '';

  if (pathname === '/api/protocol-feed/status') {
    if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
    const snapshot = store ? store.snapshot() : { active: false, updatedAt: null, stale: false, players: [], events: [] };
    writeJson(res, 200, {
      ok: true,
      active: snapshot.active === true,
      updatedAt: snapshot.updatedAt,
      ageMs: snapshot.ageMs === undefined ? null : snapshot.ageMs,
      stale: snapshot.stale === true,
      ttlMs: snapshot.ttlMs,
      gameId: snapshot.gameId === undefined ? null : snapshot.gameId,
      gameTime: snapshot.gameTime === undefined ? null : snapshot.gameTime,
      players: Array.isArray(snapshot.players) ? snapshot.players.length : 0,
      events: Array.isArray(snapshot.events) ? snapshot.events.length : 0,
      lastFeed: snapshot.active === true ? { players: snapshot.players, events: snapshot.events } : null
    });
    return true;
  }

  if (pathname !== '/api/protocol-feed') return false;
  if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
  // 只接受本机来源。先判来源再读 body，避免外部请求白读 1MB。
  const remote = req.socket && req.socket.remoteAddress;
  if (!isLoopback(remote)) {
    writeJson(res, 403, { ok: false, error: 'forbidden_source' });
    return true;
  }
  readJsonBody(req, MAX_BODY_BYTES)
    .then(body => {
      const parsed = normalizeFeed(body);
      if (!parsed.ok) { writeJson(res, 400, { ok: false, error: 'invalid_protocol_feed', detail: parsed.reason }); return; }
      const snapshot = store ? store.commit(parsed.feed) : null;
      // duplicate（1Hz 心跳）只刷 TTL，不广播；stale_frame 不写状态也不广播。
      if (onUpdate && snapshot && snapshot.accepted !== false && snapshot.duplicate !== true) onUpdate(snapshot);
      writeJson(res, 200, {
        ok: true,
        accepted: snapshot ? snapshot.accepted !== false : false,
        committed: snapshot ? snapshot.committed === true : false,
        duplicate: snapshot ? snapshot.duplicate === true : false,
        rewind: snapshot ? snapshot.rewind === true : false,
        reset: snapshot ? snapshot.reset === true : false,
        jump: snapshot ? snapshot.jump === true : false,
        reason: snapshot ? snapshot.reason : 'no_store',
        active: snapshot ? snapshot.active === true : false,
        updatedAt: snapshot ? snapshot.updatedAt : null,
        players: parsed.feed.players.length,
        events: parsed.feed.events.length
      });
    })
    .catch(error => {
      const status = error && error.statusCode ? error.statusCode : 500;
      writeJson(res, status, { ok: false, error: error && error.message ? error.message : 'protocol_feed_error' });
    });
  return true;
}

module.exports = {
  MAX_BODY_BYTES,
  PROTOCOL_FEED_TTL_MS,
  PRECISIONS,
  DEFAULT_PRECISION,
  PRECISION_FIELDS,
  DUPLICATE_EPSILON,
  JUMP_THRESHOLD,
  isExactField,
  championKey,
  FEED_SOURCES,
  EVENT_TYPES,
  PARTICIPANT_MIN,
  PARTICIPANT_MAX,
  isLoopback,
  normalizePlayerRecord,
  normalizeEvent,
  normalizeFeed,
  createProtocolFeedStore,
  createProtocolLookup,
  protocolPresence,
  applyProtocolToPlayers,
  handleProtocolFeedApi
};
