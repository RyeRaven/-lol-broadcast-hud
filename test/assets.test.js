const test = require('node:test');
const assert = require('node:assert/strict');
const assets = require('../src/assets');

test('champion icon URLs resolve Chinese, title, English and numeric names', () => {
  // 头像改本地 /assets 直出（16.22.1 全量下载），版本参数不再影响 champion 路径；
  // CDN 直链由 championCdnUrl 单独提供，供 <img data-cdn> 的 onerror 兜底。
  assert.equal(assets.championIconUrl('杰斯'), '/assets/champion/Jayce.png');
  assert.equal(assets.championIconUrl('未来守护者'), '/assets/champion/Jayce.png');
  assert.equal(assets.championIconUrl('Jayce'), '/assets/champion/Jayce.png');
  assert.equal(assets.championIconUrl(126), '/assets/champion/Jayce.png');
  assert.equal(assets.championIconUrl('鳄鱼'), '/assets/champion/Renekton.png');
  assert.equal(assets.championIconUrl('不存在的英雄'), '');
  assert.equal(assets.championCdnUrl('杰斯'), 'https://ddragon.leagueoflegends.com/cdn/16.22.1/img/champion/Jayce.png');
});

test('item icon URLs support display names, numeric ids and #id notation', () => {
  assert.equal(assets.itemIconUrl('#1054'), 'https://ddragon.leagueoflegends.com/cdn/16.22.1/img/item/1054.png');
  assert.equal(assets.itemIconUrl('1054'), 'https://ddragon.leagueoflegends.com/cdn/16.22.1/img/item/1054.png');
  assert.equal(assets.itemIconUrl(1054), 'https://ddragon.leagueoflegends.com/cdn/16.22.1/img/item/1054.png');
  assert.equal(assets.itemIconUrl('多兰之刃'), 'https://ddragon.leagueoflegends.com/cdn/16.22.1/img/item/1055.png');
  assert.equal(assets.itemIconUrl('不存在装备'), '');
});

test('summoner spell URLs resolve Chinese and Riot keys', () => {
  const flash = 'https://ddragon.leagueoflegends.com/cdn/16.22.1/img/spell/SummonerFlash.png';
  assert.equal(assets.spellIconUrl('闪现'), flash);
  assert.equal(assets.spellIconUrl('SummonerFlash'), flash);
  assert.equal(assets.spellIconUrl('治疗术'), 'https://ddragon.leagueoflegends.com/cdn/16.22.1/img/spell/SummonerHeal.png');
  assert.equal(assets.spellIconUrl('未知技能'), '');
});

test('version normalization falls back to the bundled patch', () => {
  assert.equal(assets.normalizeVersion('15.21.1'), '15.21.1');
  assert.equal(assets.normalizeVersion('bad-version'), assets.DEFAULT_VERSION);
  assert.equal(assets.normalizeVersion(undefined), assets.DEFAULT_VERSION);
  assert.equal(assets.championIconUrl('杰斯', '15.21.1'), '/assets/champion/Jayce.png');
  assert.equal(assets.championCdnUrl('杰斯', '15.21.1'), 'https://ddragon.leagueoflegends.com/cdn/15.21.1/img/champion/Jayce.png');
});

test('icon URLs are memoized and cache can be cleared', () => {
  assets.clearAssetCache();
  assert.equal(assets.assetCacheSize(), 0);
  const first = assets.championIconUrl('杰斯');
  const second = assets.championIconUrl('杰斯');
  assert.equal(first, second);
  assert.equal(assets.assetCacheSize(), 1);
  assets.itemIconUrl('多兰之刃');
  assert.equal(assets.assetCacheSize(), 2);
  assets.clearAssetCache();
  assert.equal(assets.assetCacheSize(), 0);
});

test('fallback initial handles Chinese, latin and empty labels', () => {
  assert.equal(assets.fallbackInitial('杰斯'), '杰');
  assert.equal(assets.fallbackInitial('ahri'), 'A');
  assert.equal(assets.fallbackInitial(''), '?');
  assert.equal(assets.fallbackInitial(null), '?');
});

test('icon markup always renders a fallback block and adds a real img when known', () => {
  assets.clearAssetCache();
  const known = assets.iconMarkup('champion', '杰斯', { label: '杰斯', className: 'pick-ico' });
  assert.match(known, /class="icon champion-icon pick-ico"/);
  assert.match(known, /class="icon-fb"[^>]*>杰</);
  assert.match(known, /<img src="\/assets\/champion\/Jayce\.png"/);
  assert.match(known, /data-cdn="https:\/\/ddragon\.leagueoflegends\.com\/cdn\/16\.22\.1\/img\/champion\/Jayce\.png"/);
  assert.match(known, /loading="lazy"/);
  assert.match(known, /onerror="if\(this\.dataset\.cdn\)\{this\.src=this\.dataset\.cdn;this\.removeAttribute\('data-cdn'\);\}else\{this\.remove\(\);\}"/);

  const unknown = assets.iconMarkup('champion', '不存在的英雄', { label: '?' });
  assert.match(unknown, /class="icon champion-icon"/);
  assert.match(unknown, /class="icon-fb"/);
  assert.doesNotMatch(unknown, /<img /);

  // 离线/异常输入也不能抛错，保证渲染流程不中断。
  for (const value of [null, undefined, '', 0, {}, []]) {
    assert.doesNotThrow(() => assets.iconMarkup('champion', value, { label: String(value) }));
    assert.doesNotThrow(() => assets.iconMarkup('item', value));
    assert.doesNotThrow(() => assets.iconMarkup('spell', value));
  }
});

test('browser client script exposes the same URL logic as the Node module', () => {
  const window = {};
  const factory = new Function('window', assets.clientScript());
  factory(window);
  const client = window.RBAssets;
  assert.ok(client, 'window.RBAssets should be defined');
  assert.equal(client.version, assets.DEFAULT_VERSION);
  assert.equal(client.championIconUrl('杰斯'), assets.championIconUrl('杰斯'));
  assert.equal(client.itemIconUrl('多兰之刃'), assets.itemIconUrl('多兰之刃'));
  assert.equal(client.itemIconUrl('#1054'), assets.itemIconUrl('#1054'));
  assert.equal(client.itemIconUrl(1054), assets.itemIconUrl(1054));
  assert.equal(client.championIconUrl(126), assets.championIconUrl(126));
  assert.equal(client.spellIconUrl('闪现'), assets.spellIconUrl('闪现'));
  assert.equal(client.fallbackInitial('ahri'), 'A');
  assert.match(client.icon('champion', '杰斯', '杰斯'), /<img src=/);
  assert.doesNotMatch(client.icon('champion', '未知', '未知'), /<img /);
  assert.ok(Array.isArray(client.demoItems) && client.demoItems.length >= 10);
});


test('offline Data Dragon: all four overlays render fallback-first icons from mock state', () => {
  const vm = require('node:vm');
  const { overlayPage, OVERLAY_ROOT_IDS } = require('../src/pages/overlays');
  const { state, createMockPlayers } = require('../src/app-state');
  function renderOffline(type) {
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
    vm.runInNewContext(script[1], { window: {}, document, EventSource: FakeEventSource, JSON, console }, { filename: 'overlay-' + type + '.js' });
    assert.ok(source, type + ' should connect to /events');
    assert.equal(source.url, '/events');
    const snapshot = JSON.parse(JSON.stringify(state));
    snapshot.players = createMockPlayers();
    snapshot.phase = 'in_game';
    // 显式锁定 mock 模式：initialMode 跟随本地保存的 config（live 会把未解析的 mock BP 清空）。
    snapshot.mode = 'demo';
    // 外网不可达时 <img> 不会加载；渲染本身只输出带 onerror 的标记，不应抛错。
    assert.doesNotThrow(() => source.onmessage({ data: JSON.stringify(snapshot) }));
    assert.ok(root.innerHTML.length > 200, type + ' should render content');
    return root.innerHTML;
  }
  const expectedChampions = { bp: 20, 'ingame-top': 10, 'ingame-bottom': 10, postgame: 10 };
  for (const type of Object.keys(expectedChampions)) {
    const markup = renderOffline(type);
    const images = markup.match(/<img /g) || [];
    const champions = markup.match(/img\/champion\//g) || [];
    const fallbacks = markup.match(/class="icon-fb"/g) || [];
    assert.ok(champions.length >= expectedChampions[type], type + ' should render at least ' + expectedChampions[type] + ' champion images, got ' + champions.length);
    assert.ok(fallbacks.length >= images.length, type + ' should keep a letter fallback behind every image');
    // 头像走 /assets 本地路径 + data-cdn 兜底链；onerror 链末支仍是 this.remove()。
    assert.match(markup, /onerror="if\(this\.dataset\.cdn\)\{/);
    assert.match(markup, /this\.remove\(\);\}"/);
  }
  const bottom = renderOffline('ingame-bottom');
  assert.equal((bottom.match(/img\/item\//g) || []).length, 60, '10 players x 6 item slots');
  assert.equal((bottom.match(/img\/spell\//g) || []).length, 20, '10 players x 2 summoner spells');
});

test('bundled Data Dragon tables are populated', () => {
  assert.ok(assets.CHAMPION_TABLE.length >= 150);
  assert.ok(assets.ITEM_TABLE.length >= 100);
  assert.ok(assets.DEMO_ITEM_SETS.length >= 10);
  for (const set of assets.DEMO_ITEM_SETS) {
    // 第 7 位是视野饰品：原生记分板每人 6 装备 + 1 饰品。
    assert.equal(set.length, 7);
    for (const id of set) assert.ok(Number.isInteger(id) && id > 0);
  }
});
