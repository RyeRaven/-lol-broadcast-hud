'use strict';
// t20：数据可用性矩阵（src/data-capability.js）与 HUD 降级契约的回归测试。
// 三条硬要求在这里被钉死：
//   1) exact / quantized / estimated / unavailable 四档语义互不重叠，quantized 永远不能被当成 exact；
//   2) 拿不到的数据必须显式 unavailable，页面画占位，绝不拿队伍级估算或插值冒充精确值；
//   3) 回放 timeline 插值跨度超过 90s 必须降级为 unavailable。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {
  FIELD_KEYS,
  PRECISIONS,
  MODES,
  CS_QUANTUM,
  MAX_INTERPOLATION_SPAN,
  detectMode,
  buildCapabilityMatrix,
  applyProtocolAvailability,
  interpolateAt,
  fieldOf,
  precisionOf,
  isExact,
  isQuantized,
  isUsable
} = require('../src/data-capability');
const { normalizeLiveState, buildItemIndex } = require('../src/live-data');
const { hudBroadcastPage } = require('../src/pages/hud-broadcast');

const ROOT = path.join(__dirname, '..');

const itemIndex = buildItemIndex({
  '1054': { name: '多兰之刃', gold: { total: 450 } }
}, 'test');

const payload = {
  gameData: { gameTime: 734.5, gameMode: 'CLASSIC', mapName: 'Map11' },
  allPlayers: [{
    summonerName: 'BlueTop', team: 'ORDER', championName: 'Jayce', level: 9,
    scores: { kills: 2, deaths: 1, assists: 3, creepScore: 88, wardScore: 4 },
    items: [{ itemID: 1054, displayName: '多兰之刃' }],
    summonerSpells: { summonerSpellOne: { displayName: '闪现' }, summonerSpellTwo: { displayName: '传送' } }
  }],
  events: { Events: [] }
};

// HUD 页面脚本没有导出，按 test/live-roster.test.js 的方式在 vm 里跑一遍拿到渲染函数。
function loadHud() {
  const html = hudBroadcastPage();
  const script = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(script, 'HUD 应包含内联脚本');
  const start = script[1].indexOf('(function hudScript()');
  assert.ok(start > 0, 'HUD 页面脚本应存在');
  let page = script[1].slice(start);
  const cut = page.lastIndexOf('  buildShell();');
  assert.ok(cut > 0, 'HUD 页面脚本应以 buildShell 收尾');
  page = page.slice(0, cut) + [
    '  window.__hud = {',
    '    setState: function (value) { state = value; },',
    '    setConfig: function (value) { config = value; },',
    '    playerList: playerList,',
    '    playerItemSlots: playerItemSlots,',
    '    ownedItemCount: ownedItemCount,',
    '    barCells: barCells,',
    '    csMarkup: csMarkup, playerGoldOf: playerGoldOf, diffMarkup: diffMarkup,',
    '    kdaOf: kdaOf,',
    '    capUsable: capUsable',
    '  };',
    '})();'
  ].join('\n');
  const root = { innerHTML: '', classList: { add() {} } };
  const context = {
    window: {},
    document: {
      getElementById(id) { return id === 'hud-broadcast' ? root : null; },
      body: { classList: { add() {} } },
      documentElement: { classList: { add() {} } }
    },
    console, JSON, Math, Date, Array, Object, String, Number,
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  vm.createContext(context);
  vm.runInContext(page, context, { filename: 'hud-broadcast-capability-test.js' });
  assert.ok(context.window.__hud, 'HUD 测试钩子应已安装');
  return context.window.__hud;
}

test('t20/t30：契约覆盖全部 17 个字段，且四档精度常量与模式常量固定', () => {
  // t30 在 xp 之后插入 csAsOf/xpAsOf：协议流的关键帧值必须自带「这是哪个时刻的值」，
  // 否则页面只能把 60s 前的数字当成当前值展示，等于伪造。
  assert.deepEqual([...FIELD_KEYS], [
    'level', 'kills', 'deaths', 'assists', 'cs', 'csExact', 'totalGold', 'xp',
    'csAsOf', 'xpAsOf',
    'xpProgress', 'hpPercent', 'resourcePercent', 'items', 'runes', 'summoners', 'wardScore'
  ]);
  assert.deepEqual([...PRECISIONS], ['exact', 'quantized', 'estimated', 'unavailable']);
  assert.deepEqual([...MODES], ['live-spectate', 'replay', 'offline']);
  assert.equal(CS_QUANTUM, 10);
  assert.equal(MAX_INTERPOLATION_SPAN, 90);
  for (const mode of MODES) {
    const matrix = buildCapabilityMatrix(mode, { timelineAvailable: true, liveClient: true, gameflowPhase: 'InProgress' });
    assert.equal(matrix.mode, mode);
    assert.equal(Object.keys(matrix.fields).length, FIELD_KEYS.length, mode + ' 必须给出全部字段');
    // 每个字段都必须落到且只落到一个精度桶里。
    const bucketed = [...matrix.exact, ...matrix.quantized, ...matrix.estimated, ...matrix.unavailable];
    assert.deepEqual(bucketed.slice().sort(), [...FIELD_KEYS].sort(), mode + ' 的字段必须全部被分桶');
    for (const key of FIELD_KEYS) {
      const entry = fieldOf(matrix, key);
      assert.equal(typeof entry.reason, 'string');
      assert.ok(entry.reason.length > 0, key + ' 必须写明可用性原因');
      if (entry.precision === 'quantized') assert.ok(entry.quantum > 0, key + ' 量化字段必须带 quantum');
      assert.equal(entry.available, entry.precision !== 'unavailable');
    }
  }
});

test('t20：实时观战 cs 是 quantized(quantum=10)，绝不能被当成 exact；金币/经验显式 unavailable', () => {
  const matrix = buildCapabilityMatrix('live-spectate', { liveClient: true, gameflowPhase: 'InProgress' });
  assert.equal(matrix.detected.mode, 'live-spectate');
  assert.equal(matrix.detected.reason.includes('InProgress'), true);
  assert.equal(precisionOf(matrix, 'cs'), 'quantized');
  assert.equal(fieldOf(matrix, 'cs').quantum, CS_QUANTUM);
  assert.equal(isQuantized(matrix, 'cs'), true);
  assert.equal(isExact(matrix, 'cs'), false, 'quantized 不得被当成 exact');
  assert.equal(isUsable(matrix, 'cs'), true, 'quantized 仍可展示，只是必须带 ≈ 与步长');
  // 实时观战只有 LCDA：金币与经验拿不到，estimateTeamGold 是队伍级估算，不得冒充 totalGold。
  for (const key of ['totalGold', 'xp', 'csExact', 'csAsOf', 'xpAsOf', 'xpProgress', 'hpPercent', 'resourcePercent']) {
    assert.equal(precisionOf(matrix, key), 'unavailable', key + ' 在实时观战下必须 unavailable');
    assert.equal(fieldOf(matrix, key).available, false);
    assert.equal(fieldOf(matrix, key).source, null, key + ' 不可用时不得带数据源');
  }
  assert.equal(fieldOf(matrix, 'totalGold').reason.includes('estimateTeamGold'), true, '必须写明不得用队伍估算冒充');
  for (const key of ['level', 'kills', 'deaths', 'assists', 'items', 'runes', 'summoners', 'wardScore']) {
    assert.equal(precisionOf(matrix, key), 'exact', key + ' 在实时观战下是官方逐玩家精确值');
  }
  assert.equal(matrix.quantized.length, 1);
  assert.equal(matrix.exact.includes('totalGold'), false);
});

test('t20/t30：协议流解码可用时 csExact/totalGold/xp 与时刻 csAsOf/xpAsOf 才升为 exact', () => {
  const withProtocol = buildCapabilityMatrix('live-spectate', { protocolDecode: true });
  for (const key of ['csExact', 'totalGold', 'xp', 'csAsOf', 'xpAsOf']) {
    assert.equal(precisionOf(withProtocol, key), 'exact', key + ' 在协议流可用时才是精确值');
    assert.equal(fieldOf(withProtocol, key).source, 'spectator-protocol');
  }
  assert.equal(withProtocol.detail.includes('协议流'), true);
  // cs（LCDA 量化值）不会因为协议流可用就变成 exact，两者是不同字段。
  assert.equal(precisionOf(withProtocol, 'cs'), 'quantized');
});

test('t20：回放模式用 timeline 插值，全部标 estimated 且写明 timeline-interpolated', () => {
  const matrix = buildCapabilityMatrix('replay', { isPlayingReplay: true, timelineAvailable: true });
  assert.equal(matrix.detected.mode, 'replay');
  assert.equal(matrix.detected.reason.includes('isPlayingReplay'), true);
  for (const key of ['cs', 'csExact', 'totalGold', 'xp', 'level']) {
    assert.equal(precisionOf(matrix, key), 'estimated', key + ' 在回放下只能算估算');
    assert.equal(isExact(matrix, key), false, key + ' 插值不得冒充精确值');
    assert.ok(fieldOf(matrix, key).source === 'timeline-interpolated' || fieldOf(matrix, key).source === 'timeline-events');
    assert.equal(fieldOf(matrix, key).reason.includes('90s'), true, key + ' 必须写明超过 90s 的降级规则');
  }
  // timeline 本来就没有的东西，回放也拿不到；回放每帧自带 time，不需要额外 asOf。
  for (const key of ['xpProgress', 'hpPercent', 'resourcePercent', 'runes', 'summoners', 'csAsOf', 'xpAsOf']) {
    assert.equal(precisionOf(matrix, key), 'unavailable', key + ' 回放里也必须 unavailable');
  }
  // timeline 端点不可用时整体降级。
  const noTimeline = buildCapabilityMatrix('replay', { isPlayingReplay: true, timelineAvailable: false });
  assert.equal(noTimeline.unavailable.length, FIELD_KEYS.length);
  assert.equal(noTimeline.estimated.length, 0);
});

test('t20：离线模式全部 unavailable，detectMode 四分支判定有据可查', () => {
  const offline = buildCapabilityMatrix('offline', {});
  assert.equal(offline.unavailable.length, FIELD_KEYS.length);
  assert.equal(offline.exact.length + offline.quantized.length + offline.estimated.length, 0);
  assert.equal(offline.detected.mode, 'offline');

  assert.equal(detectMode({ isPlayingReplay: true }).mode, 'replay');
  assert.equal(detectMode({ gameflowPhase: 'InProgress', liveClient: true }).mode, 'live-spectate');
  assert.equal(detectMode({ gameflowPhase: 'InProgress', observerServerIp: '10.0.0.5:5500' }).mode, 'live-spectate');
  assert.equal(detectMode({ timelineAvailable: true }).mode, 'replay');
  // 观战标志不在、也没有 timeline，就是离线，不能默认猜成实时观战。
  assert.equal(detectMode({ gameflowPhase: 'InProgress' }).mode, 'offline');
  assert.equal(detectMode({}).mode, 'offline');
  assert.ok(detectMode({}).reason.length > 0);
});

test('t37：显式 live-spectate 但无探测信号时 detected 不得离线', () => {
  const matrix = buildCapabilityMatrix('live-spectate', {});
  assert.equal(matrix.mode, 'live-spectate');
  assert.equal(matrix.detected.mode, 'live-spectate');
  assert.equal(matrix.detected.reason, 'mode 由调用方显式指定（本轮未收到探测信号）');
});

test('t37：liveClient + gameflow-phase 时 detected 使用真实探测原因', () => {
  const matrix = buildCapabilityMatrix('live-spectate', { liveClient: true, gameflowPhase: 'InProgress' });
  assert.equal(matrix.detected.mode, 'live-spectate');
  assert.equal(matrix.detected.reason.includes('Live Client Data 可达'), true);
});

test('t37：显式 offline 时 detected 保持 offline', () => {
  const matrix = buildCapabilityMatrix('offline', {});
  assert.equal(matrix.detected.mode, 'offline');
  assert.ok(matrix.detected.reason.length > 0);
});

test('t20：模式写错直接抛错，不会被静默当成 offline', () => {
  assert.throws(() => buildCapabilityMatrix('live', {}), /requires mode in/);
  assert.throws(() => buildCapabilityMatrix(undefined, {}), TypeError);
});

test('t20：timeline 60s 帧线性插值标 estimated，跨度超过 90s 降级 unavailable', () => {
  const frames = [{ time: 0, cs: 0 }, { time: 60, cs: 60 }, { time: 120, cs: 130 }];
  const mid = interpolateAt(frames, 90, 'cs');
  assert.equal(mid.available, true);
  assert.equal(mid.value, 95);
  assert.equal(mid.precision, 'estimated');
  assert.equal(mid.source, 'timeline-interpolated');
  assert.equal(mid.span, 60);
  assert.equal(isExact({ fields: { cs: mid } }, 'cs'), false);
  // 等级是阶跃字段：取最近帧原值，不插值。
  const stepped = interpolateAt([{ time: 0, level: 8 }, { time: 60, level: 9 }], 30, 'level', { step: true });
  assert.equal(stepped.value, 8);
  assert.equal(stepped.precision, 'estimated');
  // 端点外推也要算跨度，不能假装贴着最后一帧。
  const beyond = interpolateAt([{ time: 0, cs: 0 }, { time: 300, cs: 300 }], 120, 'cs');
  assert.equal(beyond.available, false);
  assert.equal(beyond.value, null);
  assert.equal(beyond.precision, 'unavailable');
  assert.equal(beyond.span, 300);
  assert.equal(beyond.reason.includes('90s'), true);
  // 帧不足时必须 unavailable，不能返回 0 冒充。
  const empty = interpolateAt([], 60, 'cs');
  assert.equal(empty.available, false);
  assert.equal(empty.value, null);
  const nanFrames = interpolateAt([{ time: 0, cs: 'x' }], 0, 'cs');
  assert.equal(nanFrames.available, false);
});

test('t20：normalizeLiveState 透传 capability，实时观战默认 cs 量化、金币不可用', () => {
  const live = normalizeLiveState(payload, { itemIndex });
  assert.ok(live.capability, 'normalizeLiveState 必须带上 capability');
  assert.equal(live.capability.mode, 'live-spectate');
  assert.equal(live.protocolDecode, false);
  assert.deepEqual([...live.capability.quantized], ['cs']);
  assert.ok(live.capability.unavailable.includes('totalGold'));
  assert.ok(live.capability.unavailable.includes('xp'));
  assert.equal(live.capability.fields.cs.quantum, 10);
  // 协议流没接上时逐玩家精确值必须是 null，不能是 0。
  assert.equal(live.players[0].csExact, null);
  assert.equal(live.players[0].totalGold, null);
  // 契约要能过 JSON（SSE 是 JSON 传输），量化步长不能丢。
  const roundTripped = JSON.parse(JSON.stringify(live.capability));
  assert.equal(roundTripped.fields.cs.precision, 'quantized');
  assert.equal(roundTripped.fields.cs.quantum, 10);

  // 调用方显式指定回放模式 + timeline 可用时，模式与精度必须跟着变。
  const replay = normalizeLiveState(payload, {
    itemIndex,
    mode: 'replay',
    capabilitySources: { timelineAvailable: true, isPlayingReplay: true }
  });
  assert.equal(replay.capability.mode, 'replay');
  assert.equal(replay.capability.fields.cs.precision, 'estimated');
  assert.equal(replay.capability.detected.mode, 'replay');

  // 模式写错时退回实时观战，而不是抛错打断直播。
  const fallback = normalizeLiveState(payload, { itemIndex, mode: 'nope' });
  assert.equal(fallback.capability.mode, 'live-spectate');
});

test('t20：/events 下发链路保留 capability（main.js 写入 state，cloneState 原样序列化）', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  assert.ok(source.includes('state.capability = live.capability || null;'), 'main.js 必须把 capability 写进 state');
  assert.ok(source.includes('function cloneState() { return JSON.parse(JSON.stringify(state)); }'), 'cloneState 必须整体序列化 state，capability 才会随 SSE 下发');
});

test('t20：HUD 按契约渲染 —— quantized 带 ≈、unavailable 画占位不画数字', () => {
  const hud = loadHud();
  hud.setConfig({ players: [] });
  const player = {
    team: 'blue', name: 'BlueTop', champion: '杰斯', level: 12, kills: 2, deaths: 1, assists: 3, cs: 142, wardScore: 9,
    items: [{ itemID: 1054, count: 1, slot: 0, displayName: '多兰之刃', price: 450 }],
    summoners: ['闪现', '传送']
  };
  // 实时观战契约：cs 量化、金币不可用、生命条不可用。
  hud.setState({ mode: 'live', players: [player], blue: {}, red: {}, capability: buildCapabilityMatrix('live-spectate', { liveClient: true, gameflowPhase: 'InProgress' }) });
  assert.equal(hud.csMarkup(player), '≈142', 'quantized 的 CS 必须带 ≈，不能裸数字');
  assert.equal(hud.capUsable('cs'), true);
  assert.equal(hud.capUsable('totalGold'), false);
  const bars = hud.barCells(player);
  assert.ok(bars.includes('hb-bar hp unknown'), '生命条不可用时必须画 unknown 占位');
  assert.equal(bars.includes('width:'), true, '占位条宽度为 0，不伪造比例');

  // 回放契约：CS 变 estimated（不带 ≈），等级仍是估算但可画。
  hud.setState({ mode: 'live', players: [player], blue: {}, red: {}, capability: buildCapabilityMatrix('replay', { timelineAvailable: true }) });
  assert.equal(hud.csMarkup(player), '142', 'estimated 用原值展示，不套量化的 ≈');
  assert.equal(hud.capUsable('items'), true);

  // 离线契约：全部字段不可用，装备槽、KDA、CS 一律占位，且不注入演示装备。
  hud.setState({ mode: 'live', players: [player], blue: {}, red: {}, capability: buildCapabilityMatrix('offline', {}) });
  assert.equal(hud.csMarkup(player), '—');
  assert.equal(hud.kdaOf(player), '—', 'KDA 不可用时必须占位');
  assert.equal(hud.capUsable('items'), false);
  const slots = hud.playerItemSlots(player, 0);
  assert.equal(slots.length, 7);
  // vm 里返回的数组属于另一个 realm，deepEqual 会因原型不同失败，所以逐个比较值。
  assert.equal(slots.filter(entry => entry !== null).length, 0, '契约不可用时 7 个槽位全为 null，不得渲染装备');
  assert.equal(hud.ownedItemCount(player, 0), 0, '契约不可用时挖孔数为 0');

  // 没有契约（mock 演示 / 老快照）时退回原行为：照常画数字，不能因为缺契约就全空。
  hud.setState({ mode: 'live', players: [player], blue: {}, red: {} });
  assert.equal(hud.csMarkup(player), '142');
  assert.equal(hud.kdaOf(player), '2/1/3');
  assert.equal(hud.capUsable('totalGold'), true);
});

// 协议流解码出的 totalGold/xp 只有亚单位精度（残差 IEEE 字节多数票），必须走 quantized 档：
// 数值可用，但矩阵里绝不能升成 exact，否则 HUD/控台会把 ±1 的估算值写成「精确值」。
test('t40：协议流 quantized 的 totalGold/xp 保持 quantized，失效后回落 unavailable', () => {
  const base = buildCapabilityMatrix('live-spectate', {
    protocolDecode: true,
    protocolKda: true,
    protocolFields: { cs: false, gold: true, xp: true, goldPrecision: 'quantized', xpPrecision: 'quantized' }
  });
  assert.equal(fieldOf(base, 'totalGold').precision, 'quantized');
  assert.equal(isQuantized(base, 'totalGold'), true);
  assert.equal(isExact(base, 'totalGold'), false);
  assert.equal(isUsable(base, 'totalGold'), true);
  assert.equal(fieldOf(base, 'xp').precision, 'quantized');
  assert.equal(fieldOf(base, 'totalGold').source, 'spectator-protocol');

  // exact 声明的生产者仍然升 exact（回放桥的兼容路径）。
  const exactMatrix = buildCapabilityMatrix('live-spectate', {
    protocolDecode: true,
    protocolFields: { cs: false, gold: true, xp: true, goldPrecision: 'exact', xpPrecision: 'exact' }
  });
  assert.equal(fieldOf(exactMatrix, 'totalGold').precision, 'exact');

  const off = applyProtocolAvailability(base, false);
  assert.equal(isUsable(off, 'totalGold'), false);
  assert.equal(fieldOf(off, 'totalGold').precision, 'unavailable');
});

// HUD 消费侧：中栏对位经济差必须用解码出的 totalGold 真值，标注按精度档区分；
// 拿不到解码值就显示 — 占位；估算口径已删（2026-11-18，OCR 1Hz 丢帧闪烁难看）。
test('t41：对位经济差优先用解码 totalGold，quantized 标 ±1，无解码值显示 —', () => {
  const hud = loadHud();
  hud.setConfig({ players: [] });
  const mk = (team, gold) => ({
    team, name: team + 'Top', cs: 200, kills: 2, deaths: 1, assists: 3, items: [],
    totalGold: gold, totalGoldPrecision: 'quantized'
  });
  const quantizedMatrix = buildCapabilityMatrix('live-spectate', {
    protocolDecode: true,
    protocolKda: true,
    protocolFields: { cs: false, gold: true, xp: true, goldPrecision: 'quantized', xpPrecision: 'quantized' }
  });
  const blue = mk('blue', 12000);
  const red = mk('red', 9000);
  hud.setState({ mode: 'live', players: [blue, red], blue: {}, red: {}, capability: quantizedMatrix });
  assert.equal(hud.capUsable('totalGold'), true);
  const decoded = hud.playerGoldOf(blue);
  assert.equal(decoded.value, 12000, '解码值必须原样使用，不能被估算值覆盖');
  assert.equal(decoded.decoded, true);
  assert.equal(decoded.exact, false);
  const markup = hud.diffMarkup(blue, red);
  assert.ok(markup.includes('3.0K'), '差值应取解码值 12000-9000：' + markup);
  assert.ok(markup.includes('±1 以内'), 'quantized 标注必须写明 ±1，不能写成精确值：' + markup);

  // exact 声明（回放桥）：标注改成「精确值」。
  const exactMatrix = buildCapabilityMatrix('live-spectate', {
    protocolDecode: true,
    protocolFields: { cs: false, gold: true, xp: true, goldPrecision: 'exact', xpPrecision: 'exact' }
  });
  const blueExact = Object.assign({}, blue, { totalGoldPrecision: 'exact' });
  const redExact = Object.assign({}, red, { totalGoldPrecision: 'exact' });
  hud.setState({ mode: 'live', players: [blueExact, redExact], blue: {}, red: {}, capability: exactMatrix });
  assert.ok(hud.diffMarkup(blueExact, redExact).includes('精确值'));

  // 拿不到解码值（老快照 / 契约失效）：直接显示 — 占位，绝不退回估算口径（估算已删）。
  const stale = { team: 'blue', name: 'BlueTop', cs: 200, kills: 2, deaths: 1, assists: 3, items: [], totalGold: 12000 };
  const staleRed = { team: 'red', name: 'RedTop', cs: 180, kills: 1, deaths: 1, assists: 2, items: [], totalGold: 9000 };
  hud.setState({ mode: 'live', players: [stale, staleRed], blue: {}, red: {}, capability: buildCapabilityMatrix('offline', {}) });
  const estimated = hud.playerGoldOf(stale);
  assert.equal(estimated, null, '估算口径已删：拿不到解码值必须返回 null');
  const staleMarkup = hud.diffMarkup(stale, staleRed);
  assert.ok(staleMarkup.includes('hb-diff unknown'), '无真值时渲染 — 占位：' + staleMarkup);
  assert.equal(staleMarkup.includes('估算'), false, '估算文案必须彻底消失：' + staleMarkup);
});
