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

function handlePostLayout(req, res, onSaved) {
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
    // 通知所有已连接的 HUD（含 OBS 里那一个）立刻套用新布局。
    if (typeof onSaved === 'function') { try { onSaved(saved); } catch { /* 推送失败不影响保存结果 */ } }
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
function handleHudLayoutApi(req, res, url, onSaved) {
  if (!url || url.pathname !== '/api/hud-layout') return false;
  if (req.method === 'GET') { handleGetLayout(res); return true; }
  if (req.method === 'POST') { return handlePostLayout(req, res, onSaved); }
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
  var hintNode = document.getElementById('he-hint');
  var measureNode = document.getElementById('he-measure');
  var statusNode = document.getElementById('he-status');
  var filterInput = document.getElementById('he-filter');
  var snapSelect = document.getElementById('he-snap');
  var showAllCheck = document.getElementById('he-show-all');
  var onlyEditedCheck = document.getElementById('he-only-edited');
  var targets = [];
  var absentTimer = null;
  var measureTimer = null;
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
    var onlyEdited = !!(onlyEditedCheck && onlyEditedCheck.checked);
    return targets.filter(function (target) {
      if (onlyEdited && !items[target.key]) return false;
      if (!needle) return true;
      return (target.label + ' ' + target.key + ' ' + (target.group || '')).toLowerCase().indexOf(needle) >= 0;
    });
  }
  // 动态元素（没出龙、没有增益、自定义遮罩 html）当帧可能不存在：列表里灰显，而不是假装能调。
  // 每次现查 iframe：缓存引用在页面生命周期里不一定可靠。
  function frameDoc() {
    var el = document.getElementById('he-frame-el');
    try { return el ? el.contentDocument : null; } catch (error) { return null; }
  }
  // 元素的真实几何：iframe 的 CSS px 就是 1920×1080 设计坐标，量到多少就是多少。
  // 面板里「宽 / 高 / 字号」没被覆盖时显示这个实测值，好照着真实数字微调。
  function measureSelected(sel) {
    var doc = frameDoc();
    if (!doc || !sel) return null;
    var el = null;
    try { el = doc.querySelector(sel); } catch (error) { return null; }
    if (!el || !el.getBoundingClientRect) return null;
    var rect = el.getBoundingClientRect();
    var view = doc.defaultView;
    var fs = view ? parseFloat(view.getComputedStyle(el).fontSize) : 0;
    // 容器上的字号没有意义（14px 继承值），只有自己直接带文字的元素才报字号。
    var hasText = false;
    for (var n = 0; n < el.childNodes.length; n += 1) {
      var child = el.childNodes[n];
      if (child.nodeType === 3 && child.textContent && child.textContent.replace(/\s+/g, '')) { hasText = true; break; }
    }
    return {
      w: Math.round(rect.width * 10) / 10,
      h: Math.round(rect.height * 10) / 10,
      fontSize: hasText && isFinite(fs) && fs > 0 ? Math.round(fs * 10) / 10 : 0
    };
  }
  function updateMeasure(measured) {
    if (!measureNode) return;
    if (!measured) { measureNode.textContent = '当前画面里没有这个元素，量不到尺寸。'; return; }
    measureNode.textContent = '实测 ' + measured.w + ' × ' + measured.h + ' px' +
      (measured.fontSize ? ' · 字号 ' + measured.fontSize + 'px' : '') +
      '　灰色数字是实测值，改一下就锁成固定值，清空回到自动。';
  }
  // 文本长度 / 龙数 / 模式都会让尺寸变，实测值跟着心跳刷。
  function refreshMeasured() {
    if (!selected || !panel || panel.hidden) return;
    var target = null;
    targets.forEach(function (entry) { if (entry.key === selected) target = entry; });
    var measured = measureSelected(target && target.sel);
    updateMeasure(measured);
    var inputs = panel.querySelectorAll('[data-field]');
    for (var i = 0; i < inputs.length; i += 1) {
      var field = inputs[i].getAttribute('data-field');
      if (field !== 'w' && field !== 'h' && field !== 'fontSize') continue;
      if (document.activeElement === inputs[i]) continue;
      var explicit = fieldValue(selected, field);
      if (explicit !== '') {
        // 已经是固定值：显示固定值，去掉「实测」灰显。
        inputs[i].classList.remove('is-measured');
        inputs[i].value = String(explicit);
        continue;
      }
      var value = measured ? (field === 'fontSize' ? measured.fontSize : measured[field]) : 0;
      inputs[i].classList.toggle('is-measured', !!value);
      inputs[i].value = value ? String(value) : '';
    }
  }
  function buildList() {
    if (!list) return;
    list.innerHTML = '';
    var doc = frameDoc();
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
  // 面板是给「调布局」用的：元素此刻有没有数据不影响可调性，所以列表一律正常显示。
  // 数据到位时 HUD 会自己长出来，之前设的位移/尺寸照常生效。
  function refreshAbsent() {
    refreshMeasured();
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
    if (hintNode) {
      if (target && String(target.key || '').indexOf('hole-') === 0) {
        hintNode.hidden = false;
        hintNode.textContent = '挖孔：宽 / 高 = 透出原生装备栏的尺寸（绝对像素），X / Y = 相对出厂孔的位移。数字一改，原生装备图标透出的范围立刻跟着变。';
      } else {
        hintNode.hidden = true;
        hintNode.textContent = '';
      }
    }
    var measured = measureSelected(target && target.sel);
    var inputs = panel.querySelectorAll('[data-field]');
    for (var i = 0; i < inputs.length; i += 1) {
      if (document.activeElement === inputs[i]) continue;
      var field = inputs[i].getAttribute('data-field');
      var value = fieldValue(selected, field);
      var show = value === '' ? '' : String(value);
      // 宽 / 高 / 字号没有覆盖时，直接把实测值填进去（灰显），免得只看到「自动」没得算。
      var auto = value === '' && measured && (field === 'w' || field === 'h' || field === 'fontSize');
      if (auto) {
        var measuredValue = field === 'fontSize' ? measured.fontSize : measured[field];
        show = measuredValue ? String(measuredValue) : '';
      }
      inputs[i].classList.toggle('is-measured', !!auto && !!show);
      inputs[i].value = show;
    }
    updateMeasure(measured);
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
    // 改完立刻刷新读出行（以及其它非聚焦字段的实测值），不等到 2s 心跳。
    refreshMeasured();
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
      window.setTimeout(refreshAbsent, 700);
      if (!absentTimer) absentTimer = window.setInterval(refreshAbsent, 2000);
      // 实测值跟着 HUD 变（挖孔 60ms 去抖、文字变长等），单独用快节拍刷；正在输入的框不碰。
      if (!measureTimer) measureTimer = window.setInterval(refreshMeasured, 350);
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
    if (field) {
      // 亲手改过的字段不再是「实测值」样式。
      if (event.target.value !== '') event.target.classList.remove('is-measured');
      commit(field, event.target.value);
    }
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
  if (onlyEditedCheck) onlyEditedCheck.addEventListener('change', buildList);
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
          '<label class="he-check"><input type="checkbox" id="he-only-edited"> 只看已改动</label>' +
        '</div>' +
        '<div class="he-filter"><input id="he-filter" type="search" placeholder="搜索元素…" autocomplete="off"></div>' +
        '<div class="he-list" id="he-list"></div>' +
        '<section class="he-panel" id="he-panel" hidden>' +
          '<h2 id="he-panel-title">—</h2>' +
          '<p class="he-hint" id="he-hint" hidden></p>' +
          '<div class="he-grid">' +
            '<label class="he-field">X<input data-field="dx" type="number" step="1" placeholder="0"></label>' +
            '<label class="he-field">Y<input data-field="dy" type="number" step="1" placeholder="0"></label>' +
            '<label class="he-field">宽<input data-field="w" type="number" step="1" min="0" placeholder="自动"></label>' +
            '<label class="he-field">高<input data-field="h" type="number" step="1" min="0" placeholder="自动"></label>' +
            '<label class="he-field">缩放<input data-field="scale" type="number" step="0.01" min="0.2" max="4" placeholder="1"></label>' +
            '<label class="he-field">字号<input data-field="fontSize" type="number" step="1" min="0" placeholder="自动"></label>' +
            '<label class="he-field">透明度<input data-field="opacity" type="number" step="0.05" min="0" max="1" placeholder="1"></label>' +
          '</div>' +
          '<p class="he-measure" id="he-measure"></p>' +
          '<div class="he-actions"><button id="he-reset-item" type="button">重置此项</button></div>' +
        '</section>' +
        '<footer class="he-foot">' +
          '<div class="he-status" id="he-status">正在连接 HUD…</div>' +
          '<div class="he-buttons">' +
            '<button id="he-reset-all" type="button">全部重置</button>' +
            '<button id="he-reload" type="button">重新载入</button>' +
            '<button id="he-save" type="button" class="is-primary">保存并应用</button>' +
          '</div>' +
          '<p class="he-note">保存写入 data/hud-layout.json，并立刻推送给所有打开的 HUD（OBS 里的源也不用刷新）。只有改了页面代码或样式才需要右键「刷新缓存」；挖孔几何请用 <a href="/broadcast/hud-calibrate" target="_blank" rel="noopener">挖孔标定页</a>。</p>' +
        '</footer>' +
      '</aside>' +
      '<section class="he-stage" id="he-stage">' +
        '<div class="he-frame" id="he-frame"><iframe id="he-frame-el" src="/overlay/hud-broadcast?hudEdit=1" width="1920" height="1080" title="HUD 预览"></iframe></div>' +
      '</section>' +
    '</main>';
  return htmlShell('Khada Jhin · HUD 布局微调', body, PAGE_SCRIPT);
}

module.exports = { hudEditorPage, handleHudLayoutApi, layoutPath };
