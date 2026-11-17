'use strict';

// 系列赛（BO1/3/5）与场次历史：控台的「局数 / 比分 / 已完成场次」都从这里取。
// 状态落盘到 data/series.json；RB_SERIES_FILE 可整体改路径（测试用临时文件）。
const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 40;
const BEST_OF = [1, 3, 5];

function dataDir() {
  return process.env.RB_DATA_DIR
    ? path.join(path.resolve(process.env.RB_DATA_DIR), 'data')
    : path.join(__dirname, '..', 'data');
}

function filePath() {
  return process.env.RB_SERIES_FILE || path.join(dataDir(), 'series.json');
}

function blank() {
  return {
    version: 1,
    // idle=没有进行中的比赛；running=进行中；finished=本轮已分出胜负（等「结束这轮」或开始下一轮）
    status: 'idle',
    tournament: '',
    bestOf: 3,
    teams: { blue: { name: '' }, red: { name: '' } },
    startedAt: null,
    endedAt: null,
    gameIndex: 0,
    scores: { blue: 0, red: 0 },
    games: [],
    history: []
  };
}

function fail(code) {
  const error = new Error(code);
  error.statusCode = 400;
  return error;
}

function int(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.round(number));
}

function pickBestOf(value) {
  const number = Number(value);
  return BEST_OF.includes(number) ? number : 3;
}

function normalizeGame(raw, index) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const winner = item.winner === 'red' ? 'red' : 'blue';
  return {
    index: int(item.index, index + 1) || index + 1,
    winner,
    blueKills: int(item.blueKills),
    redKills: int(item.redKills),
    duration: int(item.duration),
    mvp: item.mvp && typeof item.mvp === 'object'
      ? { name: String(item.mvp.name || ''), team: item.mvp.team === 'red' ? 'red' : 'blue' }
      : null,
    endedAt: int(item.endedAt) || null
  };
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = blank();
  const status = ['idle', 'running', 'finished'].includes(source.status) ? source.status : 'idle';
  const teams = source.teams && typeof source.teams === 'object' ? source.teams : {};
  const games = Array.isArray(source.games) ? source.games.map(normalizeGame) : [];
  const history = Array.isArray(source.history) ? source.history.map(item => {
    const entry = item && typeof item === 'object' ? item : {};
    const entryTeams = entry.teams && typeof entry.teams === 'object' ? entry.teams : {};
    return {
      id: String(entry.id || ''),
      tournament: String(entry.tournament || ''),
      bestOf: pickBestOf(entry.bestOf),
      teams: {
        blue: { name: String((entryTeams.blue && entryTeams.blue.name) || '') },
        red: { name: String((entryTeams.red && entryTeams.red.name) || '') }
      },
      scores: { blue: int(entry.scores && entry.scores.blue), red: int(entry.scores && entry.scores.red) },
      winner: entry.winner === 'red' ? 'red' : (entry.winner === 'blue' ? 'blue' : null),
      games: Array.isArray(entry.games) ? entry.games.map(normalizeGame) : [],
      startedAt: int(entry.startedAt) || null,
      endedAt: int(entry.endedAt) || null
    };
  }) : [];
  return {
    ...base,
    status,
    tournament: String(source.tournament || ''),
    bestOf: pickBestOf(source.bestOf),
    teams: {
      blue: { name: String((teams.blue && teams.blue.name) || '') },
      red: { name: String((teams.red && teams.red.name) || '') }
    },
    startedAt: int(source.startedAt) || null,
    endedAt: int(source.endedAt) || null,
    gameIndex: int(source.gameIndex),
    scores: { blue: int(source.scores && source.scores.blue), red: int(source.scores && source.scores.red) },
    games,
    history: history.slice(0, MAX_HISTORY)
  };
}

function read() {
  try {
    return normalize(JSON.parse(fs.readFileSync(filePath(), 'utf8')));
  } catch {
    return blank();
  }
}

function write(series) {
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(series, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return series;
}

function needed(bestOf) {
  return Math.floor(pickBestOf(bestOf) / 2) + 1;
}

function decided(series) {
  const need = needed(series.bestOf);
  return series.scores.blue >= need || series.scores.red >= need;
}

// 给控台/页面的快照：加派生字段，页面不用自己算「还差几局赢」。
function snapshot(series) {
  const current = series || read();
  const need = needed(current.bestOf);
  const wonBy = current.scores.blue >= need ? 'blue' : (current.scores.red >= need ? 'red' : null);
  return {
    ...current,
    needed: need,
    decided: Boolean(wonBy),
    winner: wonBy,
    remaining: Math.max(0, need - Math.max(current.scores.blue, current.scores.red))
  };
}

function start(input = {}) {
  const current = read();
  if (current.status === 'running' || current.status === 'finished') {
    // 已经有一轮没结掉时必须先「结束这轮」，避免误点开始把比分和历史冲掉。
    throw fail('series_in_progress');
  }
  const teams = input.teams && typeof input.teams === 'object' ? input.teams : {};
  const next = {
    ...blank(),
    status: 'running',
    tournament: String(input.tournament || current.tournament || ''),
    bestOf: pickBestOf(input.bestOf),
    teams: {
      blue: { name: String((teams.blue && teams.blue.name) || current.teams.blue.name || '') },
      red: { name: String((teams.red && teams.red.name) || current.teams.red.name || '') }
    },
    startedAt: Date.now(),
    gameIndex: 1,
    games: [],
    history: current.history
  };
  return write(next);
}

function recordGame(input = {}) {
  const current = read();
  if (current.status !== 'running') throw fail('series_not_running');
  const blueKills = int(input.blueKills);
  const redKills = int(input.redKills);
  const winner = input.winner === 'red' || input.winner === 'blue'
    ? input.winner
    : (redKills > blueKills ? 'red' : 'blue');
  const game = normalizeGame({
    index: current.gameIndex,
    winner,
    blueKills,
    redKills,
    duration: input.duration,
    mvp: input.mvp,
    endedAt: Date.now()
  });
  // 同一局重复提交（页面刷新 / 连点）只更新、不叠加比分。
  const games = current.games.filter(item => item.index !== game.index);
  games.push(game);
  games.sort((a, b) => a.index - b.index);
  const scores = { blue: 0, red: 0 };
  for (const item of games) scores[item.winner] += 1;
  const next = { ...current, games, scores };
  if (decided(next)) {
    next.status = 'finished';
    next.endedAt = Date.now();
  }
  return write(next);
}

function nextGame() {
  const current = read();
  // 分出胜负的提示优先于「没有进行中的比赛」，页面据此把「下一局」改成「结束这轮」。
  if (decided(current)) throw fail('series_decided');
  if (current.status !== 'running') throw fail('series_not_running');
  return write({ ...current, gameIndex: current.gameIndex + 1 });
}

function end() {
  const current = read();
  if (current.status === 'idle') throw fail('series_not_running');
  const need = needed(current.bestOf);
  const winner = current.scores.blue >= need ? 'blue' : (current.scores.red >= need ? 'red' : null);
  const entry = {
    id: 'm' + Date.now().toString(36),
    tournament: current.tournament,
    bestOf: current.bestOf,
    teams: current.teams,
    scores: current.scores,
    winner,
    games: current.games,
    startedAt: current.startedAt,
    endedAt: Date.now()
  };
  const history = [entry, ...current.history].slice(0, MAX_HISTORY);
  return write({
    ...blank(),
    tournament: current.tournament,
    bestOf: current.bestOf,
    teams: current.teams,
    history
  });
}

function reset() {
  const current = read();
  return write({ ...blank(), tournament: current.tournament, bestOf: current.bestOf, teams: current.teams, history: current.history });
}

module.exports = { read, write, snapshot, start, recordGame, nextGame, end, reset, needed, filePath, MAX_HISTORY };
