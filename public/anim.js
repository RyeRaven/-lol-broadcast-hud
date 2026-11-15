/* Khada Jhin — 通用广播动画工具（原生 JS，无依赖） */
(function (root) {
  'use strict';

  function prefersReducedMotion() {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (error) {
      return false;
    }
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // 数字 tween：将 target.textContent 从 from 计数到 to。
  // options: { duration=600, decimals=1, prefix='', suffix='', format }
  function tweenNumber(target, from, to, options) {
    var opts = options || {};
    var duration = opts.duration === undefined ? 600 : Math.max(0, Number(opts.duration) || 0);
    var decimals = opts.decimals === undefined ? 1 : Math.max(0, Number(opts.decimals) || 0);
    var prefix = opts.prefix === undefined ? '' : String(opts.prefix);
    var suffix = opts.suffix === undefined ? '' : String(opts.suffix);
    var start = Number(from);
    var end = Number(to);
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = 0;
    var format = typeof opts.format === 'function'
      ? opts.format
      : function (value) { return prefix + value.toFixed(decimals) + suffix; };
    if (!target) return Promise.resolve();
    if (prefersReducedMotion() || duration <= 0 || typeof root.requestAnimationFrame !== 'function') {
      target.textContent = format(end);
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      var startAt = null;
      function step(now) {
        if (startAt === null) startAt = now;
        var progress = Math.min(1, (now - startAt) / duration);
        var value = start + (end - start) * easeOutCubic(progress);
        target.textContent = format(value);
        if (progress < 1) root.requestAnimationFrame(step);
        else resolve();
      }
      root.requestAnimationFrame(step);
    });
  }

  // 依次给元素加 class（默认 bb-in），step 毫秒错开；减少动态时一次性显示。
  function staggerIn(elements, options) {
    var opts = options || {};
    var nodes = Array.prototype.slice.call(elements || []);
    var step = opts.step === undefined ? 40 : Math.max(0, Number(opts.step) || 0);
    var delay = opts.delay === undefined ? 0 : Math.max(0, Number(opts.delay) || 0);
    var className = opts.className || 'bb-in';
    var flashClass = opts.flashClass || '';
    var reduce = prefersReducedMotion();
    nodes.forEach(function (node, index) {
      if (!node || !node.classList) return;
      if (flashClass) {
        node.classList.add(flashClass);
        if (root.setTimeout) root.setTimeout(function () { node.classList.remove(flashClass); }, 260);
      }
      if (reduce) {
        node.classList.add(className);
        return;
      }
      node.style.transitionDelay = delay + index * step + 'ms';
      node.classList.add(className);
    });
    return Promise.resolve(nodes);
  }

  // 斜切 wipe 转场：在容器上覆盖一层快速扫过的面板，结束后清理。
  function sceneWipe(container, options) {
    var opts = options || {};
    if (!container || !container.appendChild) return Promise.resolve(null);
    var duration = opts.duration === undefined ? 360 : Math.max(0, Number(opts.duration) || 0);
    var layer = document.createElement('div');
    layer.className = 'rb-scene-wipe' + (opts.className ? ' ' + opts.className : '');
    layer.style.animationDuration = duration + 'ms';
    container.appendChild(layer);
    if (prefersReducedMotion() || duration <= 0) {
      return Promise.resolve(layer).then(function (node) {
        if (node && node.parentNode) node.parentNode.removeChild(node);
        return null;
      });
    }
    return new Promise(function (resolve) {
      root.setTimeout(function () {
        if (layer.parentNode) layer.parentNode.removeChild(layer);
        resolve(null);
      }, duration + 40);
    });
  }

  // 重新播放一组元素的入场：移除 class、强制 reflow、再加回。
  function replay(elements, options) {
    var opts = options || {};
    var nodes = Array.prototype.slice.call(elements || []);
    var className = opts.className || 'bb-in';
    nodes.forEach(function (node) {
      if (!node || !node.classList) return;
      node.classList.remove(className);
      node.style.transitionDelay = '';
    });
    if (nodes[0] && nodes[0].offsetWidth) void nodes[0].offsetWidth;
    return staggerIn(nodes, opts);
  }

  root.RBAnim = {
    prefersReducedMotion: prefersReducedMotion,
    tweenNumber: tweenNumber,
    staggerIn: staggerIn,
    sceneWipe: sceneWipe,
    replay: replay
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window.RBAnim : globalThis.RBAnim);
}
