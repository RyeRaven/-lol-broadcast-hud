'use strict';

// 回放文件（.rofl）赛后数据。观战位拿不到 LCU 战报端点（games / game-timelines / replay-metadata
// 对观战局全 404），但局内下载的 .rofl 文件尾部带完整赛后统计：文件末尾 u32 长度 + metadata JSON，
// 其中 statsJson 解开就是 10 名玩家的全量赛后数据（KDA/金币/精确 CS/伤害/胜负/目标数）。
// 格式在 14.20~16.22 的样本上完全一致：
//   [0..3] 'RIOT' magic；[4..5] formatVersion u16LE (=2)；[14] gameVersion 长度 u8；[15..] 版本串；
//   尾部 [end-4..end) u32LE = metadata JSON 长度，JSON 在 [end-4-metaLen, end-4)。
// 老版本（如 15.10）的 statsJson 可能为空：导入时明确报 replay_stats_missing，不伪造数据。

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }

function teamSide(teamId) { return String(teamId) === '200' ? 'red' : 'blue'; }

// 与 post-game.js 同一分路口径：MIDDLE/BOTTOM/UTILITY 收敛成 MID/ADC/SUPPORT。
const POSITION_ALIASES = { MIDDLE: 'MID', BOTTOM: 'ADC', UTILITY: 'SUPPORT' };

function normPosition(value) {
  const raw = String(value == null ? '' : value).trim().toUpperCase();
  return POSITION_ALIASES[raw] || (raw ? raw : null);
}

function parseRoflResult(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 40) fail('replay_too_small');
  if (buffer.toString('ascii', 0, 4) !== 'RIOT') fail('not_a_replay');
  const end = buffer.length;
  const metaLen = buffer.readUInt32LE(end - 4);
  if (!Number.isFinite(metaLen) || metaLen <= 0 || metaLen > 64 * 1024 * 1024 || end - 4 - metaLen < 15) fail('bad_metadata');
  let meta;
  try { meta = JSON.parse(buffer.toString('utf8', end - 4 - metaLen, end - 4)); } catch { fail('bad_metadata'); }
  if (!meta || typeof meta !== 'object') fail('bad_metadata');
  const versionLen = buffer.readUInt8(14);
  const gameVersion = versionLen > 0 ? buffer.toString('utf8', 15, 15 + versionLen) : '';
  let stats = null;
  try { stats = JSON.parse(meta.statsJson); } catch { stats = null; }
  if (!Array.isArray(stats) || stats.length === 0) fail('replay_stats_missing');
  if (stats.length !== 10) fail('bad_roster');
  return {
    formatVersion: buffer.readUInt16LE(4),
    gameVersion,
    gameLengthMs: num(meta.gameLength),
    stats
  };
}

function playerRows(stats, side) {
  return stats.filter(row => teamSide(row && row.TEAM) === side);
}

function teamConstant(rows, key) {
  if (!rows.length) return null;
  const values = rows.map(row => num(row[key]));
  const first = values[0];
  // FRIENDLY_TURRET_LOST / FRIENDLY_DAMPEN_LOST 是队伍级数字，逐玩家重复。
  return values.every(v => v === first) ? first : null;
}

function teamSum(rows, key) {
  return rows.reduce((total, row) => total + num(row[key]), 0);
}

function buildRoflPostGame(parsed) {
  const blueRows = playerRows(parsed.stats, 'blue');
  const redRows = playerRows(parsed.stats, 'red');
  if (!blueRows.length || !redRows.length) fail('bad_roster');
  const blueWin = blueRows.some(row => String(row.WIN || '').trim().toLowerCase() === 'win');
  const redWin = redRows.some(row => String(row.WIN || '').trim().toLowerCase() === 'win');
  // 双方都标胜/都没标胜：胜负未知，置 null（页面沿用 legacy 口径），不猜。
  const winSide = blueWin && !redWin ? 'blue' : (redWin && !blueWin ? 'red' : null);

  const players = parsed.stats.map(row => {
    const side = teamSide(row.TEAM);
    const gameName = String(row.RIOT_ID_GAME_NAME || '').trim();
    const tagLine = String(row.RIOT_ID_TAG_LINE || '').trim();
    const name = gameName ? (tagLine ? gameName + '#' + tagLine : gameName) : String(row.NAME || '').trim();
    const items = [];
    for (let i = 0; i < 7; i += 1) {
      const id = num(row['ITEM' + i]);
      if (id) items.push('#' + id);
    }
    return {
      name,
      championId: 0,
      participantId: null,
      champion: String(row.SKIN || '').trim(),
      team: side,
      kills: num(row.CHAMPIONS_KILLED),
      deaths: num(row.NUM_DEATHS),
      assists: num(row.ASSISTS),
      cs: num(row.MINIONS_KILLED) + num(row.NEUTRAL_MINIONS_KILLED),
      gold: num(row.GOLD_EARNED),
      damage: num(row.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS),
      taken: num(row.TOTAL_DAMAGE_TAKEN),
      position: normPosition(row.INDIVIDUAL_POSITION),
      vision: num(row.VISION_SCORE),
      level: num(row.LEVEL),
      items
    };
  });

  const teams = { blue: null, red: null };
  for (const side of ['blue', 'red']) {
    const rows = side === 'blue' ? blueRows : redRows;
    const other = side === 'blue' ? redRows : blueRows;
    // 塔 lost 是队伍级常数（逐玩家重复）：本方推掉的对面的塔 = 对面 FRIENDLY_TURRET_LOST。
    const friendlyLostConst = teamConstant(other, 'FRIENDLY_TURRET_LOST');
    const inhibLostConst = teamConstant(other, 'FRIENDLY_DAMPEN_LOST');
    teams[side] = {
      // 常数缺失（数据异常）时回退 ΣTURRETS_KILLED / ΣBARRACKS_KILLED（只算补刀，可能欠计）。
      towers: friendlyLostConst != null ? friendlyLostConst : teamSum(rows, 'TURRETS_KILLED'),
      inhibitors: inhibLostConst != null ? inhibLostConst : teamSum(rows, 'BARRACKS_KILLED'),
      dragons: teamSum(rows, 'DRAGON_KILLS'),
      barons: teamSum(rows, 'BARON_KILLS'),
      players: players.filter(p => p.team === side)
    };
  }

  // 伤害/承伤占比、参团率、对位经济差：与 post-game.js 的 EOG 路径同构。
  for (const side of ['blue', 'red']) {
    const teamPlayers = players.filter(p => p.team === side);
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
  for (const player of players) {
    player.gd = null;
    if (!player.position) continue;
    const other = players.find(p => p.team !== player.team && p.position === player.position);
    if (other && player.gold != null && other.gold != null) player.gd = player.gold - other.gold;
  }

  const sideScore = side => players.filter(p => p.team === side).reduce((total, p) => total + p.kills, 0);
  return {
    source: 'rofl',
    error: null,
    missingTeams: [],
    gameId: null,
    gameLength: Math.max(0, Math.round(parsed.gameLengthMs / 1000)),
    gameMode: '',
    gameVersion: parsed.gameVersion,
    winSide,
    isWin: winSide ? winSide === 'blue' : false,
    teams,
    players,
    blue: { score: sideScore('blue'), towers: teams.blue.towers, dragons: teams.blue.dragons, barons: teams.blue.barons },
    red: { score: sideScore('red'), towers: teams.red.towers, dragons: teams.red.dragons, barons: teams.red.barons }
  };
}

module.exports = { parseRoflResult, buildRoflPostGame };
