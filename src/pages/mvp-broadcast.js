'use strict';

// MVP 时刻页（PLAYER OF THE GAME）· 方向 B「数据牌」：
// 左侧数据面板（meta 行 / 选手名 / 英雄·分路 / 战队章 / K/D/A + 4 行统计表 / 装备列 / 页脚），
// 右侧 880px 硬边英雄原画海报。1920×1080 设计坐标，整页按 --mvp-scale 等比缩放到视口。
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
  var ROLE_LABEL = {
    TOP: 'TOP', JUNGLE: 'JUNGLE', MID: 'MID', MIDDLE: 'MID',
    ADC: 'ADC', BOTTOM: 'ADC', SUPPORT: 'SUPPORT', UTILITY: 'SUPPORT'
  };
  var NAME_MAX_WIDTH = 848;
  var NAME_MAX_SIZE = 96;
  var NAME_MIN_SIZE = 56;

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
  function setText(id, value) {
    var node = byId(id);
    if (!node) return;
    var next = String(value === null || value === undefined ? '' : value);
    if (node.textContent !== next) node.textContent = next;
  }
  function setHtml(id, html) {
    var node = byId(id);
    if (!node || node.__rbHtml === html) return;
    node.innerHTML = html;
    node.__rbHtml = html;
  }

  function getConfig() {
    if (config) return config;
    if (state && state.broadcastConfig) return state.broadcastConfig;
    return {};
  }
  function teamConfig(side) {
    var teams = getConfig().teams;
    var team = teams && typeof teams === 'object' ? teams[side] : null;
    return team && typeof team === 'object' ? team : {};
  }
  function tournamentName() {
    var cfg = getConfig();
    var series = cfg && cfg.series && typeof cfg.series === 'object' ? cfg.series : {};
    return text(state && state.tournamentName, text(cfg && cfg.tournamentName, text(series.name, '')));
  }
  function formatComma(value) {
    return String(Math.round(num(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function formatSigned(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
    var n = Math.round(Number(value));
    return (n >= 0 ? '+' : '-') + formatComma(Math.abs(n));
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function formatTime(seconds) {
    var total = Math.max(0, Math.round(num(seconds)));
    if (!total) return '';
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
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
        role: text(p.role, ''),
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

  function roleLabel(player) {
    var raw = text(player.position, text(player.role, '')).toUpperCase();
    if (!raw || raw === 'NONE') return '';
    return ROLE_LABEL[raw] || raw;
  }
  function sideLabel(side) { return side === 'red' ? 'RED SIDE' : 'BLUE SIDE'; }

  // 舞台按 1920×1080 设计坐标排版，整页缩放：OBS 源改成 1280×720 也只是等比缩小。
  function fitStage() {
    var width = window.innerWidth || 1920;
    var height = window.innerHeight || 1080;
    var scale = Math.min(width / 1920, height / 1080) || 1;
    ROOT.style.setProperty('--mvp-scale', String(scale));
  }
  // 名字自适应：Range 量到的是缩放后的视觉宽度，必须除以舞台缩放换回设计 px。
  function fitName() {
    var node = byId('mv-name');
    if (!node) return;
    var rect = ROOT.getBoundingClientRect();
    var scale = rect.width ? rect.width / 1920 : 1;
    var range = document.createRange();
    var size = NAME_MAX_SIZE;
    node.style.fontSize = size + 'px';
    while (size > NAME_MIN_SIZE) {
      range.selectNodeContents(node);
      var width = range.getBoundingClientRect().width / (scale || 1);
      if (width <= NAME_MAX_WIDTH) break;
      size -= 2;
      node.style.fontSize = size + 'px';
    }
  }

  function splashFor(player) {
    var key = player.championId || player.champion;
    var centered = RB.championCenteredSplashUrl ? RB.championCenteredSplashUrl(key) : '';
    var fallback = RB.championSplashUrl ? RB.championSplashUrl(key, RB.version) : '';
    return { src: centered || fallback, fallback: fallback && fallback !== (centered || fallback) ? fallback : '' };
  }

  function kdaMarkup(player) {
    var cells = [
      { cls: 'k', value: player.kills, label: 'KILLS' },
      { cls: 'd', value: player.deaths, label: 'DEATHS' },
      { cls: 'a', value: player.assists, label: 'ASSISTS' }
    ];
    var html = '';
    for (var i = 0; i < cells.length; i += 1) {
      if (i) html += '<i class="s">/</i>';
      html += '<span class="num ' + cells[i].cls + '"><b>' + esc(cells[i].value) + '</b>' +
        '<span class="lb">' + cells[i].label + '</span></span>';
    }
    return html;
  }

  function pctValue(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '<b class="missing">—</b>';
    return '<b>' + Math.round(clamp(Number(value), 0, 100)) + '<i>%</i></b>';
  }
  function signedValue(value) {
    var formatted = formatSigned(value);
    if (formatted === null) return '<b class="missing">—</b>';
    return '<b' + (Number(value) < 0 ? ' class="neg"' : '') + '>' + esc(formatted) + '</b>';
  }
  function tableMarkup(player) {
    var rows = [
      { key: 'kp', label: 'KP%', html: pctValue(player.kp) },
      { key: 'dmg', label: 'DMG%', html: pctValue(player.damagePct) },
      { key: 'dt', label: 'DT%', html: pctValue(player.takenPct) },
      { key: 'gd', label: 'GD@END', html: signedValue(player.gd), cls: ' gd' }
    ];
    return rows.map(function (row) {
      return '<div class="b-row' + (row.cls || '') + '"><span class="lb">' + row.label + '</span>' + row.html + '</div>';
    }).join('');
  }

  function itemsMarkup(items) {
    var list = Array.isArray(items) ? items : [];
    var html = '';
    for (var i = 0; i < 7; i += 1) {
      var item = list[i];
      var icon = item && RB.icon
        ? RB.icon('item', item, '', 'mv-item', RB.version)
        : '<span class="icon"><i class="icon-fb">·</i></span>';
      html += '<li' + (i === 6 ? ' class="trinket"' : '') + '>' + icon + '</li>';
    }
    return html;
  }

  function killsBySide(players) {
    var totals = { blue: 0, red: 0 };
    players.forEach(function (p) { totals[p.team === 'red' ? 'red' : 'blue'] += p.kills; });
    return totals;
  }

  function render(pg) {
    var players = normalizePlayers(pg);
    var mvp = resolveMvp(pg, players);
    var demo = !!(pg && pg.demo);
    ROOT.setAttribute('data-demo', demo ? '1' : '0');
    ROOT.setAttribute('data-state', mvp ? 'selected' : 'waiting');
    var badge = byId('mv-demo');
    if (badge) badge.hidden = !demo;

    var time = formatTime(pg && pg.gameLength);
    setText('mv-time', time ? 'GAME TIME ' + time : 'GAME TIME —');
    var kills = killsBySide(players);
    setText('mv-kills', 'KILLS ' + kills.blue + ' — ' + kills.red);
    setText('mv-tour', tournamentName() || 'KHADA JHIN');

    if (!mvp) {
      ROOT.setAttribute('data-ready', '1');
      return;
    }

    var side = mvp.team === 'red' ? 'red' : 'blue';
    var team = teamConfig(side);
    ROOT.setAttribute('data-side', side);
    setText('mv-art-tag', sideLabel(side));
    setText('mv-side-label', sideLabel(side));
    var sideState = state && typeof state[side] === 'object' ? state[side] : null;
    setText('mv-team-name', text(team.name, text(sideState && sideState.name, side === 'red' ? '红方' : '蓝方')));
    setText('mv-crest', text(team.shortName, side === 'red' ? 'RED' : 'BLUE').slice(0, 1).toUpperCase());

    var name = byId('mv-name');
    if (name && name.textContent !== mvp.name) {
      name.textContent = mvp.name;
      fitName();
    }
    var role = roleLabel(mvp);
    setText('mv-champ', mvp.champion);
    setText('mv-role', role);
    var dot = byId('mv-dot');
    if (dot) dot.hidden = !(mvp.champion && role);

    var art = byId('mv-art-img');
    if (art) {
      var splash = splashFor(mvp);
      if (splash.src && art.getAttribute('src') !== splash.src) {
        art.dataset.fallback = splash.fallback || '';
        art.src = splash.src;
      }
      art.onerror = function () {
        var fb = this.dataset.fallback;
        if (fb && this.src.indexOf(fb) < 0) { this.dataset.fallback = ''; this.src = fb; }
      };
      art.alt = mvp.champion || '';
    }

    setHtml('mv-kda', kdaMarkup(mvp));
    setHtml('mv-table', tableMarkup(mvp));
    setHtml('mv-items', itemsMarkup(mvp.items));
    ROOT.setAttribute('data-ready', '1');
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

  fitStage();
  window.addEventListener('resize', fitStage);
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
    document.fonts.ready.then(function () { fitName(); }).catch(function () {});
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
  '<main id="mvp-broadcast" class="mvp-broadcast" data-state="waiting" data-side="blue" data-demo="0" data-ready="0">',
  '<div class="b-art" aria-hidden="true"><img id="mv-art-img" alt=""><span class="b-art-tag" id="mv-art-tag">BLUE SIDE</span></div>',
  '<span class="b-topbar" aria-hidden="true"></span>',
  '<span class="b-divider" aria-hidden="true"></span>',
  '<div class="b-panel">',
    '<div class="b-meta">',
      '<span class="b-tag">MVP</span>',
      '<span class="b-meta-rule" aria-hidden="true"></span>',
      '<span class="b-eyebrow">PLAYER OF THE GAME</span>',
      '<span class="b-tour" id="mv-tour"></span>',
    '</div>',
    '<h1 class="b-name" id="mv-name">—</h1>',
    '<p class="b-sub"><span class="b-champ" id="mv-champ"></span><span class="b-dot" id="mv-dot" hidden></span><span class="b-role" id="mv-role"></span></p>',
    '<div class="b-team">',
      '<span class="b-crest" id="mv-crest">B</span>',
      '<span class="b-tn" id="mv-team-name"></span>',
      '<span class="b-side" id="mv-side-label">BLUE SIDE</span>',
    '</div>',
    '<span class="b-band-rule" aria-hidden="true"></span>',
    '<div class="b-body">',
      '<div class="b-kda" id="mv-kda"></div>',
      '<div class="b-table" id="mv-table"></div>',
    '</div>',
    '<ul class="b-items" id="mv-items"></ul>',
    '<div class="b-foot">',
      '<span id="mv-time">GAME TIME —</span>',
      '<i class="b-sep" aria-hidden="true"></i>',
      '<span id="mv-kills">KILLS 0 — 0</span>',
      '<span class="b-demo" id="mv-demo" hidden>DEMO DATA</span>',
    '</div>',
  '</div>',
  '<div class="b-wait"><span class="wf-eyebrow">SELECTING · 评选进行中</span><span class="wf-name">PLAYER OF THE GAME</span><span class="wf-line"><i></i></span></div>',
  '</main>'
].join('');

function mvpBroadcastPage() {
  const body = '<style data-mvp-broadcast-theme>' + readPublic('mvp-broadcast.css') + '</style>' + MVP_BODY;
  return htmlShell('MVP 时刻', body,
    assets.clientScript() + '\n' + readPublic('anim.js') + '\n' + MVP_SCRIPT);
}

module.exports = { mvpBroadcastPage };
