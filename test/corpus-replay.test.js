'use strict';

// 语料回放桥（t32）测试：buildFrames 的取整/空值/精度矩阵/事件合成 + 英雄名对齐键归一化。

const test = require('node:test');
const assert = require('node:assert');
const { buildFrames, decidePrecision, synthesizeEvents } = require('../tools/protocol-corpus-replay.cjs');
const { createProtocolLookup, championKey } = require('../src/protocol-feed');

function fixtureDec() {
  return {
    payloadLen: 1263,
    times: [0, 60.028],
    players: [
      { participantId: 1, champion: 'DrMundo', team: null, role: 'TOP', index: 0 },
      { participantId: 5, champion: 'Lulu', team: null, role: 'UTILITY', index: 4 },
      { participantId: 6, champion: 'Yone', team: null, role: 'TOP', index: 5 },
      { participantId: 10, champion: 'Nami', team: null, role: 'UTILITY', index: 9 }
    ],
    fields: {
      kills: { precision: 'exact' },
      deaths: { precision: 'exact' },
      assists: { precision: 'estimated' },
      minionsKilled: { precision: 'exact' },
      jungleMinionsKilled: { precision: 'quantized' },
      xp: { precision: 'estimated' },
      totalGold: { precision: 'estimated' },
      cs: { precision: 'quantized' }
    },
    series: {
      kills: [[0, 0, 0, 0], [2, 0, 1, 4]],
      deaths: [[0, 0, 0, 0], [1, 0, 0, 1]],
      assists: [[0, 0, 0, 0], [1, 2, 3, 4]],
      minionsKilled: [[0, 0, 0, 0], [179, 22, 203.9, 38]],
      jungleMinionsKilled: [[0, 0, 0, 0], [0.5, 143.5, 4, 0]],
      xp: [[0, 0, 0, 0], [17056.494, null, 15801.592, 10716.404]],
      totalGold: [[500, 500, 500, 500], [9620.926, null, 14262.282, 8720.4]],
      cs: [[0, 0, 0, 0], [179.5, 165.5, 207.9, 38]]
    }
  };
}

test('buildFrames: 首帧全 0 + 逐字段取整与空值语义', () => {
  const frames = buildFrames(fixtureDec(), { gameId: '901131919780' });
  assert.strictEqual(frames.length, 2);
  const f0 = frames[0];
  assert.strictEqual(f0.source, 'corpus');
  assert.strictEqual(f0.gameId, '901131919780');
  assert.strictEqual(f0.gameTime, 0);
  assert.strictEqual(f0.players.length, 4);
  for (const rec of f0.players) {
    assert.strictEqual(rec.kills, 0);
    assert.strictEqual(rec.cs, 0);
    assert.strictEqual(rec.totalGold, 500);
    assert.strictEqual(rec.xp, 0);
  }
  const f1 = frames[1];
  assert.strictEqual(f1.gameTime, 60.028);
  // participantId 1..5=蓝、6..10=红（Riot 观战协议约定）
  assert.strictEqual(f1.players[0].team, 'blue');
  assert.strictEqual(f1.players[1].team, 'blue');
  assert.strictEqual(f1.players[2].team, 'red');
  assert.strictEqual(f1.players[3].team, 'red');
  // cs = floor(minions) + floor(jungle)：179+0 / 22+143 / 203+4 / 38+0
  assert.deepStrictEqual(f1.players.map(r => r.cs), [179, 165, 207, 38]);
  // xp/gold 缺口帧发 null（解码缺口，绝不补 0）
  assert.strictEqual(f1.players[1].xp, null);
  assert.strictEqual(f1.players[1].totalGold, null);
  assert.strictEqual(f1.players[0].xp, 17056);
  assert.strictEqual(f1.players[0].totalGold, 9620);
  // 英雄名原样透传，由接收端归一化对齐
  assert.strictEqual(f1.players[0].championName, 'DrMundo');
});

test('buildFrames: 默认精度矩阵 + --conservative 回落产物标签', () => {
  const dec = fixtureDec();
  const def = decidePrecision(dec.fields, false);
  assert.deepStrictEqual(def, { kills: 'exact', deaths: 'exact', assists: 'estimated', cs: 'exact', xp: 'exact', totalGold: 'exact' });
  const con = decidePrecision(dec.fields, true);
  assert.deepStrictEqual(con, { kills: 'exact', deaths: 'exact', assists: 'estimated', cs: 'quantized', xp: 'estimated', totalGold: 'estimated' });
  const frames = buildFrames(dec, { conservative: true });
  assert.strictEqual(frames[0].players[0].precision.cs, 'quantized');
});

test('synthesizeEvents: KDA 增量贪心配对', () => {
  const dec = fixtureDec();
  // frame1 增量：kills 差 [2,0,1,4]、deaths 差 [1,0,0,1] → 击杀 7 个、死亡 2 个，配对 2 对
  const events = synthesizeEvents(dec.series, 1, 4, 60.028);
  const kills = events.filter(e => e.type === 'kill');
  const deaths = events.filter(e => e.type === 'death');
  assert.strictEqual(kills.length, 2);
  assert.strictEqual(deaths.length, 0);
  assert.strictEqual(kills[0].t, 60.028);
  assert.deepStrictEqual(kills.map(e => e.killer).sort((a, b) => a - b), [1, 1]);
  assert.deepStrictEqual(kills.map(e => e.victim).sort((a, b) => a - b), [1, 4]);
  assert.deepStrictEqual(kills[0].assists, []);
  // 首帧无增量 → 无事件
  assert.deepStrictEqual(synthesizeEvents(dec.series, 0, 4, 0), []);
});

test('createProtocolLookup: championKey 让 DrMundo 对上 Dr. Mundo', () => {
  assert.strictEqual(championKey('Dr. Mundo'), 'drmundo');
  assert.strictEqual(championKey('DrMundo'), 'drmundo');
  assert.strictEqual(championKey("Kai'Sa"), 'kaisa');
  const lookup = createProtocolLookup([{ participantId: 1, team: null, championName: 'DrMundo', cs: 179, precision: { cs: 'exact' } }]);
  const rec = lookup({ championName: 'Dr. Mundo', team: 'blue' });
  assert.ok(rec, '显示名应能精确对齐语料内部名');
  assert.strictEqual(rec.cs, 179);
});
