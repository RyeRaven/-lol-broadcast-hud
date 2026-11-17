const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTimelineGold, parseTimelineGoldPlayers } = require('../src/gold-timeline');
const { buildPostGame } = require('../src/post-game');

function pfEntry(pid, gold) {
  return { participantId: pid, totalGold: gold };
}
function pfFrom(entries) {
  const pf = {};
  for (const [pid, gold] of entries) pf[pid] = pfEntry(pid, gold);
  return pf;
}
// 蓝方泉水果真在低坐标角：把红方故意放到 pids 1-5、蓝方 6-10，证明分簇不靠惯例。
const MIXED_SPAWNS = {
  1: { x: 14100, y: 14200 },
  2: { x: 14300, y: 14150 },
  3: { x: 14200, y: 14500 },
  4: { x: 14500, y: 14300 },
  5: { x: 14050, y: 14400 },
  6: { x: 600, y: 610 },
  7: { x: 660, y: 280 },
  8: { x: 360, y: 130 },
  9: { x: 130, y: 400 },
  10: { x: 300, y: 670 }
};

function mixedFrames() {
  const frames = [];
  const gold = (m, pid) => 500 + m * 100 + pid;
  for (let m = 0; m <= 3; m += 1) {
    const pf = {};
    for (let pid = 1; pid <= 10; pid += 1) {
      pf[pid] = { participantId: pid, totalGold: gold(m, pid) };
      if (m === 0) pf[pid].position = MIXED_SPAWNS[pid];
    }
    frames.push({ timestamp: m * 60000, participantFrames: pf, events: [] });
  }
  return frames;
}

test('parseTimelineGoldPlayers: 开局出生点分簇决定蓝红（红方 pid 1-5 / 蓝方 pid 6-10 也判对）', () => {
  const out = parseTimelineGoldPlayers({ frames: mixedFrames() });
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 10);
  const byPid = Object.fromEntries(out.map((s) => [s.pid, s]));
  for (let pid = 1; pid <= 5; pid += 1) assert.equal(byPid[pid].side, 'red', 'pid ' + pid);
  for (let pid = 6; pid <= 10; pid += 1) assert.equal(byPid[pid].side, 'blue', 'pid ' + pid);
  assert.deepEqual(byPid[3].points, [
    { t: 0, gold: 503 },
    { t: 1, gold: 603 },
    { t: 2, gold: 703 },
    { t: 3, gold: 803 }
  ]);
});

test('parseTimelineGoldPlayers: 无出生点时按惯例 1-5 蓝 / 6-10 红', () => {
  const frames = mixedFrames().map((f) => ({
    ...f,
    participantFrames: pfFrom(Object.entries(f.participantFrames).map(([pid, e]) => [pid, e.totalGold]))
  }));
  const out = parseTimelineGoldPlayers({ frames });
  const byPid = Object.fromEntries(out.map((s) => [s.pid, s]));
  for (let pid = 1; pid <= 5; pid += 1) assert.equal(byPid[pid].side, 'blue', 'pid ' + pid);
  for (let pid = 6; pid <= 10; pid += 1) assert.equal(byPid[pid].side, 'red', 'pid ' + pid);
});

test('parseTimelineGoldPlayers: timeline.participants 优先（teamId 200=红）', () => {
  const out = parseTimelineGoldPlayers({
    participants: [{ participantId: 1, teamId: 200 }, { participantId: 6, teamId: 100 }],
    frames: mixedFrames()
  });
  const byPid = Object.fromEntries(out.map((s) => [s.pid, s]));
  assert.equal(byPid[1].side, 'red');
  assert.equal(byPid[6].side, 'blue');
});

test('parseTimelineGoldPlayers: roster 映射补英雄/名字，同分钟去重，坏输入返 null', () => {
  const roster = { 3: { champion: 'Syndra', name: 'mid god' } };
  const frames = mixedFrames();
  frames[1].participantFrames[3].totalGold = 999; // 同一分钟两条 → 后值生效
  frames.push({ timestamp: 3.2 * 60000, participantFrames: { 3: { participantId: 3, totalGold: 1234 } } });
  const out = parseTimelineGoldPlayers({ frames }, roster);
  const s3 = out.find((s) => s.pid === 3);
  assert.equal(s3.champion, 'Syndra');
  assert.equal(s3.name, 'mid god');
  const ts = s3.points.map((p) => p.t);
  assert.deepEqual(ts, [0, 1, 2, 3]);
  assert.equal(s3.points[1].gold, 999);
  const others = out.filter((s) => s.pid !== 3);
  for (const s of others) assert.equal(s.champion, null);
  assert.equal(parseTimelineGoldPlayers(null), null);
  assert.equal(parseTimelineGoldPlayers({ frames: [] }), null);
  assert.equal(parseTimelineGoldPlayers({ frames: [{ timestamp: 0, participantFrames: {} }] }), null);
  assert.equal(parseTimelineGold({ frames: [] }), null);
});

test('eog player 透传 participantId：有就带、没有就 null（绝不按顺序猜）', () => {
  const eog = {
    gameLength: 1500,
    teams: [
      {
        teamId: 100,
        win: true,
        players: [
          { participantId: 4, summonerName: 'blue4', championName: 'Lucian', stats: { kills: 2, deaths: 3, assists: 5, goldEarned: 9000 } },
          { summonerName: 'blue5', championName: 'Lulu', stats: { kills: 0, deaths: 1, assists: 9, goldEarned: 7000 } }
        ]
      }
    ]
  };
  const pg = buildPostGame({ eog });
  assert.equal(pg.players[0].participantId, 4);
  assert.equal(pg.players[1].participantId, null);
});
