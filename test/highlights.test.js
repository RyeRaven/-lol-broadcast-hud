'use strict';

// t26：精彩事件评分与导播提示 API 的纯函数/接口测试。
// 覆盖真实 fixture、多杀（含无显式 Multikill 的推导）、团灭、空事件、重复事件去重、
// combo 合并与最近 20 条排序；不读取游戏内存，不依赖外部网络。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHighlights,
  latestHighlights,
  summarizeHighlights,
  handleHighlightsApi,
  compareHighlights,
  MAX_HIGHLIGHTS,
  SCORE_WEIGHTS
} = require('../src/highlights');
const fixture = require('./fixtures/live-real-game.json');

const PLAYER = (name, team, champion) => ({ summonerName: name, team, championName: champion });

function eventPayload(events, players = [PLAYER('蓝方玩家#0001', 'ORDER', '奥莉安娜')]) {
  return { allPlayers: players, events: { Events: events } };
}

test('fixture：真实 58 条事件被评分并按 score/time 降序输出', () => {
  const highlights = buildHighlights(fixture);
  assert.ok(highlights.length > 0);
  assert.ok(highlights.length <= MAX_HIGHLIGHTS);
  for (const entry of highlights) {
    assert.deepEqual(Object.keys(entry).sort(), ['champion', 'id', 'player', 'score', 'side', 'text', 'time', 'type']);
    assert.equal(typeof entry.score, 'number');
    assert.ok(entry.score > 0);
  }
  for (let i = 1; i < highlights.length; i += 1) {
    assert.ok(compareHighlights(highlights[i - 1], highlights[i]) <= 0, '输出必须按 score 降序、time 降序');
  }
  const combo = highlights.find(entry => entry.type === 'combo');
  assert.ok(combo, '同队近时间高光应合并成 combo');
  assert.equal(combo.score, 95, '双杀 35 + 三杀 60 = 95');
  assert.ok(combo.text.includes('连击'));
  assert.ok(highlights.some(entry => entry.type === 'first_blood' && entry.score === 45 && entry.champion === '迅捷斥候'));
  const brickCombo = highlights.find(entry => entry.type === 'combo' && entry.score === 65);
  assert.ok(brickCombo && brickCombo.text.includes('首座防御塔'), '首座塔应与同时刻推塔合并为 65 分 combo');
  assert.ok(highlights.some(entry => entry.type === 'herald' && entry.score === 35));
  assert.ok(highlights.some(entry => entry.type === 'dragon' && entry.score === 30));
  assert.ok(highlights.some(entry => entry.type === 'tower' && entry.score === 25));
  assert.ok(highlights.some(entry => entry.type === 'horde' && entry.score === 20));
  assert.ok(highlights.some(entry => entry.type === 'game_end' && entry.score === 10));
  assert.equal(summarizeHighlights(highlights).count, highlights.length);
});

test('多杀识别：双杀/三杀/四杀/五杀分别映射权重与中文文本', () => {
  const events = [
    { EventID: 1, EventName: 'Multikill', EventTime: 10, KillerName: '蓝方玩家#0001', KillStreak: 2 },
    { EventID: 2, EventName: 'Multikill', EventTime: 20, KillerName: '蓝方玩家#0001', KillStreak: 3 },
    { EventID: 3, EventName: 'Multikill', EventTime: 30, KillerName: '蓝方玩家#0001', KillStreak: 4 },
    { EventID: 4, EventName: 'Multikill', EventTime: 40, KillerName: '蓝方玩家#0001', KillStreak: 5 }
  ];
  const highlights = buildHighlights(eventPayload(events), { comboWindowSeconds: 0 });
  assert.equal(highlights.length, 4);
  const expected = [['doublekill', 35, '双杀'], ['triplekill', 60, '三杀'], ['quadrakill', 80, '四杀'], ['pentakill', 100, '五杀']];
  for (const [type, score, text] of expected) {
    const entry = highlights.find(item => item.type === type);
    assert.ok(entry, type + ' 应被识别');
    assert.equal(entry.score, score);
    assert.equal(entry.side, 'blue');
    assert.ok(entry.text.includes(text));
  }
  assert.deepEqual(SCORE_WEIGHTS.pentakill, 100);
});

test('多杀识别：没有显式 Multikill 时从连续 ChampionKill 推导', () => {
  const events = [
    { EventID: 11, EventName: 'ChampionKill', EventTime: 100, KillerName: '蓝方玩家#0001' },
    { EventID: 12, EventName: 'ChampionKill', EventTime: 104, KillerName: '蓝方玩家#0001' },
    { EventID: 13, EventName: 'ChampionKill', EventTime: 107, KillerName: '蓝方玩家#0001' }
  ];
  const highlights = buildHighlights(eventPayload(events), { comboWindowSeconds: 0, multikillWindowSeconds: 10 });
  assert.ok(highlights.some(entry => entry.type === 'triplekill' && entry.score === 60 && entry.text.includes('三杀')));
  assert.ok(highlights.some(entry => entry.type === 'doublekill' && entry.score === 35));
});

test('大龙/远古龙/比赛结束：权重与阵营映射正确', () => {
  const events = [
    { EventID: 51, EventName: 'BaronKill', EventTime: 300, KillerName: '蓝方玩家#0001' },
    { EventID: 52, EventName: 'DragonKill', EventTime: 310, KillerName: '蓝方玩家#0001', DragonType: 'Elder' },
    { EventID: 53, EventName: 'GameEnd', EventTime: 400, WinnerTeam: 'CHAOS' }
  ];
  const highlights = buildHighlights(eventPayload(events), { comboWindowSeconds: 0 });
  const baron = highlights.find(entry => entry.type === 'baron');
  const elder = highlights.find(entry => entry.type === 'elder_dragon');
  const end = highlights.find(entry => entry.type === 'game_end');
  assert.ok(baron && baron.score === 70 && baron.text.includes('纳什男爵'));
  assert.ok(elder && elder.score === 60 && elder.text.includes('远古龙'));
  assert.ok(end && end.score === 10 && end.side === 'red' && end.text === '比赛结束');
});

test('团灭：Ace 事件按阵营与权重评分', () => {
  const events = [
    { EventID: 21, EventName: 'Ace', EventTime: 700, AcingTeam: 'ORDER' },
    { EventID: 22, EventName: 'Ace', EventTime: 800, AcingTeam: 'CHAOS' }
  ];
  const highlights = buildHighlights(eventPayload(events), { comboWindowSeconds: 0 });
  const blue = highlights.find(entry => entry.time === 700);
  const red = highlights.find(entry => entry.time === 800);
  assert.ok(blue && blue.type === 'ace' && blue.score === 65 && blue.side === 'blue');
  assert.ok(red && red.type === 'ace' && red.score === 65 && red.side === 'red');
  assert.ok(blue.text.includes('团灭'));
});

test('空事件与重复事件：安全返回空数组，同 EventID 只保留一条', () => {
  assert.deepEqual(buildHighlights(null), []);
  assert.deepEqual(buildHighlights({}), []);
  assert.deepEqual(buildHighlights({ events: { Events: [] } }), []);
  assert.deepEqual(buildHighlights([null, undefined, 0, 'x']), []);
  const duplicate = { EventID: 31, EventName: 'DragonKill', EventTime: 500, KillerName: '蓝方玩家#0001', DragonType: 'Fire' };
  const highlights = buildHighlights(eventPayload([duplicate, duplicate, { ...duplicate }]), { comboWindowSeconds: 0 });
  assert.equal(highlights.filter(entry => entry.type === 'dragon').length, 1);
  assert.equal(highlights[0].score, 30);
});

test('combo：同队 5 秒内多个高光合并并累计分数，不同队不合并', () => {
  const events = [
    { EventID: 41, EventName: 'TurretKilled', EventTime: 100, KillerName: '蓝方玩家#0001', TurretKilled: 'Turret_TChaos_01' },
    { EventID: 42, EventName: 'DragonKill', EventTime: 102, KillerName: '蓝方玩家#0001', DragonType: 'Fire' },
    { EventID: 43, EventName: 'TurretKilled', EventTime: 103, KillerName: '红方玩家#0002', TurretKilled: 'Turret_TOrder_01' }
  ];
  const highlights = buildHighlights(eventPayload(events, [
    PLAYER('蓝方玩家#0001', 'ORDER', '奥莉安娜'),
    PLAYER('红方玩家#0002', 'CHAOS', '奥瑞利安·索尔')
  ]), { comboWindowSeconds: 5 });
  const combo = highlights.find(entry => entry.type === 'combo');
  assert.ok(combo, '蓝方两条应合并');
  assert.equal(combo.side, 'blue');
  assert.equal(combo.score, 55, '推塔 25 + 小龙 30 = 55');
  assert.ok(combo.text.startsWith('蓝方 连击：'));
  const red = highlights.find(entry => entry.side === 'red' && entry.type === 'tower');
  assert.ok(red, '红方应保持独立');
});

test('最近 20 条：排序稳定且最多返回 MAX_HIGHLIGHTS 条', () => {
  const events = [];
  for (let index = 0; index < 25; index += 1) {
    events.push({ EventID: 100 + index, EventName: 'TurretKilled', EventTime: 100 + index * 10, KillerName: '蓝方玩家#0001' });
  }
  const built = buildHighlights(eventPayload(events), { comboWindowSeconds: 0 });
  assert.equal(built.length, 25);
  const latest = latestHighlights(built, MAX_HIGHLIGHTS);
  assert.equal(latest.length, MAX_HIGHLIGHTS);
  assert.equal(latest[0].time, 340);
  assert.equal(latest[latest.length - 1].time, 150);
  assert.equal(latestHighlights(null).length, 0);
});

test('GET /api/highlights 处理器返回摘要、列表与 limit 参数', () => {
  const state = {
    highlights: [
      { id: '1', time: 10, type: 'pentakill', side: 'blue', text: '五杀', score: 100, champion: '英雄A', player: '玩家A' },
      { id: '2', time: 20, type: 'tower', side: 'red', text: '推塔', score: 25, champion: '英雄B', player: '玩家B' }
    ]
  };
  let captured = null;
  const json = (res, status, body) => { captured = { status, body }; };
  handleHighlightsApi({ method: 'GET' }, {}, { searchParams: new URLSearchParams('limit=1') }, { json, state });
  assert.equal(captured.status, 200);
  assert.equal(captured.body.ok, true);
  assert.equal(captured.body.count, 1);
  assert.equal(captured.body.highlights[0].type, 'pentakill');
  assert.equal(captured.body.summary.count, 2);
  assert.equal(captured.body.summary.topScore, 100);
  captured = null;
  handleHighlightsApi({ method: 'POST' }, {}, { searchParams: new URLSearchParams() }, { json, state });
  assert.equal(captured.status, 405);
  assert.equal(captured.body.error, 'method_not_allowed');
});
