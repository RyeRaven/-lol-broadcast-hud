'use strict';

// 聚合舞台页（Stage Router）：单浏览器源承载 BP / 局内 HUD / 赛后三层，
// 根据广播 cue 与阶段自动切换；切换由全屏转场（wipe）桥接，等待期显示待机屏。
// 旧的三页路由（/broadcast/bp|hud|result）保留不动，本页是其聚合层。
const fs = require('fs');
const path = require('path');
const { htmlShell } = require('./html');

const STAGE_CSS = String.raw`
html, body { margin: 0; padding: 0; background: transparent !important; overflow: hidden; }
.stage-broadcast { position: fixed; inset: 0; background: transparent; }
.st-layer { position: absolute; inset: 0; border: 0; width: 100%; height: 100%;
  opacity: 0; visibility: hidden; pointer-events: none; transition: opacity .18s ease; }
.st-layer.st-visible { opacity: 1; visibility: visible; }
.st-standby { position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px;
  background: radial-gradient(120% 120% at 50% 30%, rgba(16,22,32,0.94) 0%, rgba(8,12,17,0.97) 60%, rgba(8,12,17,0.99) 100%);
  color: #e8c877; font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; }
.st-standby-crest { width: 64px; height: 64px; border-radius: 50%;
  border: 2px solid rgba(175,141,66,0.75); display: flex; align-items: center; justify-content: center;
  font-size: 30px; font-weight: 700; color: #e8c877; letter-spacing: 1px;
  background: rgba(175,141,66,0.12); box-shadow: 0 0 24px rgba(175,141,66,0.25); }
.st-standby-title { font-size: 34px; font-weight: 700; letter-spacing: 3px;
  color: #e8c877; text-shadow: 0 2px 12px rgba(0,0,0,0.6); }
.st-standby-line { font-size: 17px; letter-spacing: 2px; color: rgba(232,232,232,0.82); }
.st-standby-pulse { width: 220px; height: 3px; border-radius: 2px; overflow: hidden;
  background: rgba(175,141,66,0.18); position: relative; margin-top: 6px; }
.st-standby-pulse i { position: absolute; top: 0; bottom: 0; left: -40%; width: 40%; border-radius: 2px;
  background: linear-gradient(90deg, transparent, rgba(232,200,119,0.9), transparent);
  animation: st-pulse-slide 1.8s ease-in-out infinite; }
@keyframes st-pulse-slide { 0% { left: -40%; } 100% { left: 100%; } }
#st-wipe { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 9; display: none; }
#st-wipe.st-run { display: block; }
#st-wipe .st-wipe-panel { position: absolute; top: -14%; bottom: -14%; left: 0; width: 135%;
  transform: translateX(-125%) skewX(-14deg); background: linear-gradient(105deg,
    rgba(20,26,36,0) 6%, rgba(20,26,36,0.97) 28%, rgba(175,141,66,0.92) 50%,
    rgba(20,26,36,0.97) 72%, rgba(20,26,36,0) 94%); }
#st-wipe.st-run .st-wipe-panel { animation: st-wipe-sweep .72s cubic-bezier(.65,0,.35,1) forwards; }
@keyframes st-wipe-sweep { 0% { transform: translateX(-125%) skewX(-14deg); }
  100% { transform: translateX(125%) skewX(-14deg); } }
@media (prefers-reduced-motion: reduce) {
  .st-layer, .st-standby-pulse i { transition: none; animation: none; }
}
`;

const STAGE_SCRIPT = String.raw`(function () {
  'use strict';
  var ROOT = document.getElementById('stage-broadcast');
  if (!ROOT) return;
  var layers = {
    bp: document.getElementById('st-layer-bp'),
    hud: document.getElementById('st-layer-hud'),
    result: document.getElementById('st-layer-result'),
    standby: document.getElementById('st-standby')
  };
  var wipe = document.getElementById('st-wipe');
  var standbyTitle = document.getElementById('st-standby-title');
  var standbyLine = document.getElementById('st-standby-line');
  var state = null;
  var config = null;
  var current = null;
  var lastCueSeq = null;
  var lastPhase = null;
  var lastStandbyText = '';
  var WIPE_SWAP_AT = 300;
  function text(value, fallback) {
    var result = value === null || value === undefined ? '' : String(value).trim();
    return result || (fallback === undefined ? '' : fallback);
  }
  function animationsDisabled() {
    try {
      if (new URLSearchParams(window.location.search || '').get('stageAnim') === '0') return true;
    } catch (error) {}
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function cfg() {
    var base = config && typeof config === 'object' ? config : {};
    var override = state && state.broadcastConfig && typeof state.broadcastConfig === 'object' ? state.broadcastConfig : {};
    return { series: Object.assign({}, base.series, override.series), standbyCard: override.standbyCard || base.standbyCard || null };
  }
  function gameReady(nextState) {
    if (!nextState) return false;
    if (nextState.mode === 'mock') return true;
    var live = nextState.live;
    return Boolean(live && live.game && live.game.parsed === true);
  }
  function layerForPhase(phase) {
    if (phase === 'draft') return 'bp';
    if (phase === 'post_game') return 'result';
    if (phase === 'in_game') return gameReady(state) ? 'hud' : 'standby';
    return 'standby';
  }
  function setLayer(name) {
    if (!layers[name] || current === name) return;
    Object.keys(layers).forEach(function (key) {
      var node = layers[key];
      if (!node) return;
      node.classList.toggle('st-visible', key === name);
    });
    current = name;
  }
  function playWipe() {
    if (!wipe || animationsDisabled()) return false;
    wipe.classList.remove('st-run');
    void wipe.offsetWidth;
    wipe.classList.add('st-run');
    return true;
  }
  var wipeTimer = null;
  function showLayer(name, withWipe) {
    // 取消挂起的转场回调：SSE 快速连发 cue 时，旧 setTimeout 会晚到并把刚切好的层覆盖回去。
    if (wipeTimer !== null) { window.clearTimeout(wipeTimer); wipeTimer = null; }
    if (current === name) return;
    if (withWipe && playWipe()) {
      wipeTimer = window.setTimeout(function () { wipeTimer = null; setLayer(name); }, WIPE_SWAP_AT);
    } else {
      setLayer(name);
    }
  }
  function renderStandby() {
    if (!standbyTitle || !standbyLine) return;
    var all = cfg();
    var card = all.standbyCard && typeof all.standbyCard === 'object' ? all.standbyCard : {};
    var title = text(card.title, text(all.series && all.series.name, text(state && state.tournamentName, 'Khada Jhin')));
    var patch = text(all.series && all.series.patch, text(state && state.patch, ''));
    var lines = Array.isArray(card.lines) && card.lines.length
      ? card.lines
      : ['对局即将开始', patch ? 'PATCH ' + patch : '正在等待对局数据'];
    var markup = title + '|' + lines.join('|');
    if (markup === lastStandbyText) return;
    lastStandbyText = markup;
    standbyTitle.textContent = title;
    standbyLine.textContent = lines.join(' · ');
  }
  function update(nextState) {
    if (!nextState || typeof nextState !== 'object') return;
    var previousPhase = lastPhase;
    var previousCue = lastCueSeq;
    state = nextState;
    renderStandby();
    var cue = nextState.broadcastCue || {};
    var cueSeq = Number(cue.seq);
    var cueTriggered = Number.isFinite(cueSeq) && cueSeq !== previousCue;
    if (Number.isFinite(cueSeq)) lastCueSeq = cueSeq;
    var phase = text(nextState.phase, '');
    var phaseChanged = previousPhase !== null && phase !== previousPhase;
    lastPhase = phase;
    if (cueTriggered) {
      if (cue.type === 'bp-in') return showLayer('bp', true);
      if (cue.type === 'hud-in') return showLayer('hud', true);
      if (cue.type === 'result-in') return showLayer('result', true);
      if (cue.type === 'wipe') { playWipe(); return; }
      if (cue.type === 'reset') return showLayer(layerForPhase(phase), false);
    }
    // 待机 → 局内：对局数据开始流动时自动上 HUD，不等人工 cue。
    if (current === 'standby' && phase === 'in_game' && gameReady(nextState)) return showLayer('hud', true);
    if (phaseChanged) {
      if (phase === 'draft') return showLayer('bp', true);
      if (phase === 'post_game') return showLayer('result', true);
      if (phase === 'in_game') return showLayer(layerForPhase(phase), true);
      if (phase === 'lobby') return showLayer('standby', false);
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
    if (loadedConfig && typeof loadedConfig === 'object') config = loadedConfig;
    if (loadedState) {
      state = loadedState;
      if (loadedState.broadcastConfig && typeof loadedState.broadcastConfig === 'object') {
        config = Object.assign({}, config, loadedState.broadcastConfig);
      }
      renderStandby();
      var phase = text(loadedState.phase, '');
      lastPhase = phase;
      var cue = loadedState.broadcastCue || {};
      var seq = Number(cue.seq);
      if (Number.isFinite(seq)) lastCueSeq = seq;
      setLayer(layerForPhase(phase));
    } else {
      setLayer('standby');
    }
  });
  var es = new EventSource('/events');
  es.onmessage = function (event) {
    try { update(JSON.parse(event.data)); } catch (error) { /* 保留上一帧 */ }
  };
})();`;

function stageBroadcastPage() {
  const body = '<style data-stage-broadcast-theme>' + STAGE_CSS + '</style>' +
    '<main id="stage-broadcast" class="stage-broadcast">' +
      '<iframe id="st-layer-bp" class="st-layer" src="/broadcast/bp" title="BP Broadcast" scrolling="no"></iframe>' +
      '<iframe id="st-layer-hud" class="st-layer" src="/broadcast/hud" title="In-game HUD" scrolling="no"></iframe>' +
      '<iframe id="st-layer-result" class="st-layer" src="/broadcast/result" title="Result Broadcast" scrolling="no"></iframe>' +
      '<div id="st-standby" class="st-standby st-layer">' +
        '<div class="st-standby-crest">R</div>' +
        '<div class="st-standby-title" id="st-standby-title">Khada Jhin</div>' +
        '<div class="st-standby-line" id="st-standby-line">对局即将开始</div>' +
        '<div class="st-standby-pulse"><i></i></div>' +
      '</div>' +
      '<div id="st-wipe"><div class="st-wipe-panel"></div></div>' +
    '</main>';
  return htmlShell('Khada Jhin · Stage Broadcast', body, STAGE_SCRIPT);
}

module.exports = { stageBroadcastPage };
