'use strict';

// 控台页面：三栏导播台（赛事配置/数据源健康 · 比分+10 人 KDA/装备+事件流 · OBS/回放）。
// public/console.css 是本页面的样式源，通过内联 <style> 注入，避免改动 main.js 路由。
const fs = require('fs');
const path = require('path');
const { htmlShell } = require('./html');
const assets = require('../assets');

// 控台没有原生层可透（HUD 走挖孔，控台必须自绘），装备与英雄头像统一用 RBAssets 的 CDN 图标。

// 样式按 mtime 失效：dev 直跑时改 public/console.css 立刻生效（与 hud-broadcast 同策略）。
let consoleCssCache = null;
let consoleCssMtime = 0;
function consoleCss() {
  const file = path.join(__dirname, '..', '..', 'public', 'console.css');
  try {
    const stat = fs.statSync(file);
    if (consoleCssCache === null || stat.mtimeMs !== consoleCssMtime) {
      consoleCssCache = fs.readFileSync(file, 'utf8');
      consoleCssMtime = stat.mtimeMs;
    }
  } catch {
    if (consoleCssCache === null) consoleCssCache = '';
  }
  return consoleCssCache;
}

const CONSOLE_SCRIPT = String.raw`
'use strict';
var latestState = null;
var latestSources = null;
var latestReplay = null;
var latestDirector = null;
var directorDirty = false;
var broadcastConfigDraft = null;
var eventItems = [];
var seenTimeline = new Set();
var SEEN_TIMELINE_LIMIT = 500;
var sceneCache = '';
var autoCache = '';
var feedReady = false;
var toastTimer = null;

var PHASE_TEXT = { draft: '赛前 BP', in_game: '局内比赛', post_game: '赛后数据' };
var TYPE_LABEL = {
  kill: '击杀', first_blood: '一血', multikill: '多杀', ace: '团灭',
  tower: '防御塔', first_brick: '首塔', inhibitor: '水晶',
  dragon: '小龙', baron: '大龙', herald: '先锋', horde: '巢虫',
  game_start: '开始', game_end: '结束', minions: '小兵', phase: '阶段',
  draft: 'BP', system: '系统'
};
var CUE_LABELS = { 'bp-in': 'BP 入场', 'hud-in': '局内入场', 'result-in': '赛后庆祝', 'wipe': '转场', 'reset': '重置' };
var SHORTCUT_CUES = { '1': 'bp-in', '2': 'hud-in', '3': 'result-in', '4': 'wipe', 'Escape': 'reset' };
var DIRECTOR_CUES = ['bp-in', 'hud-in', 'result-in', 'wipe', 'reset'];
var ROLE_OPTIONS = [['TOP', '上单'], ['JUNGLE', '打野'], ['MID', '中单'], ['ADC', '下路'], ['SUPPORT', '辅助']];
var HL_IDS = { lcu: 'hlLcu', live: 'hlLive', obs: 'hlObs' };
var HL_LABELS = { lcu: 'LCU 客户端', live: 'Live Client Data', obs: 'OBS WebSocket' };
var lastRosterHtml = '';

function byId(id) { return document.getElementById(id); }
function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}
function fmtClock(value) {
  var total = Math.max(0, Math.floor(Number(value) || 0));
  var minutes = Math.floor(total / 60);
  var seconds = total % 60;
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}
function fmtNumber(value) {
  if (value === null || value === undefined || value === '') return '--';
  var number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return number.toLocaleString('zh-CN');
}
function fmtGold(value) {
  if (value === null || value === undefined || value === '') return '--';
  var number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return number >= 10000 ? (number / 1000).toFixed(1) + 'k' : String(Math.round(number));
}
function nowClock() {
  var date = new Date();
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
}
function phaseText(phase) { return PHASE_TEXT[phase] || '待机'; }
function eventGroup(type) {
  if (type === 'kill' || type === 'first_blood' || type === 'multikill' || type === 'ace') return 'kill';
  if (type === 'dragon' || type === 'baron' || type === 'herald' || type === 'horde') return 'objective';
  if (type === 'tower' || type === 'first_brick' || type === 'inhibitor') return 'tower';
  if (type === 'game_start' || type === 'game_end' || type === 'phase') return 'phase';
  if (type === 'draft') return 'draft';
  return 'system';
}
function toast(message, isError) {
  var el = byId('console-toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'console-toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = 'console-toast'; }, 3600);
}
function fetchJson(url, options) {
  return fetch(url, options || {}).then(function (response) {
    return response.text().then(function (text) {
      var data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (error) { data = { error: '响应不是有效 JSON' }; }
      if (!response.ok) throw new Error((data && data.error) || ('HTTP ' + response.status));
      return data;
    });
  });
}
function postJson(url, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  }).catch(function (error) {
    return { ok: false, error: error.message || String(error) };
  });
}

function pushEvent(type, text, side, gameTime) {
  eventItems.unshift({
    type: type,
    group: eventGroup(type),
    side: side || '',
    text: String(text || ''),
    clock: nowClock(),
    game: fmtClock(gameTime)
  });
  if (eventItems.length > 30) eventItems.length = 30;
  renderFeed();
}
function renderFeed() {
  var feed = byId('event-feed');
  if (!feed) return;
  if (!eventItems.length) {
    feed.innerHTML = '<div class="feed-empty">等待比赛事件…</div>';
  } else {
    feed.innerHTML = eventItems.map(function (item) {
      return '<article class="event-item type-' + esc(item.group) + (item.side === 'blue' || item.side === 'red' ? ' side-' + esc(item.side) : '') + '">' +
        '<div class="event-time"><b>' + esc(item.clock) + '</b><small>' + esc(item.game) + '</small></div>' +
        '<div class="event-copy"><span class="event-tag">' + esc(TYPE_LABEL[item.type] || '事件') + '</span>' +
        '<p>' + esc(item.text) + '</p></div></article>';
    }).join('');
  }
  var count = byId('feedCount');
  if (count) count.textContent = eventItems.length + ' / 30';
}
function processTimeline(state) {
  var timeline = state && Array.isArray(state.timeline) ? state.timeline : [];
  timeline.forEach(function (entry) {
    if (!entry || typeof entry !== 'object') return;
    var key = String(entry.time) + '|' + String(entry.type) + '|' + String(entry.text);
    if (seenTimeline.has(key)) return;
    seenTimeline.add(key);
    if (seenTimeline.size > SEEN_TIMELINE_LIMIT) {
      var oldest = seenTimeline.values().next().value;
      if (oldest !== undefined) seenTimeline.delete(oldest);
    }
    pushEvent(entry.type || 'system', entry.text || '', entry.side || '', entry.time);
  });
}
function deriveEvents(previous, current) {
  if (!previous || !current || previous.phase === undefined) return;
  if (previous.phase !== current.phase) {
    pushEvent('phase', '阶段切换：' + phaseText(previous.phase) + ' → ' + phaseText(current.phase), '', current.gameTime);
  }
  if (previous.mode !== current.mode) {
    pushEvent('system', '数据模式切换：' + String(previous.mode || 'mock') + ' → ' + String(current.mode || 'mock'), '', current.gameTime);
  }
  ['blue', 'red'].forEach(function (side) {
    var team = current[side] || {};
    var before = previous[side] || {};
    var scoreDiff = (Number(team.score) || 0) - (Number(before.score) || 0);
    if (scoreDiff > 0) {
      pushEvent('kill', String(team.name || (side === 'blue' ? '蓝方' : '红方')) + ' 取得 ' + scoreDiff + ' 次击杀 · 比分 ' +
        String(current.blue && current.blue.score !== undefined ? current.blue.score : 0) + ' : ' +
        String(current.red && current.red.score !== undefined ? current.red.score : 0), side, current.gameTime);
    }
    [['towers', '防御塔'], ['dragons', '小龙'], ['barons', '大龙'], ['heralds', '峡谷先锋']].forEach(function (pair) {
      var oldValue = Number(before[pair[0]]) || 0;
      var newValue = Number(team[pair[0]]) || 0;
      if (newValue > oldValue) {
        pushEvent('objective', String(team.name || (side === 'blue' ? '蓝方' : '红方')) + ' 拿下' + pair[1] + '（' + oldValue + ' → ' + newValue + '）', side, current.gameTime);
      }
    });
  });
  var oldDraft = previous.draft || {};
  var newDraft = current.draft || {};
  [['bluePicks', 'blue'], ['redPicks', 'red']].forEach(function (pair) {
    var before = Array.isArray(oldDraft[pair[0]]) ? oldDraft[pair[0]] : [];
    var after = Array.isArray(newDraft[pair[0]]) ? newDraft[pair[0]] : [];
    after.forEach(function (champion) {
      if (champion && before.indexOf(champion) === -1) {
        pushEvent('draft', (pair[1] === 'blue' ? '蓝方' : '红方') + ' 锁定 ' + champion, pair[1], current.gameTime);
      }
    });
  });
}

function setHealth(key, level, detail, tag) {
  var lightId = HL_IDS[key];
  if (lightId) {
    var light = byId(lightId);
    if (light) {
      light.className = 'topbar-health-item ' + level;
      light.title = (HL_LABELS[key] || key) + '：' + (detail || '--');
    }
  }
  if (typeof document.querySelector !== 'function') return;
  var row = document.querySelector('[data-health="' + key + '"]');
  if (!row) return;
  row.className = 'health-row ' + level;
  var detailEl = row.querySelector('small');
  var tagEl = row.querySelector('em');
  if (detailEl) detailEl.textContent = detail || '--';
  if (tagEl) tagEl.textContent = tag || '--';
}
function sourceResult(sources, name) {
  if (!sources || !Array.isArray(sources.results)) return null;
  for (var i = 0; i < sources.results.length; i += 1) {
    if (sources.results[i] && sources.results[i].source === name) return sources.results[i];
  }
  return null;
}
function renderHealth(state, sources) {
  state = state || {};
  var live = state.live || {};
  var lcuState = live.lcu || {};
  var gameState = live.game || {};
  var obs = state.obs || {};
  var replay = latestReplay || state.replay || {};
  var lcuProbe = sourceResult(sources, 'lcu');
  var liveProbe = sourceResult(sources, 'live_client');

  if (lcuProbe) {
    if (lcuProbe.ok) setHealth('lcu', 'ok', '已连接 · 阶段 ' + (lcuProbe.phase || '未知'), 'OK');
    else setHealth('lcu', 'idle', lcuProbe.reason === 'lockfile_not_found' ? '未发现客户端' : '无法连接：' + (lcuProbe.reason || '未知'), 'OFF');
  } else if (lcuState.connected) {
    setHealth('lcu', 'ok', '已连接 · 阶段 ' + (lcuState.phase || '未知'), 'OK');
  } else {
    setHealth('lcu', 'idle', '等待探测', '--');
  }

  if (liveProbe) {
    if (liveProbe.ok) setHealth('live', 'ok', '已连接 · 端口 ' + (liveProbe.port || 2999), 'OK');
    else if (state.phase === 'in_game' && state.mode === 'live') setHealth('live', 'warn', '游戏内但 :2999 未响应', 'WAIT');
    else setHealth('live', 'idle', '未检测到对局数据', 'OFF');
  } else if (gameState.connected || gameState.parsed) {
    setHealth('live', 'ok', '已连接 · ' + (gameState.players || 0) + ' 名玩家', 'OK');
  } else {
    setHealth('live', 'idle', '等待探测', '--');
  }

  if (obs.connected) setHealth('obs', 'ok', '已连接 · 场景 ' + (obs.currentScene || '未知'), 'OK');
  else if (obs.error) setHealth('obs', 'warn', '未连接：' + obs.error, 'WAIT');
  else setHealth('obs', 'idle', obs.configured ? '已配置但未连接' : '未配置', 'OFF');

  if (replay && replay.connected) setHealth('replay', 'ok', '回放 API 在线', 'OK');
  else if (replay && replay.error) setHealth('replay', 'idle', '未检测到回放', 'OFF');
  else setHealth('replay', 'idle', '未检测到回放', '--');

  var updated = byId('healthUpdated');
  if (updated) updated.textContent = '探测 ' + nowClock();
}

function renderHeader(state) {
  var tournament = byId('tournamentLabel');
  var clock = byId('gameClock');
  var phase = byId('phaseLabel');
  var mode = byId('topbarMode');
  if (tournament) tournament.textContent = state.tournamentName || 'Khada Jhin';
  if (clock) clock.textContent = fmtClock(state.gameTime);
  if (phase) phase.textContent = phaseText(state.phase);
  if (mode) {
    mode.textContent = String(state.mode || 'mock').toUpperCase();
    mode.className = 'topbar-mode ' + (state.mode === 'live' ? 'live' : 'mock');
  }
  var input = byId('tournament');
  if (input && document.activeElement !== input) input.value = state.tournamentName || '';
  var note = byId('phaseNote');
  if (note) note.textContent = state.mode === 'live' ? '实战数据 · LCU / Live Client 自动同步' : '模拟数据 · 每秒刷新，可直接用于 OBS 测试';
}

function statTile(label, html) {
  return '<div class="stat-tile"><small>' + esc(label) + '</small><div class="stat-pair">' + html + '</div></div>';
}
function pairStat(left, right) {
  return '<span class="blue">' + esc(fmtNumber(left)) + '</span><i>:</i><span class="red">' + esc(fmtNumber(right)) + '</span>';
}
function draftChips(list, side) {
  if (!Array.isArray(list) || !list.length) return '<span class="draft-empty">待选</span>';
  return list.map(function (name, index) {
    return '<span class="draft-chip ' + side + '"><i>' + String(index + 1).padStart(2, '0') + '</i>' + esc(name) + '</span>';
  }).join('');
}
function renderMatch(state) {
  var body = byId('matchBody');
  var badge = byId('phaseBadge');
  if (!body) return;
  if (!state) {
    body.innerHTML = '<div class="match-placeholder">正在连接本地数据链路…</div>';
    return;
  }
  var blue = state.blue || {};
  var red = state.red || {};
  var blueName = blue.name || '蓝方';
  var redName = red.name || '红方';
  if (badge) {
    badge.textContent = phaseText(state.phase);
    badge.className = 'phase-badge phase-' + esc(state.phase || 'idle');
  }
  var blueGold = blue.gold === null || blue.gold === undefined ? null : Number(blue.gold);
  var redGold = red.gold === null || red.gold === undefined ? null : Number(red.gold);
  var goldDiff = null;
  if (blueGold !== null && redGold !== null && Number.isFinite(blueGold) && Number.isFinite(redGold)) goldDiff = blueGold - redGold;
  var diffText = '--';
  if (goldDiff !== null) diffText = goldDiff >= 0 ? '+' + fmtGold(goldDiff) : '-' + fmtGold(Math.abs(goldDiff));

  var html = '<div class="scoreboard">' +
    '<div class="team-block blue"><span class="team-tag">BLUE</span><b>' + esc(blueName) + '</b><small>' + esc(blue.short || 'BLUE') + '</small></div>' +
    '<div class="score-core"><div class="score-line"><b class="blue">' + esc(fmtNumber(blue.score)) + '</b><i>:</i><b class="red">' + esc(fmtNumber(red.score)) + '</b></div><span class="match-clock">' + esc(fmtClock(state.gameTime)) + '</span></div>' +
    '<div class="team-block red"><span class="team-tag">RED</span><b>' + esc(redName) + '</b><small>' + esc(red.short || 'RED') + '</small></div>' +
    '</div>';
  html += '<div class="stat-strip">' +
    '<div class="stat-tile economy"><small>经济</small><div class="economy-line"><span class="blue">' + esc(fmtGold(blue.gold)) + '</span><em>' + esc(diffText) + '</em><span class="red">' + esc(fmtGold(red.gold)) + '</span></div></div>' +
    statTile('防御塔', pairStat(blue.towers, red.towers)) +
    statTile('小龙', pairStat(blue.dragons, red.dragons)) +
    statTile('大龙', pairStat(blue.barons, red.barons)) +
    statTile('峡谷先锋', pairStat(blue.heralds, red.heralds)) +
    '</div>';

  if (state.phase === 'draft') {
    var draft = state.draft || {};
    var activeText = draft.active === 'blue' ? '蓝方行动' : draft.active === 'red' ? '红方行动' : '等待选人';
    html += '<div class="draft-overview">' +
      '<div class="draft-team blue"><div class="draft-label"><span>蓝方阵容</span><b>' + (Array.isArray(draft.bluePicks) ? draft.bluePicks.length : 0) + '/5</b></div><div class="draft-chips">' + draftChips(draft.bluePicks, 'blue') + '</div><div class="draft-bans"><span>BAN</span>' + (Array.isArray(draft.blueBans) && draft.blueBans.length ? draft.blueBans.map(function (name) { return esc(name); }).join(' · ') : '—') + '</div></div>' +
      '<div class="draft-clock"><small>选人倒计时</small><b>' + (draft.timer === null || draft.timer === undefined ? '--' : esc(draft.timer)) + '</b><span>' + esc(activeText) + '</span><em>' + esc(draft.round || 'BP 阶段') + '</em></div>' +
      '<div class="draft-team red"><div class="draft-label"><span>红方阵容</span><b>' + (Array.isArray(draft.redPicks) ? draft.redPicks.length : 0) + '/5</b></div><div class="draft-chips">' + draftChips(draft.redPicks, 'red') + '</div><div class="draft-bans"><span>BAN</span>' + (Array.isArray(draft.redBans) && draft.redBans.length ? draft.redBans.map(function (name) { return esc(name); }).join(' · ') : '—') + '</div></div>' +
      '</div>';
  } else if (state.phase === 'post_game') {
    var blueScore = Number(blue.score) || 0;
    var redScore = Number(red.score) || 0;
    var winner = blueScore === redScore ? '双方战平' : (blueScore > redScore ? blueName : redName) + ' 获胜';
    html += '<div class="result-banner"><span>FINAL RESULT</span><b>' + esc(winner) + '</b><em>' + esc(fmtNumber(blue.score)) + ' : ' + esc(fmtNumber(red.score)) + '</em></div>';
  } else {
    html += '<div class="live-strip"><span class="live-indicator"><i></i>LIVE</span><span>比赛进行中</span><span class="live-note">' + esc(state.tournamentName || '') + '</span></div>';
  }
  body.innerHTML = html;
}

// 装备既可能是旧字符串，也可能是 t9 之后的 {itemID,count,slot,price,displayName} 对象。
function rbAssets() {
  return typeof window !== 'undefined' && window.RBAssets ? window.RBAssets : null;
}
// 英雄头像（BP 选人板 / 赛中名单共用）。
function champAvatar(name, cls, title) {
  var label = String(name === null || name === undefined ? '' : name).trim();
  if (!label) return '';
  var bag = rbAssets();
  var url = bag && bag.championIconUrl ? bag.championIconUrl(label) : '';
  var tip = title ? title : label;
  if (!url) return '<i class="' + cls + ' none" title="' + esc(tip) + '"></i>';
  return '<i class="' + cls + '" title="' + esc(tip) + '"><img src="' + esc(url) + '" alt="' + esc(label) + '" loading="lazy" onerror="this.parentNode.classList.add(\'none\')"></i>';
}
function itemIconInfo(item) {
  if (item === null || item === undefined || item === '') return null;
  var bag = rbAssets();
  var url = bag && bag.itemIconUrl ? bag.itemIconUrl(item) : '';
  var title = '';
  var count = 1;
  if (typeof item === 'object') {
    title = String(item.displayName || item.name || (item.itemID !== undefined ? item.itemID : (item.itemId !== undefined ? item.itemId : item.id)) || '');
    count = Math.floor(Number(item.count) || 1);
  } else {
    title = String(item).replace(/^#/, '');
  }
  if (count > 1) title += ' ×' + count;
  // 图标取不到也保留名称：离线时槽位仍要有 tooltip，而不是一片空白。
  return { url: url || '', title: title };
}
// 6 件装备 + 1 个饰品位，图标固定 7 格，空位留槽不塌。
function rosterItemChips(items) {
  var list = Array.isArray(items) ? items : [];
  var out = '';
  var i;
  for (i = 0; i < 6; i += 1) {
    var icon = itemIconInfo(list[i]);
    out += icon && icon.url
      ? '<span class="roster-item" title="' + esc(icon.title) + '"><img src="' + esc(icon.url) + '" alt="" loading="lazy"></span>'
      : '<span class="roster-item none"' + (icon && icon.title ? ' title="' + esc(icon.title) + '"' : '') + '></span>';
  }
  var trinket = itemIconInfo(list[6]);
  out += trinket && trinket.url
    ? '<span class="roster-item trinket" title="' + esc(trinket.title) + '"><img src="' + esc(trinket.url) + '" alt="" loading="lazy"></span>'
    : '<span class="roster-item trinket none"' + (trinket && trinket.title ? ' title="' + esc(trinket.title) + '"' : '') + '></span>';
  return out;
}
function rosterRow(player, index) {
  if (!player) {
    return '<div class="roster-row waiting"><span class="roster-name"><b>等待选手 ' + (index + 1) + '</b><small>暂无数据</small></span>' +
      '<span class="roster-kda">--</span><span class="roster-cs">--</span><span class="roster-items"><span class="roster-item none">—</span></span></div>';
  }
  var champion = String(player.champion || player.name || '选手 ' + (index + 1));
  var summoner = String(player.name || '--');
  var level = player.level === null || player.level === undefined ? '' : 'Lv' + esc(fmtNumber(player.level));
  var kda = esc(fmtNumber(player.kills)) + '/' + esc(fmtNumber(player.deaths)) + '/' + esc(fmtNumber(player.assists));
  var dead = player.alive === false;
  var respawn = dead && Number(player.respawnTimer) > 0 ? ' · 复活 ' + Math.ceil(Number(player.respawnTimer)) + 's' : '';
  var sub = esc(summoner) + (level ? ' · ' + level : '') + respawn;
  return '<div class="roster-row' + (dead ? ' dead' : '') + '">' +
    '<span class="roster-name">' + champAvatar(champion, 'roster-champ') + '<span class="roster-who"><b>' + esc(champion) + '</b><small>' + sub + '</small></span></span>' +
    '<span class="roster-kda" title="K / D / A">' + kda + '</span>' +
    '<span class="roster-cs" title="补刀">' + esc(fmtNumber(player.cs)) + '</span>' +
    '<span class="roster-items">' + rosterItemChips(player.items) + '</span>' +
    '</div>';
}
function rosterSide(list, side, label) {
  var rows = '';
  for (var i = 0; i < 5; i += 1) rows += rosterRow(list[i] || null, i);
  return '<div class="roster-side ' + side + '">' +
    '<div class="roster-side-head"><span>' + esc(label) + '</span><b>' + list.length + ' / 5</b></div>' +
    rows + '</div>';
}
function renderRoster(state) {
  var body = byId('rosterBody');
  var count = byId('rosterCount');
  if (!body) return;
  var players = state && Array.isArray(state.players) ? state.players : [];
  var blue = players.filter(function (p) { return p && (p.team === 'blue' || String(p.team).toUpperCase() === 'ORDER'); }).slice(0, 5);
  var red = players.filter(function (p) { return p && (p.team === 'red' || String(p.team).toUpperCase() === 'CHAOS'); }).slice(0, 5);
  if (!blue.length && !red.length && players.length) {
    blue = players.slice(0, 5);
    red = players.slice(5, 10);
  }
  if (count) count.textContent = Math.min(blue.length + red.length, 10) + ' / 10';
  var markup;
  if (!players.length) {
    markup = '<div class="roster-empty">' + (state && state.mode === 'live' ? '实战模式：等待 Live Client Data 推送 10 名选手…' : '等待选手数据…') + '</div>';
  } else {
    var blueName = state && state.blue && state.blue.name ? state.blue.name : '蓝方';
    var redName = state && state.red && state.red.name ? state.red.name : '红方';
    markup = rosterSide(blue, 'blue', blueName + ' · BLUE') + rosterSide(red, 'red', redName + ' · RED');
  }
  if (lastRosterHtml !== markup) {
    body.innerHTML = markup;
    lastRosterHtml = markup;
  }
}
function renderPhaseButtons(state) {
  document.querySelectorAll('#phase-switch [data-phase]').forEach(function (button) {
    button.classList.toggle('active', button.getAttribute('data-phase') === state.phase);
  });
  document.querySelectorAll('#mode-switch [data-mode]').forEach(function (button) {
    button.classList.toggle('active', button.getAttribute('data-mode') === state.mode);
  });
}

function renderSceneButtons(scenes, current) {
  var box = byId('obsScenes');
  if (!box) return;
  if (!scenes.length) { box.innerHTML = '<span class="empty">暂无场景</span>'; return; }
  box.innerHTML = scenes.map(function (name) {
    return '<button type="button" class="scene-button' + (name === current ? ' active' : '') + '" data-scene="' + esc(name) + '">' + esc(name) + '</button>';
  }).join('');
  box.querySelectorAll('[data-scene]').forEach(function (button) {
    button.addEventListener('click', function () { switchScene(button.getAttribute('data-scene')); });
  });
}
function renderSceneShortcuts(scenes, current) {
  var box = byId('scene-shortcuts');
  if (!box) return;
  if (!scenes.length) { box.innerHTML = '<span class="empty">连接 OBS 后显示场景</span>'; return; }
  box.innerHTML = scenes.slice(0, 8).map(function (name) {
    return '<button type="button" class="scene-shortcut' + (name === current ? ' active' : '') + '" data-scene-shortcut="' + esc(name) + '">' + esc(name) + '</button>';
  }).join('');
  box.querySelectorAll('[data-scene-shortcut]').forEach(function (button) {
    button.addEventListener('click', function () { switchScene(button.getAttribute('data-scene-shortcut')); });
  });
}
function switchScene(name) {
  postJson('/api/obs/scene', { sceneName: name }).then(function (data) {
    if (data.ok) {
      toast('已切换 OBS 场景：' + name);
      if (latestState && data.obs) latestState.obs = data.obs;
      if (latestState) renderObs(latestState);
    } else {
      toast('场景切换失败：' + data.error, true);
    }
  });
}
function renderAutoSwitch(auto, scenes) {
  var box = document.querySelector('.obs-auto');
  if (!box) return;
  auto = auto || {};
  var key = scenes.join('|') + '::' + [auto.draft, auto.in_game, auto.post_game, auto.mvp].join('|');
  if (key === autoCache) return;
  autoCache = key;
  if (!scenes.length) { box.innerHTML = '<span class="empty">连接 OBS 后可配置自动切换</span>'; return; }
  var option = function (phase, label) {
    var selected = auto[phase] || '';
    return '<label class="auto-row"><span>' + esc(label) + '</span><select data-auto="' + esc(phase) + '"><option value="">不自动切</option>' +
      scenes.map(function (name) { return '<option value="' + esc(name) + '"' + (selected === name ? ' selected' : '') + '>' + esc(name) + '</option>'; }).join('') +
      '</select></label>';
  };
  box.innerHTML = option('draft', 'BP 阶段') + option('in_game', '局内') + option('post_game', '赛后') + option('mvp', 'MVP 时刻');
  box.querySelectorAll('[data-auto]').forEach(function (select) {
    select.addEventListener('change', function () {
      var body = {};
      box.querySelectorAll('[data-auto]').forEach(function (item) { body[item.getAttribute('data-auto')] = item.value; });
      postJson('/api/obs/autoswitch', body).then(function (data) {
        if (data.ok) {
          toast('自动切换已更新');
          if (latestState) latestState.autoSwitch = data.autoSwitch || body;
        } else {
          toast('自动切换保存失败：' + data.error, true);
        }
      });
    });
  });
}
function renderObs(state) {
  state = state || {};
  var obs = state.obs || {};
  var status = byId('obsStatus');
  var badge = byId('obsBadge');
  var current = byId('obsCurrent');
  var recording = byId('obsRecording');
  if (status) status.textContent = obs.connected ? ('已连接 ' + (obs.url || '') + ' · 当前场景 ' + (obs.currentScene || '-')) : (obs.error ? '未连接：' + obs.error : '未连接');
  if (badge) { badge.textContent = obs.connected ? '在线' : '未连接'; badge.className = 'status-badge ' + (obs.connected ? 'online' : 'offline'); }
  if (current) current.textContent = obs.currentScene || '--';
  var stream = byId('obsStream');
  var replay = byId('obsReplay');
  var record = obs.record;
  var streamStatus = obs.stream;
  var replayStatus = obs.replayBuffer;
  if (recording) {
    if (!obs.connected) recording.textContent = '未接入';
    else if (record === null || record === undefined) recording.textContent = '查询中…';
    else recording.textContent = record.active ? '录制中 ' + (record.timecode || '') : '未录制';
  }
  if (stream) {
    if (!obs.connected) stream.textContent = '--';
    else if (streamStatus === null || streamStatus === undefined) stream.textContent = '查询中…';
    else stream.textContent = streamStatus.active ? '推流中 ' + (streamStatus.timecode || '') : '未推流';
  }
  if (replay) {
    if (!obs.connected) replay.textContent = '--';
    else if (replayStatus === null || replayStatus === undefined) replay.textContent = '查询中…';
    else replay.textContent = replayStatus.active ? '缓冲中' : '待命';
  }
  var scenes = Array.isArray(obs.scenes) ? obs.scenes : [];
  var sceneKey = scenes.join('|') + '::' + (obs.currentScene || '');
  if (sceneKey !== sceneCache) {
    sceneCache = sceneKey;
    renderSceneButtons(scenes, obs.currentScene);
    renderSceneShortcuts(scenes, obs.currentScene);
  } else {
    document.querySelectorAll('#obsScenes [data-scene], #scene-shortcuts [data-scene-shortcut]').forEach(function (button) {
      var name = button.getAttribute('data-scene') || button.getAttribute('data-scene-shortcut');
      button.classList.toggle('active', name === obs.currentScene);
    });
  }
  renderAutoSwitch(state.autoSwitch || {}, scenes);
}

function renderReplay() {
  var replay = latestReplay || {};
  var badge = byId('replayBadge');
  var status = byId('replayStatus');
  var details = byId('replayDetails');
  if (badge) { badge.textContent = replay.connected ? '在线' : '未连接'; badge.className = 'status-badge ' + (replay.connected ? 'online' : 'offline'); }
  if (!replay.connected) {
    if (status) status.textContent = replay.error ? '未检测到回放：' + replay.error : '未检测到回放';
    if (details) details.innerHTML = '<div class="detail-row"><span>播放位置</span><b>--</b></div><div class="detail-row"><span>镜头 FOV</span><b>--</b></div>';
    return;
  }
  var playback = replay.playback || {};
  var render = replay.render || {};
  if (status) status.textContent = '回放 API 在线 · ' + (playback.paused ? '已暂停' : '播放中') + ' · 速度 ' + (playback.speed !== undefined ? playback.speed : '--') + '×';
  if (details) details.innerHTML =
    '<div class="detail-row"><span>播放位置</span><b>' + esc(playback.time !== undefined ? playback.time + ' s' : '--') + '</b></div>' +
    '<div class="detail-row"><span>镜头 FOV</span><b>' + esc(render.fieldOfView !== undefined ? render.fieldOfView + '°' : '--') + '</b></div>';
}
function loadReplay() {
  fetchJson('/api/replay').then(function (data) {
    latestReplay = data;
  }).catch(function (error) {
    latestReplay = { connected: false, error: error.message || String(error) };
  }).then(function () {
    renderReplay();
    renderHealth(latestState, latestSources);
  });
}
function postReplay(path, body, label) {
  postJson(path, body).then(function (data) {
    if (data.ok) { toast(label + '已发送'); setTimeout(loadReplay, 400); }
    else toast(label + '失败：' + data.error, true);
  });
}
function obsCommand(path, body, label) {
  postJson(path, body).then(function (data) {
    if (data.ok) {
      toast(label + '已执行');
      setTimeout(loadObs, 300);
    } else {
      toast(label + '失败：' + data.error, true);
    }
  });
}
function loadObs() {
  fetchJson('/api/obs').then(function (snapshot) {
    if (!latestState) latestState = {};
    latestState.obs = snapshot;
    renderObs(latestState);
    renderHealth(latestState, latestSources);
  }).catch(function () {});
}

function refreshSources(force) {
  fetchJson(force ? '/api/sources?refresh=1' : '/api/sources').then(function (data) {
    latestSources = data;
    renderHealth(latestState || (data && data.live ? { live: data.live } : null), latestSources);
  }).catch(function (error) {
    latestSources = { error: error.message || String(error), results: [] };
    renderHealth(latestState, latestSources);
  });
}

function applyState(state) {
  var previous = latestState;
  latestState = state;
  renderHeader(state);
  renderMatch(state);
  renderRoster(state);
  renderPhaseButtons(state);
  renderCue(state);
  renderDirectorFromState(state);
  renderObs(state);
  renderMvpPanel(state);
  processTimeline(state);
  deriveEvents(previous, state);
  if (!feedReady) {
    feedReady = true;
    pushEvent('system', '控台已连接 · ' + (state.mode === 'mock' ? '模拟' : '实战') + '数据链路', '', state.gameTime);
  }
  renderHealth(state, latestSources);
  var raw = byId('state');
  if (raw) {
    raw.textContent = JSON.stringify({
      mode: state.mode, phase: state.phase, gameTime: state.gameTime,
      blue: state.blue, red: state.red,
      obs: state.obs ? { connected: state.obs.connected, scene: state.obs.currentScene } : null,
      updatedAt: state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : '--'
    }, null, 2);
  }
}

function setConnection(online) {
  var el = byId('connectionState');
  if (!el) return;
  el.className = 'conn-pill ' + (online ? 'online' : 'offline');
  el.innerHTML = '<i></i>' + (online ? 'SSE 在线' : 'SSE 重连中');
}
function buildUrls() {
  var pages = [['BP 页面', 'bp'], ['顶部比分条', 'ingame-top'], ['底部选手条', 'ingame-bottom'], ['赛后数据页', 'postgame']];
  var base = location.origin;
  var box = byId('urls');
  if (!box) return;
  box.innerHTML = pages.map(function (pair) {
    var url = base + '/overlay/' + pair[1];
    return '<div class="url-row"><span>' + esc(pair[0]) + '</span><code title="' + esc(url) + '">' + esc(url) + '</code><button type="button" data-copy="' + esc(url) + '">复制</button></div>';
  }).join('');
  box.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () { copyText(button.getAttribute('data-copy')); });
  });
}
function buildBroadcastUrls() {
  var pages = [
    ['BP 广播页', '/broadcast/bp', '赛前 BP 选人画面'],
    ['局内 HUD', '/broadcast/hud', '局内比分条 + 选手数据'],
    ['赛后庆典', '/broadcast/result', '赛后数据结算'],
    ['MVP 时刻', '/broadcast/mvp', '赛后 MVP 展示'],
    ['聚合舞台页（单场景）', '/broadcast/stage', '一个 URL 全流程自动切换，OBS 只需添加这一个']
  ];
  var base = location.origin;
  var box = byId('broadcast-urls');
  if (!box) return;
  box.innerHTML = pages.map(function (pair) {
    var url = base + pair[1];
    return '<div class="url-row broadcast-url-row"><div class="url-name"><span>' + esc(pair[0]) + '</span><small>' + esc(pair[2] || '') + '</small></div>' +
      '<code title="' + esc(url) + '">' + esc(url) + '</code>' +
      '<button type="button" data-copy="' + esc(url) + '">复制</button>' +
      '<button type="button" data-preview="' + esc(url) + '">预览</button></div>';
  }).join('');
  box.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () { copyText(button.getAttribute('data-copy')); });
  });
  box.querySelectorAll('[data-preview]').forEach(function (button) {
    button.addEventListener('click', function () {
      var url = button.getAttribute('data-preview');
      try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (error) { toast('无法打开预览：' + error.message, true); }
    });
  });
}
var mvpPick = { name: '', team: '' };
function renderMvpPanel(state) {
  var box = byId('mvp-candidates');
  if (!box) return;
  var pg = state && state.postGame;
  var pool = pg && Array.isArray(pg.players) && pg.players.length
    ? pg.players
    : (state && Array.isArray(state.players) ? state.players : []);
  var current = state && state.mvp && state.mvp.name ? state.mvp : null;
  if (!pool.length) {
    box.innerHTML = '<span class="empty">等待局内/赛后选手数据</span>';
  } else {
    box.innerHTML = pool.slice(0, 10).map(function (p, index) {
      var team = p.team === 'red' ? 'red' : 'blue';
      var name = String(p.name || ('选手 ' + (index + 1)));
      var isCurrent = current && String(current.name) === name && String(current.team || 'blue') === team;
      var isPicked = mvpPick.name === name && mvpPick.team === team;
      return '<button type="button" class="mvp-candidate team-' + team + (isPicked ? ' picked' : '') + (isCurrent ? ' current' : '') + '"' +
        ' data-name="' + esc(name) + '" data-team="' + team + '">' +
        '<b>' + esc(name) + '</b>' +
        '<small>' + esc(p.champion || '') + '</small>' +
        (isCurrent ? '<em>MVP</em>' : '') +
        '</button>';
    }).join('');
    box.querySelectorAll('.mvp-candidate').forEach(function (button) {
      button.addEventListener('click', function () {
        mvpPick = { name: button.getAttribute('data-name') || '', team: button.getAttribute('data-team') || 'blue' };
        renderMvpPanel(latestState);
      });
    });
  }
  var note = byId('mvp-note');
  if (note) note.textContent = current ? ('当前 MVP：' + current.name) : '未评选';
  var send = byId('mvp-send');
  if (send) send.disabled = !mvpPick.name;
}
function renderCue(state) {
  var cue = state && state.broadcastCue ? state.broadcastCue : null;
  var type = byId('cueType');
  var seq = byId('cueSeq');
  if (!type || !seq) return;
  if (!cue || !cue.type) {
    type.textContent = '待机';
    seq.textContent = 'SEQ --';
    return;
  }
  type.textContent = CUE_LABELS[cue.type] || String(cue.type);
  seq.textContent = 'SEQ ' + (cue.seq === null || cue.seq === undefined ? '--' : cue.seq);
}
function cueCommand(type, button) {
  var label = CUE_LABELS[type] || type;
  if (button) button.disabled = true;
  postJson('/api/broadcast/cue', { type: type }).then(function (data) {
    if (button) button.disabled = false;
    if (data && data.ok) {
      toast('广播已触发：' + label + (data.cue && data.cue.seq !== undefined ? ' · SEQ ' + data.cue.seq : ''));
      if (data.cue) {
        if (!latestState) latestState = {};
        latestState.broadcastCue = data.cue;
        renderCue(latestState);
      }
    } else {
      toast('广播触发失败：' + ((data && data.error) || '未知错误'), true);
    }
  }).catch(function (error) {
    if (button) button.disabled = false;
    toast('广播触发失败：' + (error.message || String(error)), true);
  });
}

function directorSnapshot(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.director && typeof data.director === 'object') return data.director;
  if (data.rules && typeof data.rules === 'object') return data.rules;
  return data;
}
function clockFromTimestamp(value) {
  var number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  var date = new Date(number);
  if (isNaN(date.getTime())) return '';
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
}
function directorTriggerText(trigger) {
  if (!trigger || typeof trigger !== 'object') return '暂无触发';
  var parts = [];
  var cue = CUE_LABELS[trigger.cue] || trigger.cue || '未知 CUE';
  if (trigger.reason === 'phase') {
    var phase = trigger.phase || (trigger.payload && trigger.payload.phase);
    parts.push('阶段 ' + phaseText(phase));
  } else {
    if (trigger.type) parts.push(TYPE_LABEL[trigger.type] || String(trigger.type));
    if (trigger.score !== undefined && trigger.score !== null && Number.isFinite(Number(trigger.score))) {
      parts.push(Number(trigger.score) + ' 分');
    }
  }
  parts.push(cue);
  var at = clockFromTimestamp(trigger.at);
  if (at) parts.push(at);
  return parts.join(' · ');
}
function fillDirectorForm(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  var enabled = byId('directorEnabled');
  if (enabled) enabled.checked = snapshot.enabled !== false;
  var threshold = Number(snapshot.threshold);
  if (!Number.isFinite(threshold)) threshold = 50;
  var thresholdInput = byId('directorThreshold');
  if (thresholdInput) thresholdInput.value = String(Math.round(threshold));
  var thresholdRange = byId('directorThresholdRange');
  if (thresholdRange) thresholdRange.value = String(Math.min(100, Math.max(0, Math.round(threshold))));
  var cue = byId('directorCue');
  if (cue) cue.value = DIRECTOR_CUES.indexOf(snapshot.cue) >= 0 ? snapshot.cue : 'hud-in';
  var cooldown = Number(snapshot.cooldownMs);
  if (!Number.isFinite(cooldown)) cooldown = 15000;
  var cooldownInput = byId('directorCooldown');
  if (cooldownInput) cooldownInput.value = String(Math.round(cooldown / 100) / 10);
  var phaseCues = snapshot.phaseCues && typeof snapshot.phaseCues === 'object' ? snapshot.phaseCues : {};
  var draftCue = byId('directorDraftCue');
  if (draftCue) draftCue.value = DIRECTOR_CUES.indexOf(phaseCues.draft) >= 0 ? phaseCues.draft : 'bp-in';
  var postCue = byId('directorPostCue');
  if (postCue) postCue.value = DIRECTOR_CUES.indexOf(phaseCues.post_game) >= 0 ? phaseCues.post_game : 'result-in';
  directorDirty = false;
}
function renderDirectorStatus(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  latestDirector = snapshot;
  var enabled = snapshot.enabled !== false;
  var badge = byId('directorBadge');
  if (badge) {
    badge.textContent = enabled ? '已启用' : '已停用';
    badge.className = 'status-badge director-badge ' + (enabled ? 'online' : 'offline');
  }
  var panel = byId('director-panel');
  if (panel) panel.classList.toggle('director-disabled', !enabled);
  var last = byId('directorLastTrigger');
  if (last) last.textContent = directorTriggerText(snapshot.lastTrigger);
  var remaining = Number(snapshot.cooldownRemaining);
  var cooldown = byId('directorCooldownRemaining');
  if (cooldown) {
    if (Number.isFinite(remaining) && remaining > 0) {
      cooldown.textContent = (Math.ceil(remaining / 100) / 10).toFixed(1) + ' 秒';
      cooldown.className = 'director-cooldown cooling';
    } else {
      cooldown.textContent = '就绪';
      cooldown.className = 'director-cooldown ready';
    }
  }
}
function applyDirectorSnapshot(data, fillForm) {
  var snapshot = directorSnapshot(data);
  if (!snapshot) return;
  if (fillForm) fillDirectorForm(snapshot);
  renderDirectorStatus(snapshot);
}
function renderDirectorFromState(state) {
  var snapshot = state && state.director;
  if (!snapshot) return;
  applyDirectorSnapshot(snapshot, !directorDirty);
}
function loadDirectorRules() {
  var status = byId('directorStatus');
  fetchJson('/api/director/rules').then(function (data) {
    if (!data || data.ok === false) throw new Error((data && data.error) || '读取失败');
    applyDirectorSnapshot(data, true);
    if (status) status.textContent = '已读取 · ' + nowClock() + ' · 规则修改后立即生效';
  }).catch(function (error) {
    if (status) status.textContent = '读取失败：' + (error.message || String(error));
  });
}
function readDirectorRules() {
  var threshold = Number(readFieldValue('directorThreshold'));
  var cooldownSeconds = Number(readFieldValue('directorCooldown'));
  var cue = readFieldValue('directorCue');
  var draftCue = readFieldValue('directorDraftCue');
  var postCue = readFieldValue('directorPostCue');
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100000) return { error: '阈值需在 0 - 100000 之间' };
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 86400) return { error: '冷却需在 0 - 86400 秒之间' };
  if (DIRECTOR_CUES.indexOf(cue) < 0) return { error: '触发 CUE 无效' };
  if (DIRECTOR_CUES.indexOf(draftCue) < 0) return { error: 'BP 阶段 CUE 无效' };
  if (DIRECTOR_CUES.indexOf(postCue) < 0) return { error: '赛后阶段 CUE 无效' };
  var enabled = byId('directorEnabled');
  return {
    rules: {
      enabled: !!(enabled && enabled.checked),
      threshold: Math.round(threshold),
      cue: cue,
      cooldownMs: Math.round(cooldownSeconds * 1000),
      phaseCues: { draft: draftCue, post_game: postCue }
    }
  };
}
function saveDirectorRules() {
  var status = byId('directorStatus');
  var result = readDirectorRules();
  if (result.error) {
    if (status) status.textContent = '保存失败：' + result.error;
    toast('自动导播规则保存失败：' + result.error, true);
    return;
  }
  var button = byId('directorSave');
  if (button) button.disabled = true;
  postJson('/api/director/rules', { rules: result.rules }).then(function (data) {
    if (button) button.disabled = false;
    if (data && data.ok) {
      applyDirectorSnapshot(data, true);
      if (status) status.textContent = '已保存 · ' + nowClock() + ' · 规则已生效';
      toast('自动导播规则已保存');
    } else {
      var message = (data && data.error) || '未知错误';
      if (status) status.textContent = '保存失败：' + message;
      toast('自动导播规则保存失败：' + message, true);
    }
  });
}
function bindDirectorPanel() {
  var panel = byId('director-panel');
  if (!panel || panel.getAttribute('data-bound') === '1') return;
  panel.setAttribute('data-bound', '1');
  panel.addEventListener('input', function (event) {
    directorDirty = true;
    var target = event.target;
    if (target && target.id === 'directorThresholdRange') {
      var numberInput = byId('directorThreshold');
      if (numberInput) numberInput.value = target.value;
    } else if (target && target.id === 'directorThreshold') {
      var rangeInput = byId('directorThresholdRange');
      if (rangeInput) rangeInput.value = String(Math.min(100, Math.max(0, Number(target.value) || 0)));
    }
  });
  panel.addEventListener('change', function () { directorDirty = true; });
  var reload = byId('directorReload');
  if (reload) reload.addEventListener('click', loadDirectorRules);
  var save = byId('directorSave');
  if (save) save.addEventListener('click', saveDirectorRules);
}

function cloneConfig(value) {
  try { return JSON.parse(JSON.stringify(value && typeof value === 'object' ? value : {})); } catch (error) { return {}; }
}
function setFieldValue(id, value) {
  var field = byId(id);
  if (field) field.value = value === null || value === undefined ? '' : String(value);
}
function readFieldValue(id) {
  var field = byId(id);
  return field ? String(field.value || '').trim() : '';
}
function readFieldNumber(id, fallback) {
  var number = Number(readFieldValue(id));
  return Number.isFinite(number) ? number : fallback;
}
function optionMarkup(options, selected) {
  return options.map(function (pair) {
    return '<option value="' + esc(pair[0]) + '"' + (String(selected) === String(pair[0]) ? ' selected' : '') + '>' + esc(pair[1]) + '</option>';
  }).join('');
}
function configField(label, id, value, type, className) {
  return '<label class="config-field' + (className ? ' ' + className : '') + '"><span>' + esc(label) + '</span>' +
    '<input id="' + id + '" type="' + (type || 'text') + '"' + (type === 'number' ? ' step="0.1"' : '') + ' value="' + esc(value) + '"></label>';
}
function configSelect(label, id, value, options) {
  return '<label class="config-field"><span>' + esc(label) + '</span><select id="' + id + '">' + optionMarkup(options, value) + '</select></label>';
}
function sponsorRowMarkup(sponsor) {
  var item = sponsor || {};
  var slots = [['top', '顶部'], ['bottom', '底部'], ['center', '中部']];
  return '<div class="sponsor-row" data-sponsor-row>' +
    '<input class="sponsor-name" value="' + esc(item.name || '') + '" placeholder="赞助商名称">' +
    '<select class="sponsor-slot">' + optionMarkup(slots, item.slot || 'bottom') + '</select>' +
    '<button type="button" class="icon-btn" data-sponsor-remove title="删除赞助商">×</button>' +
  '</div>';
}
function playerRowMarkup(player, index) {
  var item = player || {};
  return '<div class="player-editor-row" data-player-row>' +
    '<span class="player-index">' + String(index + 1).padStart(2, '0') + '</span>' +
    '<input class="player-display" value="' + esc(item.displayName || item.gameName || '') + '" placeholder="选手 ID">' +
    '<select class="player-team">' + optionMarkup([['blue', 'BLUE 蓝'], ['red', 'RED 红']], item.team || '') + '</select>' +
    '<select class="player-role">' + optionMarkup(ROLE_OPTIONS, item.role || '') + '</select>' +
  '</div>';
}
function coachFor(config, team) {
  var list = config && Array.isArray(config.coaches) ? config.coaches : [];
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].team === team) return list[i];
  }
  return {};
}
function renderSponsorRows(sponsors) {
  var box = byId('sponsorEditors');
  if (!box) return;
  var list = Array.isArray(sponsors) && sponsors.length ? sponsors : [{ name: '', slot: 'bottom' }];
  box.innerHTML = list.map(sponsorRowMarkup).join('');
}
function renderPlayerRows(players) {
  var box = byId('playerEditors');
  if (!box) return;
  var list = Array.isArray(players) ? players.slice(0, 10) : [];
  while (list.length < 10) list.push({ displayName: '', team: list.length < 5 ? 'blue' : 'red', role: '' });
  box.innerHTML = list.map(playerRowMarkup).join('');
}
function setLogoPreview(imgId, logo) {
  var img = byId(imgId); if (!img) return;
  if (logo) { img.src = logo; img.style.display = ''; } else { img.removeAttribute('src'); img.style.display = 'none'; }
}
function uploadLogoFile(input, targetId, previewId) {
  var file = input && input.files && input.files[0];
  var field = byId(targetId);
  if (!file || !field) return;
  var status = byId('broadcastConfigStatus');
  var reader = new FileReader();
  reader.onload = function () {
    postJson('/api/uploads/logo', { name: file.name, data: String(reader.result || '') }).then(function (data) {
      if (!data || !data.ok || !data.path) throw new Error((data && data.error) || 'upload_failed');
      field.value = data.path;
      setLogoPreview(previewId, data.path);
      if (status) status.textContent = '队标已上传：' + data.path;
    }).catch(function (error) {
      if (status) status.textContent = '队标上传失败：' + ((error && error.message) || error);
    });
  };
  reader.onerror = function () { if (status) status.textContent = '队标读取失败'; };
  reader.readAsDataURL(file);
  input.value = '';
}
function switchConfigTab(name) {
  document.querySelectorAll('#broadcastConfigForm [data-config-tab]').forEach(function (button) {
    button.classList.toggle('active', button.getAttribute('data-config-tab') === name);
  });
  document.querySelectorAll('#broadcastConfigForm [data-config-panel]').forEach(function (panel) {
    panel.classList.toggle('active', panel.getAttribute('data-config-panel') === name);
  });
}
function bindConfigForm() {
  var form = byId('broadcastConfigForm');
  if (!form || form.getAttribute('data-bound') === '1') return;
  form.setAttribute('data-bound', '1');
  form.addEventListener('input', function (event) {
    var id = event.target && event.target.id;
    if (id === 'teamBlueLogo') setLogoPreview('teamBlueLogoPreview', event.target.value.trim());
    if (id === 'teamRedLogo') setLogoPreview('teamRedLogoPreview', event.target.value.trim());
  });
  form.addEventListener('change', function (event) {
    var id = event.target && event.target.id;
    if (id === 'teamBlueLogoFile') uploadLogoFile(event.target, 'teamBlueLogo', 'teamBlueLogoPreview');
    if (id === 'teamRedLogoFile') uploadLogoFile(event.target, 'teamRedLogo', 'teamRedLogoPreview');
    if (id === 'hudKeyHook') toggleHudKeyHook(event.target.checked);
  });
  form.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-config-tab], [data-sponsor-remove], #broadcastSponsorAdd') : null;
    if (!target) return;
    if (target.hasAttribute('data-config-tab')) {
      switchConfigTab(target.getAttribute('data-config-tab'));
      return;
    }
    if (target.id === 'broadcastSponsorAdd') {
      var box = byId('sponsorEditors');
      if (box) box.insertAdjacentHTML('beforeend', sponsorRowMarkup({ name: '', slot: 'bottom' }));
      return;
    }
    var row = target.closest('.sponsor-row');
    if (!row) return;
    var rows = document.querySelectorAll('#sponsorEditors [data-sponsor-row]');
    if (rows.length > 1) row.remove();
    else row.querySelectorAll('input,select').forEach(function (field) {
      if (field.tagName === 'SELECT') field.value = 'bottom';
      else field.value = '';
    });
  });
}
function renderConfigForm(config) {
  config = cloneConfig(config);
  broadcastConfigDraft = config;
  var teams = config.teams || {};
  var blue = teams.blue || {};
  var red = teams.red || {};
  var series = config.series || {};
  var records = series.records || {};
  var fearless = config.fearless || {};
  var blueCoach = coachFor(config, 'blue');
  var redCoach = coachFor(config, 'red');
  setFieldValue('seriesName', series.name);
  setFieldValue('seriesStage', series.stage);
  setFieldValue('seriesPatch', series.patch);
  setFieldValue('seriesBestOf', series.bestOf);
  setFieldValue('recordBlue', records.blue);
  setFieldValue('recordRed', records.red);
  setFieldValue('teamBlueName', blue.name);
  setFieldValue('teamBlueShort', blue.shortName);
  setFieldValue('teamBlueRegion', blue.region);
  setFieldValue('teamBlueRank', blue.rank);
  setFieldValue('teamBlueColor', blue.color || '#3B82F6');
  setFieldValue('teamBlueLogo', blue.logo);
  setLogoPreview('teamBlueLogoPreview', blue.logo);
  setFieldValue('teamRedName', red.name);
  setFieldValue('teamRedShort', red.shortName);
  setFieldValue('teamRedRegion', red.region);
  setFieldValue('teamRedRank', red.rank);
  setFieldValue('teamRedColor', red.color || '#EF4444');
  setFieldValue('teamRedLogo', red.logo);
  setLogoPreview('teamRedLogoPreview', red.logo);
  setFieldValue('fearlessPbPct', fearless.pbPct);
  setFieldValue('fearlessPickPct', fearless.pickPct);
  setFieldValue('fearlessWins', fearless.wins);
  setFieldValue('fearlessLosses', fearless.losses);
  setFieldValue('coachBlueName', blueCoach.name);
  setFieldValue('coachBlueRole', blueCoach.role || 'HEAD COACH');
  setFieldValue('coachRedName', redCoach.name);
  setFieldValue('coachRedRole', redCoach.role || 'HEAD COACH');
  var cover = config.coverCard && typeof config.coverCard === 'object' ? config.coverCard : {};
  setFieldValue('coverTitle', cover.title);
  setFieldValue('coverLines', Array.isArray(cover.lines) ? cover.lines.join('\n') : '');
  setFieldValue('coverHtml', cover.html);
  var standby = config.standbyCard && typeof config.standbyCard === 'object' ? config.standbyCard : {};
  setFieldValue('standbyTitle', standby.title);
  setFieldValue('standbyLines', Array.isArray(standby.lines) ? standby.lines.join('\n') : '');
  var hudKey = byId('hudKeyHook');
  if (hudKey) hudKey.checked = config.hudKeyHook !== false;
  renderSponsorRows(config.sponsors);
  renderPlayerRows(config.players);
  var jsonBox = byId('broadcastConfigJson');
  if (jsonBox) jsonBox.value = JSON.stringify(config, null, 2);
  bindConfigForm();
}
function collectBroadcastConfig() {
  var base = cloneConfig(broadcastConfigDraft || {});
  var teams = base.teams || (base.teams = {});
  function readTeam(side, prefix) {
    var team = teams[side] || (teams[side] = {});
    team.name = readFieldValue(prefix + 'Name');
    team.shortName = readFieldValue(prefix + 'Short');
    team.region = readFieldValue(prefix + 'Region');
    team.rank = readFieldValue(prefix + 'Rank');
    team.color = readFieldValue(prefix + 'Color');
    if (!team.color) team.color = side === 'blue' ? '#3B82F6' : '#EF4444';
    team.logo = readFieldValue(prefix + 'Logo');
  }
  readTeam('blue', 'teamBlue');
  readTeam('red', 'teamRed');
  var series = base.series || (base.series = {});
  series.name = readFieldValue('seriesName');
  series.stage = readFieldValue('seriesStage');
  series.patch = readFieldValue('seriesPatch');
  series.bestOf = readFieldNumber('seriesBestOf', 3);
  if (!series.records || typeof series.records !== 'object') series.records = {};
  series.records.blue = readFieldNumber('recordBlue', 0);
  series.records.red = readFieldNumber('recordRed', 0);
  var fearless = base.fearless || (base.fearless = {});
  fearless.pbPct = readFieldNumber('fearlessPbPct', 0);
  fearless.pickPct = readFieldNumber('fearlessPickPct', 0);
  fearless.wins = readFieldNumber('fearlessWins', 0);
  fearless.losses = readFieldNumber('fearlessLosses', 0);
  var cover = {};
  var coverTitle = readFieldValue('coverTitle');
  var coverLines = (byId('coverLines') ? byId('coverLines').value : '').split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  var coverHtml = readFieldValue('coverHtml');
  if (coverTitle) cover.title = coverTitle;
  if (coverLines.length) cover.lines = coverLines;
  if (coverHtml) cover.html = coverHtml;
  if (cover.title || cover.lines || cover.html) base.coverCard = cover;
  else delete base.coverCard;
  var standby = {};
  var standbyTitle = readFieldValue('standbyTitle');
  var standbyLines = (byId('standbyLines') ? byId('standbyLines').value : '').split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  if (standbyTitle) standby.title = standbyTitle;
  if (standbyLines.length) standby.lines = standbyLines;
  if (standby.title || standby.lines) base.standbyCard = standby;
  else delete base.standbyCard;
  var hudKeyBox = byId('hudKeyHook');
  if (hudKeyBox) base.hudKeyHook = hudKeyBox.checked === true;
  var sponsors = [];
  document.querySelectorAll('#sponsorEditors [data-sponsor-row]').forEach(function (row, index) {
    var name = row.querySelector('.sponsor-name') ? row.querySelector('.sponsor-name').value.trim() : '';
    var slot = row.querySelector('.sponsor-slot') ? row.querySelector('.sponsor-slot').value : 'bottom';
    var source = Array.isArray(base.sponsors) && base.sponsors[index] ? base.sponsors[index] : {};
    if (name) sponsors.push({ name: name, image: source.image || '', slot: slot });
  });
  base.sponsors = sponsors;
  var players = [];
  document.querySelectorAll('#playerEditors [data-player-row]').forEach(function (row, index) {
    var source = Array.isArray(base.players) && base.players[index] ? base.players[index] : {};
    var displayName = row.querySelector('.player-display') ? row.querySelector('.player-display').value.trim() : '';
    var team = row.querySelector('.player-team') ? row.querySelector('.player-team').value : (index < 5 ? 'blue' : 'red');
    var role = row.querySelector('.player-role') ? row.querySelector('.player-role').value : '';
    var gameName = source.gameName || displayName;
    players.push({ gameName: gameName, displayName: displayName || gameName, team: team, role: role, photo: source.photo || '' });
  });
  if (players.length) base.players = players;
  var coaches = Array.isArray(base.coaches) ? base.coaches : [];
  function readCoach(team, prefix) {
    var name = readFieldValue(prefix + 'Name');
    var role = readFieldValue(prefix + 'Role') || 'HEAD COACH';
    var index = -1;
    for (var i = 0; i < coaches.length; i += 1) { if (coaches[i] && coaches[i].team === team) { index = i; break; } }
    var coach = index >= 0 ? coaches[index] : { team: team, photo: '' };
    coach.name = name;
    coach.team = team;
    coach.role = role;
    if (index < 0) coaches.push(coach);
  }
  readCoach('blue', 'coachBlue');
  readCoach('red', 'coachRed');
  base.coaches = coaches;
  return base;
}
function applyBroadcastJsonToForm() {
  var box = byId('broadcastConfigJson');
  var status = byId('broadcastConfigStatus');
  if (!box) return;
  try {
    var parsed = JSON.parse(box.value || '{}');
    if (parsed && parsed.config) parsed = parsed.config;
    renderConfigForm(parsed);
    if (status) status.textContent = 'JSON 已导入表单 · ' + nowClock();
    toast('JSON 已导入表单');
  } catch (error) {
    if (status) status.textContent = 'JSON 格式错误：' + error.message;
    toast('广播配置 JSON 格式错误', true);
  }
}
function toggleHudKeyHook(checked) {
  var status = byId('broadcastConfigStatus');
  var parsed = byId('broadcastConfigForm') ? collectBroadcastConfig() : null;
  if (!parsed) return;
  parsed.hudKeyHook = checked === true;
  postJson('/api/broadcast-config', parsed).then(function (data) {
    if (data && data.ok) {
      broadcastConfigDraft = data.config || parsed;
      if (latestState) latestState.broadcastConfig = data.config || parsed;
      if (status) status.textContent = '局内 A 键钩子' + (checked ? '已启用' : '已禁用') + ' · ' + nowClock();
      toast('局内 A 键隐藏 HUD 已' + (checked ? '启用' : '禁用'));
    } else if (status) status.textContent = 'A 键开关保存失败：' + ((data && data.error) || '未知错误');
  }).catch(function (error) {
    if (status) status.textContent = 'A 键开关保存失败：' + error.message;
  });
}
function loadBroadcastConfig() {
  var status = byId('broadcastConfigStatus');
  fetchJson('/api/broadcast-config').then(function (data) {
    if (!data || data.ok === false) throw new Error((data && data.error) || '读取失败');
    renderConfigForm(data);
    if (status) status.textContent = '已读取 · ' + nowClock() + ' · 表单与 JSON 已同步';
  }).catch(function (error) {
    if (status) status.textContent = '读取失败：' + (error.message || String(error));
  });
}
function saveBroadcastConfig() {
  var status = byId('broadcastConfigStatus');
  var parsed;
  try {
    parsed = byId('broadcastConfigForm') ? collectBroadcastConfig() : JSON.parse((byId('broadcastConfigJson') || {}).value || '{}');
  } catch (error) {
    if (status) status.textContent = '配置格式错误：' + error.message;
    toast('广播配置格式错误', true);
    return;
  }
  postJson('/api/broadcast-config', parsed).then(function (data) {
    if (data && data.ok) {
      broadcastConfigDraft = data.config || parsed;
      renderConfigForm(broadcastConfigDraft);
      if (latestState) latestState.broadcastConfig = data.config || parsed;
      if (status) status.textContent = '已保存 · ' + nowClock() + ' · 广播页将随 SSE 刷新';
      toast('广播配置已保存');
    } else {
      if (status) status.textContent = '保存失败：' + ((data && data.error) || '未知错误');
      toast('广播配置保存失败：' + ((data && data.error) || '未知错误'), true);
    }
  });
}
function isTypingTarget(target) {
  if (!target) return false;
  var tag = String(target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}
function bindShortcuts() {
  document.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    var type = SHORTCUT_CUES[event.key];
    if (!type) return;
    event.preventDefault();
    cueCommand(type, null);
  });
}
function syncGalleryLink() {
  var link = byId('screenshotGallery');
  if (link) link.href = 'http://' + (location.hostname || '127.0.0.1') + ':3220/';
}
function fallbackCopy(text) {
  var area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); } catch (error) {}
  document.body.removeChild(area);
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { toast('已复制：' + text); }).catch(function () { fallbackCopy(text); toast('已复制：' + text); });
  } else {
    fallbackCopy(text);
    toast('已复制：' + text);
  }
}
function bindControls() {
  document.querySelectorAll('#phase-switch [data-phase]').forEach(function (button) {
    button.addEventListener('click', function () {
      button.disabled = true;
      postJson('/api/phase', { phase: button.getAttribute('data-phase') }).then(function (data) {
        button.disabled = false;
        if (data.ok) toast('阶段已切换：' + phaseText(data.phase));
        else toast('阶段切换失败：' + data.error, true);
      });
    });
  });
  var save = byId('save');
  if (save) save.addEventListener('click', function () {
    var name = byId('tournament') ? byId('tournament').value : '';
    if (matchMode === 'mock') {
      // 模拟模式的赛事名只写模拟配置，绝不碰真实配置。
      var base = latestMatchConfig ? cloneConfig(latestMatchConfig) : {};
      base.series = base.series || {};
      base.series.name = name;
      postJson('/api/mock/config', { config: base }).then(function (data) {
        if (data && data.ok) { latestMatchConfig = data.config || base; toast('模拟赛事名称已保存'); }
        else toast('保存失败：' + ((data && data.error) || '未知错误'), true);
      });
      return;
    }
    postJson('/api/config', { tournamentName: name }).then(function (data) {
      if (data.ok) toast('赛事名称已保存'); else toast('保存失败：' + data.error, true);
    });
  });
  var connect = byId('obsConnect');
  if (connect) connect.addEventListener('click', function () {
    connect.disabled = true;
    var status = byId('obsStatus');
    if (status) status.textContent = '连接中…';
    postJson('/api/obs/connect', { url: byId('obsUrl').value, password: byId('obsPass').value }).then(function (data) {
      connect.disabled = false;
      if (data.ok) {
        toast('OBS 已连接');
        if (!latestState) latestState = {};
        latestState.obs = data.obs;
        renderObs(latestState);
      } else {
        if (status) status.textContent = '连接失败：' + data.error;
        toast('OBS 连接失败：' + data.error, true);
      }
    });
  });
  var rebrandButton = byId('obsRebrand');
  if (rebrandButton) rebrandButton.addEventListener('click', function () {
    rebrandButton.disabled = true;
    postJson('/api/obs/rebrand', {}).then(function (data) {
      rebrandButton.disabled = false;
      if (data.ok) {
        var rebrand = data.rebrand || {};
        var parts = [];
        if (rebrand.renamed.length) parts.push('改名 ' + rebrand.renamed.length + ' 个');
        if (rebrand.repointed.length) parts.push('URL 重指 ' + rebrand.repointed.length + ' 个');
        if (rebrand.skipped.length) parts.push('跳过 ' + rebrand.skipped.length + ' 个');
        toast(parts.length ? '一键换源完成：' + parts.join('，') : '无需换源，全部已是最新配置');
      } else toast('一键换源失败：' + data.error, true);
    });
  });

  document.querySelectorAll('[data-obs-record]').forEach(function (button) {
    button.addEventListener('click', function () {
      var action = button.getAttribute('data-obs-record');
      obsCommand('/api/obs/record', { action: action }, '录制' + (action === 'start' ? '开始' : '停止'));
    });
  });
  document.querySelectorAll('[data-obs-stream]').forEach(function (button) {
    button.addEventListener('click', function () {
      var action = button.getAttribute('data-obs-stream');
      obsCommand('/api/obs/stream', { action: action }, '推流' + (action === 'start' ? '开始' : '停止'));
    });
  });
  document.querySelectorAll('[data-obs-replay]').forEach(function (button) {
    button.addEventListener('click', function () { obsCommand('/api/obs/replay-buffer', { action: 'save' }, '保存回放'); });
  });
  document.querySelectorAll('[data-replay]').forEach(function (button) {
    button.addEventListener('click', function () {
      postReplay('/api/replay/playback', { paused: button.getAttribute('data-replay') === 'pause' }, '回放' + (button.getAttribute('data-replay') === 'pause' ? '暂停' : '播放'));
    });
  });
  document.querySelectorAll('[data-speed]').forEach(function (button) {
    button.addEventListener('click', function () {
      postReplay('/api/replay/playback', { speed: Number(button.getAttribute('data-speed')) }, '速度 ' + button.getAttribute('data-speed') + '×');
    });
  });
  document.querySelectorAll('[data-fov]').forEach(function (button) {
    button.addEventListener('click', function () {
      postReplay('/api/replay/camera', { fieldOfView: Number(button.getAttribute('data-fov')) }, '镜头 ' + button.getAttribute('data-fov') + '°');
    });
  });
  document.querySelectorAll('#bo-quick [data-bo]').forEach(function (button) {
    button.addEventListener('click', function () {
      var n = Number(button.getAttribute('data-bo')) || 3;
      var input = byId('seriesBestOf');
      if (input) input.value = n;
      document.querySelectorAll('#bo-quick [data-bo]').forEach(function (other) { other.classList.toggle('active', other === button); });
      saveBroadcastConfig();
      toast('赛制已切换为 BO' + n + '，广播页实时生效');
    });
  });
  var refresh = byId('refreshSources');
  if (refresh) refresh.addEventListener('click', function () { refreshSources(true); toast('正在重新探测数据源…'); });
  document.querySelectorAll('[data-cue]').forEach(function (button) {
    button.addEventListener('click', function () { cueCommand(button.getAttribute('data-cue'), button); });
  });
  var configLoad = byId('broadcastConfigLoad');
  if (configLoad) configLoad.addEventListener('click', loadBroadcastConfig);
  var configSave = byId('broadcastConfigSave');
  if (configSave) configSave.addEventListener('click', saveBroadcastConfig);
  var configApply = byId('broadcastConfigJsonApply');
  if (configApply) configApply.addEventListener('click', applyBroadcastJsonToForm);
  var mvpSend = byId('mvp-send');
  if (mvpSend) mvpSend.addEventListener('click', function () {
    if (!mvpPick.name) return;
    mvpSend.disabled = true;
    postJson('/api/mvp', { name: mvpPick.name, team: mvpPick.team }).then(function (data) {
      mvpSend.disabled = false;
      if (data && data.ok) toast('MVP 已发送：' + mvpPick.name);
      else toast('MVP 发送失败：' + ((data && data.error) || '未知错误'), true);
    });
  });
  var mvpClear = byId('mvp-clear');
  if (mvpClear) mvpClear.addEventListener('click', function () {
    mvpClear.disabled = true;
    postJson('/api/mvp', { name: '' }).then(function (data) {
      mvpClear.disabled = false;
      if (data && data.ok) toast('MVP 已清除');
      else toast('清除失败：' + ((data && data.error) || '未知错误'), true);
    });
  });
  bindDirectorPanel();
}
function init() {
  buildUrls();
  buildBroadcastUrls();
  syncGalleryLink();
  bindShortcuts();
  bindControls();
  loadBroadcastConfig();
  bindDirectorPanel();
  loadDirectorRules();
  renderFeed();
  refreshSources();
  loadReplay();
  loadObs();
  loadSeries();
  loadMatchConfig();
  bindSeriesControls();
  bindDemoControls();
  fetchJson('/api/state').then(applyState).catch(function () {});
  try {
    var source = new EventSource('/events');
    source.onopen = function () { setConnection(true); };
    source.onerror = function () { setConnection(false); };
    source.onmessage = function (event) {
      try { applyState(JSON.parse(event.data)); } catch (error) { /* 单帧异常不影响下一页 */ }
    };
  } catch (error) {
    setConnection(false);
  }
  window.addEventListener('riftbroadcast:service-down', function (event) {
    var detail = (event && event.detail) || {};
    setConnection(false);
    toast('本地服务已断开' + (detail.retryable ? '，正在尝试重连…' : '，请重启 Khada Jhin'), true);
  });
  window.addEventListener('riftbroadcast:service-up', function () { setConnection(true); });
  // 数据源探测会拉起 PowerShell/HTTP 探测，只在页面可见时低频刷新；强制刷新走按钮。
  setInterval(function () { if (document.visibilityState !== 'hidden') refreshSources(); }, 30000);
  setInterval(function () { if (document.visibilityState !== 'hidden') loadReplay(); }, 10000);
  setInterval(function () { if (document.visibilityState !== 'hidden') loadObs(); }, 30000);
}
/* ---------- 视图路由：一个阶段一屏 ---------- */
var VIEW_LIST = ['home', 'wait', 'bp', 'live', 'post', 'settings', 'setup', 'match'];
var PHASE_VIEW = { draft: 'bp', in_game: 'live', post_game: 'post' };
var DOCK_VIEWS = { wait: 1, bp: 1, live: 1, post: 1 };
var currentView = 'home';
var lastPhaseForView = null;

function setTextById(id, text) {
  var el = byId(id);
  if (el) el.textContent = text;
}

function showView(name, options) {
  options = options || {};
  if (VIEW_LIST.indexOf(name) < 0) name = 'home';
  currentView = name;
  var shell = byId('console-shell');
  if (shell && shell.setAttribute) shell.setAttribute('data-view', name);
  var views = (document.querySelectorAll ? document.querySelectorAll('.c2-view') : []) || [];
  for (var i = 0; i < views.length; i++) {
    if (!views[i] || !views[i].classList) continue;
    views[i].classList.toggle('active', views[i].getAttribute('data-view') === name);
  }
  var steps = (document.querySelectorAll ? document.querySelectorAll('#view-switch [data-nav]') : []) || [];
  for (var j = 0; j < steps.length; j++) {
    if (!steps[j] || !steps[j].classList) continue;
    steps[j].classList.toggle('active', steps[j].getAttribute('data-nav') === name);
  }
  var dock = byId('cue-dock');
  if (dock) dock.hidden = !DOCK_VIEWS[name];
  var stepsBox = byId('view-switch');
  if (stepsBox) stepsBox.hidden = !DOCK_VIEWS[name];
  if (name === 'match') {
    setTextById('msModeNote', matchMode === 'mock'
      ? '模拟模式：这份配置只用于模拟演示，保存后按它生成剧本，退出模拟即清空。'
      : '真实模式：这份配置会写成正式赛事配置，保存后开一轮系列赛，数据来自 LCU / Live Client。');
  }
  if (latestState) renderDemo(latestState);
  if (!options.keepScroll && typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0);
}

// ---- 演示控制条（仅 mock 模式）---------------------------------------------
var DEMO_STAGE_TEXT = { lobby: '等待开始', draft: 'BP 选人', game: '赛中', post: '赛后' };
var DEMO_LOOP_MS = 180000;

function demoClock(ms) {
  var total = Math.max(0, Math.round(ms / 1000));
  var m = Math.floor(total / 60);
  var s = total % 60;
  return m + ':' + (s < 10 ? '0' + s : s);
}

function renderDemo(state) {
  var bar = byId('demo-bar');
  if (!bar) return;
  var demo = state && state.demo;
  var isMock = state && state.mode === 'mock';
  bar.hidden = !isMock || !demo || !DOCK_VIEWS[currentView];
  if (bar.hidden) return;
  var stage = byId('demo-stage');
  if (stage) {
    var label = DEMO_STAGE_TEXT[demo.stage] || '等待开始';
    if (demo.stage === 'game' && state.gameTime != null) label += ' · ' + demoClock(state.gameTime * 1000);
    stage.textContent = label;
  }
  var fill = byId('demo-fill');
  if (fill && fill.style) fill.style.width = Math.max(0, Math.min(100, (demo.progress || 0) * 100)).toFixed(2) + '%';
  var clock = byId('demo-clock');
  if (clock) clock.textContent = demoClock(demo.elapsed) + ' / ' + demoClock(DEMO_LOOP_MS);
  var toggle = byId('demo-toggle');
  if (toggle) toggle.textContent = demo.playing ? '暂停' : '继续';
  var speeds = (document.querySelectorAll ? document.querySelectorAll('[data-demo-speed]') : []) || [];
  for (var i = 0; i < speeds.length; i++) {
    if (!speeds[i] || !speeds[i].classList) continue;
    speeds[i].classList.toggle('active', Number(speeds[i].getAttribute('data-demo-speed')) === (demo.speed || 1));
  }
}

function postDemo(body) {
  return fetch('/api/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || !data.ok) throw new Error((data && data.error) || '演示控制失败');
      if (data.demo && latestState) { latestState.demo = data.demo; renderDemo(latestState); }
      return data;
    })
    .catch(function (error) { toast(error.message || '演示控制失败', true); });
}

function bindDemoControls() {
  var toggle = byId('demo-toggle');
  if (toggle && toggle.addEventListener) toggle.addEventListener('click', function () {
    var playing = !!(latestState && latestState.demo && latestState.demo.playing);
    postDemo({ action: playing ? 'pause' : 'play' });
  });
  var replay = byId('demo-replay');
  if (replay && replay.addEventListener) replay.addEventListener('click', function () { postDemo({ action: 'restart' }); });
  var speeds = (document.querySelectorAll ? document.querySelectorAll('[data-demo-speed]') : []) || [];
  for (var i = 0; i < speeds.length; i++) {
    if (!speeds[i] || !speeds[i].addEventListener) continue;
    speeds[i].addEventListener('click', function (event) {
      var el = event && event.currentTarget;
      postDemo({ action: 'speed', speed: Number(el && el.getAttribute('data-demo-speed')) || 1 });
    });
  }
}

function showSettingsTab(name) {
  showView('settings', { keepScroll: true });
  var tabs = (document.querySelectorAll ? document.querySelectorAll('#settings-tabs [data-set-tab]') : []) || [];
  for (var i = 0; i < tabs.length; i++) {
    if (!tabs[i] || !tabs[i].classList) continue;
    tabs[i].classList.toggle('active', tabs[i].getAttribute('data-set-tab') === name);
  }
  var panels = (document.querySelectorAll ? document.querySelectorAll('[data-set-panel]') : []) || [];
  for (var j = 0; j < panels.length; j++) {
    if (!panels[j] || !panels[j].classList) continue;
    panels[j].classList.toggle('active', panels[j].getAttribute('data-set-panel') === name);
  }
}

var ROLE_ORDER = { TOP: 0, JUNGLE: 1, MID: 2, ADC: 3, SUPPORT: 4 };
var ROLE_LABEL = { TOP: '上单', JUNGLE: '打野', MID: '中单', ADC: '下路', SUPPORT: '辅助' };

function lineupMarkup(players, team) {
  var list = (Array.isArray(players) ? players : []).filter(function (p) { return p && p.team === team; });
  list.sort(function (a, b) {
    var ra = ROLE_ORDER[a.role] == null ? 9 : ROLE_ORDER[a.role];
    var rb = ROLE_ORDER[b.role] == null ? 9 : ROLE_ORDER[b.role];
    return ra - rb;
  });
  if (!list.length) return '<li class="c2-lu-empty">未配置选手</li>';
  return list.slice(0, 5).map(function (p) {
    var role = ROLE_LABEL[p.role] || p.role || '—';
    return '<li><span>' + esc(role) + '</span><b>' + esc(p.displayName || p.gameName || '—') + '</b></li>';
  }).join('');
}

function renderLineup(config) {
  var players = config && Array.isArray(config.players) ? config.players : [];
  var blue = byId('lineupBlue');
  if (blue) blue.innerHTML = lineupMarkup(players, 'blue');
  var red = byId('lineupRed');
  if (red) red.innerHTML = lineupMarkup(players, 'red');
}

function renderShellExtras(state) {
  if (!state) return;
  var blue = state.blue || {};
  var red = state.red || {};
  setTextById('homePhase', phaseText(state.phase));
  setTextById('homeSeries', state.tournamentName || 'Khada Jhin');
  setTextById('homeMatchTitle', (blue.name || '蓝方') + ' vs ' + (red.name || '红方'));
  setTextById('homeMatchSub', (state.tournamentName || 'Khada Jhin') + ' · ' + (state.mode === 'live' ? '真实模式' : '模拟模式') + ' · ' + phaseText(state.phase));
  renderLineup(state.broadcastConfig);
  renderModeEntries(state);
}

function toggleHidden(id, hidden) {
  var el = byId(id);
  if (el) el.hidden = !!hidden;
}

// 首页入口按「当前模式 + 系列赛状态」显隐：模拟与真实只能从首页切，不提供一键互切。
function renderModeEntries(state) {
  var mock = !!(state && state.mode === 'mock');
  var running = !!(latestSeries && latestSeries.status === 'running');
  toggleHidden('homeResume', !(mock || running));
  toggleHidden('homeEndSeries', !(running && !mock));
  toggleHidden('homeMockExit', !mock);
  toggleHidden('homeMockNote', !mock);
  toggleHidden('mockExit', !mock);
  var note = byId('phaseNote');
  if (note) note.textContent = mock ? '模拟数据 · 每秒刷新，可直接用于 OBS 测试' : '真实数据 · 来自 LCU / Live Client';
}

/* ---------- 系列赛：局数 / 比分 / 历史 ---------- */
var latestSeries = null;
var latestMatchConfig = null;
var activeBestOf = 3;
var matchMode = 'live';
var setupPrompted = false;

function seriesScore() {
  var s = latestSeries;
  var scores = (s && s.scores) || {};
  return { blue: Number(scores.blue) || 0, red: Number(scores.red) || 0 };
}

function seriesRunning() {
  return !!(latestSeries && latestSeries.status === 'running');
}

function postSeries(action, body) {
  return postJson('/api/series/' + action, body || {}).then(function (data) {
    if (data && data.ok && data.series) applySeries(data.series);
    return data;
  });
}

var lastSeriesKey = '';

function applySeries(series) {
  latestSeries = series || null;
  renderSeries();
  var key = '';
  try { key = JSON.stringify(latestSeries); } catch (error) { key = String(Date.now()); }
  if (key !== lastSeriesKey) {
    lastSeriesKey = key;
    renderHistory();
    renderGames();
  }
}

function renderSeries() {
  var s = latestSeries;
  var score = seriesScore();
  var bo = (s && Number(s.bestOf)) || 3;
  var running = !!(s && (s.status === 'running' || s.status === 'finished'));
  setTextById('scoreBlue', String(score.blue));
  setTextById('scoreRed', String(score.red));
  setTextById('homeScore', score.blue + ' : ' + score.red);
  setTextById('gameChip', running ? ('BO' + bo + ' · 第 ' + (Number(s.gameIndex) || 1) + ' 局') : ('BO' + bo));
  if (running && s.tournament) setTextById('homeSeries', s.tournament);
  var title = byId('homeMatchTitle');
  if (title && s && s.teams) {
    var blueName = (s.teams.blue && s.teams.blue.name) || '蓝方';
    var redName = (s.teams.red && s.teams.red.name) || '红方';
    title.textContent = blueName + ' vs ' + redName;
  }
  var sub = byId('homeMatchSub');
  if (sub && s) {
    var state = latestState || {};
    var parts = [(s.tournament || state.tournamentName || 'Khada Jhin'), 'BO' + bo, '第 ' + (Number(s.gameIndex) || 1) + ' 局'];
    if (s.status === 'idle') parts = [(s.tournament || state.tournamentName || 'Khada Jhin'), '尚未开赛'];
    if (s.status === 'finished') parts.push('系列赛已决出');
    sub.textContent = parts.join(' · ');
  }
  var nowChip = byId('msSeriesNow');
  if (nowChip) {
    if (!s || s.status === 'idle') nowChip.textContent = '还没有进行中的系列赛；点「保存并开始」会写入配置并开一轮。';
    else nowChip.textContent = '进行中：' + ((s.teams && s.teams.blue && s.teams.blue.name) || '蓝方') + ' ' + score.blue + ' : ' + score.red + ' ' + ((s.teams && s.teams.red && s.teams.red.name) || '红方') + ' · BO' + bo + ' 第 ' + (Number(s.gameIndex) || 1) + ' 局（保存并开始会重开一轮）';
  }
  var note = byId('postSeriesNote');
  if (note) {
    if (!s || s.status === 'idle') note.textContent = '还没有进行中的系列赛，点「开始新比赛」开一轮。';
    else {
      var need = s.needed || (Math.floor(bo / 2) + 1);
      note.textContent = 'BO' + bo + ' · 先拿 ' + need + ' 局者胜 · 当前 ' + score.blue + ' : ' + score.red + (s.status === 'finished' ? ' · 已决出胜负' : '');
    }
  }
  var nextBtn = byId('postNext');
  if (nextBtn) {
    var decided = !!(s && (s.decided || s.status === 'finished'));
    nextBtn.disabled = decided || !seriesRunning();
    nextBtn.textContent = decided ? '系列赛已结束' : '下一局';
  }
  var endBtn = byId('homeEndSeries');
  if (endBtn) endBtn.disabled = !(s && s.status !== 'idle');
  var postEnd = byId('postEnd');
  if (postEnd) postEnd.disabled = !(s && s.status !== 'idle');
}

function renderHistory() {
  var box = byId('historyList');
  if (!box) return;
  var list = (latestSeries && Array.isArray(latestSeries.history)) ? latestSeries.history : [];
  if (!list.length) {
    box.innerHTML = '<div class="c2-note">还没有完成的对局。赛后页点「结束这轮比赛」后会在这里留下记录。</div>';
    return;
  }
  box.innerHTML = list.map(function (item) {
    var teams = item.teams || {};
    var names = { blue: (teams.blue && teams.blue.name) || '蓝方', red: (teams.red && teams.red.name) || '红方' };
    var scores = item.scores || {};
    var winner = item.winner === 'red' ? names.red : (item.winner === 'blue' ? names.blue : '无结果');
    var games = Array.isArray(item.games) ? item.games.length : 0;
    var when = item.endedAt ? new Date(item.endedAt) : null;
    var stamp = when && !isNaN(when.getTime()) ? (when.getMonth() + 1) + '/' + when.getDate() + ' ' + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0') : '--';
    return '<div class="c2-hist-row">' +
      '<span class="c2-hist-when">' + esc(stamp) + '</span>' +
      '<span class="c2-hist-teams"><b class="blue">' + esc(names.blue) + '</b><i>' + esc(String(scores.blue || 0)) + ' : ' + esc(String(scores.red || 0)) + '</i><b class="red">' + esc(names.red) + '</b></span>' +
      '<span class="c2-hist-meta">BO' + esc(String(item.bestOf || 3)) + ' · ' + games + ' 局 · 胜者 ' + esc(winner) + '</span>' +
      '</div>';
  }).join('');
}

function teamKills(postGame, team) {
  var list = postGame && Array.isArray(postGame.players) ? postGame.players : [];
  return list.filter(function (p) { return p && p.team === team; }).reduce(function (sum, p) { return sum + (Number(p.kills) || 0); }, 0);
}

function currentGameResult() {
  var state = latestState || {};
  var pg = state.postGame || null;
  var blueKills = 0;
  var redKills = 0;
  var duration = 0;
  if (pg && pg.teams) {
    blueKills = Number(pg.teams.blue && pg.teams.blue.kills);
    redKills = Number(pg.teams.red && pg.teams.red.kills);
    if (!isFinite(blueKills)) blueKills = teamKills(pg, 'blue');
    if (!isFinite(redKills)) redKills = teamKills(pg, 'red');
    duration = Number(pg.gameLength) || Number(state.gameTime) || 0;
  } else {
    blueKills = Number(state.blue && state.blue.score) || 0;
    redKills = Number(state.red && state.red.score) || 0;
    duration = Number(state.gameTime) || 0;
  }
  var winner = redKills > blueKills ? 'red' : 'blue';
  var mvp = state.mvp && state.mvp.name ? { name: state.mvp.name, team: state.mvp.team || winner } : null;
  return { winner: winner, blueKills: blueKills, redKills: redKills, duration: duration, mvp: mvp };
}

function recordAndAdvance(mode) {
  var s = latestSeries;
  if (!s || s.status === 'idle') { toast('还没有进行中的系列赛', true); return Promise.resolve(); }
  var already = (Array.isArray(s.games) ? s.games : []).some(function (g) { return g && Number(g.index) === Number(s.gameIndex); });
  var chain = already ? Promise.resolve({ ok: true }) : postSeries('game', currentGameResult());
  return chain.then(function (data) {
    if (data && data.ok === false) throw new Error(data.error || '记录本局失败');
    if (!latestSeries || latestSeries.decided || latestSeries.status === 'finished') return { decided: true };
    return postSeries(mode === 'end' ? 'end' : 'next');
  }).then(function (data) {
    if (data && data.decided) {
      toast('这一局打完系列赛已经决出胜负，点「结束这轮比赛」收尾');
      return;
    }
    if (data && data.ok === false) throw new Error(data.error || '推进系列赛失败');
    if (mode === 'end') { toast('这轮比赛已结束'); showView('home'); }
    else { toast('已切到下一局'); showView('wait'); }
  }).catch(function (error) {
    toast('操作失败：' + ((error && error.message) || error), true);
  });
}

function renderDraftBoard(state) {
  var box = byId('draftBoard');
  if (!box) return;
  var draft = state && state.draft;
  var round = byId('draftRound');
  if (!draft || (!(draft.bluePicks || []).length && !(draft.redPicks || []).length && !(draft.blueBans || []).length && !(draft.redBans || []).length)) {
    if (round) round.textContent = '等待 BP';
    box.innerHTML = '<span class="empty">等待 BP 数据…</span>';
    return;
  }
  if (round) {
    var active = draft.active === 'red' ? '红方' : '蓝方';
    round.textContent = '第 ' + (draft.round || 1) + ' 手 · ' + active + '行动' + (draft.timer != null ? ' · ' + Math.max(0, Math.round(draft.timer)) + 's' : '');
  }
  var chips = function (list, cls, empty) {
    var out = '';
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length; i++) out += '<i class="' + cls + '">' + champAvatar(arr[i], 'chip-face') + '</i>';
    if (!arr.length) out = '<i class="slot">未开始</i>';
    return out;
  };
  var row = function (side, picks, bans) {
    var team = (state && state[side]) || {};
    var tag = side === 'blue' ? '蓝方' : '红方';
    var name = team.name || tag;
    return '<div class="c2-draft-row ' + side + '">' +
      '<span class="c2-draft-side">' + (name === tag ? '' : '<small>' + tag + '</small>') + '<b>' + esc(name) + '</b></span>' +
      '<span class="c2-draft-line"><small>禁用</small>' + chips(bans, 'ban') + '</span>' +
      '<span class="c2-draft-line"><small>已选</small>' + chips(picks, 'pick') + '</span>' +
      '</div>';
  };
  box.innerHTML = row('blue', draft.bluePicks, draft.blueBans) + row('red', draft.redPicks, draft.redBans);
}

function renderSettle(state) {
  var box = byId('settleBody');
  if (!box) return;
  var pg = state && state.postGame;
  var list = pg && Array.isArray(pg.players) ? pg.players : [];
  if (!list.length) {
    box.innerHTML = '<div class="c2-note">本局结算（伤害 / 经济 / 目标）在赛后自动汇总，随后进入 MVP 评选。现在还没有数据。</div>';
    return;
  }
  var maxDamage = list.reduce(function (max, p) { return Math.max(max, Number(p.damage) || 0); }, 1);
  var rows = list.slice().sort(function (a, b) { return (Number(b.damage) || 0) - (Number(a.damage) || 0); }).map(function (p) {
    var side = p.team === 'red' ? 'red' : 'blue';
    var pct = Math.round(((Number(p.damage) || 0) / maxDamage) * 100);
    return '<div class="c2-settle-row" data-side="' + side + '">' +
      '<span class="c2-st-name">' + esc(p.name || '—') + '<i>' + esc(p.champion || '') + '</i></span>' +
      '<span class="c2-st-bar"><b style="width:' + pct + '%"></b></span>' +
      '<span class="c2-st-kda">' + esc(String(p.kills || 0) + '/' + String(p.deaths || 0) + '/' + String(p.assists || 0)) + '</span>' +
      '<span class="c2-st-gold">' + fmtNumber(p.gold) + '</span>' +
      '</div>';
  }).join('');
  var head = '<div class="c2-settle-head"><span>选手</span><span>伤害</span><span>KDA</span><span>经济</span></div>';
  box.innerHTML = head + rows;
}

function renderGames() {
  var box = byId('gameList');
  if (!box) return;
  var s = latestSeries;
  var games = s && Array.isArray(s.games) ? s.games : [];
  if (!games.length) {
    box.innerHTML = '<div class="c2-note">这一轮还没有记录任何一局。赛后页点「下一局」或「结束这轮比赛」时会把本局战绩写入这里。</div>';
    return;
  }
  box.innerHTML = games.map(function (g) {
    var mvp = g.mvp && g.mvp.name ? ' · MVP ' + g.mvp.name : '';
    var winner = g.winner === 'red' ? '红方胜' : '蓝方胜';
    var clock = Number(g.duration) ? ' · ' + fmtClock(g.duration) : '';
    return '<div class="c2-game-row" data-side="' + esc(g.winner === 'red' ? 'red' : 'blue') + '">' +
      '<span class="c2-game-idx">第 ' + esc(String(g.index || 0)) + ' 局</span>' +
      '<span class="c2-game-score"><b class="blue">' + esc(String(g.blueKills || 0)) + '</b><i>:</i><b class="red">' + esc(String(g.redKills || 0)) + '</b></span>' +
      '<span class="c2-game-meta">' + esc(winner + clock + mvp) + '</span>' +
      '</div>';
  }).join('');
}

function loadSeries() {
  return fetchJson('/api/series').then(function (data) {
    if (data && data.series) applySeries(data.series);
  }).catch(function () {});
}

/* ---------- 比赛配置屏 ---------- */
function msVal(id) {
  var el = byId(id);
  return el && typeof el.value === 'string' ? el.value.trim() : '';
}

function renderBoButtons() {
  var box = byId('msBestOf');
  if (!box) return;
  var buttons = box.querySelectorAll('[data-bo]');
  for (var i = 0; i < buttons.length; i += 1) {
    var value = Number(buttons[i].getAttribute('data-bo'));
    buttons[i].classList.toggle('active', value === activeBestOf);
  }
}

function renderMatchForm(config) {
  if (!config) return;
  latestMatchConfig = config;
  var series = config.series || {};
  var bo = Number(series.bestOf);
  activeBestOf = bo === 5 ? 5 : (bo === 1 ? 1 : 3);
  setFieldValue('msTournament', series.name || '');
  var teams = config.teams || {};
  var blue = teams.blue || {};
  var red = teams.red || {};
  setFieldValue('msBlueName', blue.name);
  setFieldValue('msBlueShort', blue.shortName);
  setFieldValue('msBlueColor', blue.color || '#3B82F6');
  setFieldValue('msBlueLogo', blue.logo);
  setLogoPreview('msBlueLogoPreview', blue.logo);
  setFieldValue('msRedName', red.name);
  setFieldValue('msRedShort', red.shortName);
  setFieldValue('msRedColor', red.color || '#EF4444');
  setFieldValue('msRedLogo', red.logo);
  setLogoPreview('msRedLogoPreview', red.logo);
  renderMsPlayers(config.players);
  var blueCoach = coachFor(config, 'blue');
  var redCoach = coachFor(config, 'red');
  setFieldValue('msCoachBlueName', blueCoach.name || '');
  setFieldValue('msCoachBlueRole', blueCoach.role || '');
  setFieldValue('msCoachRedName', redCoach.name || '');
  setFieldValue('msCoachRedRole', redCoach.role || '');
  renderBoButtons();
}

function renderMsPlayers(players) {
  var box = byId('msPlayers');
  if (!box) return;
  var list = Array.isArray(players) ? players.slice(0, 10) : [];
  while (list.length < 10) list.push({ displayName: '', team: list.length < 5 ? 'blue' : 'red', role: '' });
  box.innerHTML = list.map(playerRowMarkup).join('');
}

function collectMatchForm() {
  var base = latestMatchConfig ? cloneConfig(latestMatchConfig) : {};
  base.series = base.series || {};
  base.series.name = msVal('msTournament');
  base.series.bestOf = activeBestOf;
  base.teams = base.teams || {};
  base.teams.blue = Object.assign({}, base.teams.blue || {}, {
    name: msVal('msBlueName'), shortName: msVal('msBlueShort'), color: msVal('msBlueColor') || '#3B82F6', logo: msVal('msBlueLogo')
  });
  base.teams.red = Object.assign({}, base.teams.red || {}, {
    name: msVal('msRedName'), shortName: msVal('msRedShort'), color: msVal('msRedColor') || '#EF4444', logo: msVal('msRedLogo')
  });
  var rows = (document.querySelectorAll ? document.querySelectorAll('#msPlayers [data-player-row]') : []) || [];
  var players = Array.isArray(base.players) ? base.players.slice() : [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var nameInput = row.querySelector('.player-display');
    var teamSelect = row.querySelector('.player-team');
    var roleSelect = row.querySelector('.player-role');
    var player = Object.assign({}, players[i] || {});
    player.displayName = nameInput ? nameInput.value.trim() : '';
    player.team = teamSelect ? teamSelect.value : 'blue';
    player.role = roleSelect ? roleSelect.value : '';
    players[i] = player;
  }
  base.players = players;
  var coaches = Array.isArray(base.coaches) ? base.coaches.slice() : [];
  [['blue', 'msCoachBlueName', 'msCoachBlueRole'], ['red', 'msCoachRedName', 'msCoachRedRole']].forEach(function (entry) {
    var team = entry[0];
    var coach = { name: msVal(entry[1]), team: team, role: msVal(entry[2]) || 'COACH' };
    var index = -1;
    for (var j = 0; j < coaches.length; j += 1) { if (coaches[j] && coaches[j].team === team) { index = j; break; } }
    if (index >= 0) coaches[index] = Object.assign({}, coaches[index], coach);
    else coaches.push(coach);
  });
  base.coaches = coaches;
  base.setupCompleted = true;
  return base;
}

function saveMatchAndMaybeStart(start) {
  var status = byId('msStatus');
  var mock = matchMode === 'mock';
  if (status) status.textContent = mock ? '正在保存模拟配置…' : '正在保存赛事配置…';
  var config = collectMatchForm();
  var saved = mock ? postJson('/api/mock/config', { config: config }) : postJson('/api/broadcast-config', config);
  return saved.then(function (data) {
    if (!data || !data.ok) throw new Error((data && data.error) || '保存失败');
    latestMatchConfig = data.config || config;
    renderMatchForm(latestMatchConfig);
    renderLineup(latestMatchConfig);
    if (status) status.textContent = mock ? '模拟配置已保存' : '赛事配置已保存';
    toast(mock ? '模拟配置已保存' : '赛事配置已保存');
    if (!start) return null;
    if (mock) {
      return postJson('/api/mock/start', { config: latestMatchConfig }).then(function (result) {
        if (!result || result.ok === false) throw new Error((result && result.error) || '启动模拟失败');
        showView('wait');
        toast('模拟已开始，顶部演示条可暂停 / 重播 / 调速');
      });
    }
    return postSeries('start', {
      tournament: msVal('msTournament'),
      bestOf: activeBestOf,
      teams: { blue: { name: msVal('msBlueName') }, red: { name: msVal('msRedName') } }
    }).then(function (result) {
      if (!result || result.ok === false) throw new Error((result && result.error) || '开局失败');
      showView('wait');
      toast('已开始这一轮比赛');
    });
  }).catch(function (error) {
    var message = (error && error.message) || String(error);
    if (status) status.textContent = '失败：' + message;
    toast('保存失败：' + message, true);
  });
}

function loadMatchConfig() {
  var mock = matchMode === 'mock';
  return fetchJson(mock ? '/api/mock/config' : '/api/broadcast-config').then(function (data) {
    var config = mock ? ((data && data.config) || {}) : data;
    if (!config) return;
    if (mock && (!Array.isArray(config.players) || !config.players.length)) {
      // 模拟配置第一次是空的：拿真实配置当草稿起点，用户只要改改队名就能演一遍。
      return fetchJson('/api/broadcast-config').then(function (real) {
        if (real && real.teams && real.teams.blue) {
          config.teams = config.teams && config.teams.blue && config.teams.blue.name && config.teams.blue.name !== '蓝方' ? config.teams : real.teams;
          config.players = real.players || [];
          if (!Array.isArray(config.coaches) || !config.coaches.length) config.coaches = real.coaches || [];
          if (!config.series || !config.series.name) {
            config.series = Object.assign({}, config.series || {}, { name: (real.series && real.series.name) || '' });
          }
        }
        latestMatchConfig = config;
        renderMatchForm(config);
        renderLineup(config);
      }).catch(function () {
        latestMatchConfig = config;
        renderMatchForm(config);
        renderLineup(config);
      });
    }
    latestMatchConfig = config;
    renderMatchForm(config);
    renderLineup(config);
    if (!mock && !setupPrompted && config.setupCompleted !== true) {
      setupPrompted = true;
      showView('setup');
      refreshSetupStatus();
    }
  }).catch(function () {});
}

/* ---------- 首次引导 ---------- */
function refreshSetupStatus() {
  setTextById('obObs', '检测中…');
  fetchJson('/api/obs').then(function (data) {
    var connected = !!(data && (data.connected || data.ok || data.status === 'connected' || data.currentScene));
    setTextById('obObs', connected ? ('已连接 OBS' + (data.currentScene ? ' · 场景 ' + data.currentScene : '')) : ('未连接' + (data && data.error ? '：' + data.error : '')));
  }).catch(function () { setTextById('obObs', '未连接：本地服务无响应'); });
  Promise.resolve(typeof refreshSources === 'function' ? refreshSources() : null).then(function () {
    var rows = (document.querySelectorAll ? document.querySelectorAll('#source-health .health-row') : []) || [];
    var texts = [];
    for (var i = 0; i < rows.length; i += 1) {
      var text = rows[i].textContent ? rows[i].textContent.replace(/\s+/g, ' ').trim() : '';
      if (text) texts.push(text);
    }
    setTextById('obSources', texts.length ? texts.join(' · ') : '暂无探测结果');
  });
  var state = latestState || {};
  setTextById('obHud', state.broadcastConfig ? 'HUD 已就绪 · 1920×1080 设计坐标' : '使用默认几何 · 1920×1080 设计坐标');
}

function finishSetup(skipped) {
  var base = latestMatchConfig ? cloneConfig(latestMatchConfig) : {};
  base.setupCompleted = true;
  postJson('/api/broadcast-config', base).then(function (data) {
    if (data && data.ok && data.config) { latestMatchConfig = data.config; renderMatchForm(data.config); }
    setTextById('obStatus', '已记录，不再打扰');
    showView('home');
    toast(skipped ? '已跳过首次配置，随时可在设置里补' : '配置完成，开始导播吧');
  }).catch(function () { showView('home'); });
}

function bindSeriesControls() {
  var start = byId('homeStart');
  if (start) start.addEventListener('click', function () { matchMode = 'live'; loadMatchConfig(); });
  var mockStart = byId('homeMockStart');
  if (mockStart) mockStart.addEventListener('click', function () { matchMode = 'mock'; loadMatchConfig(); });
  ['homeMockExit', 'mockExit'].forEach(function (id) {
    var btn = byId(id);
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      postJson('/api/mock/exit', {}).then(function (data) {
        btn.disabled = false;
        if (data && data.ok === false) throw new Error(data.error || '退出失败');
        latestMatchConfig = null;
        matchMode = 'live';
        showView('home');
        toast('已退出模拟，模拟数据已清空');
      }).catch(function (error) {
        btn.disabled = false;
        toast('退出失败：' + ((error && error.message) || error), true);
      });
    });
  });
  var homeEnd = byId('homeEndSeries');
  if (homeEnd) homeEnd.addEventListener('click', function () {
    if (!latestSeries || latestSeries.status === 'idle') return;
    if (typeof window !== 'undefined' && window.confirm && !window.confirm('结束这轮比赛并回到首页？')) return;
    postSeries('end').then(function (data) {
      if (data && data.ok === false) throw new Error(data.error || '结束失败');
      toast('这轮比赛已结束');
    }).catch(function (error) { toast('结束失败：' + ((error && error.message) || error), true); });
  });
  var next = byId('postNext');
  if (next) next.addEventListener('click', function () { recordAndAdvance('next'); });
  var end = byId('postEnd');
  if (end) end.addEventListener('click', function () { recordAndAdvance('end'); });
  var bo = byId('msBestOf');
  if (bo) bo.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-bo]') : null;
    if (!target) return;
    activeBestOf = Number(target.getAttribute('data-bo')) || 3;
    renderBoButtons();
  });
  var save = byId('msSave');
  if (save) save.addEventListener('click', function () { saveMatchAndMaybeStart(false); });
  var startBtn = byId('msStart');
  if (startBtn) startBtn.addEventListener('click', function () { saveMatchAndMaybeStart(true); });
  [['msBlueLogoFile', 'msBlueLogo', 'msBlueLogoPreview'], ['msRedLogoFile', 'msRedLogo', 'msRedLogoPreview']].forEach(function (entry) {
    var input = byId(entry[0]);
    if (input) input.addEventListener('change', function () { uploadLogoFile(input, entry[1], entry[2]); });
  });
  var msLogo = byId('msBlueLogo');
  if (msLogo) msLogo.addEventListener('input', function () { setLogoPreview('msBlueLogoPreview', msLogo.value); });
  var msLogoRed = byId('msRedLogo');
  if (msLogoRed) msLogoRed.addEventListener('input', function () { setLogoPreview('msRedLogoPreview', msLogoRed.value); });
  var done = byId('obDone');
  if (done) done.addEventListener('click', function () { finishSetup(false); });
  var skip = byId('obSkip');
  if (skip) skip.addEventListener('click', function () { finishSetup(true); });
  var recheck = byId('obRecheck');
  if (recheck) recheck.addEventListener('click', refreshSetupStatus);
}

// 阶段一变就跟着换屏（用户在首页/设置里时不打断）。
var applyStateCore = applyState;
applyState = function (state) {
  applyStateCore(state);
  renderShellExtras(state);
  renderDemo(state);
  renderDraftBoard(state);
  if (state) {
    if (state.series) applySeries(state.series);
    else if (latestSeries) renderSeries();
    renderSettle(state);
  }
  var phase = state && state.phase;
  if (phase && phase !== lastPhaseForView) {
    lastPhaseForView = phase;
    var target = PHASE_VIEW[phase];
    if (target && target !== currentView && currentView !== 'home' && currentView !== 'settings') showView(target);
  }
};

document.addEventListener('click', function (event) {
  var node = event.target;
  if (!node || !node.closest) return;
  var tab = node.closest('[data-set-tab]');
  if (tab) {
    showSettingsTab(tab.getAttribute('data-set-tab'));
    return;
  }
  var nav = node.closest('[data-nav]');
  if (!nav) return;
  event.preventDefault();
  var tabName = nav.getAttribute('data-settings-tab');
  if (tabName) showSettingsTab(tabName);
  else showView(nav.getAttribute('data-nav'));
});

showView('home');

init();
`;

function consolePage(port) {
  return htmlShell('Khada Jhin 控台', `<style data-console-theme>${consoleCss()}</style>
<main class="console-shell c2-shell" id="console-shell" data-port="${port}" data-view="home">
  <header class="c2-topbar">
    <div class="c2-brand">
      <span class="c2-mark">KJ</span>
      <div class="c2-brand-copy">
        <small>KHADA JHIN / LOCAL CONTROL</small>
        <b id="tournamentLabel">连接中…</b>
      </div>
    </div>
    <nav class="c2-steps" id="view-switch" aria-label="阶段导航">
      <button type="button" data-nav="wait"><i></i>等待开始</button>
      <button type="button" data-nav="bp"><i></i>BP</button>
      <button type="button" data-nav="live"><i></i>赛中</button>
      <button type="button" data-nav="post"><i></i>赛后</button>
    </nav>
    <div class="c2-topmeta">
      <span class="c2-stat c2-stat-series"><small>系列赛</small><span class="c2-score" id="scoreChip" title="系列赛大分：双方已赢下的局数"><b class="blue" id="scoreBlue">0</b><i>:</i><b class="red" id="scoreRed">0</b></span></span>
      <span class="c2-stat c2-stat-game"><small>局数</small><b id="gameChip">BO3</b></span>
      <span class="c2-stat c2-stat-clock"><small>时间</small><b id="gameClock">--:--</b></span>
      <span class="c2-stat c2-stat-phase"><small>阶段</small><b id="phaseLabel">--</b></span>
      <span class="topbar-mode mock" id="topbarMode">MOCK</span>
      <div class="topbar-health" id="topbarHealth" aria-label="数据源健康灯">
        <span class="topbar-health-item idle" id="hlLcu" title="LCU 客户端：等待探测"><i></i>LCU</span>
        <span class="topbar-health-item idle" id="hlLive" title="Live Client Data：等待探测"><i></i>LIVE</span>
        <span class="topbar-health-item idle" id="hlObs" title="OBS WebSocket：未配置"><i></i>OBS</span>
      </div>
      <span class="conn-pill" id="connectionState"><i></i>连接中</span>
      <button type="button" class="c2-ghost-btn" id="mockExit" hidden>退出模拟</button>
      <button type="button" class="c2-ghost-btn" data-nav="home" id="homeBtn">首页</button>
      <button type="button" class="c2-ghost-btn" data-nav="settings">设置</button>
      <a class="c2-ghost-btn" id="screenshotGallery" href="#" target="_blank" rel="noopener noreferrer">截图</a>
    </div>
  </header>

  <div class="c2-demo" id="demo-bar" hidden>
    <span class="c2-demo-tag">演示</span>
    <span class="c2-demo-stage" id="demo-stage">等待开始</span>
    <span class="c2-demo-track"><i id="demo-fill"></i></span>
    <span class="c2-demo-clock" id="demo-clock">0:00 / 3:00</span>
    <span class="c2-demo-btns">
      <button type="button" id="demo-toggle">暂停</button>
      <button type="button" id="demo-replay">重播</button>
      <button type="button" class="c2-demo-speed" data-demo-speed="1">1×</button>
      <button type="button" class="c2-demo-speed" data-demo-speed="2">2×</button>
      <button type="button" class="c2-demo-speed" data-demo-speed="4">4×</button>
    </span>
  </div>

  <div class="c2-views">
    <section class="c2-view" data-view="home">
      <div class="c2-viewhead"><h1>准备一场比赛</h1><p>配置双方队伍与选手，然后按阶段往下走：等待开始 → BP → 赛中 → 赛后。每个阶段独立成屏，只在该阶段出现。</p></div>
      <article class="c2-hero">
        <div class="c2-hero-copy">
          <small>CURRENT MATCH</small>
          <h2 id="homeMatchTitle">还没有进行中的比赛</h2>
          <p id="homeMatchSub">先在「设置 · 赛事配置」里填好队伍、选手与赛制，再进入等待开始阶段。</p>
          <div class="c2-hero-actions">
            <button type="button" class="btn primary" data-nav="match" data-match-mode="live" id="homeStart">真实模式 · 配置并开始</button>
            <button type="button" class="btn ghost" data-nav="match" data-match-mode="mock" id="homeMockStart">模拟模式 · 配置并演示</button>
            <button type="button" class="btn ghost" data-nav="wait" id="homeResume" hidden>回到进行中的比赛</button>
            <button type="button" class="btn ghost" id="homeEndSeries" hidden>结束这轮比赛</button>
            <button type="button" class="btn ghost" id="homeMockExit" hidden>退出模拟</button>
          </div>
          <p class="c2-mock-note" id="homeMockNote" hidden>模拟模式用一份独立的赛事配置和独立系列赛记录，退出即清空，不影响真实数据。两种模式只能从首页切换。</p>
        </div>
        <div class="c2-hero-side">
          <div><small>系列赛</small><b id="homeSeries">--</b></div>
          <div><small>比分</small><b id="homeScore">0 : 0</b></div>
          <div><small>阶段</small><b id="homePhase">--</b></div>
        </div>
      </article>
      <div class="c2-grid-2">
      <section class="panel" id="quick-start">
      <div class="panel-head"><h2>快速开始</h2><span class="kicker">GUIDE</span></div>
      <ol class="quick-steps">
      <li><b>配置赛事</b><small>「设置 · 赛事配置」：队伍、选手、赛制（BO1/3/5）</small></li>
      <li><b>选运行模式</b><small>首页两个入口：模拟模式跑一遍完整流程，真实模式接 LCU / Live Client 打正式比赛</small></li>
      <li><b>OBS 添加广播页</b><small>「设置 · 广播源与诊断」复制聚合舞台页 URL，添加为 OBS 浏览器源（单 URL 全流程自动切换）</small></li>
      <li><b>开赛导播</b><small>「广播控制」按钮或快捷键 1/2/3/4 切换 BP / 局内 / 赛后</small></li>
      </ol>
      </section>
        <section class="panel"><div class="panel-head"><h2>已完成场次</h2><span class="kicker">HISTORY</span></div>
          <div class="c2-history" id="historyList"><div class="c2-note">还没有完成的对局。赛后阶段点「结束这轮比赛」后会在这里留下记录。</div></div>
        </section>
      </div>
    </section>

    <section class="c2-view" data-view="wait">
      <div class="c2-viewhead"><h1>等待开始</h1><p>开赛前把链路和名单过一遍；用底部 CUE 把 OBS 切到待机画面。</p></div>
      <div class="c2-grid-2">
      <section class="panel control-panel" id="control-panel">
      <div class="panel-head"><h2>比赛阶段</h2><span class="kicker">CONTROL</span></div>
      <div class="field-label">比赛阶段</div>
      <div class="segmented" id="phase-switch">
      <button type="button" data-phase="draft">赛前 BP</button>
      <button type="button" data-phase="in_game">局内</button>
      <button type="button" data-phase="post_game">赛后</button>
      </div>
      <label class="field">赛事名称<input id="tournament" value="Khada Jhin 校园赛 · 半决赛" autocomplete="off"></label>
      <button type="button" id="save" class="btn primary wide">保存赛事名称</button>
      <div class="footnote" id="phaseNote">模拟数据 · 每秒刷新，可直接用于 OBS 测试</div>
      </section>
      <section class="panel" id="source-health">
      <div class="panel-head"><h2>数据源健康</h2><span class="kicker" id="healthUpdated">--</span></div>
      <div class="health-list">
      <div class="health-row idle" data-health="lcu"><span class="health-dot"></span><div class="health-copy"><b>LCU 客户端</b><small>等待探测</small></div><em>--</em></div>
      <div class="health-row idle" data-health="live"><span class="health-dot"></span><div class="health-copy"><b>Live Client</b><small>等待探测</small></div><em>--</em></div>
      <div class="health-row idle" data-health="obs"><span class="health-dot"></span><div class="health-copy"><b>OBS WebSocket</b><small>未配置</small></div><em>--</em></div>
      <div class="health-row idle" data-health="replay"><span class="health-dot"></span><div class="health-copy"><b>Replay API</b><small>未检测到回放</small></div><em>--</em></div>
      </div>
      <button type="button" id="refreshSources" class="btn ghost wide">重新探测数据源</button>
      </section>
        <section class="panel"><div class="panel-head"><h2>首发阵容</h2><span class="kicker">STARTING LINEUP</span></div>
          <div class="c2-lineup">
  <div class="c2-lu-col" data-side="blue"><span class="c2-lu-head">蓝方</span><ol class="c2-lu-list" id="lineupBlue"><li class="c2-lu-empty">未配置选手</li></ol></div>
  <div class="c2-lu-col" data-side="red"><span class="c2-lu-head">红方</span><ol class="c2-lu-list" id="lineupRed"><li class="c2-lu-empty">未配置选手</li></ol></div>
</div>
        </section>
        <section class="panel"><div class="panel-head"><h2>开赛前检查</h2><span class="kicker">CHECKLIST</span></div>
          <ol class="c2-checklist">
            <li>OBS 已连上，场景里含 BP / 局内 / 赛后三个源</li>
            <li>广播页源指向聚合舞台页（单 URL 全流程自动切换）</li>
            <li>数据模式 = 实战数据（正式比赛）</li>
            <li>血条 / 金币喂入进程在跑</li>
          </ol>
        </section>
      </div>
    </section>

    <section class="c2-view" data-view="bp">
      <div class="c2-viewhead"><h1>BP 阶段</h1><p>选人在游戏画面里；这里跟进本局 BP 进度，CUE 在底部。</p></div>
      <article class="panel c2-draft-panel">
      <div class="panel-head"><h2>本局选人</h2><span class="kicker" id="draftRound">等待 BP</span></div>
      <div class="c2-draft" id="draftBoard"><span class="empty">等待 BP 数据…</span></div>
      </article>
      <section class="panel c2-bp-scenes">
      <div class="panel-head"><h2>OBS 场景快捷</h2><span class="kicker">SCENES</span></div>
      <div class="scene-quick" id="scene-shortcuts"><span class="empty">连接 OBS 后显示场景</span></div>
      </section>
    </section>

    <section class="c2-view" data-view="live">
      <div class="c2-viewhead"><h1>赛中</h1><p>本局比分与经济目标、十人实时数据与事件流；底部 CUE 切局内 / 转场，「设置 · 自动导播」可开规则引擎。</p></div>
      <section class="match-card c2-match-live" id="match-card">
      <div class="match-top">
      <div><span class="eyebrow">CURRENT MATCH</span><h2 id="matchTitle">当前比赛</h2></div>
      <span class="phase-badge" id="phaseBadge">--</span>
      </div>
      <div class="match-body" id="matchBody"><div class="match-placeholder">正在连接本地数据链路…</div></div>
      </section>
      <div class="c2-live-grid">
      <div class="c2-live-left">
      <section class="panel roster-panel" id="roster-panel">
      <div class="panel-head"><h2>实时选手 · KDA / 装备</h2><span class="kicker" id="rosterCount">0 / 10</span></div>
      <div class="roster-body" id="rosterBody"><div class="roster-empty">等待选手数据…</div></div>
      </section>
      </div>
      <section class="panel feed-panel">
      <div class="panel-head"><h2>实时事件流</h2><span class="kicker" id="feedCount">0 / 30</span></div>
      <div class="event-feed" id="event-feed"><div class="feed-empty">等待比赛事件…</div></div>
      </section>
      </div>
    </section>

    <section class="c2-view" data-view="post">
      <div class="c2-viewhead"><h1>赛后</h1><p>结算数据与 MVP 评选；发送后 MVP 页切到直播画面，再决定下一局或结束这轮。</p></div>
      <div class="c2-grid-2">
      <section class="panel" id="mvp-panel">
      <div class="panel-head"><h2>MVP 评选</h2><span class="kicker">MVP</span></div>
      <div class="mvp-candidates" id="mvp-candidates"><span class="empty">等待局内/赛后选手数据</span></div>
      <div class="mvp-actions">
      <button type="button" id="mvp-send" class="btn primary" disabled>发送 MVP</button>
      <button type="button" id="mvp-clear" class="btn ghost">清除</button>
      </div>
      <div class="footnote" id="mvp-note">未评选</div>
      </section>
        <section class="panel" id="settle-panel"><div class="panel-head"><h2>结算数据</h2><span class="kicker">POST GAME</span></div>
          <div class="c2-settle" id="settleBody"><div class="c2-note">本局结算（伤害 / 经济 / 目标）在赛后阶段汇总，随后进入 MVP 评选。</div></div>
          <div class="c2-actions">
            <button type="button" class="btn primary" id="postNext">下一局</button>
            <button type="button" class="btn ghost" id="postEnd">结束这轮比赛</button>
          </div>
          <div class="footnote" id="postSeriesNote">--</div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>系列赛进度</h2><span class="kicker">SERIES</span></div>
        <div class="c2-games" id="gameList"><div class="c2-note">这一轮还没有打完的局。</div></div>
      </section>
    </section>

    <section class="c2-view" data-view="setup">
      <div class="c2-viewhead">
        <h1>首次配置</h1>
        <p>三件事确认完就能开始导播。做完这一步不再出现，之后随时在「设置」里改。</p>
      </div>
      <div class="c2-grid-3">
        <section class="panel">
          <div class="panel-head"><h2>连接 OBS</h2><span class="kicker">OBS</span></div>
          <p class="c2-note">填 OBS WebSocket 地址与密码，控台才能切场景、控录制与回放。</p>
          <div class="c2-status" id="obObs">检测中…</div>
          <button type="button" class="btn ghost" data-nav="settings" data-settings-tab="connect">去填连接信息</button>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>数据源</h2><span class="kicker">LCU / LIVE</span></div>
          <p class="c2-note">LCU 需要以管理员身份启动客户端与 Khada Jhin；Live Client Data 只在观战或对局中存在。</p>
          <div class="c2-status" id="obSources">检测中…</div>
          <button type="button" class="btn ghost" id="obRecheck">重新检测</button>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>画面与 HUD</h2><span class="kicker">HUD</span></div>
          <p class="c2-note">HUD 按 1920×1080 设计坐标绘制，OBS 源尺寸变了会自动缩放；血条、装备位在赛事配置里调。</p>
          <div class="c2-status" id="obHud">默认几何</div>
          <button type="button" class="btn ghost" data-nav="settings" data-settings-tab="config">打开赛事配置</button>
        </section>
      </div>
      <div class="c2-actions">
        <button type="button" class="btn primary" id="obDone">配置完成，进入控台</button>
        <button type="button" class="btn ghost" id="obSkip">先跳过</button>
      </div>
      <div class="footnote" id="obStatus">--</div>
    </section>

    <section class="c2-view" data-view="match">
      <div class="c2-viewhead">
        <h1>配置一场比赛</h1>
        <p id="msModeNote">填双方队名、队标、选手与教练，选好 BO。点「保存并开始」会写入赛事配置并开一轮系列赛。</p>
      </div>
      <div class="c2-grid-2">
        <section class="panel">
          <div class="panel-head"><h2>赛事</h2><span class="kicker">SERIES</span></div>
          <label class="config-field wide"><span>赛事名</span><input id="msTournament" autocomplete="off" placeholder="Khada Jhin Invitational"></label>
          <div class="c2-status" id="msSeriesNow">还没有进行中的系列赛</div>
          <div class="c2-ms-bo" id="msBestOf">
            <span class="c2-ms-bl">赛制</span>
            <button type="button" class="btn ghost" data-bo="1">BO1</button>
            <button type="button" class="btn ghost" data-bo="3">BO3</button>
            <button type="button" class="btn ghost" data-bo="5">BO5</button>
          </div>
          <div class="footnote">BO3 先拿 2 局者胜，比分与第几局由系列赛自动累计。</div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>队标与队名</h2><span class="kicker">TEAMS</span></div>
          <div class="c2-ms-teams">
            <div class="c2-ms-team" data-side="blue">
              <span class="c2-ms-tag">蓝方</span>
              <label class="config-field wide"><span>队名</span><input id="msBlueName" autocomplete="off"></label>
              <div class="c2-ms-inline">
                <label class="config-field"><span>缩写</span><input id="msBlueShort" autocomplete="off" maxlength="6"></label>
                <label class="config-field"><span>队色</span><input id="msBlueColor" type="color"></label>
              </div>
              <label class="config-field wide"><span>队标路径</span><input id="msBlueLogo" autocomplete="off" placeholder="/api/uploads/..."></label>
              <label class="config-field wide logo-upload"><span>本地上传队标</span><input id="msBlueLogoFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"></label>
              <img class="c2-ms-logo" id="msBlueLogoPreview" alt="" style="display:none">
            </div>
            <div class="c2-ms-team" data-side="red">
              <span class="c2-ms-tag">红方</span>
              <label class="config-field wide"><span>队名</span><input id="msRedName" autocomplete="off"></label>
              <div class="c2-ms-inline">
                <label class="config-field"><span>缩写</span><input id="msRedShort" autocomplete="off" maxlength="6"></label>
                <label class="config-field"><span>队色</span><input id="msRedColor" type="color"></label>
              </div>
              <label class="config-field wide"><span>队标路径</span><input id="msRedLogo" autocomplete="off" placeholder="/api/uploads/..."></label>
              <label class="config-field wide logo-upload"><span>本地上传队标</span><input id="msRedLogoFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"></label>
              <img class="c2-ms-logo" id="msRedLogoPreview" alt="" style="display:none">
            </div>
          </div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>选手与教练</h2><span class="kicker">LINEUP</span></div>
        <div class="c2-ms-players" id="msPlayers"></div>
        <div class="c2-ms-coaches">
          <label class="config-field"><span>蓝方教练</span><input id="msCoachBlueName" autocomplete="off"></label>
          <label class="config-field"><span>蓝方职务</span><input id="msCoachBlueRole" autocomplete="off" placeholder="COACH"></label>
          <label class="config-field"><span>红方教练</span><input id="msCoachRedName" autocomplete="off"></label>
          <label class="config-field"><span>红方职务</span><input id="msCoachRedRole" autocomplete="off" placeholder="COACH"></label>
        </div>
      </section>
      <div class="c2-actions">
        <button type="button" class="btn primary" id="msStart">保存并开始这轮比赛</button>
        <button type="button" class="btn ghost" id="msSave">只保存配置</button>
        <button type="button" class="btn ghost" data-nav="home">返回首页</button>
      </div>
      <div class="footnote" id="msStatus">--</div>
    </section>

    <section class="c2-view" data-view="settings">
      <div class="c2-viewhead"><h1>设置</h1><p>连接、赛事配置、自动导播与广播源。保存即生效，回到对应阶段就能用。</p></div>
      <div class="c2-set-tabs" id="settings-tabs">
        <button type="button" class="active" data-set-tab="config">赛事配置</button>
        <button type="button" data-set-tab="connect">连接与设备</button>
        <button type="button" data-set-tab="director">自动导播</button>
        <button type="button" data-set-tab="sources">广播源与诊断</button>
      </div>
      <div class="c2-set-panel active" data-set-panel="config">
      <section class="panel config-panel" id="broadcast-config">
      <div class="panel-head"><h2>赛事配置</h2><span class="kicker">TEAMS / SERIES / PLAYERS</span></div>
      <div class="config-form" id="broadcastConfigForm">
      <div class="config-tabs">
      <button type="button" class="active" data-config-tab="overview">赛事</button>
      <button type="button" data-config-tab="teams">队伍</button>
      <button type="button" data-config-tab="players">选手</button>
      </div>
      <div class="config-tab-panel active" data-config-panel="overview">
      <div class="config-section">
      <h3>系列赛</h3>
      <div class="config-grid">
      <label class="config-field wide"><span>赛事名称</span><input id="seriesName" autocomplete="off"></label>
      <label class="config-field"><span>阶段</span><input id="seriesStage" autocomplete="off"></label>
      <label class="config-field"><span>游戏版本</span><input id="seriesPatch" autocomplete="off"></label>
      <label class="config-field"><span>Best of（几局几胜）</span><input id="seriesBestOf" type="number" min="1" step="1" value="3"></label>
      <div class="config-field"><span>赛制快捷</span>
      <div class="segmented compact" id="bo-quick">
      <button type="button" data-bo="1">BO1</button>
      <button type="button" data-bo="3" class="active">BO3</button>
      <button type="button" data-bo="5">BO5</button>
      </div>
      </div>
      <label class="config-field"><span>蓝方战绩</span><input id="recordBlue" type="number" step="1" value="0"></label>
      <label class="config-field"><span>红方战绩</span><input id="recordRed" type="number" step="1" value="0"></label>
      </div>
      </div>
      <div class="config-section">
      <h3>左下角遮挡卡</h3>
      <div class="config-grid">
      <label class="config-field wide"><span>标题（留空 = 赛事名称）</span><input id="coverTitle" autocomplete="off"></label>
      <label class="config-field wide"><span>内容行（每行一条，留空 = 版本 / 阶段）</span><textarea id="coverLines" rows="3" spellcheck="false"></textarea></label>
      <label class="config-field wide"><span>自定义 HTML（可选，优先级最高）</span><textarea id="coverHtml" rows="3" spellcheck="false" placeholder="&lt;div&gt;…&lt;/div&gt;"></textarea></label>
      </div>
      <div class="footnote">全部留空 = 使用默认内容（赛事名称 + 游戏版本 + 阶段）。保存后广播页实时刷新。</div>
      </div>
      <div class="config-section">
      <h3>局内快捷键</h3>
      <div class="config-grid">
      <label class="config-field wide config-check"><input type="checkbox" id="hudKeyHook"><span>局内 A 键隐藏 HUD（全局键盘钩子）</span></label>
      </div>
      <div class="footnote">勾选状态点击即保存生效：局内（in_game 阶段）按 A 同时触发 LoL 走砍与 HUD 显隐；关掉后按 A 只走砍、不再隐藏 HUD。</div>
      </div>
      <div class="config-section">
      <h3>待机屏（聚合舞台页）</h3>
      <div class="config-grid">
      <label class="config-field wide"><span>标题（留空 = 赛事名称）</span><input id="standbyTitle" autocomplete="off"></label>
      <label class="config-field wide"><span>内容行（每行一条，留空 = 对局即将开始 / 版本）</span><textarea id="standbyLines" rows="2" spellcheck="false"></textarea></label>
      </div>
      <div class="footnote">BP 结束后、对局数据就绪前的等待期显示；仅 /broadcast/stage 聚合舞台页使用。</div>
      </div>
      <div class="config-section">
      <h3>Fearless / BP</h3>
      <div class="config-grid four">
      <label class="config-field"><span>PB %</span><input id="fearlessPbPct" type="number" step="0.1" value="0"></label>
      <label class="config-field"><span>PICK %</span><input id="fearlessPickPct" type="number" step="0.1" value="0"></label>
      <label class="config-field"><span>胜场</span><input id="fearlessWins" type="number" step="1" value="0"></label>
      <label class="config-field"><span>负场</span><input id="fearlessLosses" type="number" step="1" value="0"></label>
      </div>
      </div>
      <div class="config-section">
      <div class="config-section-head"><h3>赞助商</h3><button type="button" id="broadcastSponsorAdd" class="mini-btn">+ 添加</button></div>
      <div id="sponsorEditors" class="sponsor-editors"></div>
      </div>
      </div>
      <div class="config-tab-panel" data-config-panel="teams">
      <div class="config-section">
      <h3>队伍信息</h3>
      <div class="team-config blue">
      <div class="team-config-head"><span class="team-dot"></span><b>蓝方 BLUE</b></div>
      <div class="config-grid">
      <label class="config-field wide"><span>队伍名称</span><input id="teamBlueName" autocomplete="off"></label>
      <label class="config-field"><span>简称</span><input id="teamBlueShort" autocomplete="off"></label>
      <label class="config-field"><span>赛区</span><input id="teamBlueRegion" autocomplete="off"></label>
      <label class="config-field"><span>排名</span><input id="teamBlueRank" autocomplete="off"></label>
      <label class="config-field"><span>主色</span><input id="teamBlueColor" type="color" value="#3B82F6"></label>
      <label class="config-field wide"><span>队标 URL / 路径（留空 = 简称首字母徽章）</span><input id="teamBlueLogo" autocomplete="off" placeholder="https://… 或 /logo-blue.png"></label>
      <label class="config-field wide logo-upload"><span>本地上传队标（png / jpg / webp / gif / svg）</span><input id="teamBlueLogoFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"></label>
      <img id="teamBlueLogoPreview" class="team-logo-preview" alt="队标预览">
      </div>
      </div>
      <div class="team-config red">
      <div class="team-config-head"><span class="team-dot"></span><b>红方 RED</b></div>
      <div class="config-grid">
      <label class="config-field wide"><span>队伍名称</span><input id="teamRedName" autocomplete="off"></label>
      <label class="config-field"><span>简称</span><input id="teamRedShort" autocomplete="off"></label>
      <label class="config-field"><span>赛区</span><input id="teamRedRegion" autocomplete="off"></label>
      <label class="config-field"><span>排名</span><input id="teamRedRank" autocomplete="off"></label>
      <label class="config-field"><span>主色</span><input id="teamRedColor" type="color" value="#EF4444"></label>
      <label class="config-field wide"><span>队标 URL / 路径（留空 = 简称首字母徽章）</span><input id="teamRedLogo" autocomplete="off" placeholder="https://… 或 /logo-red.png"></label>
      <label class="config-field wide logo-upload"><span>本地上传队标（png / jpg / webp / gif / svg）</span><input id="teamRedLogoFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"></label>
      <img id="teamRedLogoPreview" class="team-logo-preview" alt="队标预览">
      </div>
      </div>
      </div>
      <div class="config-section">
      <h3>教练</h3>
      <div class="config-grid">
      <label class="config-field"><span>蓝方教练</span><input id="coachBlueName" autocomplete="off"></label>
      <label class="config-field"><span>蓝方角色</span><input id="coachBlueRole" autocomplete="off"></label>
      <label class="config-field"><span>红方教练</span><input id="coachRedName" autocomplete="off"></label>
      <label class="config-field"><span>红方角色</span><input id="coachRedRole" autocomplete="off"></label>
      </div>
      </div>
      </div>
      <div class="config-tab-panel" data-config-panel="players">
      <div class="player-editor-head"><span>#</span><span>选手 ID</span><span>队伍</span><span>分路</span></div>
      <div id="playerEditors" class="player-editors"></div>
      <div class="footnote">共 10 名选手；队伍与分路会直接写入广播页数据。</div>
      </div>
      </div>
      <div class="config-actions">
      <button type="button" id="broadcastConfigLoad" class="btn ghost">重新读取</button>
      <button type="button" id="broadcastConfigSave" class="btn primary">保存配置</button>
      </div>
      <div class="status-line" id="broadcastConfigStatus">从 /api/broadcast-config 读取</div>
      <details class="config-json-details">
      <summary>高级 JSON（可选）</summary>
      <textarea id="broadcastConfigJson" spellcheck="false" rows="7" placeholder="队伍 / 选手 / 教练 / 赞助商配置 JSON"></textarea>
      <button type="button" id="broadcastConfigJsonApply" class="btn ghost wide">导入 JSON 到表单</button>
      </details>
      </section>
      </div>
      <div class="c2-set-panel" data-set-panel="connect">
      <section class="panel" id="obs-panel">
      <div class="panel-head"><h2>OBS 控制</h2><span class="status-badge offline" id="obsBadge">未连接</span></div>
      <label class="field">WebSocket 地址<input id="obsUrl" value="ws://127.0.0.1:4455" autocomplete="off"></label>
      <label class="field">密码<input id="obsPass" type="password" placeholder="OBS → 工具 → WebSocket 服务器设置" autocomplete="off"></label>
      <button type="button" id="obsConnect" class="btn primary wide">连接 OBS</button>
      <button type="button" id="obsRebrand" class="btn wide">一键换源（改名 + 重指 URL）</button>
      <div class="status-line" id="obsStatus">未连接</div>
      <div class="stat-grid">
      <div><small>当前场景</small><b id="obsCurrent">--</b></div>
      <div><small>录制状态</small><b id="obsRecording">未接入</b></div>
      <div><small>推流状态</small><b id="obsStream">--</b></div>
      <div><small>回放缓冲</small><b id="obsReplay">--</b></div>
      </div>
      <div class="button-grid">
      <button type="button" data-obs-record="start">开始录制</button>
      <button type="button" data-obs-record="stop">停止录制</button>
      <button type="button" data-obs-stream="start">开始推流</button>
      <button type="button" data-obs-stream="stop">停止推流</button>
      <button type="button" data-obs-replay="save">保存回放</button>
      </div>
      <div class="field-label">场景列表</div>
      <div class="scene-grid" id="obsScenes"><span class="empty">暂无场景</span></div>
      <div class="field-label">阶段自动切换</div>
      <div class="obs-auto"><span class="empty">连接 OBS 后可配置自动切换</span></div>
      </section>
      <section class="panel" id="replay-panel">
      <div class="panel-head"><h2>回放镜头</h2><span class="status-badge offline" id="replayBadge">未连接</span></div>
      <div class="status-line" id="replayStatus">未检测到回放</div>
      <div class="button-grid">
      <button type="button" data-replay="pause">暂停</button>
      <button type="button" data-replay="play">播放</button>
      <button type="button" data-speed="0.5">0.5×</button>
      <button type="button" data-speed="1">1×</button>
      <button type="button" data-speed="2">2×</button>
      <button type="button" data-speed="4">4×</button>
      <button type="button" data-fov="30">近景 30°</button>
      <button type="button" data-fov="45">标准 45°</button>
      <button type="button" data-fov="60">广角 60°</button>
      </div>
      <div class="replay-details" id="replayDetails"><div class="detail-row"><span>播放位置</span><b>--</b></div><div class="detail-row"><span>镜头 FOV</span><b>--</b></div></div>
      </section>
      </div>
      <div class="c2-set-panel" data-set-panel="director">
      <section class="panel director-panel" id="director-panel">
      <div class="panel-head"><h2>自动导播</h2><span class="status-badge offline" id="directorBadge">读取中</span></div>
      <div class="director-hint"><i></i><span>规则引擎仅在 live 模式生效</span></div>
      <label class="director-toggle">
      <span class="director-toggle-copy"><b>启用规则引擎</b><small>高光分数达到阈值时自动触发广播 CUE</small></span>
      <input id="directorEnabled" type="checkbox" checked>
      </label>
      <div class="director-threshold">
      <label class="director-field"><span>高光阈值</span><input id="directorThreshold" type="number" min="0" max="100000" step="1" value="50"></label>
      <input id="directorThresholdRange" type="range" min="0" max="100" step="1" value="50" aria-label="高光阈值滑杆">
      </div>
      <div class="director-grid">
      <label class="director-field"><span>高光触发 CUE</span><select id="directorCue"><option value="bp-in">BP 入场</option><option value="hud-in">局内入场</option><option value="result-in">赛后庆祝</option><option value="wipe">转场</option><option value="reset">重置</option></select></label>
      <label class="director-field"><span>冷却（秒）</span><input id="directorCooldown" type="number" min="0" max="86400" step="0.1" value="15"></label>
      </div>
      <div class="director-grid director-phase-grid">
      <label class="director-field"><span>BP 阶段 CUE</span><select id="directorDraftCue"><option value="bp-in">BP 入场</option><option value="hud-in">局内入场</option><option value="result-in">赛后庆祝</option><option value="wipe">转场</option><option value="reset">重置</option></select></label>
      <label class="director-field"><span>赛后阶段 CUE</span><select id="directorPostCue"><option value="bp-in">BP 入场</option><option value="hud-in">局内入场</option><option value="result-in">赛后庆祝</option><option value="wipe">转场</option><option value="reset">重置</option></select></label>
      </div>
      <div class="director-runtime">
      <div class="director-runtime-row wide"><span>上次触发</span><b id="directorLastTrigger">暂无触发</b></div>
      <div class="director-runtime-row"><span>冷却剩余</span><b id="directorCooldownRemaining" class="director-cooldown ready">就绪</b></div>
      </div>
      <div class="config-actions director-actions">
      <button type="button" id="directorReload" class="btn ghost">重新读取</button>
      <button type="button" id="directorSave" class="btn primary">保存规则</button>
      </div>
      <div class="status-line" id="directorStatus">从 /api/director/rules 读取</div>
      </section>
      </div>
      <div class="c2-set-panel" data-set-panel="sources">
      <section class="panel" id="broadcast-pages">
      <div class="panel-head"><h2>广播页</h2><span class="kicker">BROADCAST</span></div>
      <div class="url-list broadcast-url-list" id="broadcast-urls"></div>
      </section>
      <section class="panel">
      <div class="panel-head"><h2>Overlay 浏览器源</h2><span class="kicker">SOURCES</span></div>
      <div class="url-list" id="urls"></div>
      </section>
      <details class="panel diag-panel">
      <summary>运行诊断</summary>
      <pre id="state">连接中…</pre>
      </details>
      </div>
    </section>
  </div>

  <div class="c2-dock" id="cue-dock" hidden>
      <section class="panel" id="broadcast-control">
      <div class="panel-head"><h2>广播控制</h2><span class="kicker">MANUAL CUE</span></div>
      <div class="cue-status"><span>当前 Cue</span><b id="cueType">待机</b><em id="cueSeq">SEQ --</em></div>
      <div class="cue-grid">
      <button type="button" data-cue="bp-in" class="btn primary">BP 入场</button>
      <button type="button" data-cue="hud-in">局内入场</button>
      <button type="button" data-cue="result-in">赛后庆祝</button>
      <button type="button" data-cue="wipe">转场</button>
      <button type="button" data-cue="reset">重置</button>
      </div>
      <div class="footnote">手动触发广播页动画；POST /api/broadcast/cue · 快捷键 1/2/3/4 · Esc 重置</div>
      </section>
  </div>

  <div class="console-toast" id="console-toast" role="status"></div>
</main>`, assets.clientScript() + '\n' + CONSOLE_SCRIPT);
}

module.exports = { consolePage };
