'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { hudBroadcastPage } = require('../src/pages/hud-broadcast');
const { overlayPage, OVERLAY_ROOT_IDS } = require('../src/pages/overlays');
const { consolePage } = require('../src/pages/console');
const { state, createMockPlayers, initialPlayersForMode } = require('../src/app-state');

function loadHudForTest() {
  const html = hudBroadcastPage();
  const script = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(script, 'HUD should embed an inline script');
  const start = script[1].indexOf('(function hudScript()');
  assert.ok(start > 0, 'HUD page script should exist');
  let page = script[1].slice(start);
  const cut = page.lastIndexOf('  buildShell();');
  assert.ok(cut > 0, 'HUD page script should end with buildShell');
  page = page.slice(0, cut) + [
    '  window.__hud = {',
    '    setState: function (value) { state = value; },',
    '    setConfig: function (value) { config = value; },',
    '    playerList: playerList,',
    '    playerItemSlots: playerItemSlots,',
    '    ownedItemCount: ownedItemCount,',
    '    hasTrinket: hasTrinket,',
    '    runeCells: runeCells,',
    '    spellCells: spellCells,',
    '    barCells: barCells,',
    '    rowMarkup: rowMarkup,',
    '    csMarkup: csMarkup,',
    '    kdaOf: kdaOf,',
    '    capUsable: capUsable,',
    '    capPrecision: capPrecision,',
    '    goldEstimate: playerGoldEstimate',
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
    console,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  vm.createContext(context);
  vm.runInContext(page, context, { filename: 'hud-broadcast-test.js' });
  assert.ok(context.window.__hud, 'HUD test hook should be installed');
  return context.window.__hud;
}

// 控台脚本没有导出，这里按 html.test.js 的方式在 vm 里跑一遍，只为了拿到顶层的渲染函数。
function loadConsoleForTest() {
  const html = consolePage(3210);
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, '控台应包含内联脚本');
  const script = match[1].replace(/\ninit\(\);\s*$/, '');
  const element = () => ({ innerHTML: '', textContent: '', className: '', value: '', style: {}, addEventListener() {} });
  const context = {
    document: { getElementById: () => element(), querySelectorAll: () => [], addEventListener() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date,
    Math,
    JSON,
    Set,
    Map,
    String,
    Number,
    Array,
    Object,
    Promise
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return context;
}

function renderOverlay(type, mutate) {
  const html = overlayPage(type);
  const script = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(script, type + ' should embed an inline script');
  const root = { innerHTML: '', classList: { add() {} } };
  const document = {
    body: { classList: { add() {} } },
    getElementById(id) { return id === OVERLAY_ROOT_IDS[type] ? root : null; }
  };
  let source = null;
  class FakeEventSource {
    constructor(url) { this.url = url; source = this; }
  }
  vm.runInNewContext(script[1], { window: {}, document, EventSource: FakeEventSource, JSON, console }, { filename: 'overlay-' + type + '-test.js' });
  assert.ok(source, type + ' should connect to /events');
  const snapshot = JSON.parse(JSON.stringify(state));
  snapshot.mode = 'live';
  snapshot.players = [];
  snapshot.blue = { name: '蓝方', score: 7, gold: 23500, towers: 3, dragons: 1, barons: 0 };
  snapshot.red = { name: '红方', score: 4, gold: 21800, towers: 1, dragons: 2, barons: 0 };
  snapshot.draft = { bluePicks: ['杰斯', '阿狸'], redPicks: ['安妮'], blueBans: ['亚索'], redBans: ['锐雯'] };
  snapshot.live = { draft: { parsed: false, actions: 0 }, game: { parsed: false } };
  snapshot.phase = 'draft';
  snapshot.postGame = null;
  if (mutate) mutate(snapshot);
  source.onmessage({ data: JSON.stringify(snapshot) });
  return root.innerHTML;
}

test('initialPlayersForMode keeps live startup roster empty and mock roster populated', () => {
  assert.deepEqual(initialPlayersForMode('live'), []);
  assert.equal(initialPlayersForMode('mock').length, 10);
  assert.ok(initialPlayersForMode('mock').some(player => player.name === 'TopStar'));
});

test('HUD live mode shows DEMO placeholders instead of startup mock players', () => {
  const hud = loadHudForTest();
  hud.setConfig({
    players: [
      { team: 'blue', gameName: 'TopStar', displayName: 'TopStar', role: 'TOP' },
      { team: 'blue', gameName: 'RiftKing', displayName: 'RiftKing', role: 'JUNGLE' },
      { team: 'red', gameName: 'RedTop', displayName: 'RedTop', role: 'TOP' }
    ]
  });
  hud.setState({ mode: 'live', players: [], blue: {}, red: {} });
  const blue = hud.playerList('blue');
  const red = hud.playerList('red');
  assert.equal(blue.length, 5);
  assert.equal(red.length, 5);
  assert.ok(blue.every(player => player.name === 'DEMO · 待选手数据' && player.demo === true));
  assert.ok(red.every(player => player.name === 'DEMO · 待选手数据' && player.demo === true));
  assert.equal(JSON.stringify(blue).includes('TopStar'), false);
  assert.equal(JSON.stringify(blue).includes('RiftKing'), false);

  hud.setState({ mode: 'mock', players: createMockPlayers(), blue: {}, red: {} });
  assert.equal(hud.playerList('blue')[0].name, 'TopStar');
});

test('live BP overlay ignores stale draft and startup mock roster when LCU draft is unparsed', () => {
  const markup = renderOverlay('bp');
  assert.equal(markup.includes('杰斯'), false);
  assert.equal(markup.includes('阿狸'), false);
  assert.equal(markup.includes('亚索'), false);
  assert.equal(markup.includes('TopStar'), false);
  assert.equal(markup.includes('RiftKing'), false);
});

test('live postgame overlay without postGame shows explicit empty state, not mock scores', () => {
  const markup = renderOverlay('postgame', snapshot => {
    snapshot.phase = 'post_game';
    snapshot.postGame = null;
  });
  assert.ok(markup.includes('DEMO'));
  assert.ok(markup.includes('赛后数据不可用'));
  assert.ok(markup.includes('等待结算'));
  assert.equal(markup.includes('TopStar'), false);
  assert.equal(markup.includes('>7<'), false);
  assert.equal(markup.includes('>4<'), false);
});

test('live postgame overlay prefers state.postGame over stale top-level mock teams', () => {
  const markup = renderOverlay('postgame', snapshot => {
    snapshot.phase = 'post_game';
    snapshot.postGame = {
      gameLength: 1800,
      blue: { name: '蓝方', score: 1, towers: 2, dragons: 1, barons: 0 },
      red: { name: '红方', score: 0, towers: 1, dragons: 0, barons: 0 },
      players: [
        { team: 'blue', name: 'BlueTop', champion: '杰斯', kills: 1, deaths: 0, assists: 2 },
        { team: 'red', name: 'RedTop', champion: '安妮', kills: 0, deaths: 1, assists: 0 }
      ]
    };
  });
  assert.ok(markup.includes('BlueTop'));
  assert.ok(markup.includes('RedTop'));
  assert.ok(markup.includes('FINAL'));
  assert.equal(markup.includes('TopStar'), false);
  assert.equal(markup.includes('>7<'), false);
  assert.equal(markup.includes('>4<'), false);
  assert.ok(markup.includes('>1<'));
  assert.ok(markup.includes('>0<'));
});

test('t9：HUD 装备槽消费对象化 items，消耗品显示数量角标，符文基石与大招缺失显式占位', () => {
  const hud = loadHudForTest();
  hud.setConfig({ players: [] });
  hud.setState({
    mode: 'live',
    blue: {},
    red: {},
    players: [{
      team: 'blue', name: 'BlueTop', champion: '杰斯', level: 12, cs: 120, wardScore: 9,
      items: [
        { itemID: 1054, count: 3, slot: 0, displayName: '多兰之盾', price: 450 },
        { itemID: 3086, count: 1, slot: 1, displayName: '狂热', price: 1200 }
      ],
      summoners: ['闪现', '传送'],
      runes: {
        keystone: { id: 8008, displayName: '致命节奏' },
        primaryRuneTree: { id: 8000, displayName: '精密' },
        secondaryRuneTree: { id: 8400, displayName: '坚决' }
      }
    }]
  });
  const player = hud.playerList('blue')[0];
  // 装备渲染（自绘/挖孔）与数据层无关，断言落在数据层：7 个槽位 + 件数 + 饰品位。
  const items = hud.playerItemSlots(player, 0);
  assert.equal(items.length, 7, '装备槽位固定 7 个（6 件 + 饰品）');
  // 逐字段断言，不整体 deepEqual：vm 里创建的对象属于另一个 realm，且 RBAssets 是否存在会决定 id 字段，
  // 整体比较会把「图标表是否注入」这种无关差异也算成失败。
  assert.equal(items[0].value, 1054, '装备槽保留 itemID');
  assert.equal(items[0].count, 3, '消耗品数量必须保留');
  assert.equal(items[0].slot, 0, '装备按 slot 落位');
  assert.equal(items[0].price, 450, '装备价格必须保留');
  assert.equal(items[0].name, '多兰之盾', '装备名称取 displayName');
  assert.equal(items[1].value, 3086, '第二件装备落在 slot 1');
  assert.equal(items[2], null, '未使用的槽位必须是显式 null，不伪造装备');
  assert.equal(items[6], null, '没有饰品时饰品位为 null');
  assert.equal(hud.ownedItemCount(player, 0), 2, '挖孔宽度按已拥有件数计算');
  assert.equal(hud.hasTrinket(player, 0), false, '没有饰品就不挖饰品孔');
  const runes = hud.runeCells(player);
  assert.ok(runes.includes('致命节奏'), '符文基石取 runes.keystone.displayName');
  assert.ok(runes.includes('>致<'), '基石没有图标时用首字兜底');
  const spells = hud.spellCells(player);
  assert.ok(spells.includes('title="闪现"'), '召唤师技能取 player.summoners 的名称');
  assert.ok(spells.includes('title="传送"'));
  assert.equal(spells.includes('unknown'), false, '两个技能都有数据时不留 unknown 占位');
  // 缺数据时必须显式 unknown，而不是拿别的东西顶上。
  const missing = hud.spellCells({ summoners: [] });
  assert.equal((missing.match(/unknown/g) || []).length, 2, '技能缺失应两个都渲染 unknown 占位');
  // 对位经济差估算必须吃到对象装备的 price（多兰之盾 450 × 3 + 狂热 1200 + 120 补刀 × 20）。
  assert.equal(hud.goldEstimate(player), 450 * 3 + 1200 + 120 * 20);
  assert.equal(hud.goldEstimate({ cs: null, items: [] }), null, '没有任何信号时不给估算值');
});

test('t9：局内底部 overlay 用对象装备的 itemID 出图标，旧字符串装备仍然兼容', () => {
  const markup = renderOverlay('ingame-bottom', snapshot => {
    snapshot.live = { draft: { parsed: false, actions: 0 }, game: { parsed: true } };
    snapshot.players = [
      {
        team: 'blue', name: 'BlueTop', champion: '杰斯', level: 12, kills: 1, deaths: 0, assists: 2, cs: 120,
        items: [{ itemID: 1054, count: 1, slot: 0, displayName: '多兰之盾', price: 450 }],
        summoners: ['闪现', '传送']
      },
      {
        team: 'red', name: 'RedTop', champion: '安妮', level: 11, kills: 0, deaths: 1, assists: 1, cs: 98,
        items: ['多兰之戒'],
        summoners: ['引燃', '闪现']
      }
    ];
  });
  assert.ok(markup.includes('/img/item/1054.png'), '对象装备应解析成 itemID 图标');
  assert.ok(markup.includes('/img/spell/SummonerFlash.png'));
  assert.equal(markup.includes('[object Object]'), false, '对象装备不能被拼成 [object Object]');
  assert.ok(markup.includes('BlueTop'));
  assert.ok(markup.includes('RedTop'));
  // 旧字符串形态（mock 数据与 post-game 快照仍在用）必须继续工作。
  assert.ok(markup.includes('item-slot'), '装备槽容器应存在');
});

test('t9：控台选手装备只画图标，6 件 + 饰品位固定 7 格', () => {
  const context = loadConsoleForTest();
  // 控台没有原生层可透（HUD 是挖孔），图标必须自绘；这里只验证结构与 tooltip。
  context.window = { RBAssets: { itemIconUrl: (item) => '/assets/img/item/' + (typeof item === 'object' ? item.itemID : String(item).replace(/^#/, '')) + '.png' } };
  const html = context.rosterItemChips([
    { itemID: 1054, count: 2, slot: 0, displayName: '多兰之盾', price: 450 },
    '#6655',
    { itemID: 3086, count: 1, displayName: '狂热' }
  ]);
  assert.equal((html.match(/class="roster-item/g) || []).length, 7, '固定 6 件 + 1 饰品位');
  assert.equal((html.match(/<img /g) || []).length, 3, '有数据的槽位画图标');
  assert.ok(html.includes('title="多兰之盾 ×2"'), '对象装备的 tooltip 带中文名与数量');
  assert.ok(html.includes('title="6655"'), '旧字符串装备去掉前导 # 当 tooltip');
  assert.equal(html.includes('[object Object]'), false);
  const empty = context.rosterItemChips(null);
  assert.equal((empty.match(/class="roster-item/g) || []).length, 7, '空数据也留 7 个槽位');
  assert.equal(empty.includes('<img '), false);
  assert.equal(empty.includes('—'), false, '空槽不再画破折号');
});

