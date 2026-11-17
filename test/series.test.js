'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-series-'));
process.env.RB_SERIES_FILE = path.join(dir, 'series.json');

const series = require('../src/series');

function fresh() {
  try { fs.unlinkSync(process.env.RB_SERIES_FILE); } catch {}
}

test('needed：BO1/3/5 分别需要 1/2/3 胜', () => {
  assert.equal(series.needed(1), 1);
  assert.equal(series.needed(3), 2);
  assert.equal(series.needed(5), 3);
  assert.equal(series.needed(7), 2, '非法 BO 回退到 BO3');
});

test('没有文件时读出 idle 空状态', () => {
  fresh();
  const state = series.read();
  assert.equal(state.status, 'idle');
  assert.equal(state.gameIndex, 0);
  assert.deepEqual(state.scores, { blue: 0, red: 0 });
  assert.deepEqual(state.games, []);
});

test('start：开局写 running、第 1 局、BO 与队名', () => {
  fresh();
  const state = series.start({ tournament: '校园赛', bestOf: 5, teams: { blue: { name: '蓝方学院' }, red: { name: '赤焰战队' } } });
  assert.equal(state.status, 'running');
  assert.equal(state.gameIndex, 1);
  assert.equal(state.bestOf, 5);
  assert.equal(state.tournament, '校园赛');
  assert.equal(state.teams.blue.name, '蓝方学院');
  assert.equal(state.teams.red.name, '赤焰战队');
  assert.ok(state.startedAt > 0);
  assert.deepEqual(series.read(), state, 'start 必须落盘');
});

test('start：已有一轮没结掉时拒绝重开（避免冲掉比分与历史）', () => {
  fresh();
  series.start({ bestOf: 3 });
  assert.throws(() => series.start({ bestOf: 3 }), /series_in_progress/);
  series.recordGame({ winner: 'blue', blueKills: 10, redKills: 2 });
  assert.throws(() => series.start({ bestOf: 3 }), /series_in_progress/, 'running 也拒绝');
});

test('recordGame：按当前局号记录、不推进局号、比分由 games 统计得出', () => {
  fresh();
  series.start({ bestOf: 3 });
  const first = series.recordGame({ winner: 'blue', blueKills: 22, redKills: 14, duration: 1920, mvp: { name: '苍岚', team: 'blue' } });
  assert.equal(first.gameIndex, 1, '记录本局不推进');
  assert.deepEqual(first.scores, { blue: 1, red: 0 });
  assert.equal(first.games.length, 1);
  assert.equal(first.games[0].blueKills, 22);
  assert.equal(first.games[0].duration, 1920);
  assert.equal(first.games[0].mvp.name, '苍岚');
});

test('recordGame：同一局重提只覆盖不改比分', () => {
  fresh();
  series.start({ bestOf: 3 });
  series.recordGame({ winner: 'blue', blueKills: 20, redKills: 9 });
  const again = series.recordGame({ winner: 'red', blueKills: 9, redKills: 20 });
  assert.equal(again.games.length, 1, '同局号覆盖而不是追加');
  assert.deepEqual(again.scores, { blue: 0, red: 1 }, '比分跟着覆盖重算');
  assert.equal(again.games[0].winner, 'red');
});

test('recordGame：没有进行中的比赛时拒绝', () => {
  fresh();
  assert.throws(() => series.recordGame({ winner: 'blue' }), /series_not_running/);
});

test('recordGame：没给 winner 时按击杀数推断', () => {
  fresh();
  series.start({ bestOf: 3 });
  const state = series.recordGame({ blueKills: 8, redKills: 17 });
  assert.equal(state.games[0].winner, 'red');
});

test('nextGame：推进局号；分出胜负后拒绝推进', () => {
  fresh();
  series.start({ bestOf: 3 });
  series.recordGame({ winner: 'blue', blueKills: 15, redKills: 10 });
  assert.equal(series.nextGame().gameIndex, 2);
  series.recordGame({ winner: 'blue', blueKills: 15, redKills: 10 });
  const decided = series.snapshot();
  assert.equal(decided.decided, true);
  assert.equal(decided.winner, 'blue');
  assert.equal(decided.remaining, 0);
  assert.throws(() => series.nextGame(), /series_decided/);
});

test('nextGame：没有进行中的比赛时拒绝', () => {
  fresh();
  assert.throws(() => series.nextGame(), /series_not_running/);
});

test('snapshot：remaining 表示最大领先方还差几胜', () => {
  fresh();
  series.start({ bestOf: 5 });
  series.recordGame({ winner: 'red', blueKills: 3, redKills: 9 });
  const snap = series.snapshot();
  assert.equal(snap.needed, 3);
  assert.equal(snap.decided, false);
  assert.equal(snap.winner, null);
  assert.equal(snap.remaining, 2);
});

test('end：本轮进历史、回到 idle、保留赛事信息', () => {
  fresh();
  series.start({ tournament: '校园赛', bestOf: 3, teams: { blue: { name: 'A' }, red: { name: 'B' } } });
  series.recordGame({ winner: 'blue', blueKills: 12, redKills: 7 });
  series.nextGame();
  series.recordGame({ winner: 'red', blueKills: 7, redKills: 12 });
  series.nextGame();
  series.recordGame({ winner: 'red', blueKills: 5, redKills: 13 });
  const after = series.end();
  assert.equal(after.status, 'idle');
  assert.equal(after.gameIndex, 0);
  assert.deepEqual(after.scores, { blue: 0, red: 0 });
  assert.equal(after.history.length, 1);
  assert.equal(after.history[0].winner, 'red');
  assert.deepEqual(after.history[0].scores, { blue: 1, red: 2 });
  assert.equal(after.history[0].games.length, 3);
  assert.equal(after.tournament, '校园赛', '赛事信息留给下一轮');
  assert.equal(after.bestOf, 3);
});

test('end：没有进行中的比赛时拒绝', () => {
  fresh();
  assert.throws(() => series.end(), /series_not_running/);
});

test('end：历史只保留最近 MAX_HISTORY 轮', () => {
  fresh();
  for (let i = 0; i < series.MAX_HISTORY + 3; i += 1) {
    series.start({ bestOf: 1, tournament: 'T' + i });
    series.recordGame({ winner: 'blue', blueKills: 1, redKills: 0 });
    series.end();
  }
  const state = series.read();
  assert.equal(state.history.length, series.MAX_HISTORY);
  assert.equal(state.history[0].tournament, 'T' + (series.MAX_HISTORY + 2), '最新一轮在最前');
});

test('reset：清空本轮，保留赛事信息与历史', () => {
  fresh();
  series.start({ tournament: '校园赛', bestOf: 3 });
  series.recordGame({ winner: 'blue', blueKills: 4, redKills: 1 });
  series.end();
  series.start({ tournament: '校园赛', bestOf: 3 });
  series.recordGame({ winner: 'red', blueKills: 1, redKills: 4 });
  const state = series.reset();
  assert.equal(state.status, 'idle');
  assert.deepEqual(state.games, []);
  assert.equal(state.history.length, 1, '已完成的场次不能被 reset 抹掉');
  assert.equal(state.tournament, '校园赛');
});

test('read：文件损坏时回退空状态而不是抛错', () => {
  fs.writeFileSync(process.env.RB_SERIES_FILE, '{not json', 'utf8');
  const state = series.read();
  assert.equal(state.status, 'idle');
  assert.deepEqual(state.games, []);
});
