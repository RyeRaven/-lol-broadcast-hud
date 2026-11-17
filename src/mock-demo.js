'use strict';

// 演示（模拟数据）引擎：把一场完整比赛压缩成 ~3 分钟的循环剧本，让人一眼看完
// 「等待开始 → BP → 赛中 → 赛后 + MVP」全部画面，而不是靠手点阶段看空面板。
//
// 纯函数风格：sceneAt(elapsedMs) 返回该时刻应有的完整快照，main.js 只负责把它写进 state。
// 剧本本身是确定性的（无随机数），所以测试可以直接断言任意时刻的比分/击杀/经济。

const LOOP = {
  lobbyMs: 5000,
  draftMs: 40000,
  gameMs: 105000,
  postMs: 30000
};
const LOOP_MS = LOOP.lobbyMs + LOOP.draftMs + LOOP.gameMs + LOOP.postMs;
const DRAFT_START = LOOP.lobbyMs;
const GAME_START = DRAFT_START + LOOP.draftMs;
const POST_START = GAME_START + LOOP.gameMs;
const GAME_LENGTH = 1260; // 演示里的对局时长（秒）= 21:00
const TIME_SCALE = GAME_LENGTH / (LOOP.gameMs / 1000); // 1 秒真实时间 = 12 秒对局时间

const TEAMS = {
  blue: { name: '蓝方学院', short: 'BLUE', logo: 'B' },
  red: { name: '红方社群', short: 'RED', logo: 'R' }
};

// 十名选手：分路/英雄/最终 KDA/补刀速率。KDA 总和必须两侧对得上（蓝 18 杀 / 红 13 杀）。
const ROSTER = [
  { name: '苍岚', team: 'blue', champion: 'Aatrox', role: 'TOP', kills: 4, deaths: 3, assists: 6, csPerMin: 8.2, damagePerMin: 620, takenPerMin: 780, vision: 24 },
  { name: '沉舟', team: 'blue', champion: 'Sejuani', role: 'JUNGLE', kills: 2, deaths: 2, assists: 12, csPerMin: 5.6, damagePerMin: 380, takenPerMin: 900, vision: 41 },
  { name: '听雨', team: 'blue', champion: 'Azir', role: 'MID', kills: 6, deaths: 2, assists: 8, csPerMin: 8.6, damagePerMin: 880, takenPerMin: 520, vision: 19 },
  { name: '白鹭', team: 'blue', champion: 'Jinx', role: 'ADC', kills: 5, deaths: 2, assists: 7, csPerMin: 9.2, damagePerMin: 940, takenPerMin: 480, vision: 17 },
  { name: '长夜', team: 'blue', champion: 'Rakan', role: 'SUPPORT', kills: 1, deaths: 4, assists: 14, csPerMin: 1.4, damagePerMin: 210, takenPerMin: 610, vision: 52 },
  { name: '夜航', team: 'red', champion: 'Renekton', role: 'TOP', kills: 3, deaths: 4, assists: 4, csPerMin: 7.9, damagePerMin: 540, takenPerMin: 820, vision: 21 },
  { name: '北冥', team: 'red', champion: 'Viego', role: 'JUNGLE', kills: 3, deaths: 3, assists: 7, csPerMin: 5.4, damagePerMin: 410, takenPerMin: 860, vision: 38 },
  { name: '狂风', team: 'red', champion: 'Sylas', role: 'MID', kills: 4, deaths: 3, assists: 5, csPerMin: 8.1, damagePerMin: 790, takenPerMin: 560, vision: 18 },
  { name: '折枝', team: 'red', champion: 'Aphelios', role: 'ADC', kills: 2, deaths: 4, assists: 3, csPerMin: 8.8, damagePerMin: 720, takenPerMin: 500, vision: 15 },
  { name: '青崖', team: 'red', champion: 'Nautilus', role: 'SUPPORT', kills: 1, deaths: 4, assists: 8, csPerMin: 1.6, damagePerMin: 190, takenPerMin: 640, vision: 47 }
];

// 每件装备都按位置给一组常见出装，够 HUD 画出 6 格 + 饰品。
const ITEM_SETS = {
  TOP: ['#3078', '#3047', '#3742', '#6333', '#3053', '#3065'],
  JUNGLE: ['#3047', '#3742', '#3116', '#3065', '#3087', '#3364'],
  MID: ['#3020', '#3116', '#3046', '#4645', '#3089', '#3135'],
  ADC: ['#3031', '#3006', '#3035', '#3072', '#3036', '#3033'],
  SUPPORT: ['#3853', '#3158', '#3222', '#3107', '#3067', '#3040']
};

const BAN_BLUE = ['Yone', 'Vi', "Kai'Sa", 'Rakan', 'Poppy'];
const BAN_RED = ['Yasuo', 'LeeSin', 'Xayah', 'Kalista', 'Rumble'];
const PICK_BLUE = ['Aatrox', 'Sejuani', 'Azir', 'Jinx', 'Rakan'];
const PICK_RED = ['Renekton', 'Viego', 'Sylas', 'Aphelios', 'Nautilus'];
// 标准 10 手选人顺序：B1 → R1 R2 → B2 B3 → R3 R4 → B4 B5 → R5
const PICK_ORDER = ['blue', 'red', 'red', 'blue', 'blue', 'red', 'red', 'blue', 'blue', 'red'];

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

// 击杀剧本：把每名选手的最终击杀数拆成时间点，两侧交替发生，节奏像真比赛。
function buildKills() {
  const queue = { blue: [], red: [] };
  for (const player of ROSTER) {
    for (let i = 0; i < player.kills; i += 1) queue[player.team].push(player.name);
  }
  const frames = [];
  let next = 'blue';
  while (queue.blue.length || queue.red.length) {
    const side = queue[next].length ? next : (next === 'blue' ? 'red' : 'blue');
    frames.push({ at: 0, side, killer: queue[side].shift() });
    next = side === 'blue' ? 'red' : 'blue';
  }
  // 时间点：第一血 04:20，之后平均 40 秒一次，末尾收在 20:30。
  const first = 260;
  const step = (1230 - first) / Math.max(1, frames.length - 1);
  frames.forEach((frame, i) => {
    frame.at = Math.round(first + step * i + ((i % 3) - 1) * 12);
  });
  return frames;
}
const KILLS = buildKills();

// 目标时间轴：小龙 / 峡谷先锋 / 大龙 / 防御塔。
const OBJECTIVES = [
  { at: 380, side: 'blue', key: 'dragons' },
  { at: 500, side: 'red', key: 'dragons' },
  { at: 600, side: 'blue', key: 'heralds' },
  { at: 730, side: 'red', key: 'towers' },
  { at: 760, side: 'blue', key: 'towers' },
  { at: 800, side: 'red', key: 'heralds' },
  { at: 830, side: 'blue', key: 'towers' },
  { at: 900, side: 'red', key: 'dragons' },
  { at: 940, side: 'blue', key: 'towers' },
  { at: 1010, side: 'blue', key: 'dragons' },
  { at: 1060, side: 'red', key: 'towers' },
  { at: 1120, side: 'blue', key: 'towers' },
  { at: 1170, side: 'blue', key: 'barons' },
  { at: 1210, side: 'blue', key: 'towers' }
];

function minuteOf(gameSeconds) { return gameSeconds / 60; }
function scoreAt(side, gameSeconds) { return KILLS.filter(k => k.side === side && k.at <= gameSeconds).length; }
function objectivesAt(side, key, gameSeconds) { return OBJECTIVES.filter(o => o.side === side && o.key === key && o.at <= gameSeconds).length; }
function goldFor(side, gameSeconds) {
  const minute = minuteOf(gameSeconds);
  const lead = side === 'blue' ? 260 : -260;
  return Math.round(2400 + minute * 1780 + lead * Math.min(1, minute / 6) + (side === 'blue' ? minute * 40 : 0));
}

function playerFrame(player, gameSeconds) {
  const minute = minuteOf(gameSeconds);
  const frac = clamp01(gameSeconds / GAME_LENGTH);
  const kills = KILLS.filter(k => k.killer === player.name && k.at <= gameSeconds).length;
  const deaths = Math.round(player.deaths * frac);
  const assists = Math.round(player.assists * frac);
  const cs = Math.round(player.csPerMin * minute);
  const level = Math.max(1, Math.min(18, 1 + Math.floor(minute * 0.85)));
  const items = Math.max(1, Math.min(6, Math.floor(minute / 3.6) + 1));
  return {
    name: player.name,
    team: player.team,
    champion: player.champion,
    role: player.role,
    level,
    kills,
    deaths,
    assists,
    cs,
    gold: Math.round(500 + minute * (330 + player.csPerMin * 22)),
    damage: Math.round(player.damagePerMin * minute),
    taken: Math.round(player.takenPerMin * minute),
    vision: Math.round(player.vision * Math.min(1, minute / 18)) || 0,
    kp: Math.round((kills + assists) / Math.max(1, scoreAt(player.team, gameSeconds)) * 100),
    alive: true,
    items: ITEM_SETS[player.role].slice(0, items),
    summoners: ['#4', '#14'],
    trinket: '#3340'
  };
}

function draftFrame(elapsed) {
  const local = Math.max(0, elapsed - DRAFT_START);
  const banBlue = Math.min(5, Math.max(0, Math.floor((local - 1000) / 2400) + 1));
  const banRed = Math.min(5, Math.max(0, Math.floor((local - 2200) / 2400) + 1));
  const picksDone = Math.min(10, Math.max(0, Math.floor((local - 6000) / 3300) + 1));
  const bluePicks = [];
  const redPicks = [];
  for (let i = 0; i < picksDone; i += 1) {
    if (PICK_ORDER[i] === 'blue') bluePicks.push(PICK_BLUE[bluePicks.length]);
    else redPicks.push(PICK_RED[redPicks.length]);
  }
  const slotMs = 3300;
  const slotLocal = local < 6000 ? local : (local - 6000) % slotMs;
  const slotIndex = Math.min(9, Math.max(0, picksDone - 1));
  return {
    round: picksDone >= 10 ? '禁用 5 / 5 · 选人完成' : '第 ' + Math.max(1, Math.floor(local / slotMs) + 1) + ' 手 · 进行中',
    timer: Math.max(0, Math.round(30 - (slotLocal / slotMs) * 30)),
    active: picksDone >= 10 ? 'blue' : PICK_ORDER[slotIndex],
    blueBans: BAN_BLUE.slice(0, banBlue),
    redBans: BAN_RED.slice(0, banRed),
    bluePicks,
    redPicks
  };
}

function teamFrame(side, gameSeconds) {
  return {
    name: TEAMS[side].name,
    short: TEAMS[side].short,
    logo: TEAMS[side].logo,
    score: scoreAt(side, gameSeconds),
    gold: goldFor(side, gameSeconds),
    towers: objectivesAt(side, 'towers', gameSeconds),
    dragons: objectivesAt(side, 'dragons', gameSeconds),
    barons: objectivesAt(side, 'barons', gameSeconds),
    heralds: objectivesAt(side, 'heralds', gameSeconds)
  };
}

function postGameFrame() {
  const players = ROSTER.map(player => {
    const frame = playerFrame(player, GAME_LENGTH);
    return {
      name: player.name,
      champion: player.champion,
      position: player.role,
      team: player.team,
      kills: frame.kills,
      deaths: player.deaths,
      assists: player.assists,
      cs: Math.round(player.csPerMin * 21),
      gold: Math.round(5200 + player.csPerMin * 21 * 26 + player.kills * 320),
      damage: frame.damage,
      taken: frame.taken,
      vision: player.vision,
      level: 18,
      items: ITEM_SETS[player.role].slice(0, 6)
    };
  });
  const teams = {};
  for (const side of ['blue', 'red']) {
    const team = teamFrame(side, GAME_LENGTH);
    teams[side] = {
      towers: team.towers,
      inhibitors: side === 'blue' ? 1 : 0,
      dragons: team.dragons,
      barons: team.barons,
      players: players.filter(p => p.team === side)
    };
  }
  return {
    source: 'demo',
    error: null,
    missingTeams: [],
    gameId: 'DEMO-' + GAME_LENGTH,
    gameLength: GAME_LENGTH,
    gameMode: 'CLASSIC',
    isWin: true,
    teams,
    players
  };
}

function sceneAt(elapsedMs) {
  const elapsed = ((Number(elapsedMs) || 0) % LOOP_MS + LOOP_MS) % LOOP_MS;
  const progress = elapsed / LOOP_MS;
  if (elapsed < DRAFT_START) {
    return {
      stage: 'lobby',
      phase: 'draft',
      progress,
      gameTime: 0,
      draft: { round: '等待开始', timer: 30, active: 'blue', blueBans: [], redBans: [], bluePicks: [], redPicks: [] },
      blue: teamFrame('blue', 0),
      red: teamFrame('red', 0),
      players: ROSTER.map(p => playerFrame(p, 0)),
      postGame: null
    };
  }
  if (elapsed < GAME_START) {
    return {
      stage: 'draft',
      phase: 'draft',
      progress,
      gameTime: 0,
      draft: draftFrame(elapsed),
      blue: teamFrame('blue', 0),
      red: teamFrame('red', 0),
      players: ROSTER.map(p => playerFrame(p, 0)),
      postGame: null
    };
  }
  if (elapsed < POST_START) {
    const gameSeconds = Math.min(GAME_LENGTH, Math.round((elapsed - GAME_START) / 1000 * TIME_SCALE));
    return {
      stage: 'game',
      phase: 'in_game',
      progress,
      gameTime: gameSeconds,
      draft: draftFrame(GAME_START - 1),
      blue: teamFrame('blue', gameSeconds),
      red: teamFrame('red', gameSeconds),
      players: ROSTER.map(p => playerFrame(p, gameSeconds)),
      postGame: null
    };
  }
  const final = {
    stage: 'post',
    phase: 'post_game',
    progress,
    gameTime: GAME_LENGTH,
    draft: draftFrame(GAME_START - 1),
    blue: teamFrame('blue', GAME_LENGTH),
    red: teamFrame('red', GAME_LENGTH),
    players: ROSTER.map(p => playerFrame(p, GAME_LENGTH)),
    postGame: postGameFrame()
  };
  final.result = {
    winner: final.blue.score >= final.red.score ? 'blue' : 'red',
    blueKills: final.blue.score,
    redKills: final.red.score,
    duration: GAME_LENGTH
  };
  return final;
}

module.exports = { LOOP, LOOP_MS, GAME_LENGTH, GAME_START, POST_START, DRAFT_START, ROSTER, TEAMS, KILLS, OBJECTIVES, sceneAt };
