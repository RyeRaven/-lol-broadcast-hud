'use strict';
// t30：协议流（观战 0xdd 关键帧解码结果）经本机 HTTP 喂进主进程的回归测试。
// 三条硬要求在这里被钉死：
//   1) 非法包整包 400，绝不半信半疑地写进状态（宁可没有数据，也不要错数据）；
//   2) 超过 2000ms 没有新包就整体失效，逐玩家精确字段回 null、契约降回 unavailable；
//   3) 精确值必须带 asOf（这个值对应哪个游戏时刻），没有 asOf 的精确值就是骗观众。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  PROTOCOL_FEED_TTL_MS,
  FEED_SOURCES,
  EVENT_TYPES,
  normalizePlayerRecord,
  normalizeEvent,
  normalizeFeed,
  createProtocolFeedStore,
  createProtocolLookup,
  protocolPresence,
  applyProtocolToPlayers,
  handleProtocolFeedApi
} = require('../src/protocol-feed');
const {
  buildCapabilityMatrix,
  applyProtocolAvailability,
  precisionOf,
  fieldOf
} = require('../src/data-capability');
const { normalizeLiveState, buildItemIndex } = require('../src/live-data');

const ROOT = path.resolve(__dirname, '..');
const OVERSIZE_BYTES = 2 * 1024 * 1024;
const SPAWN_ATTEMPTS = 5;

const itemIndex = buildItemIndex({
  '3153': { name: '破败王者之刃', gold: { total: 3200 } }
}, 'test');

// 与 tools/fake-live-server.js 的 10 名玩家一一对应（英雄名对齐，不靠屏幕位置猜）。
const CHAMPIONS = ['Jayce', 'Sett', 'Syndra', 'Ezreal', 'Nautilus', 'Renekton', 'XinZhao', 'Ahri', 'Aphelios', 'Leona'];

function feedPlayers(options = {}) {
  return CHAMPIONS.map((champion, index) => ({
    netid: '0x400000' + (0xae + index).toString(16),
    participantId: index + 1,
    team: index < 5 ? 'blue' : 'red',
    championName: champion,
    kills: index,
    deaths: 0,
    assists: 0,
    cs: 100 + index,
    totalGold: 10000 + index * 100,
    xp: 9000 + index * 100,
    // t31：精度必须由生产者声明；测试默认全 exact，单独用例会覆盖成降级值。
    precision: options.precision || { kills: 'exact', deaths: 'exact', assists: 'exact', cs: 'exact', xp: 'exact', totalGold: 'exact' },
    asOf: options.asOf === undefined ? 600 : options.asOf
  }));
}

function feedBody(options = {}) {
  return {
    source: 'live',
    gameId: 'TEST-1',
    gameTime: 720,
    players: feedPlayers(options),
    events: [{ t: 600, type: 'kill', killer: 1, victim: 6, assists: [2], confidence: 0.9 }]
  };
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ---------- 纯函数层：整包校验 ----------

test('t30：合法协议流包被接受，缺省值有明确默认（source=live / gameTime=0）', () => {
  const parsed = normalizeFeed(feedBody());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.feed.players.length, 10);
  assert.equal(parsed.feed.source, 'live');
  assert.equal(parsed.feed.gameId, 'TEST-1');
  assert.equal(parsed.feed.gameTime, 720);
  assert.equal(parsed.feed.events.length, 1);
  assert.equal(parsed.feed.events[0].assists[0], 2);

  const minimal = normalizeFeed({ players: [{ netid: '0x400000ae', participantId: 1, team: 'blue' }] });
  assert.equal(minimal.ok, true);
  assert.equal(minimal.feed.source, 'live');
  assert.equal(minimal.feed.gameTime, 0);
  assert.equal(minimal.feed.players[0].cs, null, '没给 cs 就是 null，绝不用 0 补齐');
  assert.equal(minimal.feed.players[0].asOf, null);
});

test('t31：netid 可选（语料/回放解不出 netid），非法 netid 才 400；puuid 参与身份校验', () => {
  // t31 裁决：回放/语料解码器拿不到 netid，绝不能逼生产者伪造 0x4000000N。
  const withoutNetid = normalizePlayerRecord({ participantId: 3, team: 'red', puuid: 'PUUID-3' }, 0);
  assert.equal(withoutNetid.ok, true);
  assert.equal(withoutNetid.player.netid, null, '没给 netid 就是 null，绝不伪造');
  assert.equal(withoutNetid.player.puuid, 'PUUID-3');
  assert.equal(withoutNetid.player.identity, 'puuid:PUUID-3');
  assert.equal(normalizePlayerRecord({ participantId: 1 }, 0).ok, true, 'participantId 是唯一必填的玩家字段');
  assert.equal(normalizePlayerRecord({ netid: '0xZZ', participantId: 1 }, 0).ok, false, '给了非法 netid 必须拒绝');
  assert.equal(normalizePlayerRecord({ netid: 'ae', participantId: 1 }, 0).ok, false);
  assert.equal(normalizePlayerRecord({ puuid: 42, participantId: 1 }, 0).ok, false, 'puuid 必须是字符串');
  const duplicatePuuid = normalizeFeed({ players: [{ participantId: 1, puuid: 'A' }, { participantId: 2, puuid: 'A' }] });
  assert.equal(duplicatePuuid.ok, false, '重复 puuid 必须拒绝');
});

test('t30：非法协议流包整包拒绝 —— 字符串 cs、越界 participantId、重复 netid 一律 400', () => {
  // 字符串数字是解码器最常见的口误：必须拒绝，不能悄悄 Number() 一下。
  const stringCs = normalizePlayerRecord({ netid: '0x400000ae', participantId: 1, team: 'blue', cs: '91' }, 0);
  assert.equal(stringCs.ok, false);
  assert.ok(stringCs.reason.includes('不接受字符串'), '必须写明不接受字符串');

  assert.equal(normalizePlayerRecord({ netid: 'ae', participantId: 1, team: 'blue' }, 0).ok, false, 'netid 必须是 0x 十六进制');
  assert.equal(normalizePlayerRecord({ netid: '0x400000ae', participantId: 0, team: 'blue' }, 0).ok, false, 'participantId 从 1 开始');
  assert.equal(normalizePlayerRecord({ netid: '0x400000ae', participantId: 11, team: 'blue' }, 0).ok, false, 'participantId 最大 10');
  assert.equal(normalizePlayerRecord({ netid: '0x400000ae', participantId: 1, team: 'ORDER' }, 0).ok, false, 'team 只认 blue/red');
  assert.equal(normalizePlayerRecord({ netid: '0x400000ae', participantId: 1, team: 'blue', kills: -1 }, 0).ok, false, '计数不能是负数');
  assert.equal(normalizePlayerRecord({ netid: '0x400000ae', participantId: 1, team: 'blue', asOf: -5 }, 0).ok, false, 'asOf 不能是负数');

  assert.equal(normalizeEvent({ t: 1, type: 'nuke' }, 0).ok, false, 'event type 只认 ' + EVENT_TYPES.join('/'));
  assert.equal(normalizeEvent({ t: -1, type: 'kill' }, 0).ok, false, 'event t 不能是负数');
  assert.equal(normalizeEvent({ t: 1, type: 'kill', assists: [11] }, 0).ok, false, 'assists 越界');
  assert.equal(normalizeEvent({ t: 1, type: 'kill', confidence: 1.5 }, 0).ok, false, 'confidence 必须在 0..1');

  assert.equal(normalizeFeed(null).ok, false);
  assert.equal(normalizeFeed([]).ok, false);
  assert.equal(normalizeFeed({ players: 'nope' }).ok, false, 'players 必须是数组');
  assert.equal(normalizeFeed({ source: 'guess', players: [] }).ok, false, 'source 只认 ' + FEED_SOURCES.join('/'));
  assert.equal(normalizeFeed({ gameId: '   ', players: [] }).ok, false, 'gameId 不能是空白串');

  const duplicateId = feedBody();
  duplicateId.players[1].participantId = 1;
  assert.equal(normalizeFeed(duplicateId).ok, false, '重复 participantId 无法判定真伪，必须拒绝');
  const duplicateNetid = feedBody();
  duplicateNetid.players[1].netid = duplicateNetid.players[0].netid.toUpperCase();
  assert.equal(normalizeFeed(duplicateNetid).ok, false, '重复 netid（大小写无关）必须拒绝');
});

test('t31：precision 门控 —— 只有 exact 字段进 csExact/gold/xp/KDA，未声明默认 estimated', () => {
  const records = normalizeFeed(feedBody({ precision: { kills: 'exact', deaths: 'estimated', assists: 'exact', cs: 'quantized', xp: 'estimated', totalGold: 'exact' } })).feed.players;
  const players = [{ champion: 'Jayce', team: 'blue', kills: 9, deaths: 9, assists: 9, csExact: null, totalGold: null, xp: null }];
  applyProtocolToPlayers(players, records);
  assert.equal(players[0].csExact, null, 'quantized 的 cs 绝不能当精确值');
  assert.equal(players[0].totalGold, 10000, 'gold exact 可用');
  assert.equal(players[0].xp, null, 'estimated 的 xp 不能当精确值');
  assert.equal(players[0].kills, 9, 'deaths 不是 exact → 整组 KDA 不覆盖 LCDA');
  assert.equal(players[0].kdaExact, null);
  assert.deepEqual(protocolPresence(records), { cs: false, gold: true, xp: false, goldPrecision: 'exact', xpPrecision: null });

  // quantized 的 gold/xp 是解码器唯一能诚实的档位：值可用，但页面必须标「±1 以内」。
  const quantized = normalizeFeed(feedBody({ precision: { kills: 'exact', deaths: 'exact', assists: 'exact', cs: 'exact', xp: 'quantized', totalGold: 'quantized' } })).feed.players;
  const qTarget = [{ champion: 'Jayce', team: 'blue', kills: 0, deaths: 0, assists: 0, csExact: null, totalGold: null, xp: null }];
  applyProtocolToPlayers(qTarget, quantized);
  assert.equal(qTarget[0].totalGold, 10000, 'quantized 的 gold 必须可用（否则 HUD 只能退回缺被动金币的估算）');
  assert.equal(qTarget[0].totalGoldPrecision, 'quantized', '精度必须带出来，页面才能标量化值');
  assert.equal(qTarget[0].xp, 9000);
  assert.equal(qTarget[0].xpPrecision, 'quantized');
  assert.deepEqual(protocolPresence(quantized), { cs: true, gold: true, xp: true, goldPrecision: 'quantized', xpPrecision: 'quantized' });

  // 没声明 precision 的包一律按 estimated：宁可没有精确值，也不许把未声明的数字标成 exact。
  const missing = normalizeFeed({ players: [{ participantId: 1, cs: 50, xp: 10, totalGold: 20 }] }).feed.players;
  assert.equal(missing[0].precision.cs, 'estimated');
  const target = [{ champion: 'X', team: 'blue', csExact: null, totalGold: null, xp: null }];
  applyProtocolToPlayers(target, missing);
  assert.equal(target[0].csExact, null);
  assert.equal(target[0].totalGold, null);
  assert.equal(target[0].xp, null);
});

test('t31：乱序策略 —— duplicate 刷 TTL、stale_frame 不清数据、corpus rewind 接受、跨局 reset、跳转 jump', () => {
  let clock = 1000;
  const store = createProtocolFeedStore({ now: () => clock });
  const at = (gameTime, extra) => Object.assign(normalizeFeed(feedBody()).feed, { gameTime }, extra || {});

  const first = store.commit(at(720));
  assert.equal(first.accepted, true);
  assert.equal(first.reason, 'first_packet');

  clock += 1500;
  const duplicate = store.commit(at(720));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.accepted, true);
  assert.equal(store.snapshot().active, true, 'duplicate 必须刷新 TTL');
  assert.equal(store.commits, 2);

  clock += 1500;
  const stale = store.commit(at(600));
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'stale_frame');
  assert.equal(stale.committed, false);
  assert.equal(store.snapshot().active, true, 'stale_frame 不得清空已有数据');
  assert.equal(store.snapshot().players.length, 10, '保持上一帧玩家');
  assert.equal(store.snapshot().gameTime, 720);
  assert.equal(store.commits, 2, '被丢弃的帧不计入提交');

  clock += 3000;
  assert.equal(store.snapshot().active, false, 'stale_frame 不刷 TTL，旧帧到点失效');
  assert.equal(store.snapshot().stale, true);

  const rewind = store.commit(at(600, { source: 'corpus' }));
  assert.equal(rewind.rewind, true);
  assert.equal(rewind.accepted, true);
  assert.equal(store.snapshot().gameTime, 600);

  const reset = store.commit(at(10, { gameId: 'TEST-2' }));
  assert.equal(reset.reset, true);
  assert.equal(store.snapshot().gameId, 'TEST-2');

  clock += 10;
  const jump = store.commit(at(900, { gameId: 'TEST-2' }));
  assert.equal(jump.jump, true);
  assert.equal(jump.accepted, true);
  assert.equal(store.snapshot().gameTime, 900);
});

// ---------- 纯函数层：时效 ----------

test('t30：协议流超过 2000ms 未更新即整体失效，绝不留旧包冒充当前值', async () => {
  let clock = 1000;
  const store = createProtocolFeedStore({ now: () => clock });
  assert.equal(store.snapshot().active, false);
  assert.equal(store.snapshot().stale, false, '从没收到过包不算 stale');

  store.commit(normalizeFeed(feedBody()).feed);
  const fresh = store.snapshot();
  assert.equal(fresh.active, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.players.length, 10);

  clock += PROTOCOL_FEED_TTL_MS;
  assert.equal(store.snapshot().active, true, '正好等于 TTL 时仍然有效');

  clock += 1;
  const stale = store.snapshot();
  assert.equal(stale.active, false, '超过 TTL 必须失效');
  assert.equal(stale.stale, true);
  assert.equal(stale.players.length, 0, '失效时连玩家一起清空，不可能拿旧包当当前值');
  assert.equal(stale.feed, null);
  assert.equal(stale.updatedAt, 1000, '仍保留最后一次提交时间用于诊断');
});

// ---------- 纯函数层：对齐 ----------

test('t30：协议流玩家按英雄名优先、否则按队伍行序对齐 LCDA，不按屏幕位置猜', () => {
  const records = normalizeFeed(feedBody()).feed.players;
  const resolve = createProtocolLookup(records);

  const jayce = resolve({ championName: 'Jayce', team: 'ORDER' });
  assert.equal(jayce.participantId, 1);
  const caseInsensitive = resolve({ champion: 'ahri', team: 'CHAOS' });
  assert.equal(caseInsensitive.participantId, 8, '英雄名匹配不区分大小写');

  // 没有英雄名的玩家：按 (team, 队伍内出场顺序) 游标对齐，与像素读条同一依据。
  // 上面已经认领了 Jayce（blue 第 0 行），所以 blue 的游标从第 1 行开始。
  assert.equal(resolve({ team: 'BLUE' }).participantId, 2);
  assert.equal(resolve({ team: 'BLUE' }).participantId, 3);
  assert.equal(resolve({ team: 'RED' }).participantId, 6, '另一队的游标互不影响');
  assert.equal(resolve({ team: 'unknown' }), null, '队伍不明的玩家不猜');

  // 一条记录只能被认领一次：另一轮全新对齐里，英雄名匹配失败的玩家不会顶替已认领的记录。
  const fresh = createProtocolLookup(records);
  assert.equal(fresh({ championName: 'Jayce', team: 'ORDER' }).participantId, 1);
  assert.equal(fresh({ team: 'BLUE' }).participantId, 2, '跳过已被认领的第 0 行');
  assert.equal(fresh({ team: 'BLUE' }).participantId, 3);
  // 全部记录都被认领后，再多的玩家只能拿到 null，绝不重复发同一份数据。
  const onlyTwo = createProtocolLookup(records.slice(0, 2));
  assert.equal(onlyTwo({ team: 'BLUE' }).participantId, 1);
  assert.equal(onlyTwo({ team: 'BLUE' }).participantId, 2);
  assert.equal(onlyTwo({ team: 'BLUE' }), null, '记录用尽后必须返回 null');

  assert.deepEqual(protocolPresence(records), { cs: true, gold: true, xp: true, goldPrecision: 'exact', xpPrecision: 'exact' });
  const noNumbers = normalizeFeed({ players: [{ netid: '0x400000ae', participantId: 1, team: 'blue', kills: 3 }] }).feed.players;
  assert.deepEqual(protocolPresence(noNumbers), { cs: false, gold: false, xp: false, goldPrecision: null, xpPrecision: null });
});

test('t30：applyProtocolToPlayers 每轮重写，KDA 三项齐全才覆盖，缺一项保持 LCDA', () => {
  const records = normalizeFeed(feedBody({ asOf: 480 })).feed.players;
  const players = [
    { name: 'TopStar', champion: 'Jayce', team: 'blue', kills: 99, deaths: 99, assists: 99, cs: 142, csExact: null, totalGold: null, xp: null, csAsOf: null, xpAsOf: null },
    { name: 'Nobody', champion: 'Unknown', team: 'blue', kills: 7, deaths: 1, assists: 2, cs: 50, csExact: null, totalGold: null, xp: null, csAsOf: null, xpAsOf: null }
  ];
  applyProtocolToPlayers(players, records);
  assert.equal(players[0].csExact, 100);
  assert.equal(players[0].totalGold, 10000);
  assert.equal(players[0].xp, 9000);
  assert.equal(players[0].csAsOf, 480, '精确值必须带它对应的游戏时刻');
  assert.equal(players[0].xpAsOf, 480);
  assert.equal(players[0].kills, 0, '协议流的 KDA 覆盖 LCDA');
  // 来源标记必须跟着数值一起换，不能出现「数值是协议流的、标记写着 LCDA」的错位。
  assert.deepEqual(players[0].kdaExact, { kills: 0, deaths: 0, assists: 0, asOf: 480 });
  // 英雄名匹配失败的玩家退回行序对齐，但绝不能认领别人已经拿到的记录。
  assert.equal(players[1].csExact, 101, '退回队伍行序时跳到下一条未被认领的记录');
  assert.notEqual(players[1].csExact, players[0].csExact, '两条玩家不得共享同一份协议流记录');
  assert.equal(players[1].kills, 1, '匹配到的记录 KDA 三项齐全（1/0/0），协议流覆盖 LCDA 的 7');
  // 队伍不明的玩家不猜：精确字段保持 null，不是 0，也不是旧值。
  const unknownSide = [{ champion: 'Nobody', team: 'unknown', kills: 7, csExact: null, totalGold: null, csAsOf: null }];
  applyProtocolToPlayers(unknownSide, records);
  assert.equal(unknownSide[0].kdaExact, null, '没匹配到记录时 kdaExact 必须是 null');
  assert.equal(unknownSide[0].csExact, null);
  assert.equal(unknownSide[0].totalGold, null);
  assert.equal(unknownSide[0].csAsOf, null);
  assert.equal(unknownSide[0].kills, 7, '没有协议流 KDA 时保持 LCDA');

  // KDA 缺一项：整组不覆盖，绝不用 0 补齐。
  const partial = normalizeFeed({ players: [{ netid: '0x400000ae', participantId: 1, team: 'blue', kills: 5, deaths: 1, cs: 20, precision: { kills: 'exact', deaths: 'exact', cs: 'exact' } }] }).feed.players;
  const target = [{ champion: 'Jayce', team: 'blue', kills: 9, deaths: 9, assists: 9 }];
  applyProtocolToPlayers(target, partial);
  assert.equal(target[0].kills, 9, 'deaths/assists 缺失时不得用 0 补齐覆盖');
  assert.equal(target[0].csExact, 20);
});

// ---------- 纯函数层：契约双向切换 ----------

test('t30：契约随协议流双向切换，且 quantized 的 cs 永远是 quantized', () => {
  const offline = buildCapabilityMatrix('live-spectate', {});
  assert.equal(precisionOf(offline, 'csExact'), 'unavailable');
  assert.equal(precisionOf(offline, 'csAsOf'), 'unavailable');

  const on = applyProtocolAvailability(offline, true, { cs: true, gold: true, xp: true, kda: false });
  for (const key of ['csExact', 'totalGold', 'xp', 'csAsOf', 'xpAsOf', 'xpProgress']) {
    assert.equal(precisionOf(on, key), 'exact', key + ' 在协议流可用时才是精确值');
    assert.equal(fieldOf(on, key).source, 'spectator-protocol');
  }
  assert.equal(precisionOf(on, 'cs'), 'quantized', 'LCDA 的 cs 不会因为协议流可用就变成 exact');
  assert.equal(offline.fields.csExact.precision, 'unavailable', '不得就地改传入的矩阵');

  const off = applyProtocolAvailability(on, false);
  for (const key of ['csExact', 'totalGold', 'xp', 'csAsOf', 'xpAsOf', 'xpProgress']) {
    assert.equal(precisionOf(off, key), 'unavailable', key + ' 失效后必须立刻降回 unavailable');
    assert.equal(fieldOf(off, key).source, null, '不可用时不得带数据源');
  }
  // KDA 只在「协议流可用」方向上切：失效瞬间玩家对象上还是协议流的 KDA 值，
  // 此刻把来源改成 live-client-data 就是错标；等下一轮 LCDA 轮询重建状态时自然回落。
  const kdaOn = applyProtocolAvailability(offline, true, { protocolKda: true });
  assert.equal(fieldOf(kdaOn, 'kills').source, 'protocol-feed');
  const kdaOff = applyProtocolAvailability(kdaOn, false, { protocolKda: true });
  assert.equal(fieldOf(kdaOff, 'kills').source, 'protocol-feed', '失效方向不改 KDA 来源，避免与玩家对象上的值错位');
  assert.equal(precisionOf(kdaOff, 'kills'), 'exact', 'KDA 本身永远是精确值，降级不等于数据消失');
  // 包新鲜但本包 KDA 三项不齐时，不得把来源标成协议流。
  assert.equal(fieldOf(applyProtocolAvailability(offline, true, { protocolKda: false }), 'kills').source, 'live-client-data');

  // 幂等：已经是目标状态时返回同一个对象，避免每帧都重建契约。
  assert.equal(applyProtocolAvailability(off, false), off);
  assert.equal(applyProtocolAvailability(on, true, { cs: true, gold: true, xp: true, kda: false }), on);
  // 解码器本身不可用时，即使包还新鲜也不能标 exact。
  assert.equal(precisionOf(applyProtocolAvailability(offline, true, { protocolDecode: false }), 'csExact'), 'unavailable');
});

test('t39：协议流逐字段 presence —— 只发 xp exact 时 csExact/gold 不升级，xpProgress 跟随 xp', () => {
  const base = buildCapabilityMatrix('live-spectate', { liveClient: true, gameflowPhase: 'InProgress' });
  const xpOnly = applyProtocolAvailability(base, true, { cs: false, gold: false, xp: true, kda: false });
  assert.equal(precisionOf(xpOnly, 'csExact'), 'unavailable', '没有 exact cs 时不得升级 csExact（BUG B）');
  assert.equal(precisionOf(xpOnly, 'totalGold'), 'unavailable', '没有 exact gold 时不得升级金币');
  assert.equal(precisionOf(xpOnly, 'xp'), 'exact');
  assert.equal(precisionOf(xpOnly, 'xpProgress'), 'exact', 'xp exact 时经验条必须同步升级');
  assert.equal(fieldOf(xpOnly, 'xpProgress').source, 'spectator-protocol');
  assert.match(fieldOf(xpOnly, 'xpProgress').reason, /xp/);

  const csOnly = applyProtocolAvailability(base, true, { cs: true, gold: false, xp: false, kda: false });
  assert.equal(precisionOf(csOnly, 'csExact'), 'exact');
  assert.equal(precisionOf(csOnly, 'xp'), 'unavailable', '只有 cs 时不得升级 xp');
  assert.equal(precisionOf(csOnly, 'xpProgress'), 'unavailable', '只有 cs 时经验条仍不可用');

  const none = applyProtocolAvailability(base, true, { cs: false, gold: false, xp: false, kda: false });
  for (const key of ['csExact', 'totalGold', 'xp', 'csAsOf', 'xpAsOf', 'xpProgress']) {
    assert.equal(precisionOf(none, key), 'unavailable', '没有对应 exact 值时 ' + key + ' 必须保持 unavailable');
  }

  const xpGone = applyProtocolAvailability(xpOnly, true, { cs: false, gold: false, xp: false, kda: false });
  assert.equal(precisionOf(xpGone, 'xpProgress'), 'unavailable', 'xp 消失后经验条必须立即回落');

  const built = buildCapabilityMatrix('live-spectate', {
    protocolDecode: true,
    protocolFields: { cs: false, gold: false, xp: true },
    protocolKda: false
  });
  assert.equal(precisionOf(built, 'csExact'), 'unavailable');
  assert.equal(precisionOf(built, 'totalGold'), 'unavailable');
  assert.equal(precisionOf(built, 'xp'), 'exact');
  assert.equal(precisionOf(built, 'xpProgress'), 'exact');
});

// ---------- live-data 集成 ----------

test('t30：normalizeLiveState 接受协议流查询函数，精确字段与 asOf 一起透传', () => {
  const payload = {
    gameData: { gameTime: 734.5, gameMode: 'CLASSIC', mapName: 'Map11' },
    allPlayers: [{
      summonerName: 'BlueTop', team: 'ORDER', championName: 'Jayce', level: 9,
      scores: { kills: 2, deaths: 1, assists: 3, creepScore: 88, wardScore: 4 },
      items: [{ itemID: 3153, displayName: '破败王者之刃' }]
    }],
    events: { Events: [] }
  };
  const records = normalizeFeed(feedBody({ asOf: 600 })).feed.players;
  const live = normalizeLiveState(payload, {
    itemIndex,
    protocol: player => records.find(record => record.championName === player.championName) || null
  });
  assert.equal(live.players[0].csExact, 100);
  assert.equal(live.players[0].totalGold, 10000);
  assert.equal(live.players[0].csAsOf, 600);
  assert.equal(live.players[0].xpAsOf, 600);
  assert.equal(live.players[0].kills, 0, '协议流 KDA 优先于 LCDA');
  assert.equal(live.protocolDecode, true);
  assert.equal(precisionOf(live.capability, 'csExact'), 'exact');

  const withoutProtocol = normalizeLiveState(payload, { itemIndex });
  assert.equal(withoutProtocol.players[0].csExact, null);
  assert.equal(withoutProtocol.players[0].csAsOf, null, '没有精确值就不许挂一个假时刻');
  assert.equal(withoutProtocol.protocolDecode, false);
  assert.equal(precisionOf(withoutProtocol.capability, 'csExact'), 'unavailable');
});

// ---------- HTTP 层（in-process） ----------

function fakeExchange(options = {}) {
  const req = {
    method: options.method || 'POST',
    socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
    headers: options.headers || {}
  };
  const listeners = {};
  req.on = (event, handler) => { (listeners[event] = listeners[event] || []).push(handler); return req; };
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body === undefined ? '' : String(body); }
  };
  return { req, res, emit: (event, value) => (listeners[event] || []).forEach(handler => handler(value)) };
}

test('t30：非本机来源 403 且不带 CORS 头；非法包 400 且不污染状态；status 形状固定', async () => {
  const store = createProtocolFeedStore();
  const forbidden = fakeExchange({ remoteAddress: '192.168.1.20' });
  assert.equal(handleProtocolFeedApi(forbidden.req, forbidden.res, { pathname: '/api/protocol-feed' }, { store }), true);
  assert.equal(forbidden.res.statusCode, 403);
  assert.equal(JSON.parse(forbidden.res.body).error, 'forbidden_source');
  assert.equal(forbidden.res.headers['Access-Control-Allow-Origin'], undefined, '内部写接口绝不能开 CORS');
  assert.equal(store.snapshot().active, false);

  const ok = fakeExchange();
  handleProtocolFeedApi(ok.req, ok.res, { pathname: '/api/protocol-feed' }, { store });
  ok.emit('data', JSON.stringify(feedBody()));
  ok.emit('end');
  await delay(30);
  assert.equal(ok.res.statusCode, 200);
  assert.equal(JSON.parse(ok.res.body).players, 10);
  assert.equal(ok.res.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(store.snapshot().active, true);

  // 1Hz 心跳：同一帧重发必须返回 duplicate=true（只刷 TTL，不重复广播）。
  const heartbeat = fakeExchange();
  handleProtocolFeedApi(heartbeat.req, heartbeat.res, { pathname: '/api/protocol-feed' }, { store });
  heartbeat.emit('data', JSON.stringify(feedBody()));
  heartbeat.emit('end');
  await delay(30);
  assert.equal(heartbeat.res.statusCode, 200);
  assert.equal(JSON.parse(heartbeat.res.body).duplicate, true);
  assert.equal(JSON.parse(heartbeat.res.body).accepted, true);

  const before = JSON.stringify(store.snapshot().players);
  const bad = fakeExchange();
  handleProtocolFeedApi(bad.req, bad.res, { pathname: '/api/protocol-feed' }, { store });
  bad.emit('data', JSON.stringify({ players: [{ netid: '0x400000ae', participantId: 1, team: 'blue', cs: '91' }] }));
  bad.emit('end');
  await delay(30);
  assert.equal(bad.res.statusCode, 400);
  assert.equal(JSON.parse(bad.res.body).error, 'invalid_protocol_feed');
  assert.equal(JSON.stringify(store.snapshot().players), before, '非法包不得污染状态');

  const status = fakeExchange({ method: 'GET' });
  handleProtocolFeedApi(status.req, status.res, { pathname: '/api/protocol-feed/status' }, { store });
  const statusBody = JSON.parse(status.res.body);
  assert.equal(status.res.statusCode, 200);
  assert.equal(statusBody.active, true);
  assert.equal(statusBody.players, 10);
  assert.equal(statusBody.ttlMs, PROTOCOL_FEED_TTL_MS);
  assert.equal(Array.isArray(statusBody.lastFeed.players), true);

  const wrongMethod = fakeExchange({ method: 'GET' });
  handleProtocolFeedApi(wrongMethod.req, wrongMethod.res, { pathname: '/api/protocol-feed' }, { store });
  assert.equal(wrongMethod.res.statusCode, 405);
});

// ---------- 端到端 ----------

function allocatePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function spawnNode(scriptRelative, args, env) {
  const child = spawn(process.execPath, [path.join(ROOT, scriptRelative)].concat(args), {
    cwd: ROOT,
    env: Object.assign({}, process.env, env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const run = { child, stdout: '', stderr: '', exit: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { run.stdout += chunk; });
  child.stderr.on('data', chunk => { run.stderr += chunk; });
  child.on('exit', (code, signal) => { run.exit = { code, signal }; });
  return run;
}

async function waitForOutput(run, pattern, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pattern.test(run.stdout)) return run.stdout;
    if (run.exit) throw new Error('子进程提前退出（code=' + run.exit.code + '）：' + run.stderr);
    if (/EADDRINUSE/.test(run.stderr)) {
      const retryable = new Error('端口被占用：' + run.stderr);
      retryable.code = 'EADDRINUSE';
      throw retryable;
    }
    await delay(100);
  }
  throw new Error('等待输出超时：' + pattern + '；stderr=' + run.stderr);
}

function stopRun(run) {
  return new Promise(resolve => {
    if (!run || !run.child || run.child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    run.child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { run.child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const handle = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    handle.setTimeout(options.timeoutMs || 8000, () => handle.destroy(new Error('HTTP 超时：' + pathname)));
    handle.on('error', reject);
    if (options.body !== undefined) handle.write(options.body);
    handle.end();
  });
}

async function getJson(port, pathname) {
  const response = await request(port, pathname);
  return { status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

function postFeed(port, payload) {
  return request(port, '/api/protocol-feed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

function oversizedPost(port, pathname) {
  return new Promise((resolve, reject) => {
    const handle = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(OVERSIZE_BYTES) } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    handle.setTimeout(15000, () => handle.destroy(new Error('超时')));
    handle.on('error', reject);
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < OVERSIZE_BYTES) {
        sent += chunk.length;
        if (!handle.write(chunk)) { handle.once('drain', pump); return; }
      }
      handle.end();
    };
    pump();
  });
}

async function waitFor(description, probe, timeoutMs = 20000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(120);
  }
  throw new Error('等待超时（' + timeoutMs + 'ms）：' + description + (lastError ? '；最后错误：' + lastError.message : ''));
}

async function startStack(t) {
  const livePort = await allocatePort();
  const live = spawnNode('tools/fake-live-server.js', [String(livePort)], {});
  t.after(() => stopRun(live));
  await waitForOutput(live, /fake live client on \d+/);
  let lastError = null;
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt += 1) {
    const port = await allocatePort();
    const app = spawnNode('src/main.js', [], {
      PORT: String(port),
      LIVE_CLIENT_URL: 'http://127.0.0.1:' + livePort,
      RIOT_LCU_PORT: '9',
      RIOT_REMOTING_AUTH_TOKEN: '',
      RIOT_CLIENT_COMMAND_LINE: '',
      RIOT_LOCKFILE: ''
    });
    t.after(() => stopRun(app));
    try {
      await waitForOutput(app, /Khada Jhin running at http:\/\/127\.0\.0\.1:\d+/);
      return { port, app, live };
    } catch (error) {
      await stopRun(app);
      lastError = error;
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError || new Error('无法启动测试服务');
}

test('t30：真实服务 —— 协议流喂入后 /api/state 出现精确值，超时后回 null 且契约降级', { timeout: 90000 }, async t => {
  const { port, app } = await startStack(t);
  const inGame = await waitFor('进入局内阶段', async () => {
    const response = await getJson(port, '/api/state');
    return response.body.mode === 'live' && response.body.players.length === 10 ? response.body : null;
  });
  // 未喂包时：精确字段全 null，契约 unavailable。
  assert.equal(inGame.players[0].csExact, null);
  assert.equal(inGame.capability.fields.csExact.precision, 'unavailable');
  assert.equal(inGame.protocolFeed.active, false);

  const posted = await postFeed(port, feedBody({ asOf: 600 }));
  assert.equal(posted.status, 200);
  assert.equal(JSON.parse(posted.body).players, 10);

  const withFeed = await waitFor('协议流生效', async () => {
    const response = await getJson(port, '/api/state');
    const state = response.body;
    return state.players[0] && state.players[0].csExact !== null ? state : null;
  });
  const jayce = withFeed.players.find(player => player.champion === 'Jayce');
  assert.equal(jayce.csExact, 100);
  assert.equal(jayce.totalGold, 10000);
  assert.equal(jayce.xp, 9000);
  assert.equal(jayce.csAsOf, 600, '精确值必须带它对应的游戏时刻');
  assert.equal(withFeed.protocolDecode, true);
  assert.equal(withFeed.protocolFeed.active, true);
  assert.equal(withFeed.capability.fields.csExact.precision, 'exact');
  assert.equal(withFeed.capability.fields.csExact.source, 'spectator-protocol');
  assert.equal(withFeed.capability.fields.cs.precision, 'quantized', 'LCDA 的 cs 不会变成 exact');

  const status = await getJson(port, '/api/protocol-feed/status');
  assert.equal(status.body.active, true);
  assert.equal(status.body.players, 10);

  // 停止喂包 → 超过 2000ms 后必须整体失效：精确字段回 null，契约降回 unavailable。
  const expired = await waitFor('协议流过期降级', async () => {
    const response = await getJson(port, '/api/state');
    const state = response.body;
    return state.protocolFeed.active === false && state.players[0].csExact === null ? state : null;
  }, 15000);
  assert.equal(expired.capability.fields.csExact.precision, 'unavailable');
  assert.equal(expired.protocolDecode, false);
  for (const player of expired.players) {
    assert.equal(player.csExact, null, '失效后不许留旧值');
    assert.equal(player.totalGold, null);
    assert.equal(player.csAsOf, null, '失效后不许留旧时刻');
  }
  assert.equal(app.exit, null, '服务必须存活');
  assert.equal(/unhandledRejection|uncaughtException/.test(app.stderr), false, 'stderr 不得出现兜底异常');
});

test('t30：POST /api/protocol-feed 的 2MB 请求体返回 413，服务存活', { timeout: 60000 }, async t => {
  const { port, app } = await startStack(t);
  const response = await oversizedPost(port, '/api/protocol-feed');
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.body).error, 'payload_too_large');
  const health = await getJson(port, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(app.exit, null);
});
