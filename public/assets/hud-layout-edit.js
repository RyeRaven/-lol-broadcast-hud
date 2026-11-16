/* HUD 布局微调 · 页面内编辑层
 * 只在 ?hudEdit=1 时由 /overlay/hud-broadcast 动态加载。
 * 职责：在 HUD 页面上盖一层不可见的命中框，负责选中/拖拽/缩放/方向键微调，
 * 把值交给 window.__hbLayout（页面自己的 applyLayoutItems 实现真正写入），
 * 并通过 postMessage 把变更同步给外层编辑页做数值输入与保存。
 * HUD 的生产渲染路径完全不依赖本文件。
 */
(function () {
  'use strict';
  if (window.__hbEditMounted) return;
  window.__hbEditMounted = true;

  var layer = null;
  var boxes = Object.create(null);
  var selected = null;
  var snap = 1;
  var showAll = true;
  var drag = null;
  var raf = 0;
  var labelEl = null;

  function hb() { return window.__hbLayout || null; }
  function targets() { var api = hb(); return api && Array.isArray(api.targets) ? api.targets : []; }
  function allItems() { var api = hb(); return (api && api.items && api.items()) || {}; }
  function itemOf(key) { var all = allItems(); return all[key] || {}; }
  function numOr(value, fallback) { return typeof value === 'number' && isFinite(value) ? value : fallback; }
  function val(key, field, fallback) { var it = itemOf(key); return numOr(it[field], fallback); }

  function post(message) {
    try { window.parent.postMessage(message, '*'); } catch (error) { /* 独立打开时没有父页面 */ }
  }

  function apply(key, value) {
    var api = hb();
    if (!api || !api.setItem) return;
    api.setItem(key, value);
  }

  // 吸附：默认 1px；Alt 临时关闭；Shift 按 10px 大步（与方向键一致）。
  function quantize(delta, ev) {
    if (ev && ev.altKey) return delta;
    var step = ev && ev.shiftKey ? 10 : snap;
    if (!(step > 0)) return delta;
    return Math.round(delta / step) * step;
  }

  function elFor(target) {
    try { return document.querySelector(target.sel); } catch (error) { return null; }
  }

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div');
    layer.id = 'hb-edit-layer';
    layer.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483000', 'pointer-events:none',
      'font:600 12px/1 Bahnschrift,"Segoe UI",sans-serif', 'color:#04212b'
    ].join(';'));
    document.body.appendChild(layer);
    return layer;
  }

  function boxFor(key) {
    if (boxes[key] && boxes[key].isConnected) return boxes[key];
    var box = document.createElement('div');
    box.className = 'hb-edit-box';
    box.setAttribute('data-key', key);
    box.setAttribute('style', [
      'position:absolute', 'pointer-events:auto', 'box-sizing:border-box',
      'border:1px dashed rgba(0,229,255,.55)', 'background:rgba(0,229,255,.04)',
      'cursor:move'
    ].join(';'));
    layer.appendChild(box);
    boxes[key] = box;
    return box;
  }

  function removeStale(keys) {
    Object.keys(boxes).forEach(function (key) {
      if (keys.indexOf(key) >= 0) return;
      var node = boxes[key];
      if (node && node.parentNode) node.parentNode.removeChild(node);
      delete boxes[key];
    });
  }

  function handlesFor(box) {
    var boxHandles = box.querySelectorAll('.hb-edit-handle');
    if (boxHandles.length) return boxHandles;
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (name) {
      var handle = document.createElement('div');
      handle.className = 'hb-edit-handle';
      handle.setAttribute('data-handle', name);
      var pos = {
        nw: 'left:-4px;top:-4px;cursor:nwse-resize',
        n: 'left:50%;margin-left:-4px;top:-4px;cursor:ns-resize',
        ne: 'right:-4px;top:-4px;cursor:nesw-resize',
        e: 'right:-4px;top:50%;margin-top:-4px;cursor:ew-resize',
        se: 'right:-4px;bottom:-4px;cursor:nwse-resize',
        s: 'left:50%;margin-left:-4px;bottom:-4px;cursor:ns-resize',
        sw: 'left:-4px;bottom:-4px;cursor:nesw-resize',
        w: 'left:-4px;top:50%;margin-top:-4px;cursor:ew-resize'
      }[name];
      handle.setAttribute('style', 'position:absolute;width:8px;height:8px;background:#00e5ff;border:1px solid #04212b;' + pos);
      box.appendChild(handle);
    });
    return box.querySelectorAll('.hb-edit-handle');
  }

  function refresh() {
    var api = hb();
    if (!api || !api.enabled) return;
    ensureLayer();
    var list = targets();
    var keys = list.map(function (target) { return target.key; });
    removeStale(keys);
    keys.forEach(function (key) {
      var target = null;
      for (var i = 0; i < list.length; i += 1) if (list[i].key === key) { target = list[i]; break; }
      if (!target) return;
      var el = elFor(target);
      var box = boxes[key];
      if (!el) { if (box && box.parentNode) box.parentNode.removeChild(box); delete boxes[key]; return; }
      box = boxFor(key);
      var rect = el.getBoundingClientRect();
      var isSelected = selected === key;
      box.style.left = Math.round(rect.left) + 'px';
      box.style.top = Math.round(rect.top) + 'px';
      box.style.width = Math.round(rect.width) + 'px';
      box.style.height = Math.round(rect.height) + 'px';
      box.style.display = (!showAll && !isSelected) ? 'none' : 'block';
      box.style.borderColor = isSelected ? '#ffd166' : 'rgba(0,229,255,.5)';
      box.style.background = isSelected ? 'rgba(255,209,102,.10)' : 'rgba(0,229,255,.03)';
      box.style.cursor = isSelected ? 'move' : 'pointer';
      if (isSelected) handlesFor(box);
      var old = box.querySelectorAll('.hb-edit-handle');
      for (var h = 0; h < old.length; h += 1) old[h].style.display = isSelected ? 'block' : 'none';
    });
    positionLabel();
  }

  function positionLabel() {
    if (!selected || !boxes[selected]) { if (labelEl) labelEl.style.display = 'none'; return; }
    if (!labelEl) {
      labelEl = document.createElement('div');
      labelEl.setAttribute('style', [
        'position:absolute', 'pointer-events:none', 'padding:2px 6px', 'border-radius:3px',
        'background:#ffd166', 'color:#04212b', 'font:600 11px/1.3 Bahnschrift,"Segoe UI",sans-serif',
        'white-space:nowrap', 'transform:translateY(-100%)'
      ].join(';'));
      layer.appendChild(labelEl);
    }
    var target = null;
    targets().forEach(function (entry) { if (entry.key === selected) target = entry; });
    var box = boxes[selected];
    labelEl.style.display = 'block';
    labelEl.textContent = (target ? target.label : selected) + ' · ' + Math.round(parseFloat(box.style.width)) + '×' + Math.round(parseFloat(box.style.height));
    labelEl.style.left = box.style.left;
    labelEl.style.top = box.style.top;
  }

  function select(key) {
    if (selected === key) return;
    selected = key;
    refresh();
    var target = null;
    targets().forEach(function (entry) { if (entry.key === key) target = entry; });
    post({ type: 'hb-layout', event: 'select', key: key, label: target ? target.label : key, value: key ? itemOf(key) : null });
  }

  function startMove(key, ev) {
    var start = { x: ev.clientX, y: ev.clientY, dx: val(key, 'dx', 0), dy: val(key, 'dy', 0) };
    drag = { mode: 'move', key: key, start: start };
  }

  function startResize(key, ev, handle) {
    var box = boxes[key];
    var start = {
      x: ev.clientX, y: ev.clientY,
      w: parseFloat(box.style.width) || 0,
      h: parseFloat(box.style.height) || 0,
      dx: val(key, 'dx', 0), dy: val(key, 'dy', 0)
    };
    drag = { mode: 'resize', key: key, handle: handle, start: start };
  }

  function onPointerDown(ev) {
    if (!hb() || !hb().enabled) return;
    var node = ev.target;
    var handle = node.getAttribute && node.getAttribute('data-handle');
    var box = node.closest ? node.closest('.hb-edit-box') : null;
    if (!box) { select(null); return; }
    var key = box.getAttribute('data-key');
    if (!handle && key !== selected) select(key);
    if (handle) startResize(key, ev, handle); else startMove(key, ev);
    ev.preventDefault();
    ev.stopPropagation();
  }

  function onPointerMove(ev) {
    if (!drag) return;
    var item = Object.assign({}, itemOf(drag.key));
    var deltaX = ev.clientX - drag.start.x;
    var deltaY = ev.clientY - drag.start.y;
    if (drag.mode === 'move') {
      item.dx = Math.round((drag.start.dx + quantize(deltaX, ev)) * 100) / 100;
      item.dy = Math.round((drag.start.dy + quantize(deltaY, ev)) * 100) / 100;
    } else {
      var handle = drag.handle;
      // 西/北向缩放要同时移动左/上缘：位移跟手，宽高反向补偿，另一条边才钉在原地。
      var growX = quantize(deltaX, ev);
      var growY = quantize(deltaY, ev);
      if (handle.indexOf('e') >= 0) item.w = Math.max(0, Math.round(drag.start.w + growX));
      if (handle.indexOf('s') >= 0) item.h = Math.max(0, Math.round(drag.start.h + growY));
      if (handle.indexOf('w') >= 0) {
        var shrinkW = Math.min(growX, drag.start.w);
        item.w = Math.round(drag.start.w - shrinkW);
        item.dx = Math.round((drag.start.dx + shrinkW) * 100) / 100;
      }
      if (handle.indexOf('n') >= 0) {
        var shrinkH = Math.min(growY, drag.start.h);
        item.h = Math.round(drag.start.h - shrinkH);
        item.dy = Math.round((drag.start.dy + shrinkH) * 100) / 100;
      }
    }
    apply(drag.key, item);
    refresh();
    post({ type: 'hb-layout', event: 'change', key: drag.key, value: item });
    ev.preventDefault();
  }

  function onPointerUp() {
    if (!drag) return;
    post({ type: 'hb-layout', event: 'commit', key: drag.key, value: itemOf(drag.key) });
    drag = null;
  }

  function onKeyDown(ev) {
    if (!selected) return;
    var map = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    var dir = map[ev.key];
    if (!dir) return;
    var step = ev.shiftKey ? 10 : 1;
    var item = Object.assign({}, itemOf(selected));
    item.dx = Math.round((numOr(item.dx, 0) + dir[0] * step) * 100) / 100;
    item.dy = Math.round((numOr(item.dy, 0) + dir[1] * step) * 100) / 100;
    apply(selected, item);
    refresh();
    post({ type: 'hb-layout', event: 'change', key: selected, value: item });
    ev.preventDefault();
    ev.stopPropagation();
  }

  function onMessage(ev) {
    var data = ev.data;
    if (!data || data.type !== 'hb-layout') return;
    if (data.event === 'select') select(data.key || null);
    else if (data.event === 'set') {
      var api = hb();
      if (api && api.setItem) { api.setItem(data.key, data.value || {}); refresh(); }
    } else if (data.event === 'snap') { snap = numOr(data.snap, 1); }
    else if (data.event === 'show-all') { showAll = data.value !== false; refresh(); }
    else if (data.event === 'reload') {
      var api2 = hb();
      if (api2 && api2.reload) api2.reload();
      refresh();
    }
  }

  function tick() {
    if (!hb() || !hb().enabled) { raf = 0; return; }
    refresh();
    raf = window.setTimeout(tick, 320);
  }

  function mount(options) {
    var api = hb();
    if (!api) return false;
    api.enabled = true;
    ensureLayer();
    layer.style.pointerEvents = 'none';
    layer.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('message', onMessage);
    window.addEventListener('resize', refresh);
    refresh();
    post({ type: 'hb-layout', event: 'ready', targets: targets().map(function (target) {
      return { key: target.key, label: target.label, group: target.group, hole: !!target.hole };
    }), items: allItems() });
    if (!raf) raf = window.setTimeout(tick, 320);
    return true;
  }

  window.HBLayoutEdit = { mount: mount, refresh: refresh, select: select };
})();
