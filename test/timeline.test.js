'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTimeline, latestTimeline, MAX_TIMELINE } = require('../src/timeline');
const { normalizeLiveState, createLcuConnectionManager, createLiveClientWatchdog } = require('../src/live-data');
const { normalizeDraftSession } = require('../src/draft');
const { parseUxLog, findUxLogConnections } = require('../src/data-sources');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixture = require('./fixtures/live-real-game.json');

const SHAPE_KEYS = ['champion', 'side', 'text', 'time', 'type'];

test('fixture 的 58 个原始事件全部归类并按时间升序', () => {
  const raw = fixture.events.Events;
  assert.equal(raw.length, 58, 'fixture 原始事件数应为 58');

  const timeline = buildTimeline(fixture);
  assert.equal(timeline.length, raw.length, '每个原始事件都应产出时间线条目');

  const counts = {};
  for (const entry of timeline) counts[entry.type] = (counts[entry.type] || 0) + 1;
  assert.deepEqual(counts, {
    game_start: 1,
    minions: 1,
    kill: 38,
    first_blood: 1,
    horde: 3,
    dragon: 2,
    tower: 6,
    first_brick: 1,
    multikill: 3,
    herald: 1,
    game_end: 1
  });

  for (let i = 1; i < timeline.length; i += 1) {
    assert.ok(timeline[i].time >= timeline[i - 1].time, '时间线必须按时间升序');
  }
  for (const entry of timeline) {
    assert.deepEqual(Object.keys(entry).sort(), SHAPE_KEYS);
    assert.equal(typeof entry.time, 'number');
    assert.equal(typeof entry.type, 'string');
    assert.equal(typeof entry.text, 'string');
    assert.equal(typeof entry.champion, 'string');
    assert.ok(entry.side === null || entry.side === 'blue' || entry.side === 'red');
    assert.ok(entry.text.length > 0);
  }

  const firstBlood = timeline.find(entry => entry.type === 'first_blood');
  assert.equal(firstBlood.time, 111.895);
  assert.equal(firstBlood.side, 'red');
  assert.equal(firstBlood.champion, '迅捷斥候');
  assert.match(firstBlood.text, /一血/);

  const firstKill = timeline.find(entry => entry.type === 'kill');
  assert.equal(firstKill.text, '红方 迅捷斥候 击杀 蓝方 蛮族之王');
  assert.equal(firstKill.champion, '迅捷斥候');

  const multiTexts = timeline.filter(entry => entry.type === 'multikill').map(entry => entry.text);
  assert.ok(multiTexts.some(text => /双杀/.test(text)));
  assert.ok(multiTexts.some(text => /三杀/.test(text)));
  const dragonTexts = timeline.filter(entry => entry.type === 'dragon').map(entry => entry.text);
  assert.ok(dragonTexts.some(text => /火龙/.test(text)));
  assert.ok(dragonTexts.some(text => /土龙/.test(text)));
});

test('state.timeline 只保留最近 50 条且保持升序与固定字段', () => {
  const all = buildTimeline(fixture);
  assert.equal(all.length, 58);
  assert.equal(MAX_TIMELINE, 50);

  const recent = latestTimeline(all);
  assert.equal(recent.length, 50);
  assert.deepEqual(recent, all.slice(-50));
  for (let i = 1; i < recent.length; i += 1) {
    assert.ok(recent[i].time >= recent[i - 1].time);
  }
  for (const entry of recent) assert.deepEqual(Object.keys(entry).sort(), SHAPE_KEYS);
});

test('LCU 请求失败后缓存立即失效，下一轮轮询重新发现并恢复（4 秒内）', async () => {
  let now = 1000;
  let discoveries = 0;
  const manager = createLcuConnectionManager({
    now: () => now,
    discover: async () => {
      discoveries += 1;
      return { port: 3000 + discoveries, password: 'token-' + discoveries };
    }
  });

  const first = await manager.get();
  assert.equal(discoveries, 1);
  assert.equal(await manager.get(), first, '缓存命中时不应重复发现');
  assert.equal(discoveries, 1);

  now += 1200; // 一个轮询周期后请求失败
  manager.invalidate();
  const second = await manager.get();
  assert.equal(discoveries, 2, '缓存失效后应重新发现');
  assert.notEqual(second, first);
  assert.ok(now - 1000 < 4000, '恢复时间必须小于 4 秒');
});

test('LCU 发现失败时退避 4 秒再重试', async () => {
  let now = 0;
  let discoveries = 0;
  const manager = createLcuConnectionManager({
    now: () => now,
    discover: async () => {
      discoveries += 1;
      return discoveries >= 2 ? { port: 8899, password: 'token' } : null;
    }
  });

  assert.equal(await manager.get(), null);
  assert.equal(manager.blockedUntil, 4000);
  assert.equal(await manager.get(), null, '退避期间直接返回 null');
  assert.equal(discoveries, 1, '退避期间不应再次发现');

  now = 3999;
  assert.equal(await manager.get(), null);
  assert.equal(discoveries, 1);

  now = 4000;
  assert.deepEqual(await manager.get(), { port: 8899, password: 'token' });
  assert.equal(discoveries, 2);
});

test('ARAM 对局解析不抛错且不伪造分路', () => {
  const players = Array.from({ length: 10 }, (_, index) => ({
    summonerName: 'ARAM玩家' + index + '#000' + index,
    team: index < 5 ? 'ORDER' : 'CHAOS',
    championName: '英雄' + index,
    position: 'Invalid',
    scores: { kills: 0, deaths: 0, assists: 0, creeps: 0, wardScore: 0 }
  }));
  const payload = {
    gameData: { gameMode: 'ARAM', mapName: 'Map12', mapNumber: 12, gameTime: 300 },
    allPlayers: players,
    events: {
      Events: [
        { EventID: 0, EventName: 'ChampionKill', EventTime: 10, KillerName: 'ARAM玩家0#0000', VictimName: 'ARAM玩家5#0005' }
      ]
    }
  };

  let live = null;
  assert.doesNotThrow(() => { live = normalizeLiveState(payload); });
  assert.ok(live);
  assert.equal(live.isAram, true);
  assert.equal(live.players.length, 10);
  assert.equal(live.players[0].position, null, 'ARAM 不应展示假分路');

  const timeline = buildTimeline(payload);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].champion, '英雄0');
});

test('无 ban 的 BP 会话解析不抛错', () => {
  const session = {
    actions: [],
    myTeam: [{ cellId: 0, championId: 11 }],
    theirTeam: [{ cellId: 5, championId: 22 }],
    timer: { phase: 'FINALIZATION', adjustedTimeLeftInPhase: 5000 }
  };
  let draft = null;
  assert.doesNotThrow(() => { draft = normalizeDraftSession(session, id => '#' + id); });
  assert.ok(draft);
  assert.deepEqual(draft.blueBans, []);
  assert.deepEqual(draft.redBans, []);
  assert.equal(draft.bluePicks.length, 1);
  assert.equal(draft.redPicks.length, 1);
  assert.doesNotThrow(() => normalizeDraftSession({ myTeam: [], theirTeam: [], actions: [] }, id => String(id)));
});

test('空 payload 与未知事件不会让时间线抛错', () => {
  assert.deepEqual(buildTimeline(null), []);
  assert.deepEqual(buildTimeline({}), []);
  assert.deepEqual(buildTimeline({ events: { Events: [{ EventName: 'LevelUp', EventTime: 1 }] } }), []);
  assert.deepEqual(latestTimeline([]), []);
});

test('933KB Ux 日志从头部 Command line arguments 行解析端口，忽略 Cef CommandLine 诱饵', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-ux-'));
  const log = path.join(dir, '2026-11-13T00-03-29_16244_8300_LeagueClientUx.log');
  const token = 'ux-test-token-22chars';
  try {
    const commandLine = '000000.000|   OKAY| Command line arguments: --riotclient-auth-token=client-token --app-port=62742 --remoting-auth-token=' + token + ' --region=CN';
    const cef = '000000.017| ALWAYS| Cef CommandLine: --remote-debugging-port=9222 --app-port=11111 --remoting-auth-token=cef-wrong-token';
    const filler = ('x'.repeat(1023) + '\n').repeat(930);
    const text = ['000000.000| ALWAYS| Logging started', '000000.000| ALWAYS| Application Version: 1', '000000.000| ALWAYS| Running LeagueClient', commandLine, '000000.000|   OKAY| Memory Monitor enabled', '', '', cef].join('\n') + '\n' + filler;
    fs.writeFileSync(log, text);
    assert.ok(fs.statSync(log).size > 96 * 1024, '回归日志必须大于旧 readTail 的 96KB 窗口');
    assert.deepEqual(parseUxLog(commandLine), { port: 62742, password: token, protocol: 'https', source: 'ux_log' });
    assert.equal(parseUxLog(cef), null);
    const parsed = parseUxLog(text);
    assert.equal(parsed.port, 62742);
    assert.equal(parsed.password, token);
    const found = await findUxLogConnections({ dirs: [dir] });
    assert.equal(found.length, 1);
    assert.equal(found[0].port, 62742);
    assert.equal(found[0].logPath, log);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(':2999 连续失败 5 秒且局内超过 60 秒后触发赛后兜底', () => {
  let now = 0;
  const watchdog = createLiveClientWatchdog({ now: () => now });
  watchdog.success(10);
  assert.equal(watchdog.failure(10), false, '首次失败不立即触发');
  now = 4999;
  assert.equal(watchdog.failure(10), false, '不足 5 秒不触发');
  now = 60000;
  assert.equal(watchdog.failure(10), true, '连续失败 5 秒且 in_game 超过 60 秒应触发');
});

test(':2999 断流兜底在短局内不误触发，reset 后重新计时', () => {
  let now = 0;
  const watchdog = createLiveClientWatchdog({ now: () => now });
  watchdog.success(20);
  now = 1000;
  assert.equal(watchdog.failure(20), false);
  now = 6000;
  assert.equal(watchdog.failure(20), false, '刚进游戏 6 秒不应因为掉线直接结算');
  assert.equal(watchdog.maxGameTime, 20);
  watchdog.reset();
  now = 70000;
  watchdog.success(120);
  assert.equal(watchdog.failure(120), false, 'reset 后首次失败重新计时');
  now = 75000;
  assert.equal(watchdog.failure(120), true, '最后已知 gameTime 超过 60 秒时可兜底');
});
