'use strict';
const test = require('node:test');
const assert = require('node:assert');
const demo = require('../src/mock-demo');

test('循环长度与阶段边界固定', () => {
  assert.strictEqual(demo.LOOP_MS, 180000);
  assert.strictEqual(demo.LOOP.lobbyMs + demo.LOOP.draftMs + demo.LOOP.gameMs + demo.LOOP.postMs, demo.LOOP_MS);
  assert.strictEqual(demo.sceneAt(0).stage, 'lobby');
  assert.strictEqual(demo.sceneAt(4999).stage, 'lobby');
  assert.strictEqual(demo.sceneAt(5000).stage, 'draft');
  assert.strictEqual(demo.sceneAt(44000).stage, 'draft');
  assert.strictEqual(demo.sceneAt(45000).stage, 'game');
  assert.strictEqual(demo.sceneAt(149000).stage, 'game');
  assert.strictEqual(demo.sceneAt(150000).stage, 'post');
  assert.strictEqual(demo.sceneAt(179999).stage, 'post');
});

test('赛后一帧给出完整结算与比分', () => {
  const scene = demo.sceneAt(151000);
  assert.strictEqual(scene.stage, 'post');
  assert.strictEqual(scene.phase, 'post_game');
  assert.strictEqual(scene.result.blueKills, 18);
  assert.strictEqual(scene.result.redKills, 13);
  assert.strictEqual(scene.result.winner, 'blue');
  assert.ok(scene.postGame, 'postGame 必须存在');
  assert.strictEqual(scene.postGame.players.length, 10);
  assert.strictEqual(scene.postGame.gameLength, demo.GAME_LENGTH);
  for (const p of scene.postGame.players) {
    assert.ok(p.damage > 0, '伤害必须为正：' + p.name);
    assert.ok(p.gold > 0, '经济必须为正：' + p.name);
  }
});

test('击杀事件与选手 KDA 对账', () => {
  const scene = demo.sceneAt(151000);
  const sum = (side, key) => scene.players.filter(p => p.team === side).reduce((n, p) => n + p[key], 0);
  assert.strictEqual(sum('blue', 'kills'), 18);
  assert.strictEqual(sum('red', 'kills'), 13);
  assert.strictEqual(demo.KILLS.length, 31);
  assert.strictEqual(demo.KILLS.filter(k => k.side === 'blue').length, 18);
  assert.strictEqual(demo.KILLS.filter(k => k.side === 'red').length, 13);
  assert.ok(demo.KILLS.every(k => k.at >= 0 && k.at <= demo.GAME_LENGTH));
  assert.ok(demo.KILLS[0].at > 0);
});

test('BP 选人逐步增加、禁止各五个', () => {
  const count = (scene) => scene.draft.bluePicks.length + scene.draft.redPicks.length;
  const early = count(demo.sceneAt(6000));
  const mid = count(demo.sceneAt(25000));
  const late = demo.sceneAt(44000);
  assert.ok(early < mid, 'BP 手数必须随时间增加');
  assert.ok(mid < count(late));
  assert.strictEqual(late.draft.bluePicks.length, 5);
  assert.strictEqual(late.draft.redPicks.length, 5);
  assert.strictEqual(late.draft.blueBans.length, 5);
  assert.strictEqual(late.draft.redBans.length, 5);
  assert.ok(late.draft.timer >= 0 && late.draft.timer <= 30);
});

test('局内经济随时间单调递增', () => {
  let lastBlue = 0;
  let lastRed = 0;
  for (let t = 45000; t <= 149000; t += 4000) {
    const scene = demo.sceneAt(t);
    assert.ok(scene.blue.gold >= lastBlue, '蓝方经济不能倒退 @' + t);
    assert.ok(scene.red.gold >= lastRed, '红方经济不能倒退 @' + t);
    lastBlue = scene.blue.gold;
    lastRed = scene.red.gold;
  }
  assert.ok(lastBlue > 30000 && lastRed > 30000);
});

test('剧本是纯函数（同一时刻结果完全一致）', () => {
  for (const t of [0, 12345, 77777, 151000, 179999]) {
    assert.deepStrictEqual(demo.sceneAt(t), demo.sceneAt(t));
  }
});

test('十人名单与队伍信息齐备', () => {
  assert.strictEqual(demo.ROSTER.length, 10);
  assert.ok(demo.TEAMS.blue.name && demo.TEAMS.red.name);
  const roles = demo.ROSTER.map(p => p.role).sort().join(',');
  assert.strictEqual(roles, 'ADC,ADC,JUNGLE,JUNGLE,MID,MID,SUPPORT,SUPPORT,TOP,TOP');
});
