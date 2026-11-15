'use strict';

// 赛后数据。两个来源，按可靠性排序：
// 1) LCU /lol-end-of-game/v1/eog-stats-block —— 只在结算画面（PreEndOfGame / EndOfGame）短暂可用，
//    有金币、伤害、视野分，但可能没有召唤师名字。
// 2) 局内每秒冻结的 Live Client Data 快照 —— :2999 在游戏结束瞬间就关闭，所以必须在局内持续快照。
// 优先用 eog，缺名字时按 championId 从冻结快照里补。

function teamSide(teamId) { return Number(teamId) === 200 ? 'red' : 'blue'; }
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function statsOf(entry) { return entry && entry.stats ? entry.stats : (entry || {}); }

function pickItems(stats) {
  const items = [];
  for (let i = 0; i < 7; i += 1) {
    const id = num(stats['item' + i]);
    if (id) items.push('#' + id);
  }
  return items;
}

function emptyTeam() { return { towers: 0, inhibitors: 0, dragons: 0, barons: 0, players: [] }; }

function normalizeEogStats(block) {
  if (!block || !Array.isArray(block.teams)) return null;
  const teams = { blue: null, red: null };
  const missingTeams = [];
  const players = [];
  for (const team of block.teams) {
    if (!team || typeof team !== 'object') continue;
    const side = teamSide(team.teamId);
    const roster = Array.isArray(team.players) ? team.players.filter(Boolean) : [];
    const list = roster.map(entry => {
      const stats = statsOf(entry);
      return {
        name: entry.summonerName || entry.riotIdGameName || entry.gameName || '',
        championId: num(entry.championId),
        champion: entry.championName || '',
        team: side,
        kills: num(stats.kills),
        deaths: num(stats.deaths),
        assists: num(stats.assists),
        cs: num(stats.totalMinionsKilled) + num(stats.neutralMinionsKilled),
        gold: num(stats.goldEarned),
        damage: num(stats.totalDamageDealtToChampions),
        taken: num(stats.totalDamageTaken),
        vision: num(stats.visionScore) || num(stats.wardScore),
        level: num(stats.champLevel),
        items: pickItems(stats)
      };
    });
    teams[side] = {
      towers: num(team.towerKills),
      inhibitors: num(team.inhibitorKills),
      dragons: num(team.dragonKills),
      barons: num(team.baronKills),
      players: list
    };
    players.push(...list);
  }
  for (const side of ['blue', 'red']) {
    if (!teams[side]) { teams[side] = emptyTeam(); missingTeams.push(side); }
  }
  if (!players.length) return null;
  return {
    source: 'eog',
    error: missingTeams.length ? 'missing_team:' + missingTeams.join(',') : null,
    missingTeams,
    gameId: block.gameId || null,
    gameLength: num(block.gameLength),
    gameMode: block.gameMode || '',
    isWin: block.isWin === true,
    teams,
    players
  };
}

function fromFrozen(frozen) {
  if (!frozen || !Array.isArray(frozen.players) || !frozen.players.length) return null;
  const players = frozen.players.map(p => ({
    name: p.name || '',
    championId: 0,
    champion: p.champion || '',
    team: p.team,
    kills: num(p.kills),
    deaths: num(p.deaths),
    assists: num(p.assists),
    cs: num(p.cs),
    // 冻结快照没有逐玩家金币/伤害/承伤：宁可给 null（页面显式 '—'）也不伪造 0。
    gold: null,
    damage: null,
    taken: null,
    position: p.position || null,
    vision: num(p.wardScore),
    level: num(p.level),
    items: Array.isArray(p.items) ? p.items : []
  }));
  const teams = { blue: null, red: null };
  for (const side of ['blue', 'red']) {
    const src = frozen[side] || {};
    teams[side] = {
      towers: num(src.towers), inhibitors: 0, dragons: num(src.dragons), barons: num(src.barons),
      players: players.filter(p => p.team === side)
    };
  }
  return { source: 'frozen', error: null, missingTeams: [], gameId: frozen.gameId || null, gameLength: num(frozen.gameTime), gameMode: frozen.gameMode || '', isWin: false, teams, players };
}

function buildPostGame({ eog, frozen, championLabel } = {}) {
  const label = typeof championLabel === 'function' ? championLabel : id => (id ? '#' + id : '');
  const eogData = normalizeEogStats(eog);
  const base = eogData || fromFrozen(frozen);
  if (!base) return null;
  const nameByChampion = new Map();
  if (frozen && Array.isArray(frozen.players)) {
    for (const player of frozen.players) if (player.champion) nameByChampion.set(player.champion, player.name);
  }
  const players = base.players.map(player => ({
    ...player,
    name: player.name || nameByChampion.get(player.champion) || '选手',
    champion: player.champion || label(player.championId) || ''
  }));
  // 分路归一：LCDA 的 MIDDLE/BOTTOM/UTILITY 收敛成 MID/ADC/SUPPORT，页面按统一口径画分路图标。
  const POSITION_ALIASES = { MIDDLE: 'MID', BOTTOM: 'ADC', UTILITY: 'SUPPORT' };
  const normPos = value => {
    const raw = String(value == null ? '' : value).trim().toUpperCase();
    return POSITION_ALIASES[raw] || (raw ? raw : null);
  };
  // EOG 没有 position：从局内冻结快照按英雄名配对补齐，配不上留空（页面显式占位，不猜分路）。
  if (frozen && Array.isArray(frozen.players)) {
    const posByChampion = new Map();
    const rowsBySide = { blue: [], red: [] };
    for (const fp of frozen.players) {
      if (!fp) continue;
      const side = fp.team === 'red' ? 'red' : 'blue';
      rowsBySide[side].push(fp);
      if (!fp.champion || !fp.position) continue;
      posByChampion.set(String(fp.champion).toLowerCase() + '|' + side, fp.position);
    }
    const rowIndex = { blue: 0, red: 0 };
    for (const player of players) {
      const side = player.team === 'red' ? 'red' : 'blue';
      const keys = [String(player.champion || '')];
      const labeled = label(player.championId);
      if (labeled) keys.push(labeled);
      let hit = null;
      for (const key of keys) {
        const keyLower = String(key || '').toLowerCase();
        if (keyLower && posByChampion.has(keyLower + '|' + side)) { hit = posByChampion.get(keyLower + '|' + side); break; }
      }
      if (!hit) {
        // 行序兜底只在同侧人数与冻结快照一致时才可信；人数对不上时行序必然错位，宁缺勿配。
        const rowCount = rowsBySide[side].length;
        const teamCount = players.filter(p => p.team === side).length;
        if (rowCount === teamCount) {
          const row = rowsBySide[side][rowIndex[side]];
          rowIndex[side] += 1;
          hit = row && row.position;
        }
      }
      player.position = normPos(player.position || hit);
    }
  } else {
    for (const player of players) player.position = normPos(player.position);
  }
  for (const side of ['blue', 'red']) {
    const teamPlayers = players.filter(p => p.team === side);
    // 伤害/承伤缺席（frozen 兜底）时占比给 null：页面显式占位，不渲染看似真实的 0% 分布。
    const hasDamage = teamPlayers.every(p => p.damage != null);
    const hasTaken = teamPlayers.every(p => p.taken != null);
    const teamDamage = teamPlayers.reduce((total, p) => total + (p.damage || 0), 0);
    const teamTaken = teamPlayers.reduce((total, p) => total + (p.taken || 0), 0);
    const teamKills = teamPlayers.reduce((total, p) => total + p.kills, 0);
    for (const player of teamPlayers) {
      player.damagePct = hasDamage && teamDamage ? Math.round((player.damage / teamDamage) * 1000) / 10 : null;
      player.takenPct = hasTaken && teamTaken ? Math.round((player.taken / teamTaken) * 1000) / 10 : null;
      player.kp = teamKills ? Math.round(((player.kills + player.assists) / teamKills) * 100) : 0;
    }
  }
  // 对位经济差：同分路两侧都识别到才给数，缺任一侧置 null，页面显式占位（GD@END）。
  for (const player of players) {
    player.gd = null;
    if (!player.position) continue;
    const other = players.find(p => p.team !== player.team && p.position === player.position);
    // 双侧金币都必须是真实数值（EOG 路径）；frozen 兜底缺金币时不给差值。
    if (other && player.gold != null && other.gold != null) player.gd = player.gold - other.gold;
  }
  const sideScore = side => players.filter(p => p.team === side).reduce((total, p) => total + p.kills, 0);
  const blueTeam = base.teams.blue || emptyTeam();
  const redTeam = base.teams.red || emptyTeam();
  return {
    source: eogData ? 'eog' : 'frozen',
    error: base.error || null,
    missingTeams: Array.isArray(base.missingTeams) ? base.missingTeams.slice() : [],
    gameId: base.gameId || null,
    gameLength: base.gameLength,
    gameMode: base.gameMode,
    isWin: base.isWin,
    players,
    blue: { score: sideScore('blue'), towers: blueTeam.towers, dragons: blueTeam.dragons, barons: blueTeam.barons },
    red: { score: sideScore('red'), towers: redTeam.towers, dragons: redTeam.dragons, barons: redTeam.barons }
  };
}

module.exports = { buildPostGame, normalizeEogStats };
