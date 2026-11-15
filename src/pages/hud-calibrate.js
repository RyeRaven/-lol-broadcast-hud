'use strict';

// 运行时 HUD 挖孔标定页（/overlay/hud-calibrate）。
// 页面只做一件事：把 5 行 x 2 侧的装备孔 / 饰品孔画出来，让人在真实原生 HUD 上拖动对齐，
// 然后把 8 个几何参数保存到 data/hud-calib.json，供 /overlay/hud-broadcast 的 nativeGeometry() 读取。
//
// 本模块同时承载 /api/hud-calib 的读写与校验：GET 返回文件值或内置默认（source=default|file），
// POST 只接受 127.0.0.1 的 8 字段严格数值对象，原子写盘（先写临时文件再 rename），失败保留旧文件。
const fs = require('fs');
const path = require('path');
const { htmlShell } = require('./html');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CALIB_PATH = path.join(PROJECT_ROOT, 'data', 'hud-calib.json');
const MAX_CALIB_BYTES = 1024;

// 与 src/pages/hud-broadcast.js 的 NATIVE_DEFAULTS 一一对应（row1CenterY 对应 row1Y）。
const DEFAULT_HUD_CALIB = {
  // 2026-11-15 用户实机 1920x1080 原生观战截图逐像素实测，与 hud-broadcast.js
  // NATIVE_DEFAULTS / hud-broadcast.css 三处保持一致（运行时这里会经 /api/hud-calib
  // 回写 CSS 变量，优先级最高——不改这里等于改了白改）。
  itemSize: 24,
  itemPitch: 25.6,
  rowPitch: 43.4,
  row1CenterY: 876.5,
  blueX: 643,
  redX: 1140,
  trinketBlueX: 619,
  trinketRedX: 1294
};

// 验收口径：尺寸 4..80 / 4..120 / 8..160，其余坐标 -2000..4000。
const CALIB_RANGES = {
  itemSize: [4, 80],
  itemPitch: [4, 120],
  rowPitch: [8, 160],
  row1CenterY: [-2000, 4000],
  blueX: [-2000, 4000],
  redX: [-2000, 4000],
  trinketBlueX: [-2000, 4000],
  trinketRedX: [-2000, 4000]
};
const CALIB_FIELDS = Object.keys(DEFAULT_HUD_CALIB);
// 每行 y 偏移（相对 row1CenterY + row*rowPitch 的微调，5 行共享两侧）；默认全 0。
const DEFAULT_ROW_OFFSETS = [0, 0, 0, 0, 0];

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeRowOffsets(input) {
  if (input === undefined || input === null) return DEFAULT_ROW_OFFSETS.slice();
  if (!Array.isArray(input) || input.length !== 5) return null;
  const result = [];
  for (const value of input) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value < -2000 || value > 4000) return null;
    result.push(value);
  }
  return result;
}

// POST/文件载荷：8 个标定字段 + 可选 rowOffsets（5 个有限数值）。
function normalizeHudCalibPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const rowOffsets = normalizeRowOffsets(input.rowOffsets);
  if (!rowOffsets) return null;
  const fields = {};
  for (const key of Object.keys(input)) {
    if (key !== 'rowOffsets') fields[key] = input[key];
  }
  const calibration = normalizeHudCalib(fields);
  if (!calibration) return null;
  return { calibration, rowOffsets };
}

// 严格校验：必须是普通对象，8 个字段齐全、都是有限 number 且落在范围内；多余字段也拒绝。
function normalizeHudCalib(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(CALIB_RANGES, key)) return null;
  }
  const result = {};
  for (const key of CALIB_FIELDS) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const range = CALIB_RANGES[key];
    if (value < range[0] || value > range[1]) return null;
    result[key] = value;
  }
  return result;
}

function calibPath() {
  return process.env.HUD_CALIB_PATH || DEFAULT_CALIB_PATH;
}

// 读盘：文件缺失、损坏、字段不合法一律当作没有标定，回退内置默认，绝不让坏文件拖崩 overlay。
function readHudCalib(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const source = raw && typeof raw === 'object' && raw.calibration && typeof raw.calibration === 'object' ? raw.calibration : raw;
    const calibration = normalizeHudCalib(source);
    if (!calibration) return null;
    const rowOffsets = normalizeRowOffsets(raw && typeof raw === 'object' ? raw.rowOffsets : undefined);
    if (!rowOffsets) return null;
    let updatedAt = null;
    try { updatedAt = fs.statSync(filePath).mtime.toISOString(); } catch { updatedAt = null; }
    return { calibration, rowOffsets, updatedAt };
  } catch {
    return null;
  }
}

// 原子写：同目录临时文件落盘后再 rename 覆盖；任何一步失败都抛错，旧文件保持原样。
function saveHudCalib(calibration, rowOffsets, filePath) {
  // 兼容旧调用 saveHudCalib(calibration, filePath)。
  if (typeof rowOffsets === 'string') { filePath = rowOffsets; rowOffsets = DEFAULT_ROW_OFFSETS.slice(); }
  const offsets = normalizeRowOffsets(rowOffsets);
  if (!offsets) throw new Error('invalid_row_offsets');
  const target = filePath || calibPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: 1, calibration, rowOffsets: offsets }, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* 临时文件可能根本没创建 */ }
    throw error;
  }
  return calibration;
}

function sendJson(res, code, body) {
  if (!res || res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// 只允许本机回环访问写接口（读接口同源页面也要用，不额外限制）。
// 服务端固定监听 127.0.0.1，正常请求 remoteAddress 为 127.0.0.1 / ::1 / ::ffff:127.0.0.1。
function isLoopback(req) {
  const address = req && req.socket && typeof req.socket.remoteAddress === 'string' ? req.socket.remoteAddress : '';
  if (!address) return true;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// 专用小体读取：1KB 上限，超限立刻 413 并丢弃后续数据（避免和全局 1MB 的 readBody 混用）。
function readCalibBody(req, res) {
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
    if (Number.isFinite(declared) && declared > MAX_CALIB_BYTES) {
      return fail(Object.assign(new Error('payload_too_large'), { statusCode: 413 }));
    }
    req.on('data', chunk => {
      if (done) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_CALIB_BYTES) return fail(Object.assign(new Error('payload_too_large'), { statusCode: 413 }));
      raw += chunk;
    });
    req.on('end', () => { if (done) return; done = true; try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); } });
    req.on('error', error => { if (!done) { done = true; reject(error); } });
  });
}

function handleGetHudCalib(res) {
  const loaded = readHudCalib(calibPath());
  if (loaded) return sendJson(res, 200, { ok: true, source: 'file', calibration: loaded.calibration, rowOffsets: loaded.rowOffsets, updatedAt: loaded.updatedAt });
  return sendJson(res, 200, { ok: true, source: 'default', calibration: clone(DEFAULT_HUD_CALIB), rowOffsets: DEFAULT_ROW_OFFSETS.slice() });
}

function handlePostHudCalib(req, res) {
  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return Promise.resolve(true);
  }
  return readCalibBody(req, res).then(body => {
    const payload = normalizeHudCalibPayload(body);
    if (!payload) {
      sendJson(res, 400, { ok: false, error: 'invalid_calibration' });
      return true;
    }
    try {
      saveHudCalib(payload.calibration, payload.rowOffsets);
      sendJson(res, 200, { ok: true, calibration: payload.calibration, rowOffsets: payload.rowOffsets });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: 'write_failed' });
    }
    return true;
  }).catch(error => {
    if (!res.headersSent) sendJson(res, error && error.statusCode === 413 ? 413 : 400, { ok: false, error: error && error.statusCode === 413 ? 'payload_too_large' : 'invalid_calibration' });
    return true;
  });
}

// 返回 true 表示已接管该请求；main.js 只需要判断 url.pathname。
function handleHudCalibApi(req, res, url) {
  if (!url || url.pathname !== '/api/hud-calib') return false;
  if (req.method === 'GET') { handleGetHudCalib(res); return true; }
  if (req.method === 'POST') { return handlePostHudCalib(req, res); }
  sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  return true;
}

const PAGE_SCRIPT = `(function () {
  'use strict';
  var DEFAULT = __DEFAULT_JSON__;
  var FIELDS = ['itemSize', 'itemPitch', 'rowPitch', 'row1CenterY', 'blueX', 'redX', 'trinketBlueX', 'trinketRedX'];
  var RANGES = {
    itemSize: [4, 80], itemPitch: [4, 120], rowPitch: [8, 160],
    row1CenterY: [-2000, 4000], blueX: [-2000, 4000], redX: [-2000, 4000],
    trinketBlueX: [-2000, 4000], trinketRedX: [-2000, 4000]
  };
  var cal = {};
  for (var f = 0; f < FIELDS.length; f += 1) cal[FIELDS[f]] = DEFAULT[FIELDS[f]];
  var ROW_OFFSETS = [0, 0, 0, 0, 0];
  var root = document.getElementById('hud-calibrate');
  var stage = document.getElementById('calib-stage');
  var hint = document.getElementById('calib-hint');
  var toastNode = document.getElementById('calib-toast');
  var statusNode = document.getElementById('calib-status');
  var selected = null;
  var drag = null;
  var source = 'default';

  function clamp(key, value) {
    var range = RANGES[key] || [-1e9, 1e9];
    var n = Number(value);
    if (!isFinite(n)) n = DEFAULT[key];
    return Math.min(range[1], Math.max(range[0], n));
  }
  function fmt(value) {
    return (Math.round(value * 100) / 100).toFixed(2);
  }
  function status(text) {
    if (statusNode) statusNode.textContent = text;
  }
  function toast(text) {
    if (!toastNode) return;
    toastNode.textContent = text;
    toastNode.classList.add('show');
    if (toastNode.__timer) clearTimeout(toastNode.__timer);
    toastNode.__timer = setTimeout(function () { toastNode.classList.remove('show'); }, 2200);
  }
  function updateInputs() {
    var inputs = document.querySelectorAll('[data-param]');
    for (var i = 0; i < inputs.length; i += 1) {
      var key = inputs[i].getAttribute('data-param');
      if (document.activeElement === inputs[i]) continue;
      inputs[i].value = fmt(cal[key]);
    }
  }
  function layout() {
    var holes = stage ? stage.querySelectorAll('.calib-hole') : [];
    for (var i = 0; i < holes.length; i += 1) {
      var hole = holes[i];
      var side = hole.getAttribute('data-side');
      var row = Number(hole.getAttribute('data-row')) - 1;
      var x = side === 'blue' ? cal.blueX : cal.redX;
      var y = cal.row1CenterY + row * cal.rowPitch + (ROW_OFFSETS[row] || 0) - cal.itemSize / 2;
      var width = cal.itemSize + 5 * cal.itemPitch;
      hole.style.left = x + 'px';
      hole.style.top = y + 'px';
      hole.style.width = width + 'px';
      hole.style.height = cal.itemSize + 'px';
      var trinket = hole.querySelector('.calib-trinket');
      if (trinket) {
        var trinketX = side === 'blue' ? cal.trinketBlueX : cal.trinketRedX;
        trinket.style.left = (trinketX - x) + 'px';
        trinket.style.top = '0px';
        trinket.style.width = cal.itemSize + 'px';
        trinket.style.height = cal.itemSize + 'px';
      }
    }
    if (root && root.style && root.style.setProperty) {
      root.style.setProperty('--calib-item-size', cal.itemSize + 'px');
      root.style.setProperty('--calib-item-pitch', cal.itemPitch + 'px');
      root.style.setProperty('--calib-row-pitch', cal.rowPitch + 'px');
    }
  }
  function render() {
    layout();
    updateInputs();
    var values = document.getElementById('calib-values');
    if (values) {
      var parts = [];
      for (var i = 0; i < FIELDS.length; i += 1) parts.push(FIELDS[i] + '=' + fmt(cal[FIELDS[i]]));
      parts.push('rowOffsets=[' + ROW_OFFSETS.map(fmt).join(',') + ']');
      values.textContent = parts.join('  ');
    }
  }
  function select(hole) {
    if (selected) selected.classList.remove('is-selected');
    selected = hole || null;
    if (selected) selected.classList.add('is-selected');
  }
  function setParam(key, value) {
    if (!RANGES[key]) return;
    cal[key] = clamp(key, value);
    render();
  }
  function reset() {
    for (var i = 0; i < FIELDS.length; i += 1) cal[FIELDS[i]] = DEFAULT[FIELDS[i]];
    ROW_OFFSETS = [0, 0, 0, 0, 0];
    source = 'default';
    status('source: default（未保存）');
    render();
    toast('已重置为内置默认');
  }
  function applyPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    var candidate = payload.calibration && typeof payload.calibration === 'object' ? payload.calibration : payload;
    var applied = false;
    for (var i = 0; i < FIELDS.length; i += 1) {
      var key = FIELDS[i];
      var value = candidate[key];
      if (typeof value === 'number' && isFinite(value)) { cal[key] = clamp(key, value); applied = true; }
    }
    if (Array.isArray(payload.rowOffsets) && payload.rowOffsets.length === 5) {
      ROW_OFFSETS = payload.rowOffsets.map(function (value) { return clamp('row1CenterY', value); });
      applied = true;
    }
    return applied;
  }
  function save() {
    if (typeof fetch !== 'function') { toast('当前环境不支持保存'); return; }
    fetch('/api/hud-calib', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, cal, { rowOffsets: ROW_OFFSETS }))
    }).then(function (response) {
      return response.json().then(function (body) { return { status: response.status, body: body }; });
    }).then(function (result) {
      if (result.status === 200 && result.body && result.body.ok) {
        source = 'file';
        status('source: file（已保存）');
        toast('保存成功：data/hud-calib.json');
      } else {
        toast('保存失败：' + ((result.body && result.body.error) || result.status));
      }
    }).catch(function () { toast('保存失败：网络错误'); });
  }
  function reload() {
    if (typeof fetch !== 'function') return;
    fetch('/api/hud-calib', { cache: 'no-store' }).then(function (response) { return response.json(); }).then(function (body) {
      if (!body || !body.calibration) return;
      applyPayload(body);
      source = body.source === 'file' ? 'file' : 'default';
      status('source: ' + source);
      render();
      toast('已读取 ' + source);
    }).catch(function () { toast('读取失败'); });
  }
  if (stage) {
    stage.addEventListener('pointerdown', function (event) {
      var target = event.target;
      var hole = target && target.closest ? target.closest('.calib-hole') : null;
      if (!hole) return;
      event.preventDefault();
      select(hole);
      var trinket = target.closest ? target.closest('.calib-trinket') : null;
      drag = {
        side: hole.getAttribute('data-side'),
        row: Number(hole.getAttribute('data-row')) - 1,
        kind: trinket ? 'trinket' : 'hole',
        startX: event.clientX,
        startY: event.clientY,
        base: {},
        baseRowOffset: ROW_OFFSETS[Number(hole.getAttribute('data-row')) - 1] || 0
      };
      for (var i = 0; i < FIELDS.length; i += 1) drag.base[FIELDS[i]] = cal[FIELDS[i]];
      try { stage.setPointerCapture(event.pointerId); } catch (error) { /* 无指针捕获也能拖 */ }
    });
    stage.addEventListener('pointermove', function (event) {
      if (!drag) return;
      var dx = event.clientX - drag.startX;
      var dy = event.clientY - drag.startY;
      if (drag.kind === 'trinket') {
        var trinketKey = drag.side === 'blue' ? 'trinketBlueX' : 'trinketRedX';
        cal[trinketKey] = clamp(trinketKey, drag.base[trinketKey] + dx);
      } else {
        var xKey = drag.side === 'blue' ? 'blueX' : 'redX';
        cal[xKey] = clamp(xKey, drag.base[xKey] + dx);
        ROW_OFFSETS[drag.row] = clamp('row1CenterY', drag.baseRowOffset + dy);
      }
      render();
    });
    var stopDrag = function () { drag = null; };
    stage.addEventListener('pointerup', stopDrag);
    stage.addEventListener('pointercancel', stopDrag);
    stage.addEventListener('wheel', function (event) {
      event.preventDefault();
      var factor = Math.pow(1.0015, -event.deltaY);
      if (event.shiftKey) {
        cal.rowPitch = clamp('rowPitch', cal.rowPitch * factor);
      } else if (event.altKey) {
        cal.itemPitch = clamp('itemPitch', cal.itemPitch * factor);
      } else {
        var before = cal.itemSize;
        var next = clamp('itemSize', before * factor);
        var ratio = before > 0 ? next / before : 1;
        cal.itemSize = next;
        cal.itemPitch = clamp('itemPitch', cal.itemPitch * ratio);
        cal.rowPitch = clamp('rowPitch', cal.rowPitch * ratio);
      }
      render();
    }, { passive: false });
  }
  document.addEventListener('keydown', function (event) {
    var key = event.key;
    if ((key === 's' || key === 'S') && !event.ctrlKey && !event.metaKey) { event.preventDefault(); save(); return; }
    if (key === 'r' || key === 'R') { event.preventDefault(); reset(); return; }
    if (key.indexOf('Arrow') !== 0 || !selected) return;
    event.preventDefault();
    var step = event.shiftKey ? 10 : 1;
    var side = selected.getAttribute('data-side');
    var rowIndex = Number(selected.getAttribute('data-row')) - 1;
    var xKey = side === 'blue' ? 'blueX' : 'redX';
    if (key === 'ArrowLeft') cal[xKey] = clamp(xKey, cal[xKey] - step);
    else if (key === 'ArrowRight') cal[xKey] = clamp(xKey, cal[xKey] + step);
    else if (key === 'ArrowUp') ROW_OFFSETS[rowIndex] = clamp('row1CenterY', (ROW_OFFSETS[rowIndex] || 0) - step);
    else if (key === 'ArrowDown') ROW_OFFSETS[rowIndex] = clamp('row1CenterY', (ROW_OFFSETS[rowIndex] || 0) + step);
    render();
  });
  var inputs = document.querySelectorAll('[data-param]');
  for (var i = 0; i < inputs.length; i += 1) {
    (function (input) {
      var handler = function () { setParam(input.getAttribute('data-param'), input.value); };
      input.addEventListener('change', handler);
      input.addEventListener('input', handler);
    })(inputs[i]);
  }
  var buttons = document.querySelectorAll('[data-act]');
  for (var b = 0; b < buttons.length; b += 1) {
    (function (button) {
      button.addEventListener('click', function () {
        var act = button.getAttribute('data-act');
        if (act === 'save') save();
        else if (act === 'reset') reset();
        else if (act === 'reload') reload();
      });
    })(buttons[b]);
  }
  var hintClose = document.getElementById('calib-hint-close');
  if (hintClose && hint) hintClose.addEventListener('click', function () { hint.classList.add('is-hidden'); });
  render();
  // 进页面先读一次文件值，读到后覆盖默认并重排。
  if (typeof fetch === 'function') {
    fetch('/api/hud-calib', { cache: 'no-store' }).then(function (response) { return response.json(); }).then(function (body) {
      if (!body || !body.calibration) return;
      applyPayload(body);
      source = body.source === 'file' ? 'file' : 'default';
      status('source: ' + source);
      render();
    }).catch(function () { status('source: default（读取失败）'); });
  }
})();`;

function hudCalibrateCss() {
  try { return fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'hud-calibrate.css'), 'utf8'); }
  catch { return ''; }
}

function pageBody() {
  const holes = [];
  for (const side of ['blue', 'red']) {
    for (let row = 1; row <= 5; row += 1) {
      holes.push(
        '<div class="calib-hole ' + side + '" data-side="' + side + '" data-row="' + row + '" tabindex="0">' +
          '<span class="calib-hole-label">' + side + ' · row' + row + '</span>' +
          '<span class="calib-hole-tag">装备 x6</span>' +
          '<span class="calib-trinket" data-side="' + side + '" title="饰品孔（左右拖动）"></span>' +
        '</div>'
      );
    }
  }
  const fields = CALIB_FIELDS.map(key => (
    '<label class="calib-field"><span>' + key + '</span><input type="number" step="0.1" data-param="' + key + '"></label>'
  )).join('');
  return '<style data-hud-calibrate-theme>' + hudCalibrateCss() + '</style>' +
    '<main id="hud-calibrate" class="hud-calibrate">' +
      '<div class="calib-stage" id="calib-stage">' + holes.join('') + '</div>' +
      '<aside class="calib-panel" id="calib-panel">' +
        '<header><b>HUD 挖孔标定</b><small>1920 x 1080 基准 · 拖动对齐原生装备栏</small></header>' +
        '<div class="calib-fields">' + fields + '</div>' +
        '<div class="calib-actions">' +
          '<button type="button" data-act="save">保存 (S)</button>' +
          '<button type="button" data-act="reset">重置 (R)</button>' +
          '<button type="button" data-act="reload">重新读取</button>' +
        '</div>' +
        '<p class="calib-status" id="calib-status">source: —</p>' +
      '</aside>' +
      '<div class="calib-hint" id="calib-hint">' +
        '<span class="calib-hint-text">拖动矩形 = 移动该行装备孔 · 滚轮 = itemSize（等比改 itemPitch / rowPitch） · Shift+滚轮 = rowPitch · Alt+滚轮 = itemPitch · 方向键 = 1px 微调 · S = 保存 · R = 重置</span>' +
        '<span class="calib-values" id="calib-values"></span>' +
        '<button type="button" id="calib-hint-close" aria-label="关闭提示">×</button>' +
      '</div>' +
      '<div class="calib-toast" id="calib-toast"></div>' +
    '</main>';
}

function hudCalibratePage() {
  const script = PAGE_SCRIPT.replace('__DEFAULT_JSON__', () => JSON.stringify(DEFAULT_HUD_CALIB));
  return htmlShell('Khada Jhin · HUD Calibrate', pageBody(), script);
}

module.exports = {
  DEFAULT_HUD_CALIB,
  DEFAULT_ROW_OFFSETS,
  CALIB_RANGES,
  CALIB_FIELDS,
  MAX_CALIB_BYTES,
  DEFAULT_CALIB_PATH,
  normalizeHudCalib,
  normalizeRowOffsets,
  normalizeHudCalibPayload,
  readHudCalib,
  saveHudCalib,
  handleHudCalibApi,
  hudCalibratePage,
  isLoopback
};
