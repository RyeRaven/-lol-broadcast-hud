'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_BROADCAST_CONFIG,
  normalizeBroadcastConfig,
  readBroadcastConfig,
  saveBroadcastConfig,
  resolveImage
} = require('../src/broadcast-config');

test('normalizeBroadcastConfig 补齐缺省字段并转换数字', () => {
  const config = normalizeBroadcastConfig({
    teams: { blue: { name: '蓝队' } },
    players: [{ gameName: 'Mid' }],
    coaches: ['Coach A'],
    sponsors: [{ name: 'Sponsor' }],
    series: { bestOf: '5' },
    fearless: { pbPct: '73.3' }
  });
  assert.equal(config.teams.blue.name, '蓝队');
  assert.equal(config.teams.blue.shortName, DEFAULT_BROADCAST_CONFIG.teams.blue.shortName);
  assert.equal(config.teams.blue.color, DEFAULT_BROADCAST_CONFIG.teams.blue.color);
  assert.equal(config.teams.red.name, DEFAULT_BROADCAST_CONFIG.teams.red.name);
  assert.equal(config.players[0].displayName, 'Mid');
  assert.equal(config.players[0].team, '');
  assert.equal(config.players[0].photo, '');
  assert.equal(config.coaches[0].name, 'Coach A');
  assert.equal(config.coaches[0].role, 'COACH');
  assert.equal(config.sponsors[0].image, '');
  assert.equal(config.series.bestOf, 5);
  assert.equal(config.fearless.pbPct, 73.3);
  assert.equal(config.fearless.wins, 0);
});

test('resolveImage 保留外链、校验本地图片并拒绝缺失文件', () => {
  assert.equal(resolveImage('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(resolveImage('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(resolveImage('styles.css'), '/styles.css');
  assert.equal(resolveImage('/styles.css'), '/styles.css');
  assert.equal(resolveImage('/missing-image.png'), '');
  const config = normalizeBroadcastConfig({
    teams: { blue: { logo: '/styles.css' }, red: { logo: '/missing-image.png' } },
    players: [{ gameName: 'A', photo: '/missing-image.png' }],
    sponsors: [{ name: 'S', image: 'https://example.com/s.png' }]
  });
  assert.equal(config.teams.blue.logo, '/styles.css');
  assert.equal(config.teams.red.logo, '');
  assert.equal(config.players[0].photo, '');
  assert.equal(config.sponsors[0].image, 'https://example.com/s.png');
});

test('readBroadcastConfig 对缺失和损坏文件返回默认配置副本', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'riftbroadcast-config-'));
  const missing = path.join(temp, 'missing.json');
  const broken = path.join(temp, 'broken.json');
  fs.writeFileSync(broken, '{not json', 'utf8');
  try {
    const fromMissing = readBroadcastConfig(missing);
    const fromBroken = readBroadcastConfig(broken);
    assert.equal(fromMissing.teams.blue.name, DEFAULT_BROADCAST_CONFIG.teams.blue.name);
    assert.equal(fromBroken.teams.red.name, DEFAULT_BROADCAST_CONFIG.teams.red.name);
    assert.notStrictEqual(fromMissing, DEFAULT_BROADCAST_CONFIG);
    assert.notStrictEqual(fromMissing.teams, DEFAULT_BROADCAST_CONFIG.teams);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('saveBroadcastConfig 归一化并持久化到指定文件', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'riftbroadcast-config-'));
  const target = path.join(temp, 'nested', 'broadcast.json');
  try {
    const saved = saveBroadcastConfig({
      teams: { blue: { name: '保存队', logo: '/styles.css' } },
      players: [{ gameName: 'Player 1', photo: '/missing.png' }],
      series: { bestOf: '5', records: { blue: '2', red: 1 } }
    }, target);
    assert.ok(fs.existsSync(target));
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(raw.teams.blue.name, '保存队');
    assert.equal(raw.teams.blue.logo, '/styles.css');
    assert.equal(raw.players[0].photo, '');
    assert.equal(raw.series.bestOf, 5);
    assert.equal(raw.series.records.blue, 2);
    assert.deepEqual(readBroadcastConfig(target), saved);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
