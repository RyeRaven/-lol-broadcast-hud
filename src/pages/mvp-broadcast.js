'use strict';

// MVP 时刻页（照 LCK PLAYER OF THE GAME 风格）：
// 左上选手名+分路图标、右上标题+MVP 徽标、中间英雄原画大面板叠 K/D/A、右侧 ITEMS 装备列、
// 底部 KP%/DMG%/DT%/GD@END 四格。不做选手照片/符文列/队标/累计 MVP 数。
// 数据：EOG 赛后结算（src/post-game.js）+ 控台 POST /api/mvp 手选；mock 模式 demo 兜底并自动选伤害最高者。
// public/mvp-broadcast.css 与 assets.clientScript() 由本模块内联注入，不新增静态路由。
const fs = require('fs');
const path = require('path');
const { htmlShell } = require('./html');
const assets = require('../assets');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const fileCache = Object.create(null);

function readPublic(name) {
  if (!(name in fileCache)) {
    try {
      fileCache[name] = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
    } catch (error) {
      fileCache[name] = '';
    }
  }
  return fileCache[name];
}

const MVP_SCRIPT = String.raw`(function () {
  'use strict';
  var ROOT = document.getElementById('mvp-broadcast');
  if (!ROOT) return;
  document.body.classList.add('mv-body');
  try { if (document.documentElement) document.documentElement.classList.add('mv-html'); } catch (error) {}
  var RB = window.RBAssets || {};
  var PARAMS = new URLSearchParams(window.location.search);
  var state = {};
  var config = null;
  var ROLES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'];
  var POSITION_FILES = { TOP: 'top', JUNGLE: 'jungle', MID: 'middle', ADC: 'bottom', SUPPORT: 'utility' };

  function byId(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function text(value, fallback) {
    var result = value === null || value === undefined ? '' : String(value).trim();
    return result || (fallback === undefined ? '' : fallback);
  }
  function num(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function q(name) { var v = PARAMS.get(name); return v === null ? '' : String(v).trim(); }
  function setIfChanged(id, html) {
    var node = byId(id);
    if (!node || node.innerHTML === html) return;
    node.innerHTML = html;
  }

  function getConfig() {
    if (config) return config;
    if (state && state.broadcastConfig) return state.broadcastConfig;
    return {};
  }
  function formatComma(value) {
    return String(Math.round(num(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function formatSigned(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
    var n = Math.round(Number(value));
    return (n >= 0 ? '+' : '-') + formatComma(Math.abs(n));
  }

  // 演示兜底：与结算页同口径（配置 10 名选手 + DEMO_LINES），并补 MVP 页需要的 taken/position/gd。
  var DEMO_LINES = [
    [4, 2, 6, 212, 11200, 22400, 18, 16],
    [3, 3, 9, 168, 9800, 15800, 24, 15],
    [7, 1, 5, 245, 13100, 28600, 15, 17],
    [8, 2, 3, 256, 13800, 31500, 14, 17],
    [1, 3, 12, 42, 8200, 9600, 41, 13],
    [2, 5, 4, 198, 10400, 18200, 16, 15],
    [1, 4, 8, 155, 9600, 12400, 22, 14],
    [5, 4, 3, 230, 12200, 24800, 13, 16],
    [4, 3, 2, 241, 12800, 27100, 12, 16],
    [0, 6, 9, 38, 7900, 7200, 38, 12]
  ];
  var DEMO_CHAMPS = ['杰斯', '瑟提', '辛德拉', '伊泽瑞尔', '诺提勒斯', '雷克顿', '赵信', '阿狸', '厄斐琉斯', '蕾欧娜'];
  var DEMO_IDS = [126, 875, 134, 81, 111, 58, 64, 103, 523, 89];
  var DEMO_ITEM_SETS = [
    [1055, 3047, 6333, 3053, 3143, 3078, 3340],
    [1101, 3111, 3068, 3053, 3143, 3065, 3364],
    [1056, 3020, 3157, 3089, 3135, 3165, 3363],
    [1055, 3006, 6672, 3031, 3094, 3036, 3364],
    [3097, 3047, 3222, 3011, 3190, 3050, 3364],
    [1055, 3047, 6630, 3071, 3053, 3143, 3340],
    [1056, 3020, 6653, 3083, 3065, 3165, 3363],
    [1055, 3047, 6632, 3161, 3110, 3814, 3340],
    [1055, 3006, 6672, 6675, 3036, 3094, 3364],
    [1082, 3158, 3190, 3011, 3107, 3222, 3364]
  ];

  function demoPostGame() {
    var cfgList = getConfig().players || [];
    var players = [];
    for (var i = 0; i < 10; i += 1) {
      var cfgPlayer = cfgList[i] || {};
      var side = cfgPlayer.team === 'red' || i >= 5 ? 'red' : 'blue';
      var line = DEMO_LINES[i] || DEMO_LINES[0];
      players.push({
        name: text(cfgPlayer.displayName, text(cfgPlayer.gameName, (side === 'blue' ? 'BLUE ' : 'RED ') + (i % 5 + 1))),
        champion: text(cfgPlayer.champion, DEMO_CHAMPS[i]),
        championId: cfgPlayer.championId || DEMO_IDS[i],
        team: side,
        role: text(cfgPlayer.role, ROLES[i % 5]),
        position: ROLES[i % 5],
        kills: line[0], deaths: line[1], assists: line[2],
        cs: line[3], gold: line[4], damage: line[5],
        taken: Math.round(line[5] * 0.62) + 1200 + i * 90,
        vision: line[6], level: line[7],
        items: (DEMO_ITEM_SETS[i] || DEMO_ITEM_SETS[0]).map(function (id) { return '#' + id; })
      });
    }
    ['blue', 'red'].forEach(function (side) {
      var team = players.filter(function (p) { return p.team === side; });
      var totalDamage = team.reduce(function (t, p) { return t + p.damage; }, 0);
      var totalTaken = team.reduce(function (t, p) { return t + p.taken; }, 0);
      var totalKills = team.reduce(function (t, p) { return t + p.kills; }, 0);
      team.forEach(function (p) {
        p.damagePct = totalDamage ? Math.round((p.damage / totalDamage) * 1000) / 10 : 0;
        p.takenPct = totalTaken ? Math.round((p.taken / totalTaken) * 1000) / 10 : 0;
        p.kp = totalKills ? Math.round(((p.kills + p.assists) / totalKills) * 100) : 0;
        var other = players.filter(function (x) { return x.team !== side && x.position === p.position; })[0];
        p.gd = other ? p.gold - other.gold : null;
      });
    });
    return {
      players: players,
      gameLength: 2339,
      gameMode: 'CLASSIC',
      isWin: true,
      demo: true,
      source: 'DEMO DATA'
    };
  }

  function currentPostGame() {
    var actual = state && state.postGame;
    if (actual && typeof actual === 'object') return actual;
    return demoPostGame();
  }

  function normalizePlayers(pg) {
    var raw = pg && Array.isArray(pg.players) ? pg.players : [];
    return raw.slice(0, 10).map(function (p, index) {
      var side = p.team === 'red' ? 'red' : 'blue';
      return {
        name: text(p.name, '选手 ' + (index + 1)),
        champion: text(p.champion, ''),
        championId: p.championId,
        team: side,
        position: text(p.position, ''),
        kills: num(p.kills), deaths: num(p.deaths), assists: num(p.assists),
        gold: num(p.gold), damage: num(p.damage), taken: num(p.taken),
        damagePct: num(p.damagePct), takenPct: num(p.takenPct),
        kp: num(p.kp), gd: p.gd === null || p.gd === undefined || !Number.isFinite(Number(p.gd)) ? null : Number(p.gd),
        level: num(p.level), items: Array.isArray(p.items) ? p.items : []
      };
    });
  }

  function resolveMvp(pg, players) {
    var forcedName = q('name');
    var forcedTeam = q('team').toLowerCase();
    if (forcedName) {
      var hit = players.filter(function (p) {
        return String(p.name).toLowerCase() === forcedName.toLowerCase() && (!forcedTeam || p.team === forcedTeam);
      })[0];
      if (hit) return hit;
    }
    var pick = state && state.mvp && typeof state.mvp === 'object' ? state.mvp : null;
    if (pick && text(pick.name)) {
      var pickTeam = pick.team === 'red' ? 'red' : 'blue';
      var found = players.filter(function (p) {
        return String(p.name).toLowerCase() === String(pick.name).toLowerCase() && p.team === pickTeam;
      })[0];
      if (!found && pick.championId) {
        found = players.filter(function (p) { return num(p.championId) === num(pick.championId) && p.team === pickTeam; })[0];
      }
      if (found) return found;
    }
    if (pg && pg.demo) {
      // 演示模式没有手选时自动选伤害最高的选手，保证截图/预览有内容。
      return players.slice().sort(function (a, b) { return b.damage - a.damage; })[0] || null;
    }
    return null;
  }

  function positionIcon(position) {
    var file = POSITION_FILES[String(position || '').toUpperCase()];
    if (!file) return '<i class="mv-pos-fb">—</i>';
    return '<img src="/assets/positions/position-' + file + '.svg" alt="' + esc(position) + '" onerror="this.style.display=\'none\'">';
  }
  function splashMarkup(player) {
    var centered = RB.championCenteredSplashUrl ? RB.championCenteredSplashUrl(player.championId || player.champion) : '';
    var fallback = RB.championSplashUrl ? RB.championSplashUrl(player.championId || player.champion, RB.version) : '';
    if (!centered && !fallback) return '';
    var srcAttr = centered || fallback;
    var fb = fallback && fallback !== srcAttr ? ' data-fallback="' + esc(fallback) + '"' : '';
    return '<img src="' + esc(srcAttr) + '"' + fb + ' alt="' + esc(player.champion) + '">';
  }
  function itemIcon(item, index) {
    var markup = RB.icon
      ? RB.icon('item', item, '', 'mv-item', RB.version)
      : '<span class="icon"><i class="icon-fb">·</i></span>';
    return '<span class="mv-item-slot' + (index === 6 ? ' trinket' : '') + '">' + markup + '</span>';
  }

  function render(pg) {
    var players = normalizePlayers(pg);
    var mvp = resolveMvp(pg, players);
    var demo = !!(pg && pg.demo);
    ROOT.setAttribute('data-demo', demo ? '1' : '0');
    ROOT.setAttribute('data-state', mvp ? 'selected' : 'waiting');
    byId('mv-demo-badge').hidden = !demo;
    if (!mvp) return;

    byId('mv-name').textContent = mvp.name;
    byId('mv-champ').textContent = mvp.champion || '';
    setIfChanged('mv-pos', positionIcon(mvp.position));
    var artHtml = '<div class="mv-art-img">' + splashMarkup(mvp) + '</div>' +
      '<div class="mv-kda">' +
        '<span class="mv-kda-num" id="mv-k"><b>' + mvp.kills + '</b></span>' +
        '<span class="mv-kda-sep">/</span>' +
        '<span class="mv-kda-num" id="mv-d"><b>' + mvp.deaths + '</b></span>' +
        '<span class="mv-kda-sep">/</span>' +
        '<span class="mv-kda-num" id="mv-a"><b>' + mvp.assists + '</b></span>' +
      '</div>';
    setIfChanged('mv-art', artHtml);
    var itemsHtml = '';
    for (var i = 0; i < 7; i += 1) itemsHtml += itemIcon(mvp.items[i], i);
    setIfChanged('mv-items', itemsHtml);
    var gdText = formatSigned(mvp.gd);
    var stats = [
      { label: 'KP%', value: clamp(num(mvp.kp), 0, 100) + '%', note: '参团率' },
      { label: 'DMG%', value: mvp.damagePct == null ? '—' : clamp(num(mvp.damagePct), 0, 100) + '%', note: '伤害占比' },
      { label: 'DT%', value: mvp.takenPct == null ? '—' : clamp(num(mvp.takenPct), 0, 100) + '%', note: '承伤占比' },
      { label: 'GD@END', value: gdText === null ? '—' : gdText, note: '对位经济差', cls: gdText === null ? '' : (mvp.gd >= 0 ? ' pos' : ' neg') }
    ];
    var statsHtml = '';
    for (var s = 0; s < stats.length; s += 1) {
      statsHtml += '<div class="mv-stat' + (stats[s].cls || '') + '">' +
        '<b class="mv-stat-val">' + esc(stats[s].value) + '</b>' +
        '<span class="mv-stat-label">' + esc(stats[s].label) + '</span>' +
        '<span class="mv-stat-note">' + esc(stats[s].note) + '</span>' +
      '</div>';
    }
    setIfChanged('mv-stats', statsHtml);
  }

  function renderAll() {
    render(currentPostGame());
  }

  function update(next) {
    if (!next || typeof next !== 'object') return;
    state = next;
    renderAll();
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      return response && response.ok ? response.json() : null;
    }).catch(function () { return null; });
  }

  Promise.all([fetchJson('/api/state'), fetchJson('/api/broadcast-config')]).then(function (results) {
    var loadedState = results[0];
    var loadedConfig = results[1];
    if (loadedState) state = loadedState;
    if (loadedConfig) config = loadedConfig;
    if (loadedState && loadedState.broadcastConfig) config = loadedState.broadcastConfig;
    renderAll();
    ROOT.classList.add('mv-in');
  });
  var es = new EventSource('/events');
  es.onmessage = function (event) {
    try { update(JSON.parse(event.data)); } catch (error) { /* 保留上一帧 */ }
  };
})()`;

const MVP_BODY = [
  '<main id="mvp-broadcast" class="mvp-broadcast mv" data-state="waiting" data-demo="0">',
  '<div class="mv-bg" aria-hidden="true"><span class="mv-beam b1"></span><span class="mv-beam b2"></span></div>',
  '<header class="mv-top">',
    '<div class="mv-player">',
      '<h1 class="mv-name" id="mv-name">—</h1>',
      '<div class="mv-sub"><span class="mv-pos" id="mv-pos"></span><span class="mv-champ" id="mv-champ"></span></div>',
    '</div>',
    '<div class="mv-award">',
      '<span class="mv-kicker">PLAYER OF THE GAME</span>',
      '<b class="mv-badge">MVP</b>',
    '</div>',
  '</header>',
  '<section class="mv-stage">',
    '<div class="mv-art" id="mv-art"></div>',
    '<aside class="mv-items-panel">',
      '<h3>ITEMS</h3>',
      '<div class="mv-item-grid" id="mv-items"></div>',
    '</aside>',
  '</section>',
  '<footer class="mv-stats" id="mv-stats"></footer>',
  '<div class="mv-waiting"><span>等待导播评选 MVP</span></div>',
  '<span class="mv-demo-badge" id="mv-demo-badge" hidden>DEMO DATA</span>',
  '</main>'
].join('');

function mvpBroadcastPage() {
  const body = '<style data-mvp-broadcast-theme>' + readPublic('mvp-broadcast.css') + '</style>' + MVP_BODY;
  return htmlShell('MVP 时刻', body,
    assets.clientScript() + '\n' + readPublic('anim.js') + '\n' + MVP_SCRIPT);
}

module.exports = { mvpBroadcastPage };
