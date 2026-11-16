'use strict';

// HUD 布局微调页（/broadcast/hud-editor）。
// 左边是元素清单与数值输入，右边是 1920x1080 的 HUD 实况 iframe（?hudEdit=1）。
// 拖拽/缩放发生在 iframe 内（/assets/hud-layout-edit.js），这里只负责数值面板与落盘。
// 保存目标是 data/hud-layout.json，HUD 每次加载经 /api/hud-layout 读回。
const fs = require('fs');
const path = require('path');
const { htmlShell } = require('./html');
const { MAX_LAYOUT_BYTES, loadLayout, saveLayout } = require('../hud-layout');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LAYOUT_PATH = path.join(PROJECT_ROOT, 'data', 'hud-layout.json');

// 测试通过 HUD_LAYOUT_PATH 指向临时目录，避免污染仓库 data/。
function layoutPath() { return process.env.HUD_LAYOUT_PATH || DEFAULT_LAYOUT_PATH; }

function sendJson(res, code, body) {
  if (!res || res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// 写接口只允许回环地址；读接口同源页面要用，不额外限制。
function isLoopback(req) {
  const address = req && req.socket && typeof req.socket.remoteAddress === 'string' ? req.socket.remoteAddress : '';
  if (!address) return true;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// 专用小体读取（布局 JSON 上限 64KB），超限立刻 413 并停止累积。
function readLayoutBody(req, res) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    let done = false;
    const fail = error => {
      if (done) return;
      done = true;
      if (res && !res.headersSent) sendJson(res, 413, { ok: false, error: 'payload_too_large' });
      reject(error);
    };
    const declared = Number(req.headers && req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_LAYOUT_BYTES) {
      return fail(Object.assign(new Error('payload_too_large'), { statusCode: 413 }));
    }
    req.on('data', chunk => {
      if (done) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_LAYOUT_BYTES) return fail(Object.assign(new Error('payload_too_large'), { statusCode: 413 }));
      raw += chunk;
    });
    req.on('end', () => { if (done) return; done = true; try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); } });
    req.on('error', error => { if (!done) { done = true; reject(error); } });
  });
}

function handleGetLayout(res) {
  const loaded = loadLayout(layoutPath());
  return sendJson(res, 200, { ok: true, source: loaded.source, layout: loaded.layout });
}

function handlePostLayout(req, res) {
  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return Promise.resolve(true);
  }
  return readLayoutBody(req, res).then(body => {
    const saved = saveLayout(layoutPath(), body);
    if (!saved) {
      sendJson(res, 400, { ok: false, error: 'invalid_layout' });
      return true;
    }
    sendJson(res, 200, { ok: true, layout: saved });
    return true;
  }).catch(error => {
    if (!res.headersSent) {
      const status = error && error.statusCode === 413 ? 413 : 500;
      sendJson(res, status, { ok: false, error: status === 413 ? 'payload_too_large' : 'write_failed' });
    }
    return true;
  });
}

// 返回 true 表示已接管该请求；main.js 只按 url.pathname 分流。
function handleHudLayoutApi(req, res, url) {
  if (!url || url.pathname !== '/api/hud-layout') return false;
  if (req.method === 'GET') { handleGetLayout(res); return true; }
  if (req.method === 'POST') { return handlePostLayout(req, res); }
  sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  return true;
}

const PAGE_SCRIPT = `(function () {
  'use strict';
  var FIELDS = ['dx', 'dy', 'w', 'h', 'scale', 'fontSize', 'opacity'];
  var frame = document.getElementById('he-frame-el');
  var stage = document.getElementById('he-stage');
  var frameBox = document.getElementById('he-frame');
  var list = document.getElementById('he-list');
  var panel = document.getElementById('he-panel');
  var panelTitle = document.getElementById('he-panel-title');
  var statusNode = document.getElementById('he-status');
  var filterInput = document.getElementById('he-filter');
  var snapSelect = document.getElementById('he-snap');
  var showAllCheck = document.getElementById('he-show-all');
  var targets = [];
  var items = {};
  var selected = null;
  var dirty = false;

  function status(text, tone) {
    if (!statusNode) return;
    statusNode.textContent = text;
    statusNode.setAttribute('data-tone', tone || '');
  }
  function markDirty() {
    dirty = true;
    status('有未保存的改动', 'warn');
  }
  function itemOf(key) { return (items && items[key]) || {}; }
  function fieldValue(key, field) {
    var item = itemOf(key);
    if (item[field] === undefined || item[field] === null) return '';
    return item[field];
  }
  function numOr(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }
  function send(event, payload) {
    if (!frame || !frame.contentWindow) return;
    var message = { type: 'hb-layout', event: event };
    if (payload) for (var k in payload) message[k] = payload[k];
    frame.contentWindow.postMessage(message, '*');
  }
  function fit() {
    if (!stage || !frameBox) return;
    var width = stage.clientWidth - 32;
    var height = stage.clientHeight - 32;
    var scale = Math.min(width / 1920, height / 1080);
    if (!(scale > 0)) scale = 0.2;
    frameBox.style.width = '1920px';
    frameBox.style.height = '1080px';
    frameBox.style.transform = 'scale(' + scale + ')';
    var shownW = 1920 * scale;
    var shownH = 1080 * scale;
    frameBox.style.left = Math.max(0, (stage.clientWidth - shownW) / 2) + 'px';
    frameBox.style.top = Math.max(0, (stage.clientHeight - shownH) / 2) + 'px';
  }
  function visibleTargets() {
    var needle = (filterInput && filterInput.value || '').trim().toLowerCase();
    if (!needle) return targets;
    return targets.filter(function (target) {
      return (target.label + ' ' + target.key + ' ' + (target.group || '')).toLowerCase().indexOf(needle) >= 0;
    });
  }
  function buildList() {
    if (!list) return;
    list.innerHTML = '';
    var groups = [];
    var byGroup = {};
    visibleTargets().forEach(function (target) {
      var name = target.group || '其他';
      if (!byGroup[name]) { byGroup[name] = []; groups.push(name); }
      byGroup[name].push(target);
    });
    groups.forEach(function (name) {
      var heading = document.createElement('div');
      heading.className = 'he-group';
      heading.textContent = name;
      list.appendChild(heading);
      byGroup[name].forEach(function (target) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'he-item';
        row.setAttribute('data-key', target.key);
        row.textContent = target.label;
        var badge = document.createElement('em');
        badge.className = 'he-badge';
        badge.textContent = '';
        row.appendChild(badge);
        if (target.key === selected) row.classList.add('is-active');
        if (items[target.key]) row.classList.add('is-edited');
        list.appendChild(row);
      });
    });
    if (!groups.length) {
      var empty = document.createElement('p');
      empty.className = 'he-empty';
      empty.textContent = '没有匹配的元素';
      list.appendChild(empty);
    }
  }
  function syncList() {
    if (!list) return;
    var rows = list.querySelectorAll('.he-item');
    for (var i = 0; i < rows.length; i += 1) {
      var key = rows[i].getAttribute('data-key');
      rows[i].classList.toggle('is-active', key === selected);
      rows[i].classList.toggle('is-edited', !!items[key]);
    }
  }
  function fillPanel() {
    if (!panel) return;
    if (!selected) { panel.hidden = true; return; }
    panel.hidden = false;
    var target = null;
    targets.forEach(function (entry) { if (entry.key === selected) target = entry; });
    if (panelTitle) panelTitle.textContent = target ? target.label : selected;
    var inputs = panel.querySelectorAll('[data-field]');
    for (var i = 0; i < inputs.length; i += 1) {
      if (document.activeElement === inputs[i]) continue;
      var field = inputs[i].getAttribute('data-field');
      var value = fieldValue(selected, field);
      inputs[i].value = value === '' ? '' : String(value);
    }
  }
  function commit(field, rawValue) {
    if (!selected) return;
    var next = {};
    FIELDS.forEach(function (name) { if (itemOf(selected)[name] !== undefined) next[name] = itemOf(selected)[name]; });
    if (rawValue === '' || rawValue === null || rawValue === undefined) delete next[field];
    else {
      var n = Number(rawValue);
      if (!isFinite(n)) return;
      next[field] = n;
    }
    items[selected] = next;
    if (!Object.keys(next).length) delete items[selected];
    markDirty();
    syncList();
    send('set', { key: selected, value: Object.keys(next).length ? next : {} });
  }
  function resetItem() {
    if (!selected) return;
    delete items[selected];
    markDirty();
    syncList();
    fillPanel();
    send('set', { key: selected, value: {} });
  }
  function post(payload) {
    return fetch('/api/hud-layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || { items: items })
    }).then(function (response) { return response.json().catch(function () { return null; }); });
  }
  function save() {
    status('保存中…');
    post({ items: items }).then(function (data) {
      if (!data || !data.ok) { status('保存失败：' + (data && data.error || 'unknown'), 'bad'); return; }
      items = (data.layout && data.layout.items) || {};
      dirty = false;
      buildList();
      status('已保存 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }), 'good');
    }).catch(function () { status('保存失败：网络错误', 'bad'); });
  }
  function resetAll() {
    if (!window.confirm('清空全部微调，恢复到出厂布局？')) return;
    items = {};
    selected = null;
    markDirty();
    send('reload');
  }
  function onMessage(event) {
    var data = event.data;
    if (!data || data.type !== 'hb-layout') return;
    if (data.event === 'ready') {
      targets = Array.isArray(data.targets) ? data.targets : [];
      items = data.items && typeof data.items === 'object' ? data.items : {};
      dirty = false;
      buildList();
      status('已连接 HUD · ' + targets.length + ' 个可调元素', 'good');
    } else if (data.event === 'select') {
      selected = data.key || null;
      syncList();
      fillPanel();
    } else if (data.event === 'change' || data.event === 'commit') {
      if (!data.key) return;
      var value = data.value && typeof data.value === 'object' ? data.value : {};
      if (Object.keys(value).length) items[data.key] = value; else delete items[data.key];
      markDirty();
      syncList();
      if (data.key === selected) fillPanel();
    }
  }

  if (list) list.addEventListener('click', function (event) {
    var row = event.target && event.target.closest ? event.target.closest('.he-item') : null;
    if (!row) return;
    send('select', { key: row.getAttribute('data-key') });
  });
  if (panel) panel.addEventListener('input', function (event) {
    var field = event.target && event.target.getAttribute ? event.target.getAttribute('data-field') : null;
    if (field) commit(field, event.target.value);
  });
  var resetItemButton = document.getElementById('he-reset-item');
  if (resetItemButton) resetItemButton.addEventListener('click', resetItem);
  var saveButton = document.getElementById('he-save');
  if (saveButton) saveButton.addEventListener('click', save);
  var resetAllButton = document.getElementById('he-reset-all');
  if (resetAllButton) resetAllButton.addEventListener('click', resetAll);
  var reloadButton = document.getElementById('he-reload');
  if (reloadButton) reloadButton.addEventListener('click', function () {
    if (dirty && !window.confirm('丢弃未保存的改动？')) return;
    dirty = false;
    send('reload');
    status('已重新载入');
  });
  if (filterInput) filterInput.addEventListener('input', buildList);
  if (snapSelect) snapSelect.addEventListener('change', function () {
    send('snap', { snap: Number(snapSelect.value) || 1 });
  });
  if (showAllCheck) showAllCheck.addEventListener('change', function () {
    send('show-all', { value: !!showAllCheck.checked });
  });
  window.addEventListener('message', onMessage);
  window.addEventListener('resize', fit);
  window.addEventListener('beforeunload', function (event) {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  fit();
  setInterval(fit, 800);
})();`;

function hudEditorCss() {
  try { return fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'hud-editor.css'), 'utf8'); }
  catch (error) { return ''; }
}

function hudEditorPage() {
  const body = '<style data-hud-editor-theme>' + hudEditorCss() + '</style>' +
    '<main class="hud-editor" id="hud-editor">' +
      '<aside class="he-side">' +
        '<header class="he-head">' +
          '<h1>HUD 布局微调</h1>' +
          '<p class="he-sub">点画面里的元素或左侧列表选中；拖拽移动，拖角缩放。方向键 1px，Shift 10px，Alt 关吸附。</p>' +
        '</header>' +
        '<div class="he-tools">' +
          '<label class="he-field">吸附' +
            '<select id="he-snap"><option value="1">1px</option><option value="5">5px</option><option value="10">10px</option><option value="0">关闭</option></select>' +
          '</label>' +
          '<label class="he-check"><input type="checkbox" id="he-show-all" checked> 显示全部边框</label>' +
        '</div>' +
        '<div class="he-filter"><input id="he-filter" type="search" placeholder="搜索元素…" autocomplete="off"></div>' +
        '<div class="he-list" id="he-list"></div>' +
        '<section class="he-panel" id="he-panel" hidden>' +
          '<h2 id="he-panel-title">—</h2>' +
          '<div class="he-grid">' +
            '<label class="he-field">X<input data-field="dx" type="number" step="1" placeholder="0"></label>' +
            '<label class="he-field">Y<input data-field="dy" type="number" step="1" placeholder="0"></label>' +
            '<label class="he-field">宽<input data-field="w" type="number" step="1" min="0" placeholder="自动"></label>' +
            '<label class="he-field">高<input data-field="h" type="number" step="1" min="0" placeholder="自动"></label>' +
            '<label class="he-field">缩放<input data-field="scale" type="number" step="0.01" min="0.2" max="4" placeholder="1"></label>' +
            '<label class="he-field">字号<input data-field="fontSize" type="number" step="1" min="0" placeholder="自动"></label>' +
            '<label class="he-field">透明度<input data-field="opacity" type="number" step="0.05" min="0" max="1" placeholder="1"></label>' +
          '</div>' +
          '<div class="he-actions"><button id="he-reset-item" type="button">重置此项</button></div>' +
        '</section>' +
        '<footer class="he-foot">' +
          '<div class="he-status" id="he-status">正在连接 HUD…</div>' +
          '<div class="he-buttons">' +
            '<button id="he-reset-all" type="button">全部重置</button>' +
            '<button id="he-reload" type="button">重新载入</button>' +
            '<button id="he-save" type="button" class="is-primary">保存并应用</button>' +
          '</div>' +
          '<p class="he-note">保存写入 data/hud-layout.json。OBS 里的 HUD 需要刷新一次（右键 → 刷新缓存，或控台一键换源）才会用上新值；挖孔几何请用 <a href="/broadcast/hud-calibrate" target="_blank" rel="noopener">挖孔标定页</a>。</p>' +
        '</footer>' +
      '</aside>' +
      '<section class="he-stage" id="he-stage">' +
        '<div class="he-frame" id="he-frame"><iframe id="he-frame-el" src="/overlay/hud-broadcast?hudEdit=1" width="1920" height="1080" title="HUD 预览"></iframe></div>' +
      '</section>' +
    '</main>';
  return htmlShell('Khada Jhin · HUD 布局微调', body, PAGE_SCRIPT);
}

module.exports = { hudEditorPage, handleHudLayoutApi, layoutPath };
