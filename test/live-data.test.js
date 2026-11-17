const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLiveState, buildItemIndex, createObjectiveLedger } = require('../src/live-data');

// 价格断言不能依赖磁盘上的 Data Dragon 缓存（可能过期/缺失），统一注入小型索引。
const itemIndex = buildItemIndex({
  '1054': { name: '多兰之刃', gold: { total: 450 } },
  '3086': { name: '狂热', gold: { total: 1200 } },
  '1042': { name: '短剑', gold: { total: 250 } }
}, 'test');

const payload = {
  gameData: { gameTime: 734.5, gameMode: 'CLASSIC', mapName: 'Map11' },
  allPlayers: [
    { summonerName: 'BlueTop', team: 'ORDER', championName: 'Jayce', level: 9, isDead: false, respawnTimer: 0, position: 'TOP', scores: { kills: 2, deaths: 1, assists: 3, creepScore: 88, wardScore: 4 }, items: [{ itemID: 1054, displayName: '多兰之刃' }], summonerSpells: { summonerSpellOne: { displayName: '闪现' }, summonerSpellTwo: { displayName: '传送' } } },
    { summonerName: 'BlueMid', team: 'ORDER', championName: 'Syndra', level: 8, isDead: true, respawnTimer: 12, scores: { kills: 1, deaths: 2, assists: 1, creepScore: 70 } },
    { summonerName: 'RedAdc', team: 'CHAOS', championName: 'Jinx', level: 9, isDead: false, scores: { kills: 3, deaths: 0, assists: 2, creepScore: 95 } }
  ],
  events: { Events: [
    { EventID: 1, EventName: 'TurretKilled', KillerName: 'Jinx', EventTime: 600 },
    { EventID: 2, EventName: 'DragonKill', KillerName: 'Jayce', EventTime: 620 },
    { EventID: 3, EventName: 'ChampionKill', KillerName: 'Jinx', EventTime: 700 }
  ] }
};

test('maps players, teams and death state', () => {
  const live = normalizeLiveState(payload, { itemIndex });
  assert.equal(live.gameTime, 734.5);
  assert.equal(live.players.length, 3);
  assert.equal(live.players[0].team, 'blue');
  assert.equal(live.players[1].team, 'blue');
  assert.equal(live.players[2].team, 'red');
  assert.equal(live.players[1].alive, false);
  assert.equal(live.players[1].respawnTimer, 12);
  assert.deepEqual(live.players[0].summoners, ['闪现', '传送']);
  // t9：装备保留对象形态（itemID/count/slot/displayName/price），itemNames 是给老页面的兼容访问器。
  assert.deepEqual(live.players[0].items, [{ itemID: 1054, count: 1, slot: null, displayName: '多兰之刃', price: 450 }]);
  assert.deepEqual(live.players[0].itemNames, ['多兰之刃']);
});

test('aggregates score and objectives by side', () => {
  const live = normalizeLiveState(payload);
  assert.equal(live.blue.score, 3);
  assert.equal(live.red.score, 3);
  assert.equal(live.red.towers, 1);
  assert.equal(live.blue.dragons, 1);
  assert.equal(live.blue.barons, 0);
  assert.equal(live.eventCount, 3);
  assert.equal(live.lastEvent.EventName, 'ChampionKill');
});

// t?: 真机实测（训练模式 2026-11-18）：同局同玩家连杀 3 只潮虫的 3 条 HordeKill 除 EventID 外字段完全一样，
// ledger 去重键必须优先用 EventID，否则只计 1；窗口重放不得重复计数；无 EventID 回退字段组合键。
test('objective ledger dedups by EventID (repeated grubs) and tolerates window replay', () => {
  const led = createObjectiveLedger();
  const events = [11, 13, 15].map(id => ({ EventID: id, EventName: 'HordeKill', KillerName: 'Player8', Stolen: 'False' }));
  const base = { gameData: { gameTime: 500, gameMode: 'CLASSIC' }, allPlayers: [{ summonerName: 'Player8', team: 'CHAOS', championName: 'Jinx' }] };
  const first = normalizeLiveState({ ...base, events: { Events: events } }, { objectiveLedger: led });
  assert.equal(first.red.grubs, 3);
  // LCDA 事件窗口是滚动的：下一轮轮询可能原样重放同一批事件，不得重复计数。
  const second = normalizeLiveState({ ...base, events: { Events: events } }, { objectiveLedger: led });
  assert.equal(second.red.grubs, 3);
  // 没有 EventID 的来源回退到字段组合键：字段完全一样的同类事件只计 1。
  const led2 = createObjectiveLedger();
  const noId = [{ EventName: 'HordeKill', KillerName: 'Player8' }, { EventName: 'HordeKill', KillerName: 'Player8' }];
  const third = normalizeLiveState({ ...base, events: { Events: noId } }, { objectiveLedger: led2 });
  assert.equal(third.red.grubs, 1);
});

test('real game fixture attributes objectives by side (tagged summoner names, minion turret kills)', () => {
  const fixture = require('./fixtures/live-real-game.json');
  const live = normalizeLiveState(fixture);
  assert.equal(live.players.length, 10);
  assert.equal(live.blue.score, 14);
  assert.equal(live.red.score, 24);
  assert.equal(live.blue.towers + live.red.towers, 6);
  assert.equal(live.blue.towers, 2);
  assert.equal(live.red.towers, 4);
  assert.equal(live.blue.dragons + live.red.dragons, 2);
  assert.equal(live.red.heralds, 1);
});

test('returns null for unusable payloads', () => {
  assert.equal(normalizeLiveState(null), null);
  assert.equal(normalizeLiveState({ gameData: {} }), null);
});

test('skips null players, events and items without throwing', () => {
  const live = normalizeLiveState({
    gameData: { gameTime: 12, gameMode: 'CLASSIC' },
    allPlayers: [
      null,
      { summonerName: 'A', team: 'ORDER', championName: 'Jayce', scores: { kills: 1 }, items: [null, { itemID: 1054, displayName: '多兰之刃' }, {}] }
    ],
    events: { Events: [null, { EventName: 'ChampionKill', KillerName: 'Jayce', EventTime: 1 }, null] }
  }, { itemIndex });
  assert.equal(live.players.length, 1);
  // null 与空对象 {} 都不是装备，只有真装备留下。
  assert.deepEqual(live.players[0].items.map(item => item.displayName), ['多兰之刃']);
  assert.deepEqual(live.players[0].itemNames, ['多兰之刃']);
  assert.equal(live.eventCount, 1);
});

test('t9：装备保留 itemID/count/slot/displayName/price，价格优先 Data Dragon 总价', () => {
  const live = normalizeLiveState({
    gameData: { gameTime: 100, gameMode: 'CLASSIC' },
    allPlayers: [{
      summonerName: 'A', team: 'ORDER', championName: 'Jayce', scores: { creepScore: 10 },
      items: [
        { itemID: 3086, displayName: '狂热', count: 1, slot: 0, price: 350 },
        { itemID: 1042, displayName: '短剑', count: 3, slot: 1, price: 250 },
        { itemID: 999999, displayName: '未知装备', count: 1, slot: 2, price: 500 }
      ]
    }]
  }, { itemIndex });
  assert.deepEqual(live.players[0].items, [
    // 3086 的 Data Dragon 总价是 1200，Live Client Data 只给合成基础价 350 —— 用总价，和 estimateTeamGold 同口径。
    { itemID: 3086, count: 1, slot: 0, displayName: '狂热', price: 1200 },
    { itemID: 1042, count: 3, slot: 1, displayName: '短剑', price: 250 },
    // 索引里没有的装备回退 Live Client Data 自带 price；再没有才是 0（未知不编造）。
    { itemID: 999999, count: 1, slot: 2, displayName: '未知装备', price: 500 }
  ]);
  assert.deepEqual(live.players[0].itemNames, ['狂热', '短剑', '未知装备']);
});

test('t9：真实对局 fixture 的 runes 解析出基石与两条符文树，召唤师技能拿到稳定 id', () => {
  const live = normalizeLiveState(require('./fixtures/live-real-game.json'));
  const player = live.players[0];
  assert.deepEqual(player.runes.keystone, { id: 8008, displayName: '致命节奏' });
  assert.equal(player.runes.primaryRuneTree.id, 8000);
  assert.equal(player.runes.primaryRuneTree.displayName, '精密');
  assert.equal(player.runes.secondaryRuneTree.id, 8400);
  assert.equal(player.runes.secondaryRuneTree.displayName, '坚决');
  // Live Client Data 不给数字 id：用 Data Dragon spell key 作稳定 id，且不能把 _DisplayName 尾巴带进来。
  assert.deepEqual(player.summonerSpellIds, ['SummonerBoost', 'SummonerHaste']);
  assert.deepEqual(player.summoners, ['净化', '幽灵疾步']);
  assert.equal(player.isBot, false);
});

test('t9：runes 缺失或为 null 时整体降级为 null，不抛错也不编造', () => {
  const live = normalizeLiveState({
    gameData: { gameTime: 10, gameMode: 'CLASSIC' },
    allPlayers: [
      { summonerName: 'NoRunes', team: 'ORDER', championName: 'Jayce', runes: null, isBot: true },
      { summonerName: 'EmptyRunes', team: 'ORDER', championName: 'Syndra', runes: {} },
      { summonerName: 'OnlyKeystone', team: 'CHAOS', championName: 'Jinx', runes: { keystone: { id: 8008, displayName: '致命节奏' } } }
    ]
  });
  assert.equal(live.players[0].runes, null);
  assert.equal(live.players[0].isBot, true);
  assert.equal(live.players[1].runes, null);
  assert.equal(live.players[2].runes.keystone.id, 8008);
  assert.equal(live.players[2].runes.primaryRuneTree.id, null);
});

test('t9：协议流精确字段优先，缺省时显式为 null 且 protocolDecode=false', () => {
  const base = {
    gameData: { gameTime: 300, gameMode: 'CLASSIC' },
    allPlayers: [
      { summonerName: 'BlueTop', team: 'ORDER', championName: 'Jayce', scores: { creepScore: 88, kills: 2, deaths: 1, assists: 3 } },
      { summonerName: 'RedAdc', team: 'CHAOS', championName: 'Jinx', scores: { creepScore: 95 } }
    ]
  };
  const degraded = normalizeLiveState(base);
  assert.equal(degraded.players[0].csExact, null);
  assert.equal(degraded.players[0].totalGold, null);
  assert.equal(degraded.players[0].xp, null);
  // LCDA 的估算值仍在 cs 上，绝不冒充 csExact。
  assert.equal(degraded.players[0].cs, 88);
  assert.equal(degraded.protocolDecode, false);

  const decoded = normalizeLiveState(base, {
    protocol: player => (player.summonerName === 'BlueTop' ? { cs: 91, totalGold: 12345, xp: 6789 } : null)
  });
  assert.equal(decoded.players[0].csExact, 91);
  assert.equal(decoded.players[0].totalGold, 12345);
  assert.equal(decoded.players[0].xp, 6789);
  assert.equal(decoded.players[1].csExact, null);
  assert.equal(decoded.protocolDecode, true);
});

test('t9：协议流字段不完整时逐项降级，负数视为无效', () => {
  const live = normalizeLiveState({
    gameData: { gameTime: 60, gameMode: 'CLASSIC' },
    allPlayers: [{ summonerName: 'A', team: 'ORDER', championName: 'Jayce' }]
  }, { protocol: () => ({ cs: 12, totalGold: -1 }) });
  assert.equal(live.players[0].csExact, 12);
  assert.equal(live.players[0].totalGold, null);
  assert.equal(live.players[0].xp, null);
  assert.equal(live.protocolDecode, true);
});

test('t30：协议流 KDA 三项齐全时覆盖 LCDA 并把契约标成 protocol-feed', () => {
  const live = normalizeLiveState(payload, {
    itemIndex,
    protocol: player => (player.summonerName === 'BlueTop'
      ? { kills: 7, deaths: 2, assists: 9, cs: 120, xp: 8000, totalGold: 9000, asOf: 600 }
      : null)
  });
  assert.equal(live.players[0].kills, 7, '协议流 KDA 必须覆盖 LCDA 的 2/1/3');
  assert.equal(live.players[0].deaths, 2);
  assert.equal(live.players[0].assists, 9);
  assert.deepEqual(live.players[0].kdaExact, { kills: 7, deaths: 2, assists: 9, asOf: 600 });
  assert.equal(live.players[1].kills, 1, '没有协议流记录的玩家保持 LCDA');
  assert.equal(live.players[1].kdaExact, null);
  assert.equal(live.capability.fields.kills.source, 'protocol-feed', 'KDA 来源必须标明是协议流');
  assert.equal(live.capability.fields.kills.precision, 'exact');
  assert.equal(live.capability.fields.csExact.source, 'spectator-protocol');
});

test('t30：协议流 KDA 缺项时不覆盖，契约仍标 live-client-data', () => {
  const live = normalizeLiveState(payload, {
    itemIndex,
    protocol: () => ({ kills: 5, deaths: 1, cs: 30 })
  });
  assert.equal(live.players[0].kills, 2, '缺 assists 时整组作废，绝不用 0 补齐覆盖');
  assert.equal(live.players[0].deaths, 1);
  assert.equal(live.players[0].assists, 3);
  assert.equal(live.players[0].kdaExact, null);
  assert.equal(live.capability.fields.kills.source, 'live-client-data');
  assert.equal(live.capability.fields.csExact.source, 'spectator-protocol', 'cs 仍然来自协议流');
});

test('t30：cs/xp 解不出时是 null，绝不用 LCDA 的 creepScore 或估算值顶替', () => {
  const live = normalizeLiveState(payload, { itemIndex, protocol: () => ({ kills: 1, deaths: 0, assists: 0 }) });
  assert.equal(live.players[0].csExact, null);
  assert.equal(live.players[0].xp, null);
  assert.equal(live.players[0].totalGold, null);
  assert.equal(live.players[0].csAsOf, null, '没有精确值就不许挂假时刻');
  assert.equal(live.players[0].cs, 88, 'LCDA 的量化 cs 仍在 cs 上，两者是不同字段');
  assert.equal(live.protocolDecode, false, '只有 KDA 不算解码出精确数值');
  assert.equal(live.capability.fields.csExact.precision, 'unavailable');
  assert.equal(live.capability.fields.kills.source, 'protocol-feed', 'KDA 仍然来自协议流');
});

test('t39：只发 xp exact 时 csExact/gold 保持 unavailable，xpProgress 升级', () => {
  const live = normalizeLiveState(payload, {
    itemIndex,
    protocol: player => (player.summonerName === 'BlueTop' ? { xp: 8000, asOf: 1800 } : null)
  });
  assert.equal(live.players[0].xp, 8000);
  assert.equal(live.players[0].xpAsOf, 1800);
  assert.equal(live.players[0].csExact, null);
  assert.equal(live.players[0].totalGold, null);
  assert.equal(live.capability.fields.csExact.precision, 'unavailable', '没有 exact cs 时 csExact 不得升级');
  assert.equal(live.capability.fields.totalGold.precision, 'unavailable', '没有 exact gold 时金币不得升级');
  assert.equal(live.capability.fields.xp.precision, 'exact');
  assert.equal(live.capability.fields.xpProgress.precision, 'exact');
  assert.equal(live.capability.fields.xpProgress.available, true);
  assert.equal(live.capability.fields.xpProgress.source, 'spectator-protocol');
});


