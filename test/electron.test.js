'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');

test('electron main exposes retryable service-down and service-up events', () => {
  assert.ok(source.includes("dispatchServiceEvent('service-down'"));
  assert.ok(source.includes("dispatchServiceEvent('service-up'"));
  assert.ok(source.includes('retryable: true'));
  assert.ok(source.includes('retryable: false'));
  assert.ok(source.includes('riftbroadcast:'));
});

test('electron main caps exponential restart attempts and reports final failure', () => {
  assert.ok(source.includes('SERVER_RESTART_MAX_ATTEMPTS = 5'));
  assert.ok(source.includes('SERVER_RESTART_BASE_MS = 500'));
  assert.ok(source.includes('SERVER_RESTART_MAX_MS = 15000'));
  assert.ok(source.includes('2 ** serverRestartAttempts'));
  assert.ok(source.includes('已重试 5 次'));
  assert.ok(source.includes('serverRestartTimer'));
});
