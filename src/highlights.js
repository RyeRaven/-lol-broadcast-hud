'use strict';

// Live Client Data 事件 → 导播高光评分。
// 纯函数：只解析 /liveclientdata/allgamedata 的 payload，不读取游戏内存。
// 输出 { id, time, type, side, text, score, champion, player }，按 score 降序、time 降序排列。
// 同队 5 秒内的多个高光会合并成一条 combo，分数累计；请求失败/空事件都必须安全返回 []。

const { sideFromTeamValue: sideFromTeam, sideFromTurretName } = require('./side');

const MAX_HIGHLIGHTS = 20;
const DEFAULT_COMBO_WINDOW = 5;

const SCORE_WEIGHTS = Object.freeze({
  doublekill: 35,
  triplekill: 60,
  quadrakill: 80,
  pentakill: 100,
  first_blood: 45,
  baron: 70,
  dragon: 30,
  elder_dragon: 60,
  herald: 35,
  horde: 20,
  tower: 25,
  first_brick: 40,
  ace: 65,
  game_end: 10
});

const MULTIKILL_TYPES = Object.freeze({ 2: 'doublekill', 3: 'triplekill', 4: 'quadrakill', 5: 'pentakill' });
const MULTIKILL_TEXT = Object.freeze({ 2: '双杀', 3: '三杀', 4: '四杀', 5: '五杀' });
const SIDE_TEXT = Object.freeze({ blue: '蓝方', red: '红方' });
const DRAGON_TEXT = Object.freeze({
  Fire: '火龙', Earth: '土龙', Water: '水龙', Air: '风龙',
  Hextech: '海克斯龙', Chemtech: '炼金龙', Elder: '远古龙'
});

function stripTag(name) { return String(name || '').replace(/#.*$/, '').trim(); }

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function eventTime(event) {
  const seconds = toNumber(event && event.EventTime, 0);
  return Math.max(0, Math.round(seconds * 1000) / 1000);
}

function extractEvents(payload) {
  if (Array.isArray(payload)) return payload.filter(Boolean);
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.events)) return payload.events.filter(Boolean);
  if (payload.events && Array.isArray(payload.events.Events)) return payload.events.Events.filter(Boolean);
  return [];
}

function extractPlayers(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Array.isArray(payload.allPlayers) ? payload.allPlayers.filter(Boolean) : [];
}

function buildPlayerIndex(players) {
  const index = new Map();
  for (const player of Array.isArray(players) ? players : []) {
    if (!player || typeof player !== 'object') continue;
    const rawName = player.summonerName || player.riotIdGameName || player.riotId || player.name || '';
    const plainName = stripTag(rawName);
    const champion = player.championName || player.champion || '';
    const side = sideFromTeam(player.team);
    const record = { side, champion: String(champion || ''), player: plainName, name: plainName };
    for (const key of [rawName, plainName, champion]) {
      if (!key) continue;
      index.set(String(key), record);
      index.set(String(key).toLowerCase(), record);
    }
  }
  return index;
}

function lookupPlayer(index, name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const plain = stripTag(raw);
  return index.get(raw) || index.get(plain) || index.get(raw.toLowerCase()) || index.get(plain.toLowerCase()) || null;
}

function displayName(record, fallback) {
  if (record && record.champion) return record.champion;
  if (record && record.player) return record.player;
  return stripTag(fallback);
}

function sidePrefix(side) { return SIDE_TEXT[side] ? SIDE_TEXT[side] + ' ' : ''; }

function eventKey(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.EventID !== undefined && event.EventID !== null && event.EventID !== '') return String(event.EventID);
  return [
    event.EventName || '', event.EventTime, event.KillerName || '', event.VictimName || '',
    event.Recipient || '', event.KillStreak == null ? '' : event.KillStreak,
    event.DragonType || '', event.TurretKilled || ''
  ].join('|');
}

function actorFor(event, playerIndex, preferRecipient = false) {
  const killer = lookupPlayer(playerIndex, event && event.KillerName);
  const recipient = lookupPlayer(playerIndex, event && event.Recipient);
  const actor = preferRecipient ? (recipient || killer) : (killer || recipient);
  const fallback = preferRecipient
    ? (event && (event.Recipient || event.KillerName))
    : (event && (event.KillerName || event.Recipient));
  return { actor, name: displayName(actor, fallback), fallback: stripTag(fallback) };
}

function makeEntry(event, type, text, actor, sideOverride) {
  const score = SCORE_WEIGHTS[type];
  if (!score) return null;
  const side = sideOverride || (actor && actor.side) || sideFromTeam(event && (event.KillerTeam || event.RecipientTeam || event.Team)) || null;
  return {
    id: eventKey(event),
    time: eventTime(event),
    type,
    side,
    text: String(text || '').trim(),
    score,
    champion: actor && actor.champion ? actor.champion : '',
    player: actor && actor.player ? actor.player : stripTag(event && (event.KillerName || event.Recipient))
  };
}

function multikillEntry(event, streak, playerIndex, idPrefix) {
  const count = Math.max(2, Math.min(5, Math.floor(toNumber(streak, 2))));
  const type = MULTIKILL_TYPES[count];
  const { actor, name } = actorFor(event, playerIndex, false);
  const entry = makeEntry(event, type, sidePrefix(actor && actor.side) + (name ? name + ' ' : '') + MULTIKILL_TEXT[count], actor);
  if (entry && idPrefix) entry.id = idPrefix + entry.id;
  return entry;
}

function toHighlight(event, playerIndex) {
  if (!event || typeof event !== 'object') return null;
  const eventName = String(event.EventName || '');
  if (!eventName) return null;

  switch (eventName) {
    case 'Multikill': {
      const streak = toNumber(event.KillStreak, 0);
      if (streak < 2) return null;
      return multikillEntry(event, streak, playerIndex);
    }
    case 'ChampionKill': {
      // 常规击杀不计入高光；只有事件本身带 KillStreak 时才视为多杀。
      const streak = toNumber(event.KillStreak, 0);
      return streak >= 2 ? multikillEntry(event, streak, playerIndex) : null;
    }
    case 'FirstBlood': {
      const { actor, name } = actorFor(event, playerIndex, true);
      const side = (actor && actor.side) || null;
      return makeEntry(event, 'first_blood', sidePrefix(side) + (name ? name + ' ' : '') + '拿下一血', actor, side);
    }
    case 'DragonKill':
    case 'ElderDragonKill': {
      const { actor, name } = actorFor(event, playerIndex, false);
      const type = eventName === 'ElderDragonKill' || /elder|远古/i.test(String(event.DragonType || '')) ? 'elder_dragon' : 'dragon';
      const dragon = DRAGON_TEXT[event.DragonType] || (type === 'elder_dragon' ? '远古龙' : (event.DragonType ? String(event.DragonType) + '龙' : '小龙'));
      return makeEntry(event, type, sidePrefix(actor && actor.side) + (name ? name + ' ' : '') + '击杀' + dragon, actor);
    }
    case 'BaronKill': {
      const { actor, name } = actorFor(event, playerIndex, false);
      return makeEntry(event, 'baron', sidePrefix(actor && actor.side) + (name ? name + ' ' : '') + '击杀纳什男爵', actor);
    }
    case 'HeraldKill': {
      const { actor, name } = actorFor(event, playerIndex, false);
      return makeEntry(event, 'herald', sidePrefix(actor && actor.side) + (name ? name + ' ' : '') + '击杀峡谷先锋', actor);
    }
    case 'HordeKill': {
      const { actor, name } = actorFor(event, playerIndex, false);
      return makeEntry(event, 'horde', sidePrefix(actor && actor.side) + (name ? name + ' ' : '') + '击杀虚空巢虫', actor);
    }
    case 'TurretKilled': {
      const { actor, name } = actorFor(event, playerIndex, false);
      const side = (actor && actor.side) || sideFromTurretName(event.TurretKilled);
      return makeEntry(event, 'tower', sidePrefix(side) + (name ? name + ' ' : '') + '推掉一座防御塔', actor, side);
    }
    case 'FirstBrick': {
      const { actor, name } = actorFor(event, playerIndex, false);
      return makeEntry(event, 'first_brick', sidePrefix(actor && actor.side) + (name ? name + ' ' : '') + '拿下首座防御塔', actor);
    }
    case 'Ace': {
      const side = sideFromTeam(event.AcingTeam || event.Team || event.KillerTeam) || (lookupPlayer(playerIndex, event.KillerName) || {}).side || null;
      return makeEntry(event, 'ace', sidePrefix(side) + '团灭对手', lookupPlayer(playerIndex, event.KillerName), side);
    }
    case 'GameEnd': {
      const side = sideFromTeam(event.WinnerTeam || event.WinningTeam || event.Result) || null;
      return makeEntry(event, 'game_end', '比赛结束', null, side);
    }
    default:
      return null;
  }
}

function dedupeEntries(entries) {
  const seenIds = new Set();
  const seenSemantic = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry) continue;
    const idKey = String(entry.id || '');
    const semanticKey = [entry.side || '', entry.time, entry.type, entry.score, entry.champion || '', entry.player || '', entry.text || ''].join('|');
    if (idKey && seenIds.has(idKey)) continue;
    if (seenSemantic.has(semanticKey)) continue;
    if (idKey) seenIds.add(idKey);
    seenSemantic.add(semanticKey);
    result.push(entry);
  }
  return result;
}

// 没有显式 Multikill 事件时，从连续 ChampionKill 推导多杀，保证真实客户端少发事件也能识别。
function deriveMultikills(events, playerIndex, windowSeconds) {
  const chains = new Map();
  const derived = [];
  for (const event of events) {
    if (!event || event.EventName !== 'ChampionKill') continue;
    const killer = stripTag(event.KillerName);
    if (!killer) continue;
    const time = eventTime(event);
    const key = killer.toLowerCase();
    const previous = chains.get(key);
    const count = previous && time >= previous.time && time - previous.time <= windowSeconds ? previous.count + 1 : 1;
    chains.set(key, { count, time });
    if (count >= 2) {
      const entry = multikillEntry(event, count, playerIndex, 'streak-');
      if (entry) derived.push(entry);
    }
  }
  return derived;
}

function mergeCombos(entries, windowSeconds) {
  if (!(windowSeconds > 0)) return entries;
  const sorted = entries.slice().sort((a, b) => a.time - b.time || String(a.id).localeCompare(String(b.id)));
  const groups = [];
  let current = null;
  for (const entry of sorted) {
    if (!entry.side) { current = null; groups.push([entry]); continue; }
    if (current && current.side === entry.side && entry.time - current.lastTime <= windowSeconds && entry.time - current.startTime <= windowSeconds) {
      current.items.push(entry);
      current.lastTime = entry.time;
    } else {
      current = { side: entry.side, startTime: entry.time, lastTime: entry.time, items: [entry] };
      groups.push(current.items);
      current.items = current.items; // keep group reference for later mutation
    }
  }

  return groups.map(items => {
    if (items.length === 1) return items[0];
    const texts = [];
    for (const item of items) if (item && item.text && !texts.includes(item.text)) texts.push(item.text);
    const side = items[0].side;
    const prefix = sidePrefix(side) + '连击：';
    const body = texts.map(text => {
      const sideText = SIDE_TEXT[side] ? SIDE_TEXT[side] + ' ' : '';
      return sideText && text.startsWith(sideText) ? text.slice(sideText.length) : text;
    }).join(' + ');
    const firstChampion = items.find(item => item.champion);
    const firstPlayer = items.find(item => item.player);
    return {
      id: 'combo-' + items.map(item => item.id).join('+'),
      time: items[items.length - 1].time,
      type: 'combo',
      side,
      text: prefix + body,
      score: items.reduce((total, item) => total + (Number(item.score) || 0), 0),
      champion: firstChampion ? firstChampion.champion : '',
      player: firstPlayer ? firstPlayer.player : ''
    };
  });
}

function compareHighlights(a, b) {
  const scoreDiff = (Number(b && b.score) || 0) - (Number(a && a.score) || 0);
  if (scoreDiff) return scoreDiff;
  return (Number(b && b.time) || 0) - (Number(a && a.time) || 0);
}

function summarizeHighlights(entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const types = {};
  let topScore = 0;
  let latestTime = null;
  for (const entry of list) {
    types[entry.type] = (types[entry.type] || 0) + 1;
    topScore = Math.max(topScore, Number(entry.score) || 0);
    if (latestTime === null || Number(entry.time) > latestTime) latestTime = Number(entry.time) || 0;
  }
  return { count: list.length, topScore, latestTime, types };
}

function buildHighlights(payload, options = {}) {
  const events = extractEvents(payload);
  const players = Array.isArray(options.players) ? options.players : extractPlayers(payload);
  const playerIndex = buildPlayerIndex(players);
  const comboWindow = Number.isFinite(Number(options.comboWindowSeconds))
    ? Math.max(0, Number(options.comboWindowSeconds))
    : DEFAULT_COMBO_WINDOW;

  const scored = [];
  const seenEvents = new Set();
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const key = eventKey(event);
    if (key && seenEvents.has(key)) continue;
    if (key) seenEvents.add(key);
    const entry = toHighlight(event, playerIndex);
    if (entry) scored.push(entry);
  }

  // 只有完全没有显式 Multikill 时才推导，避免和客户端已给出的多杀事件重复计分。
  const hasExplicitMultikill = events.some(event => event && event.EventName === 'Multikill' && toNumber(event.KillStreak, 0) >= 2);
  if (!hasExplicitMultikill) {
    const windowSeconds = Number.isFinite(Number(options.multikillWindowSeconds))
      ? Math.max(0, Number(options.multikillWindowSeconds))
      : 10;
    scored.push(...deriveMultikills(events, playerIndex, windowSeconds));
  }

  let result = mergeCombos(dedupeEntries(scored), comboWindow);
  result.sort(compareHighlights);
  const limit = Number(options.limit);
  if (Number.isFinite(limit) && limit > 0) result = result.slice(0, Math.floor(limit));
  return result;
}

function latestHighlights(entries, limit = MAX_HIGHLIGHTS) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : MAX_HIGHLIGHTS;
  return list.slice().sort(compareHighlights).slice(0, max);
}

function handleHighlightsApi(req, res, url, context = {}) {
  const { json, state } = context;
  if (req.method !== 'GET') {
    if (typeof json === 'function') json(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  const list = Array.isArray(state && state.highlights) ? state.highlights.filter(Boolean) : [];
  const requested = Number(url && url.searchParams ? url.searchParams.get('limit') : 0);
  const highlights = Number.isFinite(requested) && requested > 0 ? latestHighlights(list, requested) : list;
  if (typeof json === 'function') {
    json(res, 200, { ok: true, count: highlights.length, summary: summarizeHighlights(list), highlights });
  }
  return true;
}

module.exports = {
  buildHighlights,
  latestHighlights,
  summarizeHighlights,
  handleHighlightsApi,
  compareHighlights,
  MAX_HIGHLIGHTS,
  DEFAULT_COMBO_WINDOW,
  SCORE_WEIGHTS
};
