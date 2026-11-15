'use strict';

// Live Client Data 事件 → 可播报时间线。
// 输入是 /liveclientdata/allgamedata 的原始 payload（events.Events），
// 输出按 EventTime 升序的 { time, type, side, text, champion }。
// 所有解析都宽松处理：缺字段、未知事件类型、ARAM 无打野阵容都不能让整条时间线崩掉。

const MAX_TIMELINE = 50;

const SIDE_TEXT = { blue: '蓝方', red: '红方' };
const DRAGON_TEXT = {
  Fire: '火龙', Earth: '土龙', Water: '水龙', Air: '风龙',
  Hextech: '海克斯龙', Chemtech: '炼金龙', Elder: '远古龙'
};
const MULTIKILL_TEXT = { 2: '双杀', 3: '三杀', 4: '四杀', 5: '五杀' };

const EVENT_TYPES = {
  GameStart: 'game_start',
  MinionsSpawning: 'minions',
  ChampionKill: 'kill',
  FirstBlood: 'first_blood',
  Multikill: 'multikill',
  TurretKilled: 'tower',
  FirstBrick: 'first_brick',
  DragonKill: 'dragon',
  BaronKill: 'baron',
  HeraldKill: 'herald',
  HordeKill: 'horde',
  InhibKilled: 'inhibitor',
  GameEnd: 'game_end',
  Ace: 'ace'
};

function stripTag(name) { return String(name || '').replace(/#.*$/, '').trim(); }
function sideFromTeam(team) { return String(team || '').toUpperCase() === 'CHAOS' ? 'red' : 'blue'; }
function sideFromTurretName(turretKilled) {
  const raw = String(turretKilled || '');
  if (/TOrder/i.test(raw)) return 'red';
  if (/TChaos/i.test(raw)) return 'blue';
  return null;
}

function eventsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.events)) return payload.events;
  if (payload.events && Array.isArray(payload.events.Events)) return payload.events.Events;
  return [];
}
function playersOf(payload) {
  if (Array.isArray(payload)) return [];
  return payload && Array.isArray(payload.allPlayers) ? payload.allPlayers : [];
}

// 事件里的 KillerName 是召唤师名且不带 #tag，玩家对象里带 tag；多种写法都登记。
function buildPlayerIndex(players) {
  const index = new Map();
  for (const player of Array.isArray(players) ? players : []) {
    if (!player || typeof player !== 'object') continue;
    const rawName = player.summonerName || player.riotIdGameName || player.riotId || player.name || '';
    const champion = player.championName || player.champion || '';
    const team = player.team;
    const side = team === 'blue' || team === 'red' ? team : sideFromTeam(team);
    const record = { side, champion: String(champion || ''), name: stripTag(rawName) };
    for (const key of [rawName, stripTag(rawName), champion]) {
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
function nameLabel(record, fallback) {
  if (record && record.champion) return record.champion;
  if (record && record.name) return record.name;
  return stripTag(fallback);
}
function sidePrefix(side) { return SIDE_TEXT[side] ? SIDE_TEXT[side] + ' ' : ''; }

function toTimelineEntry(event, playerIndex) {
  const eventName = String(event.EventName || '');
  const type = EVENT_TYPES[eventName];
  if (!type) return null;
  const rawTime = Number(event.EventTime);
  const time = Number.isFinite(rawTime) && rawTime > 0 ? Math.round(rawTime * 1000) / 1000 : 0;
  const killer = lookupPlayer(playerIndex, event.KillerName);
  const victim = lookupPlayer(playerIndex, event.VictimName);
  const recipient = lookupPlayer(playerIndex, event.Recipient);
  let side = killer ? killer.side : null;
  let champion = killer && killer.champion ? killer.champion : '';
  let text = '';

  switch (type) {
    case 'game_start': text = '比赛开始'; break;
    case 'minions': text = '小兵出发'; break;
    case 'game_end': text = '比赛结束'; break;
    case 'kill': {
      const killerName = nameLabel(killer, event.KillerName);
      const victimName = nameLabel(victim, event.VictimName);
      const victimSide = victim ? SIDE_TEXT[victim.side] : '';
      text = `${sidePrefix(side)}${killerName ? killerName + ' ' : ''}击杀 ${victimSide ? victimSide + ' ' : ''}${victimName}`.trim();
      break;
    }
    case 'first_blood': {
      const record = recipient || killer;
      if (record) side = record.side;
      if (record && record.champion) champion = record.champion;
      const name = nameLabel(record, event.Recipient || event.KillerName);
      text = `${sidePrefix(side)}${name ? name + ' ' : ''}拿下一血`.trim();
      break;
    }
    case 'multikill': {
      const name = nameLabel(killer, event.KillerName);
      const streak = Number(event.KillStreak) || 2;
      const label = MULTIKILL_TEXT[streak] || `${streak}连杀`;
      text = `${sidePrefix(side)}${name ? name + ' ' : ''}${label}`.trim();
      break;
    }
    case 'tower': {
      if (!side) side = sideFromTurretName(event.TurretKilled);
      const name = nameLabel(killer, '');
      text = `${sidePrefix(side)}${name ? name + ' ' : ''}推掉一座防御塔`.trim();
      break;
    }
    case 'first_brick': {
      const name = nameLabel(killer, '');
      text = `${sidePrefix(side)}${name ? name + ' ' : ''}拿下首座防御塔`.trim();
      break;
    }
    case 'dragon': {
      const dragon = DRAGON_TEXT[event.DragonType] || (event.DragonType ? String(event.DragonType) + '龙' : '小龙');
      text = `${sidePrefix(side)}${champion ? champion + ' ' : ''}击杀${dragon}`;
      break;
    }
    case 'baron': text = `${sidePrefix(side)}${champion ? champion + ' ' : ''}击杀纳什男爵`; break;
    case 'herald': text = `${sidePrefix(side)}${champion ? champion + ' ' : ''}击杀峡谷先锋`; break;
    case 'horde': text = `${sidePrefix(side)}${champion ? champion + ' ' : ''}击杀虚空巢虫`; break;
    case 'inhibitor': text = `${sidePrefix(side)}${champion ? champion + ' ' : ''}摧毁一座水晶`; break;
    case 'ace': text = `${sidePrefix(side)}团灭对手`.trim(); break;
    default: return null;
  }
  return { time, type, side: side || null, text, champion };
}

function buildTimeline(payload, options = {}) {
  const events = eventsOf(payload);
  const players = Array.isArray(options.players) ? options.players : playersOf(payload);
  const playerIndex = buildPlayerIndex(players);
  const entries = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const entry = toTimelineEntry(event, playerIndex);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => a.time - b.time);
  const limit = Number(options.limit);
  if (Number.isFinite(limit) && limit > 0) return entries.slice(-Math.floor(limit));
  return entries;
}

// 状态里只保留最近 50 条；输入已按时间升序，slice 不改变顺序。
function latestTimeline(entries, limit = MAX_TIMELINE) {
  const list = Array.isArray(entries) ? entries : [];
  const max = Number(limit) > 0 ? Math.floor(Number(limit)) : MAX_TIMELINE;
  return list.slice(-max);
}

module.exports = { buildTimeline, latestTimeline, MAX_TIMELINE, EVENT_TYPES };
