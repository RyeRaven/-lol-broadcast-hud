'use strict';

// 赛后结算页（照搬 LCK 风格）：顶栏比分 + 标语条 + 左列团队数据对比 + 右侧伤害榜/经济差曲线。
// MVP 独立页面（/broadcast/mvp）另行实现，本页不再包含 MVP 卡片。
// public/result-broadcast.css 与 anim.js 由本模块内联注入，不新增静态路由。
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

const RESULT_SCRIPT = String.raw`(function () {
  'use strict';
  var ROOT = document.getElementById('result-broadcast');
  if (!ROOT) return;
  document.body.classList.add('rb-body');
  try { if (document.documentElement) document.documentElement.classList.add('rb-html'); } catch (error) {}
  var A = window.RBAnim || {};
  var RB = window.RBAssets || {};
  var PARAMS = new URLSearchParams(window.location.search);
  var state = {};
  var config = null;
  var lastPhase = null;
  var lastCueSeq = null;
  var ROLES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'];

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

  function mergeConfig(base, override) {
    var left = base && typeof base === 'object' ? base : {};
    var right = override && typeof override === 'object' ? override : {};
    return {
      teams: {
        blue: Object.assign({}, left.teams && left.teams.blue, right.teams && right.teams.blue),
        red: Object.assign({}, left.teams && left.teams.red, right.teams && right.teams.red)
      },
      players: (right.players && right.players.length) ? right.players : (left.players || []),
      coaches: (right.coaches && right.coaches.length) ? right.coaches : (left.coaches || []),
      sponsors: (right.sponsors && right.sponsors.length) ? right.sponsors : (left.sponsors || []),
      series: Object.assign({}, left.series, right.series)
    };
  }
  function getConfig() {
    if (config) return config;
    if (state && state.broadcastConfig) return state.broadcastConfig;
    return {};
  }
  function teamOf(side) {
    var c = getConfig();
    var t = c.teams && c.teams[side];
    var s = state && state[side];
    return {
      name: text(t && t.name, text(s && s.name, side === 'red' ? '红方社群' : '蓝方学院')),
      shortName: text(t && t.shortName, side === 'red' ? 'RED' : 'BLUE'),
      rank: text(t && t.rank, ''),
      logo: text(t && t.logo, ''),
      color: text(t && t.color, side === 'red' ? '#EF4444' : '#3B82F6')
    };
  }
  function seriesInfo() {
    var s = getConfig().series || {};
    return {
      name: text(s.name, text(state.tournamentName, 'Khada Jhin 邀请赛')),
      stage: text(s.stage, '决赛'),
      patch: text(s.patch, text(state.patch, '—')),
      bestOf: num(s.bestOf, 3),
      records: s.records
    };
  }
  function formatDuration(seconds) {
    var total = Math.max(0, Math.round(num(seconds)));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  // 参考图格式：80.0K / 19.2K；不足 1K 直接显示整数。
  function formatGoldK(value) {
    var v = Math.max(0, num(value));
    if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
    return String(Math.round(v));
  }
  function formatComma(value) {
    return String(Math.round(num(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function findConfigPlayer(name, side, index) {
    var list = getConfig().players || [];
    var wanted = String(name || '').toLowerCase();
    if (wanted) {
      var hit = list.filter(function (p) {
        return [p.displayName, p.gameName, p.name].some(function (v) {
          return String(v || '').toLowerCase() === wanted;
        });
      })[0];
      if (hit) return hit;
    }
    var sideList = list.filter(function (p) { return p.team === side; });
    return sideList[index % 5] || {};
  }
  function normalizePlayer(p, index) {
    var side = p && p.team === 'red' ? 'red' : (p && p.team === 'blue' ? 'blue' : (index < 5 ? 'blue' : 'red'));
    var cfgPlayer = findConfigPlayer(p && p.name, side, index);
    return {
      name: text(p && p.name, text(p && p.displayName, text(cfgPlayer.displayName, text(cfgPlayer.gameName, 'PLAYER ' + (index + 1))))),
      champion: text(p && p.champion, text(p && p.championName, '')),
      championId: p && p.championId,
      team: side,
      role: text(p && p.role, text(cfgPlayer.role, '')),
      slot: 0,
      kills: num(p && p.kills),
      deaths: num(p && p.deaths),
      assists: num(p && p.assists),
      cs: num(p && p.cs),
      gold: (p && (p.gold != null || p.goldEarned != null)) ? num(p.gold !== undefined ? p.gold : p.goldEarned) : null,
      damage: p && p.damage != null ? num(p.damage) : null,
      vision: num(p && p.vision),
      level: num(p && p.level, 1),
      items: p && Array.isArray(p.items) ? p.items : [],
      damagePct: p ? p.damagePct : undefined,
      kp: p ? p.kp : undefined
    };
  }
  function deriveStats(players) {
    ['blue', 'red'].forEach(function (side) {
      var team = players.filter(function (p) { return p.team === side; });
      var totalDamage = team.reduce(function (total, p) { return total + num(p.damage); }, 0);
      var totalKills = team.reduce(function (total, p) { return total + num(p.kills); }, 0);
      var slot = 0;
      team.forEach(function (p) {
        p.slot = slot;
        slot += 1;
        if (p.damagePct === undefined || p.damagePct === null || !Number.isFinite(Number(p.damagePct))) {
          p.damagePct = p.damage == null ? null : (totalDamage ? Math.round((num(p.damage) / totalDamage) * 1000) / 10 : 0);
        }
        if (p.kp === undefined || p.kp === null || !Number.isFinite(Number(p.kp))) {
          p.kp = totalKills ? Math.round(((num(p.kills) + num(p.assists)) / totalKills) * 1000) / 10 : 0;
        }
        p.damagePct = p.damagePct == null ? null : clamp(num(p.damagePct), 0, 100);
        p.kp = clamp(num(p.kp), 0, 100);
      });
    });
    return players;
  }
  function buildPlayers(pg) {
    var raw = pg && Array.isArray(pg.players) ? pg.players.slice(0, 10) : [];
    var out = [];
    var i;
    for (i = 0; i < 10; i += 1) out.push(normalizePlayer(raw[i] || {}, i));
    var blueCount = out.filter(function (p) { return p.team === 'blue'; }).length;
    var redCount = out.filter(function (p) { return p.team === 'red'; }).length;
    if (!blueCount || !redCount) {
      out.forEach(function (p, index) { p.team = index < 5 ? 'blue' : 'red'; });
    }
    return deriveStats(out);
  }
  // 演示兜底：配置里的 10 名选手 + 一组稳定、合理的示例数据。
  // 每个条目是 [K, D, A, CS, 经济, 伤害, 视野, 等级]。
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
  function demoRawPlayers() {
    var cfgList = getConfig().players || [];
    var liveList = state && Array.isArray(state.players) ? state.players : [];
    var out = [];
    for (var i = 0; i < 10; i += 1) {
      var cfgPlayer = cfgList[i] || {};
      var livePlayer = liveList[i] || {};
      var side = cfgPlayer.team === 'red' || livePlayer.team === 'red' || i >= 5 ? 'red' : 'blue';
      var line = DEMO_LINES[i] || DEMO_LINES[0];
      out.push({
        name: text(cfgPlayer.displayName, text(cfgPlayer.gameName, text(livePlayer.name, (side === 'blue' ? 'BLUE ' : 'RED ') + (i % 5 + 1)))),
        champion: text(livePlayer.champion, text(cfgPlayer.champion, DEMO_CHAMPS[i] || '')),
        championId: livePlayer.championId || cfgPlayer.championId,
        team: side,
        role: text(cfgPlayer.role, text(livePlayer.role, ROLES[i % 5])),
        kills: line[0],
        deaths: line[1],
        assists: line[2],
        cs: line[3],
        gold: line[4],
        damage: line[5],
        vision: line[6],
        level: line[7]
      });
    }
    return out;
  }
  var DEMO_BANS = ['Ahri', 'Lee Sin', 'Jinx', 'Thresh', 'Syndra', 'Gwen', 'Vi', 'Yone', 'Ashe', 'Karma'];
  // 演示英雄：config/实时数据都没有 champion 时兜底，让 demo 图有真实头像。
  var DEMO_CHAMPS = ['杰斯', '瑟提', '辛德拉', '伊泽瑞尔', '诺提勒斯', '雷克顿', '赵信', '阿狸', '厄斐琉斯', '蕾欧娜'];
  // 演示经济差曲线（胜方视角）：前期胶着 → 中期小幅落后 → 后期一路扩大。
  var DEMO_DIFF = [
    120, -80, 240, -160, 320, -240, 180, -60, -420, -680,
    -820, -1040, -1210, -1380, -1520, -1578, -1490, -1330, -1120, -860,
    -540, -180, 320, 940, 1660, 2480, 3320, 4260, 5120, 5680,
    6240, 7960, 9480, 10820, 11960, 12840, 13560, 14202
  ];
  function demoGoldTimeline() {
    var winnerBlue = resolveResult({}).winner !== 'red';
    return DEMO_DIFF.map(function (d, i) {
      var diff = winnerBlue ? d : -d;
      return { t: i, blue: 96000 + Math.round(diff / 2), red: 96000 - Math.round(diff / 2) };
    });
  }
  function currentPostGame() {
    var actual = state && state.postGame;
    if (actual && typeof actual === 'object') return actual;
    return demoPostGame();
  }
  function demoPostGame() {
    return {
      players: demoRawPlayers(),
      gameLength: 2339,
      gameMode: 'CLASSIC',
      isWin: q('side').toLowerCase() !== 'red',
      demo: true,
      source: 'DEMO DATA'
    };
  }
  function resolveResult(pg) {
    var forced = q('result').toUpperCase();
    var userSide = q('side').toLowerCase();
    if (pg.winSide === 'blue' || pg.winSide === 'red') {
      // 回放上传：胜负以 .rofl 官方统计为准，winSide 就是胜方；?result= 仍可强制覆盖横幅文案。
      var roflWinner = pg.winSide;
      var roflBase = userSide === 'blue' || userSide === 'red' ? userSide : 'blue';
      var roflResult = forced === 'DEFEAT' || forced === 'VICTORY' ? forced : (roflWinner === roflBase ? 'VICTORY' : 'DEFEAT');
      return { result: roflResult, winner: roflWinner, theme: roflWinner };
    }
    var result = forced === 'DEFEAT' || forced === 'VICTORY' ? forced : (pg.isWin === false ? 'DEFEAT' : 'VICTORY');
    var winner = userSide;
    if (winner !== 'blue' && winner !== 'red') winner = pg.isWin === false ? 'red' : 'blue';
    return { result: result, winner: winner, theme: winner };
  }

  function championIcon(p) {
    var label = text(p.champion, p.name);
    if (RB.icon) return RB.icon('champion', p.championId || p.champion || p.name, label, '', RB.version);
    return '<span class="icon champion-icon"><i class="icon-fb">' + esc((label || '?').slice(0, 1)) + '</i></span>';
  }
  function logoMarkup(team, side) {
    var initial = esc((team.shortName || team.name || side).slice(0, 1).toUpperCase());
    var img = team.logo ? '<img src="' + esc(team.logo) + '" alt="' + esc(team.name) + '" onerror="this.remove()">' : '';
    return img + '<i>' + initial + '</i>';
  }
  // demo 模式下全局目标计数全 0 时用演示数据，避免表格整列零。
  // demo 目标数按真实规则自洽：远古龙需一方先拿 4 条小龙的龙魂后才会刷新
  var DEMO_OBJECTIVES = {
    blue: { kills: 0, towers: 9, dragons: 4, barons: 3, heralds: 0, grubs: 2, elder: 1, gold: 80400 },
    red: { kills: 0, towers: 3, dragons: 1, barons: 0, heralds: 1, grubs: 0, elder: 0, gold: 66100 }
  };
  function sideData(side) {
    var s = state && state[side] && typeof state[side] === 'object' ? state[side] : {};
    var out = {
      kills: num(s.score),
      towers: num(s.towers),
      dragons: num(s.dragons),
      barons: num(s.barons),
      heralds: num(s.heralds),
      grubs: num(s.grubs),
      elder: (Array.isArray(s.dragonTypes) ? s.dragonTypes : []).filter(function (t) { return String(t).toLowerCase() === 'elder'; }).length,
      gold: num(s.gold)
    };
    var anyCount = out.kills || out.towers || out.dragons || out.barons || out.heralds || out.grubs || out.elder;
    var pg = null;
    try { pg = currentPostGame(); } catch (e) { pg = null; }
    if (!anyCount && pg && pg.demo && DEMO_OBJECTIVES[side]) return DEMO_OBJECTIVES[side];
    return out;
  }
  function bansFor(side) {
    // ban 位真值源：进对局时固化的 BP 快照（state.gameBans）——draft 在离开选人时会被清空，
    // .rofl 也不含 ban 数据，所以回放上传后同样吃这份快照；快照缺失才回退 draft/演示数据。
    var snap = state && state.gameBans;
    var list = snap && Array.isArray(snap[side === 'red' ? 'red' : 'blue']) ? snap[side === 'red' ? 'red' : 'blue'] : [];
    if (!list.length) {
      var draft = state && state.draft;
      list = draft && Array.isArray(draft[side === 'red' ? 'redBans' : 'blueBans']) ? draft[side === 'red' ? 'redBans' : 'blueBans'] : [];
    }
    if (list.length) return list.slice(0, 5);
    return (side === 'red' ? DEMO_BANS.slice(5) : DEMO_BANS.slice(0, 5));
  }

  function renderTopbar(pg, players, info) {
    var blue = teamOf('blue');
    var red = teamOf('red');
    var kills = { blue: 0, red: 0 };
    players.forEach(function (p) { kills[p.team] += num(p.kills); });
    var blueKills = kills.blue || sideData('blue').kills;
    var redKills = kills.red || sideData('red').kills;
    byId('rs-seed-blue').textContent = text(blue.rank, 'BLUE SIDE');
    byId('rs-seed-red').textContent = text(red.rank, 'RED SIDE');
    byId('rs-name-blue').textContent = text(blue.name, blue.shortName);
    byId('rs-name-red').textContent = text(red.name, red.shortName);
    byId('rs-logo-blue').innerHTML = logoMarkup(blue, 'blue');
    byId('rs-logo-red').innerHTML = logoMarkup(red, 'red');
    byId('rs-kills-blue').textContent = String(blueKills);
    byId('rs-kills-red').textContent = String(redKills);
    byId('rs-gametime').textContent = formatDuration(pg.gameLength);
    var blueWin = info.winner === 'blue';
    byId('rs-tag-blue').textContent = blueWin ? 'WIN' : 'LOSS';
    byId('rs-tag-red').textContent = blueWin ? 'LOSS' : 'WIN';
    byId('rs-tag-blue').className = 'rs-tag' + (blueWin ? ' win' : '');
    byId('rs-tag-red').className = 'rs-tag' + (blueWin ? '' : ' win');
  }
  function renderBanner() {
    var s = seriesInfo();
    // 参考：WORLDS 2026 | THIS IS OUR MOMENT——系列名自带阶段（如「校园赛·半决赛」）时不再拼 stage，避免重复。
    var name = text(s.name, '');
    var stage = text(s.stage, '');
    byId('rs-banner').textContent = name && stage && name.indexOf(stage) === -1 ? name + ' | ' + stage : (name || 'KHADA JHIN');
  }
  function statRow(label, blueValue, redValue, winner, extra) {
    return '<div class="rs-row' + (extra ? ' ' + extra : '') + '">' +
      '<b class="rs-val blue' + (winner === 'blue' ? ' gold' : '') + '">' + blueValue + '</b>' +
      '<span class="rs-label">' + esc(label) + '</span>' +
      '<b class="rs-val red' + (winner === 'red' ? ' gold' : '') + '">' + redValue + '</b>' +
    '</div>';
  }
  function banIcons(side) {
    var list = bansFor(side);
    var html = '';
    for (var i = 0; i < 5; i += 1) {
      var name = list[i] || '';
      html += '<span class="rs-ban">' + (name ? championIcon({ champion: name, name: name }) : '<i class="icon-fb">–</i>') + '</span>';
    }
    return html;
  }
  function renderTable(players, info) {
    var winner = info.winner;
    var blue = sideData('blue');
    var red = sideData('red');
    var sums = { blue: { k: 0, d: 0, a: 0, g: 0 }, red: { k: 0, d: 0, a: 0, g: 0 } };
    players.forEach(function (p) {
      var s = sums[p.team];
      if (!s) return;
      s.k += num(p.kills); s.d += num(p.deaths); s.a += num(p.assists); s.g += num(p.gold);
    });
    var blueGold = sums.blue.g || blue.gold;
    var redGold = sums.red.g || red.gold;
    var rows = '';
    rows += statRow('KDA', sums.blue.k + '/' + sums.blue.d + '/' + sums.blue.a, sums.red.k + '/' + sums.red.d + '/' + sums.red.a, winner);
    rows += statRow('GOLD', formatGoldK(blueGold), formatGoldK(redGold), winner);
    rows += statRow('TURRETS', blue.towers, red.towers, winner);
    rows += statRow('DRAKES', blue.dragons, red.dragons, winner);
    rows += statRow('ELDER DRAGONS', blue.elder, red.elder, winner);
    rows += statRow('BARONS', blue.barons, red.barons, winner);
    rows += statRow('RIFT HERALDS', blue.heralds, red.heralds, winner);
    rows += statRow('VOIDGRUBS', blue.grubs, red.grubs, winner);
    rows += '<div class="rs-row rs-ban-row">' +
      '<span class="rs-val blue' + (winner === 'blue' ? ' gold' : '') + '">' + banIcons('blue') + '</span>' +
      '<span class="rs-label">BAN</span>' +
      '<span class="rs-val red' + (winner === 'red' ? ' gold' : '') + '">' + banIcons('red') + '</span>' +
    '</div>';
    setIfChanged('rs-rows', rows);
  }
  // SSE 每次 broadcast 都会全量重渲染；innerHTML 相同则跳过，避免反复重启入场动画。
  function setIfChanged(id, html) {
    var node = byId(id);
    if (!node || node.__lastHtml === html) return;
    node.__lastHtml = html;
    node.innerHTML = html;
  }
  // 参考图：5 行蓝/红镜像对位——每行蓝左红右，条从贴值一侧向中心生长。
  function damageHalf(p, side, maxDamage) {
    if (!p) return '<span class="rs-dhalf ' + side + '"><span class="rs-dbar"></span></span>';
    var dmg = p.damage == null ? null : num(p.damage);
    var pct = dmg == null ? 0 : clamp((dmg / (maxDamage || 1)) * 100, 2, 100);
    var icon = '<span class="rs-dicon">' + championIcon(p) + '</span>';
    var val = '<b class="rs-dval">' + (dmg == null ? '—' : formatGoldK(dmg)) + '</b>';
    var bar = '<span class="rs-dbar"><i style="width:' + pct.toFixed(1) + '%"></i></span>';
    if (side === 'blue') return '<span class="rs-dhalf blue">' + icon + val + bar + '</span>';
    return '<span class="rs-dhalf red">' + bar + val + icon + '</span>';
  }
  function renderDamage(players) {
    var maxDamage = 1;
    players.forEach(function (p) { if (p.damage != null) maxDamage = Math.max(maxDamage, num(p.damage)); });
    var blue = players.filter(function (p) { return p.team === 'blue'; });
    var red = players.filter(function (p) { return p.team === 'red'; });
    var html = '';
    for (var i = 0; i < 5; i += 1) {
      html += '<div class="rs-drow">' + damageHalf(blue[i], 'blue', maxDamage) + damageHalf(red[i], 'red', maxDamage) + '</div>';
    }
    setIfChanged('rs-damage', html);
  }
  function renderGoldChart(points, info) {
    var winner = info.winner === 'red' ? 'red' : 'blue';
    var diffs = points.map(function (pt) {
      var d = winner === 'blue' ? num(pt.blue) - num(pt.red) : num(pt.red) - num(pt.blue);
      return { t: num(pt.t), d: d };
    });
    var maxAbs = 1;
    var maxVal = 0;
    var minVal = 0;
    diffs.forEach(function (p) {
      maxAbs = Math.max(maxAbs, Math.abs(p.d));
      maxVal = Math.max(maxVal, p.d);
      minVal = Math.min(minVal, p.d);
    });
    var maxT = Math.max(1, diffs.length ? diffs[diffs.length - 1].t : 1);
    var W = 640; var H = 210;
    var padL = 62; var padR = 10; var padT = 16; var padB = 30;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    var zeroY = padT + plotH / 2;
    function x(t) { return padL + (t / maxT) * plotW; }
    function y(d) { return zeroY - (d / maxAbs) * (plotH / 2); }
    var grid = '';
    var step = maxT > 32 ? 10 : 5;
    for (var gt = 0; gt <= maxT; gt += step) {
      var gx = x(gt);
      grid += '<line x1="' + gx.toFixed(1) + '" y1="' + padT + '" x2="' + gx.toFixed(1) + '" y2="' + (H - padB) + '" class="rs-gline"/>' +
        '<text x="' + gx.toFixed(1) + '" y="' + (H - padB + 16) + '" class="rs-gtick">' + gt + '</text>';
    }
    var line = '';
    var area = '';
    diffs.forEach(function (p, i) {
      var cmd = i === 0 ? 'M' : 'L';
      line += cmd + x(p.t).toFixed(1) + ' ' + y(p.d).toFixed(1) + ' ';
    });
    area = 'M' + x(diffs[0] ? diffs[0].t : 0).toFixed(1) + ' ' + zeroY.toFixed(1) + ' ' +
      diffs.map(function (p) { return 'L' + x(p.t).toFixed(1) + ' ' + y(p.d).toFixed(1) + ' '; }).join('') +
      'L' + x(diffs.length ? diffs[diffs.length - 1].t : 0).toFixed(1) + ' ' + zeroY.toFixed(1) + ' Z';
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<defs>' +
        '<clipPath id="rs-gold-clip"><rect x="' + padL + '" y="' + padT + '" width="' + plotW + '" height="' + (zeroY - padT) + '"/></clipPath>' +
        '<clipPath id="rs-gray-clip"><rect x="' + padL + '" y="' + zeroY + '" width="' + plotW + '" height="' + (H - padB - zeroY) + '"/></clipPath>' +
      '</defs>' +
      '<path d="' + area + '" fill="#caa15c" clip-path="url(#rs-gold-clip)" opacity="0.9"/>' +
      '<path d="' + area + '" fill="#d8d8d8" clip-path="url(#rs-gray-clip)" opacity="0.85"/>' +
      '<rect x="' + padL + '" y="' + padT + '" width="' + plotW + '" height="' + plotH + '" class="rs-gframe"/>' +
      grid +
      '<line x1="' + padL + '" y1="' + zeroY + '" x2="' + (W - padR) + '" y2="' + zeroY + '" class="rs-gzero"/>' +
      '<path d="' + line + '" fill="none" stroke="#f2f2f2" stroke-width="2"/>' +
      '<text x="4" y="' + (padT + 8) + '" class="rs-gylab">' + formatComma(maxVal) + '</text>' +
      // 参考图：底部极值标幅度（正数），不写负号
      '<text x="4" y="' + (H - padB - 4) + '" class="rs-gylab">' + formatComma(Math.abs(minVal)) + '</text>' +
    '</svg>';
    setIfChanged('rs-goldchart', svg);
  }

  function renderFooter() {
    var s = seriesInfo();
    byId('rs-patch').textContent = 'PATCH ' + text(s.patch, '—');
  }
  function renderAll(next) {
    if (next && typeof next === 'object') state = next;
    var pg = currentPostGame();
    var players = buildPlayers(pg);
    var info = resolveResult(pg);
    ROOT.dataset.winner = info.winner;
    ROOT.dataset.result = info.result.toLowerCase();
    ROOT.dataset.demo = pg.demo ? '1' : '0';
    renderTopbar(pg, players, info);
    renderBanner();
    renderTable(players, info);
    renderDamage(players);
    var tl = state && Array.isArray(state.goldTimeline) && state.goldTimeline.length ? state.goldTimeline : demoGoldTimeline();
    renderGoldChart(tl, info);
    renderFooter();
  }
  function update(next) {
    if (!next || typeof next !== 'object') return;
    var previousPhase = lastPhase;
    var previousCue = lastCueSeq;
    state = next;
    renderAll(next);
    var cue = next.broadcastCue || {};
    var cueSeq = Number(cue.seq);
    var phase = text(next.phase, '');
    var phaseChanged = phase === 'post_game' && previousPhase !== 'post_game';
    var cueTriggered = (cue.type === 'result-in' || cue.type === 'postgame-in' || cue.type === 'result') &&
      Number.isFinite(cueSeq) && cueSeq !== previousCue;
    lastPhase = phase;
    lastCueSeq = Number.isFinite(cueSeq) ? cueSeq : previousCue;
    if (phaseChanged || cueTriggered) {
      ROOT.classList.remove('rs-in');
      void ROOT.offsetWidth;
      ROOT.classList.add('rs-in');
    }
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
    if (loadedState && loadedState.broadcastConfig) config = mergeConfig(config || {}, loadedState.broadcastConfig);
    if (loadedState) {
      lastPhase = text(loadedState.phase, '');
      var cue = loadedState.broadcastCue || {};
      var seq = Number(cue.seq);
      lastCueSeq = Number.isFinite(seq) ? seq : null;
    }
    renderAll();
    ROOT.classList.add('rs-in');
  });
  var es = new EventSource('/events');
  es.onmessage = function (event) {
    try { update(JSON.parse(event.data)); } catch (error) { /* 保留上一帧 */ }
  };
})();`;

const RESULT_BODY = [
  '<main id="result-broadcast" class="result-broadcast rs" data-winner="blue" data-result="victory" data-demo="0">',
  '<div class="rb-bg" aria-hidden="true"><span class="rb-beam b1"></span><span class="rb-beam b2"></span></div>',
  '<header class="rs-topbar">',
    '<div class="rs-teamside left"><span class="rs-seed" id="rs-seed-blue">BLUE SIDE</span><b class="rs-tname" id="rs-name-blue">BLUE</b></div>',
    '<span class="rs-logo blue" id="rs-logo-blue"><i>B</i></span>',
    '<span class="rs-tag" id="rs-tag-blue">WIN</span>',
    '<b class="rs-kills" id="rs-kills-blue">0</b>',
    '<div class="rs-sep" aria-hidden="true"></div>',
    '<div class="rs-gametime"><b id="rs-gametime">00:00</b><span>GAMETIME</span></div>',
    '<div class="rs-sep" aria-hidden="true"></div>',
    '<b class="rs-kills" id="rs-kills-red">0</b>',
    '<span class="rs-tag" id="rs-tag-red">LOSS</span>',
    '<span class="rs-logo red" id="rs-logo-red"><i>R</i></span>',
    '<div class="rs-teamside right"><span class="rs-seed" id="rs-seed-red">RED SIDE</span><b class="rs-tname" id="rs-name-red">RED</b></div>',
  '</header>',
  '<div class="rs-banner"><span id="rs-banner">KHADA JHIN | FINAL</span></div>',
  '<div class="rs-columns">',
    '<section class="rs-table"><div id="rs-rows"></div></section>',
    '<section class="rs-charts">',
      '<div class="rs-panel"><h2>DAMAGE DEALT TO CHAMPIONS</h2><div class="rs-damage" id="rs-damage"></div></div>',
      '<div class="rs-panel"><h2>GOLD DIFFERENCE OVER TIME</h2><div class="rs-goldchart" id="rs-goldchart"></div></div>',
    '</section>',
  '</div>',
  '<footer class="rs-footer"><span class="rs-crest"><b>R</b><small>26</small></span><span class="rs-patch" id="rs-patch">PATCH —</span></footer>',
  '<span class="rb-demo-badge" id="rb-demo-badge">DEMO DATA</span>',
  '</main>'
].join('');

const TRANSITION_SCRIPT = String.raw`(function () {
  'use strict';
  var ROOT = document.getElementById('overlay-transition');
  if (!ROOT) return;
  document.body.classList.add('tr-body');
  try { if (document.documentElement) document.documentElement.classList.add('tr-html'); } catch (error) {}
  var PARAMS = new URLSearchParams(window.location.search);
  var cfg = { color: '#22d3ee', accent: '#f5c451', direction: 'left', duration: 350, mode: 'cover', debug: false };
  function q(name) { var v = PARAMS.get(name); return v === null ? '' : String(v).trim(); }
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function readCfg() {
    var color = q('color');
    if (/^#[0-9a-fA-F]{3,8}$/.test(color) || /^rgba?\(/.test(color)) cfg.color = color;
    var accent = q('accent');
    if (/^#[0-9a-fA-F]{3,8}$/.test(accent)) cfg.accent = accent;
    var direction = q('direction').toLowerCase();
    if (['left', 'right', 'up', 'down'].indexOf(direction) >= 0) cfg.direction = direction;
    var duration = parseInt(q('duration'), 10);
    if (Number.isFinite(duration)) cfg.duration = clamp(duration, 100, 2000);
    var mode = q('mode').toLowerCase();
    if (mode === 'pass' || mode === 'cover') cfg.mode = mode;
    cfg.debug = q('debug') === '1';
  }
  function apply() {
    ROOT.style.setProperty('--tr-color', cfg.color);
    ROOT.style.setProperty('--tr-accent', cfg.accent);
    ROOT.style.setProperty('--tr-duration', cfg.duration + 'ms');
    ROOT.dataset.direction = cfg.direction;
    ROOT.dataset.mode = cfg.mode;
    ROOT.dataset.debug = cfg.debug ? '1' : '0';
    if (q('preview') === '1') ROOT.dataset.preview = '1';
    else delete ROOT.dataset.preview;
    var debugEl = document.getElementById('tr-debug');
    if (debugEl) debugEl.textContent = 'WIPE · ' + cfg.direction.toUpperCase() + ' · ' + cfg.duration + 'ms · ' + cfg.mode + ' · ' + cfg.color;
  }
  function play() {
    ROOT.classList.remove('tr-play');
    void ROOT.offsetWidth;
    ROOT.classList.add('tr-play');
    if (cfg.mode === 'pass') {
      window.setTimeout(function () { ROOT.classList.remove('tr-play'); }, cfg.duration + 80);
    }
  }
  window.RBTransition = {
    config: cfg,
    play: function (next) {
      if (next && typeof next === 'object') {
        if (next.color) cfg.color = next.color;
        if (next.accent) cfg.accent = next.accent;
        if (next.direction) cfg.direction = next.direction;
        if (next.duration) cfg.duration = clamp(Number(next.duration) || cfg.duration, 100, 2000);
        if (next.mode) cfg.mode = next.mode;
      }
      apply();
      play();
    }
  };
  readCfg();
  apply();
  if (q('noplay') === '1') ROOT.classList.add('tr-play');
  else window.setTimeout(play, 40);
  var es = new EventSource('/events');
  es.onmessage = function (event) {
    try {
      var s = JSON.parse(event.data);
      var cue = s.broadcastCue || {};
      if (cue.type === 'wipe' || cue.type === 'transition') {
        var p = cue.payload || {};
        if (p.color) cfg.color = p.color;
        if (p.accent) cfg.accent = p.accent;
        if (p.direction) cfg.direction = p.direction;
        if (p.duration) cfg.duration = clamp(Number(p.duration) || 350, 100, 2000);
        if (p.mode) cfg.mode = p.mode;
        apply();
        play();
      }
    } catch (error) { /* 保留当前转场 */ }
  };
})();`;

const TRANSITION_BODY = [
  '<main id="overlay-transition" class="overlay-transition" data-direction="left" data-mode="cover" data-debug="0">',
    '<div class="tr-layer tr-layer-back"></div>',
    '<div class="tr-layer tr-layer-front"></div>',
    '<div class="tr-brand"><b>KHADA JHIN</b><i></i><small>SCENE TRANSITION</small></div>',
    '<div class="tr-debug" id="tr-debug">WIPE</div>',
  '</main>'
].join('');

function resultBroadcastPage() {
  const body = '<style data-result-broadcast-theme>' + readPublic('result-broadcast.css') + '</style>' + RESULT_BODY;
  return htmlShell('Khada Jhin · 赛后数据', body,
    assets.clientScript() + '\n' + readPublic('anim.js') + '\n' + RESULT_SCRIPT);
}

function transitionPage() {
  const body = '<style data-transition-theme>' + readPublic('transitions.css') + '</style>' + TRANSITION_BODY;
  return htmlShell('Khada Jhin · 场景转场', body, TRANSITION_SCRIPT);
}

module.exports = { resultBroadcastPage, transitionPage };
