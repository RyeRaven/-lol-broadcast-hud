'use strict';

// HUD 经济估算：Live Client Data 不提供全队金币，只能由装备总价 + 补刀 + KDA + 被动金币估算。
// 测试不访问网络：使用 data/items-16.22.1.json 缓存和注入的小型物品索引。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  estimateTeamGold, buildItemIndex, loadItemIndex, readItemCache,
  ITEM_CACHE_TTL, GOLD_WEIGHTS
} = require('../src/live-data');
const fixture = require('./fixtures/live-real-game.json');

test('empty or invalid player list returns zero for both sides', () => {
  assert.deepEqual(estimateTeamGold([], 0), { blue: 0, red: 0 });
  assert.deepEqual(estimateTeamGold(null, 1000), { blue: 0, red: 0 });
  assert.deepEqual(estimateTeamGold([null, {}, { team: 'SPECTATOR' }], 1000), { blue: 0, red: 0 });
});

test('estimates both sides from the 10-player real fixture', async () => {
  const index = await loadItemIndex({ version: '16.22.1' });
  assert.equal(index.version, '16.22.1');
  assert.ok(index.size > 800, 'Data Dragon 物品索引应已加载');
  // 确认用的是 item.json 的 gold.total，而不是 Live Client Data 的 price（后者是合成基础价）。
  assert.equal(index.price(3086), 1200);
  assert.equal(index.price(3074), 3300);

  const gold = estimateTeamGold(fixture.allPlayers, fixture.gameData.gameTime, { itemIndex: index });
  assert.deepEqual(gold, { blue: 63415, red: 74115 });
  assert.ok(Number.isInteger(gold.blue) && Number.isInteger(gold.red));
  assert.ok(gold.blue > 5 * fixture.gameData.gameTime * GOLD_WEIGHTS.passivePerSecond);
  assert.ok(gold.red > 5 * fixture.gameData.gameTime * GOLD_WEIGHTS.passivePerSecond);
});

test('falls back to item.price and then zero when Data Dragon has no price', () => {
  const index = buildItemIndex({ '1': { id: '1', name: '测试装备', gold: { total: 1000 } } }, 'test');
  const gold = estimateTeamGold([
    {
      team: 'ORDER',
      scores: { kills: 1, assists: 2, creepScore: 10 },
      items: [
        { itemID: 1 },
        { itemID: 999999, price: 500 },
        { displayName: '不存在的装备' },
        null
      ]
    }
  ], 10, { itemIndex: index });
  // 1000 装备 + 500 回退 + 10*20 补刀 + 1*300 击杀 + 2*150 助攻 + 10*2.4 被动 = 2324
  assert.equal(gold.blue, 2324);
  assert.equal(gold.red, 0);
});

test('accepts normalized players (blue/red, cs, item display names)', () => {
  const index = buildItemIndex({ '1': { id: '1', name: '测试装备', gold: { total: 1000 } } }, 'test');
  const gold = estimateTeamGold([
    { team: 'blue', cs: 10, kills: 1, assists: 2, items: ['测试装备'] },
    { team: 'red', cs: 5, kills: 0, assists: 0, items: [] }
  ], 10, { itemIndex: index });
  assert.equal(gold.blue, 1000 + 10 * GOLD_WEIGHTS.cs + GOLD_WEIGHTS.kill + 2 * GOLD_WEIGHTS.assist + 10 * GOLD_WEIGHTS.passivePerSecond);
  assert.equal(gold.red, 5 * GOLD_WEIGHTS.cs + 10 * GOLD_WEIGHTS.passivePerSecond);
});

test('item cache expires after seven days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-items-'));
  try {
    const file = path.join(dir, 'items-test.json');
    fs.writeFileSync(file, JSON.stringify({
      savedAt: Date.now() - ITEM_CACHE_TTL - 1000,
      version: 'test',
      data: { '1': { id: '1', name: '测试装备', gold: { total: 1000 } } }
    }));
    assert.equal(readItemCache('test', { cacheDir: dir }), null, '超过 7 天应视为过期');

    fs.writeFileSync(file, JSON.stringify({
      savedAt: Date.now(),
      version: 'test',
      data: { '1': { id: '1', name: '测试装备', gold: { total: 1000 } } }
    }));
    const fresh = readItemCache('test', { cacheDir: dir });
    assert.ok(fresh);
    assert.equal(fresh.price(1), 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
