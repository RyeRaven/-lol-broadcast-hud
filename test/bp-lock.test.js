'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LOCK_PATH = path.join(__dirname, '..', 'src', 'pages', 'bp-lock.js');
function fresh() {
  delete require.cache[require.resolve(LOCK_PATH)];
  return require(LOCK_PATH);
}

const blank = [null, null, null, null, null];

test('diffLocks: 首次渲染（prev=null）不触发任何锁定', function () {
  const { diffLocks } = fresh();
  const result = diffLocks(null, { blue: ['A', null, null, null, null], red: [] });
  assert.deepEqual(result, []);
});

test('diffLocks: 从空槽到有英雄产生一条新锁定', function () {
  const { diffLocks } = fresh();
  const result = diffLocks(
    { blue: blank.slice(), red: blank.slice() },
    { blue: ['A', null, null, null, null], red: blank.slice() }
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].side, 'blue');
  assert.equal(result[0].index, 0);
  assert.equal(result[0].champion, 'A');
  assert.equal(typeof result[0].seq, 'number');
});

test('diffLocks: 同一 prev/next 连续调用第二次不重复触发', function () {
  const { diffLocks } = fresh();
  const prev = { blue: blank.slice(), red: blank.slice() };
  const next = { blue: ['A', null, null, null, null], red: blank.slice() };
  const first = diffLocks(prev, next);
  const second = diffLocks(prev, next);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

test('diffLocks: 回到空槽不算锁定，但会清空记录使下一次锁定可再次触发', function () {
  const { diffLocks } = fresh();
  const reset = diffLocks(
    { blue: ['A', null, null, null, null], red: blank.slice() },
    { blue: blank.slice(), red: blank.slice() }
  );
  assert.deepEqual(reset, []);
  const relock = diffLocks(
    { blue: blank.slice(), red: blank.slice() },
    { blue: ['A', null, null, null, null], red: blank.slice() }
  );
  assert.equal(relock.length, 1);
  assert.equal(relock[0].champion, 'A');
});

test('diffLocks: 红蓝同时锁定返回 2 条且 blue 在前', function () {
  const { diffLocks } = fresh();
  const result = diffLocks(
    { blue: blank.slice(), red: blank.slice() },
    { blue: ['A', null, null, null, null], red: ['B', null, null, null, null] }
  );
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(function (item) { return item.side; }), ['blue', 'red']);
  assert.equal(result[0].champion, 'A');
  assert.equal(result[1].champion, 'B');
});
