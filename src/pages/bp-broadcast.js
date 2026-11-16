'use strict';

// BP / 阵容广播页（参考图 1 高配版）。旧 /overlay/bp 保留不动。
// public/bp-broadcast.css 与 public/anim.js 由本模块内联注入，避免增加静态路由。
const fs = require('fs');
const path = require('path');
const { htmlShell } = require('./html');
const assets = require('../assets');

let cssCache = null;
function broadcastCss() {
  if (cssCache === null) {
    try {
      cssCache = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'bp-broadcast.css'), 'utf8');
    } catch {
      cssCache = '';
    }
  }
  return cssCache;
}

let animCache = null;
function animationJs() {
  if (animCache === null) {
    try {
      animCache = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'anim.js'), 'utf8');
    } catch {
      animCache = '';
    }
  }
  return animCache;
}

let lockCache = null;
function lockJs() {
  if (lockCache === null) {
    try {
      lockCache = fs.readFileSync(path.join(__dirname, 'bp-lock.js'), 'utf8');
    } catch {
      lockCache = '';
    }
  }
  return lockCache;
}

const PAGE_SCRIPT = String.raw`(function () {
  'use strict';
  var ROOT = document.getElementById('bp-broadcast');
  if (!ROOT) return;
  document.body.classList.add('bb-body');
  try { if (document.documentElement) document.documentElement.classList.add('bb-html'); } catch (error) {}
  var RB = window.RBAssets || {};
  var A = window.RBAnim || {};
  var L = window.RBLock || {};
  if (animationsDisabled()) document.body.classList.add('bb-anim-off');
  var state = null;
  var config = null;
  var lastPhase = null;
  var lastCueSeq = null;
  var lastSlots = null;
  var introRunning = false;
  var ROLE_CN = { TOP: '上单', JUNGLE: '打野', MID: '中单', ADC: '下路', SUPPORT: '辅助' };
  var ROLE_ORDER = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'];
  // 分路标志（内联 SVG path，currentColor）
  var ROLE_SVG = {
    TOP: 'M3 3h18v4H7v14H3V3z',
    JUNGLE: 'M12 2c2.8 3.9 6.5 6.1 6.5 10.6A6.5 6.5 0 1 1 5.5 12.6C5.5 8.1 9.2 5.9 12 2z',
    MID: 'M6.2 19.4 19.4 6.2v4.8L11 19.4H6.2z',
    ADC: 'M21 3v18H3v-4h14V3h4z',
    SUPPORT: 'M12 2 22 12 12 22 2 12 12 2zM12 7 7 12l5 5 5-5-5-5z'
  };
  // 锁定聚光 FIFO 队列（每手 2s，逐个放）
  var spotQueue = [];
  var spotActive = null;
  // 选边/倒计时线插值状态
  var tlState = { remaining: null, at: 0, total: 30, raw: null };

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  function byId(id) { return document.getElementById(id); }
  function text(value, fallback) {
    var result = value === null || value === undefined ? '' : String(value).trim();
    return result || (fallback === undefined ? '' : fallback);
  }
  function cfg() {
    if (config) return config;
    if (state && state.broadcastConfig) return state.broadcastConfig;
    return {};
  }
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
      series: Object.assign({}, left.series, right.series),
      fearless: Object.assign({}, left.fearless, right.fearless)
    };
  }
  function draft() {
    // live 模式下只有 LCU parsed=true 才使用 state.draft；否则空 BP，避免显示 mock 或上一局。
    var source = {};
    if (state) {
      if (state.mode === 'live') {
        if (state.live && state.live.draft && state.live.draft.parsed === true) source = state.draft || {};
      } else {
        source = state.draft || {};
      }
    }
    return {
      round: text(source.round, 'BP'),
      timer: num(source.timer),
      active: text(source.active, 'blue'),
      bluePicks: Array.isArray(source.bluePicks) ? source.bluePicks : [],
      redPicks: Array.isArray(source.redPicks) ? source.redPicks : [],
      blueBans: Array.isArray(source.blueBans) ? source.blueBans : [],
      redBans: Array.isArray(source.redBans) ? source.redBans : [],
      blueHover: Array.isArray(source.blueHover) ? source.blueHover : [],
      redHover: Array.isArray(source.redHover) ? source.redHover : [],
      blueBanHover: Array.isArray(source.blueBanHover) ? source.blueBanHover : [],
      redBanHover: Array.isArray(source.redBanHover) ? source.redBanHover : []
    };
  }
  function hasDraftData() {
    var d = draft();
    return Boolean(d.bluePicks.length || d.redPicks.length || d.blueBans.length || d.redBans.length);
  }
  function showDemoData() {
    if (!state) return true;
    if (state.mode === 'mock') return true;
    if (!state.live || !state.live.draft || state.live.draft.parsed !== true) return true;
    return !hasDraftData();
  }
  function pickList(side) {
    var d = draft();
    return side === 'blue' ? d.bluePicks : d.redPicks;
  }
  function banList(side) {
    var d = draft();
    return side === 'blue' ? d.blueBans : d.redBans;
  }
  // ban 悬停预览：数组形状与 pick 悬停相同（5 槽，null 占位），复用同一规范化。
  function banHoverList(side) {
    var d = draft();
    return normalizedPicks(side === 'blue' ? d.blueBanHover : d.redBanHover);
  }
  function normalizedPicks(list) {
    var result = [];
    for (var i = 0; i < 5; i += 1) {
      var value = Array.isArray(list) ? list[i] : null;
      if (value && typeof value === 'object') value = value.champion !== undefined ? value.champion : value.name;
      var textValue = value === null || value === undefined ? '' : String(value).trim();
      result.push(textValue || null);
    }
    return result;
  }
  function currentSlots() {
    var d = draft();
    return { blue: normalizedPicks(d.bluePicks), red: normalizedPicks(d.redPicks) };
  }
  function animationsDisabled() {
    try {
      if (new URLSearchParams(window.location.search || '').get('bpAnim') === '0') return true;
    } catch (error) {}
    return !!(A.prefersReducedMotion && A.prefersReducedMotion());
  }
  function teamConfig(side) {
    var all = cfg();
    return (all.teams && all.teams[side]) || {};
  }
  function configPlayers(side) {
    var all = cfg();
    return (all.players || []).filter(function (player) { return player && player.team === side; });
  }
  function livePlayers(side) {
    return (state && Array.isArray(state.players) ? state.players : []).filter(function (player) {
      return player && player.team === side;
    });
  }
  function playerKey(value) {
    return String(value === null || value === undefined ? '' : value).replace(/#.*$/, '').trim().toLowerCase();
  }
  function isLiveClientPlayer(player) {
    // mock 选手没有 Live Client Data 的这些字段；不能让启动 mock 或上一局数据冒充 BP 名单。
    return Boolean(player && ('wardScore' in player || 'respawnTimer' in player || 'position' in player || 'isBot' in player));
  }
  function matchingLivePlayer(side, configured) {
    if (!state || !state.live || !state.live.game || state.live.game.parsed !== true) return null;
    var wanted = [configured.gameName, configured.displayName, configured.name].map(playerKey).filter(Boolean);
    if (!wanted.length) return null;
    var candidates = livePlayers(side);
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      if (!isLiveClientPlayer(candidate)) continue;
      var actual = [candidate.name, candidate.displayName, candidate.gameName].map(playerKey).filter(Boolean);
      for (var j = 0; j < actual.length; j += 1) {
        if (wanted.indexOf(actual[j]) !== -1) return candidate;
      }
    }
    return null;
  }
  function playerAt(side, index) {
    var picks = pickList(side);
    var base = {};
    // live BP 的 name/role 以 config 名单为准；仅真实 Live Client 玩家同队同名时才覆盖。
    if (state && state.mode === 'live') {
      base = configPlayers(side)[index] || {};
      var live = matchingLivePlayer(side, base);
      if (live) base = Object.assign({}, base, live);
    } else {
      base = livePlayers(side)[index] || configPlayers(side)[index] || {};
    }
    var champion = text(base.champion, text(picks[index], ''));
    return {
      name: text(base.displayName, text(base.name, text(base.gameName, '—'))),
      champion: champion,
      role: text(base.role, ROLE_ORDER[index] || ''),
      photo: text(base.photo, ''),
      summoners: Array.isArray(base.summoners) && base.summoners.length ? base.summoners : ['闪现', '引燃']
    };
  }
  function artUrl(player) {
    if (player.photo) return player.photo;
    if (player.champion && RB.championCenteredSplashUrl) return RB.championCenteredSplashUrl(player.champion);
    if (player.champion && RB.championSplashUrl) return RB.championSplashUrl(player.champion, RB.version);
    return '';
  }
  function splashFallbackUrl(player) {
    if (player.photo) return '';
    if (player.champion && RB.championSplashUrl) return RB.championSplashUrl(player.champion, RB.version);
    return '';
  }
  function initial(team, side) {
    return text(team.shortName, text(team.name, side === 'blue' ? 'B' : 'R')).slice(0, 1).toUpperCase();
  }
  function logoMarkup(team, side) {
    var url = text(team.logo, '');
    var html = '<span class="bb-logo-fallback">' + esc(initial(team, side)) + '</span>';
    if (url) html += '<img src="' + esc(url) + '" alt="" loading="lazy" onerror="this.remove()">';
    return html;
  }
  function icon(kind, value, label) {
    if (RB.icon) return RB.icon(kind, value, label, '', RB.version);
    return '<span class="icon"><i class="icon-fb">' + esc(String(value || '·').slice(0, 1)) + '</i></span>';
  }
  // 分路标志：客户端 ChampSelect 官方图标（public/assets/positions/），金色 #c8aa6e
  var ROLE_FILE = { TOP: 'top', JUNGLE: 'jungle', MID: 'middle', ADC: 'bottom', SUPPORT: 'utility' };
  function roleImg(role) {
    var key = String(role || '').toUpperCase();
    var file = ROLE_FILE[key] || ROLE_FILE.SUPPORT;
    return '<img src="/assets/positions/position-' + file + '.svg" alt="">';
  }
  // 舞台 tile 只建一次骨架（img 节点常驻），之后全部就地更新，不再销毁重建——
  // 已缓存原画不会因节点重建重新解码闪帧；换英雄时等 onload 解码完成再淡入。
  function tileSkeleton(index) {
    return '<div class="bb-stage-tile bb-stagger no-pick no-art" data-index="' + index + '" title="">' +
      '<span class="bb-stage-art"><img alt=""></span>' +
      '<div class="bb-pid"><span class="bb-pid-name"></span><span class="bb-role"></span></div>' +
      '</div>';
  }
  var PREWARMED = {};
  function prewarm(champion) {
    var url = champion && RB.championCenteredSplashUrl ? RB.championCenteredSplashUrl(champion) : '';
    if (!url || PREWARMED[url]) return;
    PREWARMED[url] = true;
    var img = new Image();
    img.src = url;
  }
  function ensureTiles(tiles) {
    if (tiles.__bbTiles) return tiles.__bbTiles;
    tiles.innerHTML = '';
    var list = [];
    for (var i = 0; i < 5; i += 1) {
      var holder = document.createElement('div');
      holder.innerHTML = tileSkeleton(i);
      var tile = holder.firstChild;
      tiles.appendChild(tile);
      list.push(tile);
    }
    tiles.__bbTiles = list;
    return list;
  }
  function updateTile(tile, player, side, index) {
    var url = artUrl(player);
    var fallback = splashFallbackUrl(player);
    var picked = Boolean(player.champion);
    // 逐类切换而非整体覆写 className：保留 intro 的 bb-in 与锁定动画的 bb-lock
    tile.classList.toggle('no-pick', !picked);
    tile.classList.toggle('no-art', !url);
    tile.classList.toggle('bb-hover', Boolean(player.preview));
    tile.classList.toggle('bb-spot', Boolean(spotActive && spotActive.side === side && spotActive.index === index));
    var title = player.champion || '';
    if (tile.getAttribute('title') !== title) tile.setAttribute('title', title);
    var art = tile.querySelector('.bb-stage-art');
    var img = art ? art.querySelector('img') : null;
    if (art && img) {
      var artSig = url + '|' + (fallback && fallback !== url ? fallback : '');
      if (tile.__bbArt !== artSig) {
        tile.__bbArt = artSig;
        art.classList.remove('bb-art-in');
        art.style.backgroundImage = url ? 'url(' + url + ')' : '';
        if (url) {
          if (fallback && fallback !== url) img.setAttribute('data-fallback', fallback);
          else img.removeAttribute('data-fallback');
          img.onload = function () { art.classList.add('bb-art-in'); };
          img.src = url;
        } else {
          img.removeAttribute('data-fallback');
          img.removeAttribute('src');
        }
      }
      // 图未变只是状态翻转（hover 预览转锁定）且早已解码完成：确保可见
      if (url && picked && img.complete && img.naturalWidth > 0) art.classList.add('bb-art-in');
    }
    var pidName = tile.querySelector('.bb-pid-name');
    if (pidName && pidName.textContent !== player.name) pidName.textContent = player.name;
    var roleEl = tile.querySelector('.bb-role');
    if (roleEl) {
      var roleKey = String(player.role || '').toUpperCase();
      if (roleEl.__bbRole !== roleKey) {
        roleEl.__bbRole = roleKey;
        roleEl.innerHTML = roleImg(player.role);
        roleEl.setAttribute('title', ROLE_CN[roleKey] || roleKey || '');
      }
    }
  }
  function buildShell() {
    ROOT.innerHTML = '' +
      '<div class="bb-bar" id="bb-bar">' +
        '<div class="bb-timeline" id="bb-timeline"><div class="bb-timeline-fill blue" id="bb-timeline-fill"></div></div>' +
        '<div class="bb-coach-strip blue" id="bb-coach-strip-blue"><div class="bb-coach" id="bb-coach-blue"></div><div class="bb-ban-group" id="bb-bans-blue"></div></div>' +
        '<div class="bb-coach-strip red" id="bb-coach-strip-red"><div class="bb-coach" id="bb-coach-red"></div><div class="bb-ban-group" id="bb-bans-red"></div></div>' +
        '<div class="bb-row" id="bb-row">' +
          '<div class="bb-picks blue" id="bb-stage-blue"></div>' +
          '<section class="bb-center" id="bb-info">' +
          '<div class="bb-pips"><span class="bb-pip-row" id="bb-pips-blue"></span><span class="bb-info-vs">VS</span><span class="bb-pip-row" id="bb-pips-red"></span></div>' +
          '<div class="bb-teams">' +
            '<div class="bb-team blue" id="bb-team-blue"><div class="bb-team-logo" id="bb-team-logo-blue"><span class="bb-logo-fallback">B</span></div><b class="bb-team-name" id="bb-team-name-blue">蓝方</b><span class="bb-team-side">BLUE SIDE</span></div>' +
            '<span class="bb-info-vs">VS</span>' +
            '<div class="bb-team red" id="bb-team-red"><div class="bb-team-logo" id="bb-team-logo-red"><span class="bb-logo-fallback">R</span></div><b class="bb-team-name" id="bb-team-name-red">红方</b><span class="bb-team-side">RED SIDE</span></div>' +
          '</div>' +
          '<div class="bb-first-pick" id="bb-first-pick">BLUE SIDE ◀ 1ST PICK</div>' +
          '<div class="bb-info-sep"></div>' +
            '<div class="bb-patch" id="bb-patch">PATCH —</div>' +
          '</section>' +
          '<div class="bb-picks red" id="bb-stage-red"></div>' +
        '</div>' +
        '<div class="bb-demo" id="bb-demo">DEMO DATA</div>' +
      '</div>';
  }

  // 品牌栏/赞助商节点已随视觉改版移除，这里只剩 DEMO 徽标开关。
  function renderBrand() {
    var demo = byId('bb-demo');
    if (demo) demo.classList.toggle('show', showDemoData());
  }

  function setHtml(node, html) {
    if (!node) return;
    if (node.__rbHtml === html) return;
    node.__rbHtml = html;
    node.innerHTML = html;
  }
  function hoverList(side) {
    var d = draft();
    return normalizedPicks(side === 'blue' ? d.blueHover : d.redHover);
  }
  function renderStage() {
    ['blue', 'red'].forEach(function (side) {
      var tiles = byId('bb-stage-' + side);
      if (!tiles) return;
      var players = [];
      var i;
      for (i = 0; i < 5; i += 1) players.push(playerAt(side, i));
      // 悬停预览：该侧第一个悬停英雄放进第一个空槽（与锁定后按 cellId 顺序填充一致）；
      // 锁定后悬停 action 变 completed，预览消失、正式头像出现在同一槽位。
      var hovers = hoverList(side);
      var hoverVal = null;
      for (i = 0; i < 5; i += 1) { if (hovers[i]) { hoverVal = hovers[i]; break; } }
      if (hoverVal) {
        for (i = 0; i < 5; i += 1) {
          if (!players[i].champion) { players[i] = Object.assign({}, players[i], { champion: hoverVal, preview: true }); break; }
        }
      }
      var list = ensureTiles(tiles);
      for (i = 0; i < 5; i += 1) updateTile(list[i], players[i], side, i);
      // hover 一出现就预载原画（本地缓存路由），锁定瞬间图已就位
      for (i = 0; i < hovers.length; i += 1) prewarm(hovers[i]);
    });
  }

  function renderCoaches() {
    var all = cfg();
    ['blue', 'red'].forEach(function (side) {
      var node = byId('bb-coach-' + side);
      if (!node) return;
      var coach = (all.coaches || []).filter(function (item) { return item && item.team === side; })[0] || {};
      node.innerHTML = '<span>COACH:</span><b>' + esc(text(coach.name, '—')) + '</b>' + (coach.role ? '<small>' + esc(coach.role) + '</small>' : '');
    });
  }

  // isHover=true 时画成悬停预览格（半透明+呼吸边，见 bb-ban-hover 样式）。
  function banMarkup(champion, isHover) {
    if (!champion) return '<span class="bb-ban empty" title="未禁用"></span>';
    return '<span class="bb-ban banned' + (isHover ? ' bb-ban-hover' : '') + '" title="' + esc(champion) + '">' + icon('champion', champion, champion) + '</span>';
  }
  function renderBans() {
    ['blue', 'red'].forEach(function (side) {
      var node = byId('bb-bans-' + side);
      if (!node) return;
      var bans = banList(side);
      // 悬停预览填进第一个空 ban 槽；已锁定的 ban 不被预览覆盖（真实值优先）。
      var hovers = banHoverList(side);
      var hoverVal = null;
      for (var i = 0; i < 5; i += 1) if (hovers[i]) { hoverVal = hovers[i]; break; }
      var previewUsed = false;
      var html = '';
      for (var i = 0; i < 5; i += 1) {
        var champion = bans[i];
        var isHover = false;
        if (!champion && hoverVal && !previewUsed) { champion = hoverVal; isHover = true; previewUsed = true; }
        html += banMarkup(champion, isHover);
      }
      setHtml(node, html);
    });
  }

  function renderInfo() {
    var all = cfg();
    var d = draft();
    var series = all.series || {};
    var first = byId('bb-first-pick');
    var patch = byId('bb-patch');
    if (first) first.textContent = (d.active === 'red' ? 'RED SIDE' : 'BLUE SIDE') + ' ◀ 1ST PICK';
    if (patch) patch.textContent = 'PATCH ' + text(series.patch, text(state && state.patch, RB.version || '—'));
    ['blue', 'red'].forEach(function (side) {
      var team = teamConfig(side);
      var logo = byId('bb-team-logo-' + side);
      var name = byId('bb-team-name-' + side);
      if (logo) logo.innerHTML = logoMarkup(team, side);
      if (name) name.textContent = text(team.name, side === 'blue' ? '蓝方' : '红方');
    });
    renderPips();
  }

  // 系列赛胜场格：config.series.bestOf 决定格数，records.blue/red 决定已胜数
  function renderPips() {
    var series = (cfg().series || {});
    var bestOf = num(series.bestOf);
    var need = Math.max(1, Math.ceil((bestOf > 0 ? bestOf : 3) / 2));
    var rec = series.records || {};
    var blueWins = Math.max(0, Math.min(need, num(rec.blue)));
    var redWins = Math.max(0, Math.min(need, num(rec.red)));
    function row(wins, cls) {
      var html = '';
      for (var i = 0; i < need; i += 1) html += '<span class="bb-pip' + (i < wins ? ' won ' + cls : '') + '"></span>';
      return html;
    }
    var blue = byId('bb-pips-blue');
    var red = byId('bb-pips-red');
    if (blue) blue.innerHTML = row(blueWins, 'blue');
    if (red) red.innerHTML = row(redWins, 'red');
  }

  // 选边权 + 倒计时线：收到新 timer 后 rAF 秒内插值，双端向心收缩 scaleX
  function timelineUpdate() {
    var fill = byId('bb-timeline-fill');
    if (!fill) return;
    var rawDraft = state && state.draft ? state.draft : null;
    var raw = rawDraft && rawDraft.timer !== null && rawDraft.timer !== undefined && Number.isFinite(Number(rawDraft.timer)) ? Number(rawDraft.timer) : null;
    var side = rawDraft ? text(rawDraft.active, 'blue') : 'blue';
    fill.classList.toggle('blue', side !== 'red');
    fill.classList.toggle('red', side === 'red');
    if (raw === null) {
      tlState.remaining = null;
      fill.style.transform = 'scaleX(1)';
      return;
    }
    if (tlState.raw === null || raw > tlState.raw) tlState.total = Math.max(raw, 10);
    tlState.raw = raw;
    tlState.remaining = raw;
    tlState.at = Date.now();
  }
  function timelineFrame() {
    var fill = byId('bb-timeline-fill');
    if (fill && tlState.remaining !== null) {
      var rem = Math.max(0, tlState.remaining - (Date.now() - tlState.at) / 1000);
      var ratio = Math.max(0, Math.min(1, rem / (tlState.total || 30)));
      fill.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
    }
    requestAnimationFrame(timelineFrame);
  }
  requestAnimationFrame(timelineFrame);

  // 锁定聚光队列：队头槽位放大 2s → 缩回 → 下一手
  function applySpots() {
    ['blue', 'red'].forEach(function (side) {
      var tiles = byId('bb-stage-' + side);
      if (!tiles) return;
      Array.prototype.forEach.call(tiles.querySelectorAll('.bb-stage-tile'), function (node) {
        var index = Number(node.getAttribute('data-index'));
        node.classList.toggle('bb-spot', Boolean(spotActive && spotActive.side === side && spotActive.index === index));
      });
    });
  }
  function enqueueSpot(lock) {
    if (!lock || animationsDisabled()) return;
    spotQueue.push({ side: lock.side, index: lock.index });
    runSpotQueue();
  }
  function runSpotQueue() {
    if (spotActive || !spotQueue.length || animationsDisabled()) return;
    spotActive = spotQueue.shift();
    applySpots();
    window.setTimeout(function () {
      spotActive = null;
      applySpots();
      window.setTimeout(runSpotQueue, 480);
    }, 2000);
  }

  function renderAll(nextState) {
    if (nextState) state = nextState;
    if (!ROOT.querySelector('.bb-bar')) buildShell();
    if (introRunning) { renderBrand(); renderInfo(); return; }
    renderBrand();
    renderStage();
    renderCoaches();
    renderBans();
    renderInfo();
    timelineUpdate();
    if (ROOT.classList.contains('bb-ready')) {
      Array.prototype.forEach.call(ROOT.querySelectorAll('.bb-stage-tile,.bb-center,.bb-timeline'), function (node) {
        node.classList.add('bb-in');
      });
    }
  }

  function playIntro() {
    if (!ROOT || introRunning) return;
    introRunning = true;
    ROOT.classList.remove('bb-ready');
    var timeline = byId('bb-timeline');
    var info = byId('bb-info');
    var tiles = Array.prototype.slice.call(ROOT.querySelectorAll('.bb-stage-tile'));
    if (animationsDisabled()) {
      ROOT.classList.add('bb-ready');
      introRunning = false;
      return;
    }
    if (timeline) { timeline.classList.add('bb-in'); }
    if (A.staggerIn) {
      A.staggerIn(tiles.slice(0, 5), { step: 60, className: 'bb-in', flashClass: 'bb-flash' });
      A.staggerIn(tiles.slice(5), { step: 60, className: 'bb-in', flashClass: 'bb-flash' });
    } else {
      tiles.forEach(function (node) { node.classList.add('bb-in'); });
    }
    window.setTimeout(function () {
      if (info) info.classList.add('bb-in');
    }, 450);
    window.setTimeout(function () {
      ROOT.classList.add('bb-ready');
      introRunning = false;
    }, 1250);
  }

  function clearLock(node) {
    if (!node) return;
    if (node.__bbLockTimer) {
      window.clearTimeout(node.__bbLockTimer);
      node.__bbLockTimer = null;
    }
    node.classList.remove('bb-lock');
    node.style.animationDelay = '';
    if (node.style.removeProperty) node.style.removeProperty('--bb-lock-delay');
    var badge = node.querySelector ? node.querySelector('.bb-lock-badge') : null;
    if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
  }

  function animateLock(node, delay) {
    if (!node) return;
    clearLock(node);
    void node.offsetWidth;
    node.classList.add('bb-lock');
    node.style.animationDelay = delay + 'ms';
    if (node.style.setProperty) node.style.setProperty('--bb-lock-delay', delay + 'ms');
    node.__bbLockTimer = window.setTimeout(function () {
      clearLock(node);
    }, 1200 + delay + 60);
  }

  function playLock(lock, order) {
    var delay = Math.max(0, order) * 80;
    var stageWrap = byId('bb-stage-' + lock.side);
    var tile = stageWrap ? stageWrap.querySelector('.bb-stage-tile[data-index="' + lock.index + '"]') : null;
    animateLock(tile, delay);
  }

  function playLocks(locks) {
    if (!locks || !locks.length) return;
    locks.forEach(function (lock, order) {
      playLock(lock, order);
      enqueueSpot(lock);
    });
  }

  function replayIntro(withWipe) {
    if (withWipe && A.sceneWipe) A.sceneWipe(ROOT, { duration: 360 });
    renderAll(state);
    window.setTimeout(playIntro, withWipe ? 180 : 0);
  }

  function update(nextState) {
    if (!nextState || typeof nextState !== 'object') return;
    var previousPhase = lastPhase;
    var previousCue = lastCueSeq;
    state = nextState;
    renderAll(nextState);
    timelineUpdate();
    var nextSlots = currentSlots();
    var locks = L.diffLocks ? L.diffLocks(lastSlots, nextSlots) : [];
    lastSlots = nextSlots;
    var cue = nextState.broadcastCue || {};
    var cueSeq = Number(cue.seq);
    var phase = text(nextState.phase, '');
    var phaseChanged = (phase === 'draft' && previousPhase !== 'draft');
    var cueTriggered = cue.type === 'bp-in' && Number.isFinite(cueSeq) && cueSeq !== previousCue;
    lastPhase = phase;
    lastCueSeq = Number.isFinite(cueSeq) ? cueSeq : previousCue;
    if (!phaseChanged && !cueTriggered) playLocks(locks);
    if (phaseChanged || cueTriggered) replayIntro(true);
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      return response && response.ok ? response.json() : null;
    }).catch(function () { return null; });
  }

  // 居中版原画加载失败 → data-fallback 回退 ddragon 原图；再失败隐藏
  ROOT.addEventListener('error', function (event) {
    var node = event.target;
    if (!node || node.tagName !== 'IMG') return;
    if (node.dataset && node.dataset.fallback) {
      node.src = node.dataset.fallback;
      delete node.dataset.fallback;
    } else {
      node.style.display = 'none';
    }
  }, true);

  buildShell();
  Promise.all([fetchJson('/api/state'), fetchJson('/api/broadcast-config')]).then(function (results) {
    var loadedState = results[0];
    var loadedConfig = results[1];
    if (loadedConfig) config = mergeConfig(loadedConfig, loadedState && loadedState.broadcastConfig);
    else if (loadedState && loadedState.broadcastConfig) config = loadedState.broadcastConfig;
    if (loadedState) {
      renderAll(loadedState);
      lastSlots = currentSlots();
      playIntro();
    }
  });

  var es = new EventSource('/events');
  es.onmessage = function (event) {
    try { update(JSON.parse(event.data)); } catch (error) { /* 保留上一帧 */ }
  };
})();`;

function bpBroadcastPage() {
  const body = '<style data-bp-broadcast-theme>' + broadcastCss() + '</style>' +
    '<main id="bp-broadcast" class="bp-broadcast"><div class="bb-loading">正在载入 BP 数据…</div></main>';
  return htmlShell('Khada Jhin · BP Broadcast', body, assets.clientScript() + '\n' + animationJs() + '\n' + lockJs() + '\n' + PAGE_SCRIPT);
}

module.exports = { bpBroadcastPage };
