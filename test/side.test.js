'use strict';

// 队伍归属统一口径（src/side.js）：live-data 与 highlights 过去各写一份且实现漂移，这里锁定共享实现的契约。
const test = require('node:test');
const assert = require('node:assert/strict');

const { sideOf, sideFromTeamValue, sideFromTurretName } = require('../src/side');

test('sideOf maps ORDER/CHAOS and falls back to blue for unknown teams', () => {
  assert.equal(sideOf('ORDER'), 'blue');
  assert.equal(sideOf('CHAOS'), 'red');
  assert.equal(sideOf('order'), 'blue');
  assert.equal(sideOf('chaos'), 'red');
  assert.equal(sideOf(''), 'blue');
  assert.equal(sideOf(null), 'blue');
  assert.equal(sideOf(undefined), 'blue');
});

test('sideFromTeamValue recognises every team spelling in use', () => {
  assert.equal(sideFromTeamValue('CHAOS'), 'red');
  assert.equal(sideFromTeamValue('Red'), 'red');
  assert.equal(sideFromTeamValue('TEAM 200'), 'red');
  assert.equal(sideFromTeamValue('200'), 'red');
  assert.equal(sideFromTeamValue('2'), 'red');
  assert.equal(sideFromTeamValue('ORDER'), 'blue');
  assert.equal(sideFromTeamValue('BLUE'), 'blue');
  assert.equal(sideFromTeamValue('TEAM_100'), 'blue');
  assert.equal(sideFromTeamValue('100'), 'blue');
  assert.equal(sideFromTeamValue('1'), 'blue');
  assert.equal(sideFromTeamValue(''), null);
  assert.equal(sideFromTeamValue('monster'), null);
});

test('sideFromTurretName covers TOrder/TChaos and the T1/T2 aliases', () => {
  assert.equal(sideFromTurretName('Turret_TOrder_L001'), 'red');
  assert.equal(sideFromTurretName('Turret_TChaos_C001'), 'blue');
  assert.equal(sideFromTurretName('T1_Turret'), 'red');
  assert.equal(sideFromTurretName('T2_Turret'), 'blue');
  assert.equal(sideFromTurretName('Hwei'), null);
  assert.equal(sideFromTurretName(''), null);
});
