/* Khada Jhin — BP 英雄锁定 diff（纯逻辑，可被 node require） */
(function (root) {
  'use strict';

  var SIDES = ['blue', 'red'];
  var SLOT_COUNT = 5;
  var sequence = 0;
  var lastCallKey = null;
  var lastNext = null;
  var emitted = Object.create(null);

  function championOf(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') {
      if (value.champion !== undefined) return championOf(value.champion);
      if (value.name !== undefined) return championOf(value.name);
      return null;
    }
    var text = String(value).trim();
    return text || null;
  }

  function normalizeSide(values) {
    var source = Array.isArray(values) ? values : [];
    var result = [];
    for (var i = 0; i < SLOT_COUNT; i += 1) result.push(championOf(source[i]));
    return result;
  }

  function normalize(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    return {
      blue: normalizeSide(snapshot.blue),
      red: normalizeSide(snapshot.red)
    };
  }

  function sameState(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // 返回本次需要播放锁定动效的槽位：[{ side, index, champion, seq }]。
  // 首次渲染（prev 为 null/undefined）只建立基线，不触发；重复的同一帧不会重播。
  function diffLocks(prev, next) {
    var previous = normalize(prev);
    var current = normalize(next);
    if (!current) return [];

    var callKey = JSON.stringify([previous, current]);
    if (lastCallKey === callKey) return [];
    lastCallKey = callKey;

    // 页面切到另一份数据（prev 与上次的 next 不连续）时清空已触发记录，
    // 避免不同测试/不同对局之间互相压制。
    if (previous && lastNext && !sameState(previous, lastNext)) {
      emitted = Object.create(null);
    }

    var locks = [];
    if (previous) {
      SIDES.forEach(function (side) {
        for (var index = 0; index < SLOT_COUNT; index += 1) {
          var oldValue = previous[side][index];
          var newValue = current[side][index];
          var key = side + ':' + index;
          if (oldValue !== null && newValue === null) {
            delete emitted[key];
            continue;
          }
          if (newValue !== null && oldValue !== newValue) {
            if (emitted[key] === newValue) continue;
            emitted[key] = newValue;
            sequence += 1;
            locks.push({ side: side, index: index, champion: newValue, seq: sequence });
          }
        }
      });
    }

    lastNext = current;
    return locks;
  }

  root.RBLock = { diffLocks: diffLocks };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.RBLock;
})(typeof window !== 'undefined' ? window : globalThis);
