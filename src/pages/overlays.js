'use strict';

// 4 个 OBS Overlay 页面：BP / 局内顶部 / 局内底部 / 赛后。
// 页面只依赖 /events（SSE）推送的 state；图标解析与兜底由 src/assets.js 生成。
const { htmlShell } = require('./html');
const assets = require('../assets');

const OVERLAY_TYPES = ['bp', 'ingame-top', 'ingame-bottom', 'postgame'];
// 稳定根节点 id：供 OBS 自定义 CSS 与视觉升级定位，不随渲染内容变化。
const OVERLAY_ROOT_IDS = { bp: 'bp-board', 'ingame-top': 'ingame-top', 'ingame-bottom': 'ingame-bottom', postgame: 'postgame-table' };

function overlayScript(type, rootId) {
  return assets.clientScript() + `
(function () {
  'use strict';
  var TYPE = ${JSON.stringify(type)};
  var ROOT_ID = ${JSON.stringify(rootId)};
  var LANES = ['上单', '打野', '中单', '下路', '辅助'];
  var app = document.getElementById(ROOT_ID);
  document.body.classList.add('overlay-body');
  try { if (document.documentElement) document.documentElement.classList.add('overlay-html'); } catch (error) {}
  if (app) app.classList.add('overlay-root');

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  function fmtTime(seconds) {
    var total = Math.max(0, Math.round(num(seconds)));
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  }
  function fmtGold(value) {
    if (value === null || value === undefined || value === '') return '—';
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(Math.round(n));
  }
  var RB = window.RBAssets;
  function icon(kind, value, label, className) {
    return RB.icon(kind, value, label, className, RB.version);
  }
  function splashUrl(champion) {
    return RB.championSplashUrl ? RB.championSplashUrl(champion, RB.version) : '';
  }
  function splashLayer(champion, className) {
    var url = splashUrl(champion);
    return url ? '<span class="' + className + '" style="background-image:url(' + esc(url) + ')"></span>' : '';
  }
  function postGameOf(state) {
    return state && state.mode === 'live' && state.postGame && typeof state.postGame === 'object' ? state.postGame : null;
  }
  function teamPlayers(state, side) {
    var list = [];
    if (state && state.mode === 'live') {
      var post = postGameOf(state);
      if (state.phase === 'post_game') list = post && Array.isArray(post.players) ? post.players : [];
      else if (state.live && state.live.game && state.live.game.parsed === true && Array.isArray(state.players)) list = state.players;
    } else if (state && Array.isArray(state.players)) {
      list = state.players;
    }
    return list.filter(function (p) { return p && p.team === side; });
  }
  function allPlayers(state) {
    var list = teamPlayers(state, 'blue').concat(teamPlayers(state, 'red'));
    return list.sort(function (a, b) { return (a.team === 'blue' ? 0 : 1) - (b.team === 'blue' ? 0 : 1); });
  }
  function kda(player) {
    return '<b>' + num(player.kills) + '</b><i>/</i><span>' + num(player.deaths) + '</span><i>/</i><b>' + num(player.assists) + '</b>';
  }
  var PLACEHOLDER = /^[◇◆◈▪▫●○]$/;
  // 装备既可能是 t9 之前的字符串，也可能是 {itemID,count,slot,price,displayName} 对象：
  // 图标要的是能喂给 RBAssets.itemIconUrl 的值，所以对象取 itemID，回退中文名。
  function itemLabel(raw) {
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'object') {
      var id = raw.itemID !== undefined && raw.itemID !== null ? raw.itemID : (raw.itemId !== undefined && raw.itemId !== null ? raw.itemId : raw.id);
      if (id !== undefined && id !== null && String(id).trim() !== '') return id;
      return String(raw.displayName || raw.name || '').trim();
    }
    return String(raw).trim();
  }
  function itemValues(player, index) {
    var source = player && Array.isArray(player.items) ? player.items : [];
    var list = [];
    for (var i = 0; i < source.length; i += 1) {
      var value = itemLabel(source[i]);
      if (value !== '' && value !== null && value !== undefined) list.push(value);
    }
    if (!list.length) return [];
    var placeholders = list.every(function (x) { return PLACEHOLDER.test(String(x).trim()); });
    if (placeholders && RB.demoItems && RB.demoItems.length) return RB.demoItems[index % RB.demoItems.length];
    return list;
  }
  function itemSlots(player, index) {
    var values = itemValues(player, index);
    var html = '';
    for (var i = 0; i < 6; i += 1) {
      html += values[i] === undefined ? '<span class="item-slot empty"></span>' : '<span class="item-slot">' + icon('item', values[i], '') + '</span>';
    }
    return html;
  }
  function spellSlots(player) {
    var spells = Array.isArray(player.summoners) ? player.summoners : [];
    var html = '';
    for (var i = 0; i < 2; i += 1) {
      html += '<span class="spell-slot">' + (spells[i] === undefined ? '<span class="icon spell-icon"><i class="icon-fb">·</i></span>' : icon('spell', spells[i], '')) + '</span>';
    }
    return html;
  }
  function damagePct(player, team) {
    if (player.damagePct !== null && player.damagePct !== undefined && Number.isFinite(Number(player.damagePct))) {
      return Math.max(0, Math.min(100, Number(player.damagePct)));
    }
    var total = team.reduce(function (sum, p) { return sum + num(p.damage); }, 0);
    return total > 0 ? (num(player.damage) / total) * 100 : 0;
  }
  function killParticipation(player, team) {
    if (player.kp !== null && player.kp !== undefined && Number.isFinite(Number(player.kp))) {
      return Math.max(0, Math.min(100, Number(player.kp)));
    }
    var kills = team.reduce(function (sum, p) { return sum + num(p.kills); }, 0);
    return kills > 0 ? ((num(player.kills) + num(player.assists)) / kills) * 100 : 0;
  }

  // 大小龙倒计时：用双方击杀数变化推断下一只刷新时间，纯前端近似，不依赖游戏内存。
  var objectiveState = { dragonCount: null, baronCount: null, dragonAt: 300, baronAt: 1200 };
  function updateObjectives(state) {
    var gameTime = num(state.gameTime);
    var dragonCount = num(state.blue && state.blue.dragons) + num(state.red && state.red.dragons);
    var baronCount = num(state.blue && state.blue.barons) + num(state.red && state.red.barons);
    if (objectiveState.dragonCount === null) {
      objectiveState.dragonCount = dragonCount;
      objectiveState.baronCount = baronCount;
      if (dragonCount > 0) objectiveState.dragonAt = gameTime + 300;
      return;
    }
    if (dragonCount > objectiveState.dragonCount) objectiveState.dragonAt = gameTime + 300;
    if (baronCount > objectiveState.baronCount) objectiveState.baronAt = gameTime + 360;
    objectiveState.dragonCount = dragonCount;
    objectiveState.baronCount = baronCount;
  }
  function timerState(kind, state) {
    var at = kind === 'dragon' ? objectiveState.dragonAt : objectiveState.baronAt;
    var left = Math.round(at - num(state.gameTime));
    return left <= 0 ? { text: '已刷新', ready: true } : { text: fmtTime(left), ready: false };
  }

  function topSide(state, side) {
    var team = state[side] || {};
    var players = teamPlayers(state, side).slice(0, 5);
    var logo = team.logo || (side === 'blue' ? 'B' : 'R');
    var champs = players.map(function (p) { return icon('champion', p.champion, p.champion, 'sb-champ'); }).join('');
    return '<div class="sb-side ' + side + '">' +
      '<div class="sb-logo">' + esc(logo) + '</div>' +
      '<div class="sb-name"><b>' + esc(team.name || '') + '</b><small>' + (side === 'blue' ? 'BLUE SIDE' : 'RED SIDE') + '</small><div class="sb-champs">' + champs + '</div></div>' +
      '<div class="sb-score">' + num(team.score) + '</div>' +
    '</div>';
  }
  function objectiveGroup(label, blue, red) {
    return '<span class="sb-obj"><i>' + label + '</i><b class="blue">' + num(blue) + '</b><em>:</em><b class="red">' + num(red) + '</b></span>';
  }
  function goldLine(state) {
    var blueGold = state.blue && state.blue.gold;
    var redGold = state.red && state.red.gold;
    var diff = '经济 —';
    if (blueGold !== null && blueGold !== undefined && redGold !== null && redGold !== undefined) {
      var b = Number(blueGold);
      var r = Number(redGold);
      if (Number.isFinite(b) && Number.isFinite(r)) {
        var value = b - r;
        diff = '经济差 ' + (value > 0 ? '+' : value < 0 ? '-' : '') + fmtGold(Math.abs(value));
      }
    }
    return '<div class="sb-gold"><span class="blue">' + fmtGold(blueGold) + '</span><i>' + diff + '</i><span class="red">' + fmtGold(redGold) + '</span></div>';
  }
  function timerCard(kind, state) {
    var info = timerState(kind, state);
    var label = kind === 'dragon' ? '小龙' : '大龙';
    var sub = kind === 'dragon' ? 'DRAGON' : 'BARON';
    var glyph = kind === 'dragon' ? '龙' : '爵';
    return '<div class="obj-timer ' + kind + (info.ready ? ' ready' : '') + '"><span class="obj-glyph">' + glyph + '</span><div class="obj-timer-text"><b>' + label + '</b><small>' + sub + '</small></div><em>' + info.text + '</em></div>';
  }
  function renderTop(state) {
    var blue = state.blue || {};
    var red = state.red || {};
    return '<div class="topbar">' + topSide(state, 'blue') +
      '<div class="sb-center"><div class="sb-clock">' + fmtTime(state.gameTime) + '</div>' +
        '<div class="sb-objectives">' + objectiveGroup('推塔', blue.towers, red.towers) + objectiveGroup('小龙', blue.dragons, red.dragons) + objectiveGroup('大龙', blue.barons, red.barons) + '</div>' +
        goldLine(state) +
      '</div>' + topSide(state, 'red') + '</div>' +
      '<div class="obj-timers">' + timerCard('dragon', state) + timerCard('baron', state) + '</div>';
  }

  function playerCard(player, index) {
    var dead = player.alive === false;
    var respawn = dead && num(player.respawnTimer) > 0 ? ' · 复活 ' + Math.round(num(player.respawnTimer)) + 's' : '';
    return '<div class="player ' + (player.team || '') + (dead ? ' dead' : '') + '">' +
      '<div class="player-head">' + icon('champion', player.champion, player.champion, 'player-champ') +
        '<div class="player-meta"><b>' + esc(player.name || '') + '</b><small>Lv ' + num(player.level) + respawn + '</small></div>' +
      '</div>' +
      '<div class="player-stats"><span class="player-kda">' + kda(player) + '</span><span class="player-cs">CS ' + num(player.cs) + '</span><span class="player-team-tag">' + (player.team === 'blue' ? 'BLUE' : 'RED') + '</span></div>' +
      '<div class="item-row">' + itemSlots(player, index) + '</div>' +
      '<div class="spell-row">' + spellSlots(player) + '</div>' +
    '</div>';
  }
  function renderBottom(state) {
    var players = allPlayers(state);
    var blue = state.blue || {};
    var red = state.red || {};
    return '<div class="bottombar"><div class="bb-head"><span class="bb-team blue">BLUE · ' + esc(blue.name || '') + '</span><span class="bb-note">10 人装备与 KDA</span><span class="bb-team red">' + esc(red.name || '') + ' · RED</span></div>' +
      '<div class="player-grid">' + players.map(playerCard).join('') + '</div></div>';
  }

  function pickCard(champion, index, side, player) {
    var name = player && player.name ? esc(player.name) : '—';
    return '<div class="bp-pick ' + side + '">' + splashLayer(champion, 'pick-splash') +
      '<span class="pick-order">' + String(index + 1).padStart(2, '0') + '</span>' +
      '<div class="pick-art">' + icon('champion', champion, champion, 'pick-ico') + '</div>' +
      '<div class="pick-info"><small>' + LANES[index % LANES.length] + '</small><b>' + esc(champion) + '</b><em>' + name + '</em></div>' +
      '<span class="pick-spells">' + spellSlots(player || {}) + '</span></div>';
  }
  function emptyPick(index, side) {
    return '<div class="bp-pick empty ' + side + '"><span class="pick-order">' + String(index + 1).padStart(2, '0') + '</span><div class="pick-art"><span class="icon pick-ico"><i class="icon-fb">?</i></span></div><div class="pick-info"><small>' + LANES[index % LANES.length] + '</small><b>—</b><em>待选</em></div><span class="pick-spells"><span class="spell-slot"><span class="icon spell-icon"><i class="icon-fb">·</i></span></span><span class="spell-slot"><span class="icon spell-icon"><i class="icon-fb">·</i></span></span></span></div>';
  }
  function banCard(champion) {
    return '<div class="bp-ban" title="' + esc(champion) + '">' + icon('champion', champion, champion, 'ban-ico') + '<span>' + esc(champion) + '</span></div>';
  }
  function emptyBan() {
    return '<div class="bp-ban empty"><span class="icon ban-ico"><i class="icon-fb">×</i></span><span>—</span></div>';
  }
  function draftFor(state) {
    // live 模式下只有 LCU 解析出真实 pick/ban 才展示；否则保持空 BP，不能露出 mock/上一局。
    if (state && state.mode === 'live') {
      var live = state.live && state.live.draft;
      if (!live || live.parsed !== true) return {};
    }
    return (state && state.draft) || {};
  }
  function bpTeam(state, side) {
    var team = state[side] || {};
    var draft = draftFor(state);
    var picks = (side === 'blue' ? draft.bluePicks : draft.redPicks) || [];
    var bans = (side === 'blue' ? draft.blueBans : draft.redBans) || [];
    var players = teamPlayers(state, side);
    var pickHtml = '';
    for (var i = 0; i < 5; i += 1) pickHtml += picks[i] ? pickCard(picks[i], i, side, players[i]) : emptyPick(i, side);
    var banHtml = '';
    for (var j = 0; j < 5; j += 1) banHtml += bans[j] ? banCard(bans[j]) : emptyBan();
    return '<section class="bp-team ' + side + '">' +
      '<div class="bp-team-head"><span class="bp-team-logo">' + esc(team.logo || (side === 'blue' ? 'B' : 'R')) + '</span><span class="bp-side-tag">' + (side === 'blue' ? 'BLUE SIDE' : 'RED SIDE') + '</span><b>' + esc(team.name || '') + '</b><small>' + (side === 'blue' ? 'FIRST PICK' : 'SECOND PICK') + '</small></div>' +
      '<div class="bp-picks">' + pickHtml + '</div>' +
      '<div class="bp-bans-head">BANS</div><div class="bp-bans">' + banHtml + '</div>' +
    '</section>';
  }
  function bpStage(state, side) {
    var team = state[side] || {};
    var draft = draftFor(state);
    var picks = (side === 'blue' ? draft.bluePicks : draft.redPicks) || [];
    var strips = picks.map(function (champion) { return splashLayer(champion, 'bp-stage-strip'); }).join('');
    return '<div class="bp-stage-side ' + side + '"><div class="bp-stage-art">' + strips + '</div><div class="bp-stage-info"><span>' + (side === 'blue' ? 'BLUE SIDE' : 'RED SIDE') + '</span><b>' + esc(team.name || '') + '</b><small>' + (side === 'blue' ? 'FIRST PICK' : 'SECOND PICK') + '</small></div></div>';
  }
  function renderBp(state) {
    var draft = draftFor(state);
    return '<div class="bp-card"><header class="bp-head"><div class="bp-brand"><span class="eyebrow">' + esc(state.tournamentName || 'Khada Jhin') + '</span><b>BP · ' + esc(draft.round || '') + '</b></div>' +
      '<div class="bp-meta"><span class="bp-phase">' + esc(draft.active === 'red' ? 'RED 方选人' : 'BLUE 方选人') + '</span><i class="bp-timer">' + num(draft.timer) + '</i></div></header>' +
      '<div class="bp-stage">' + bpStage(state, 'blue') + '<div class="bp-stage-core"><span class="eyebrow">' + esc(state.tournamentName || 'Khada Jhin') + '</span><b>BP</b><small>GAME 1 · PICK PHASE</small></div>' + bpStage(state, 'red') + '</div>' +
      '<div class="bp-teams">' + bpTeam(state, 'blue') + '<div class="bp-vs"><b>VS</b><small>GAME 1</small><em>PICK PHASE</em><small>PATCH ' + esc(state.patch || RB.version) + '</small></div>' + bpTeam(state, 'red') + '</div></div>';
  }

  function pgRow(player, team) {
    var pct = Math.round(damagePct(player, team) * 10) / 10;
    return '<div class="pg-row ' + (player.team || '') + '">' + icon('champion', player.champion, player.champion, 'pg-champ') +
      '<div class="pg-player"><b>' + esc(player.name || '') + '</b><small>' + esc(player.champion || '') + '</small></div>' +
      '<span class="pg-kda">' + kda(player) + '</span>' +
      '<span class="pg-cs">CS ' + num(player.cs) + '</span>' +
      '<div class="pg-damage"><span class="dmg-bar"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></span><b>' + pct.toFixed(1) + '%</b></div>' +
      '<span class="pg-kp">KP ' + Math.round(killParticipation(player, team)) + '%</span>' +
    '</div>';
  }
  function pgTeam(state, side, source) {
    var team = Object.assign({}, state[side] || {}, source && source[side] ? source[side] : {});
    var players = teamPlayers(state, side);
    return '<section class="pg-team ' + side + '">' +
      '<div class="pg-team-head"><span class="pg-team-logo">' + esc(team.logo || (side === 'blue' ? 'B' : 'R')) + '</span><b>' + esc(team.name || '') + '</b><span>' + (side === 'blue' ? 'BLUE SIDE' : 'RED SIDE') + '</span></div>' +
      '<div class="pg-cols"><span></span><span>选手</span><span>KDA</span><span>补刀</span><span>伤害占比</span><span>参团</span></div>' +
      players.map(function (p) { return pgRow(p, players); }).join('') +
    '</section>';
  }
  function renderPostgame(state) {
    var source = null;
    if (state && state.mode === 'live') {
      if (state.phase === 'post_game' && state.postGame && typeof state.postGame === 'object') source = state.postGame;
    } else {
      source = state;
    }
    if (!source) {
      return '<div class="postgame pg-empty" style="min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:#e8eef8;background:rgba(8,12,22,.92)">' +
        '<div style="font:700 42px/1.1 sans-serif;letter-spacing:.18em">DEMO</div>' +
        '<div style="font:600 24px/1.3 sans-serif">赛后数据不可用</div>' +
        '<div style="font:400 16px/1.5 sans-serif;opacity:.72">等待结算 / 等待 LCU 恢复</div></div>';
    }
    var blue = Object.assign({}, (state && state.blue) || {}, source.blue || {});
    var red = Object.assign({}, (state && state.red) || {}, source.red || {});
    var gameLength = source.gameLength !== undefined && source.gameLength !== null ? source.gameLength : source.gameTime;
    return '<div class="postgame"><header class="pg-head"><div class="bp-brand"><span class="eyebrow">' + esc(state.tournamentName || 'Khada Jhin') + '</span><b>FINAL · ' + fmtTime(gameLength) + '</b></div>' +
      '<div class="pg-objectives">推塔 ' + num(blue.towers) + ' · ' + num(red.towers) + '　小龙 ' + num(blue.dragons) + ' · ' + num(red.dragons) + '　大龙 ' + num(blue.barons) + ' · ' + num(red.barons) + '</div></header>' +
      '<div class="pg-score"><span class="pg-name blue">' + esc(blue.name || '') + '</span><b class="blue">' + num(blue.score) + '</b><em>:</em><b class="red">' + num(red.score) + '</b><span class="pg-name red">' + esc(red.name || '') + '</span></div>' +
      '<div class="pg-grid">' + pgTeam(state, 'blue', source) + pgTeam(state, 'red', source) + '</div></div>';
  }

  function render(state) {
    if (!state || !app) return;
    updateObjectives(state);
    if (TYPE === 'ingame-top') app.innerHTML = renderTop(state);
    else if (TYPE === 'ingame-bottom') app.innerHTML = renderBottom(state);
    else if (TYPE === 'bp') app.innerHTML = renderBp(state);
    else app.innerHTML = renderPostgame(state);
  }
  var es = new EventSource('/events');
  es.onmessage = function (event) {
    try {
      render(JSON.parse(event.data));
    } catch (error) {
      // 单帧脏数据不应打断直播，保留上一帧。
    }
  };
})();`;
}

function overlayPage(type) {
  const rootId = OVERLAY_ROOT_IDS[type] || 'app';
  const body = '<main id="' + rootId + '" class="overlay ' + type + '"><div class="loading">连接比赛数据…</div></main>';
  return htmlShell('Khada Jhin · ' + type, body, overlayScript(type, rootId));
}

module.exports = { OVERLAY_TYPES, OVERLAY_ROOT_IDS, overlayPage };
