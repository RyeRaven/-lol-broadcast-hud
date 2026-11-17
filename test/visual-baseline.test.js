'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decodePng, encodePng, diffImages, STATES, DEFAULT_WIDTH, DEFAULT_HEIGHT } = require('../tools/shot-hud.cjs');

const ROOT = path.join(__dirname, '..');
const BASELINE_DIR = path.join(ROOT, 'test', 'visual-baseline');
const FILES = Object.freeze({
  full: 'hud-full-1920x1080.png',
  degraded: 'hud-degraded-1920x1080.png',
  edge: 'hud-edge-1920x1080.png'
});

function readBaseline(state) {
  return decodePng(fs.readFileSync(path.join(BASELINE_DIR, FILES[state])));
}

test('visual baseline: three full-size PNGs above the 20KB floor', () => {
  for (const state of STATES) {
    const file = path.join(BASELINE_DIR, FILES[state]);
    assert.ok(fs.existsSync(file), state + ' baseline is missing: ' + file);
    const bytes = fs.statSync(file).size;
    assert.ok(bytes > 20 * 1024, state + ' baseline is only ' + bytes + 'B');
    const image = decodePng(fs.readFileSync(file));
    assert.equal(image.width, DEFAULT_WIDTH, state + ' width');
    assert.equal(image.height, DEFAULT_HEIGHT, state + ' height');
  }
});

test('visual baseline: manifest records ten visible rows per state', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, 'manifest.json'), 'utf8'));
  assert.equal(manifest.viewport.width, DEFAULT_WIDTH);
  assert.equal(manifest.viewport.height, DEFAULT_HEIGHT);
  assert.equal(manifest.shots.length, STATES.length);
  for (const shot of manifest.shots) {
    assert.equal(shot.rows, 10, shot.state + ' rows');
    assert.equal(shot.visibleRows, 10, shot.state + ' visible rows');
    assert.equal(shot.width, DEFAULT_WIDTH);
    assert.equal(shot.height, DEFAULT_HEIGHT);
    assert.ok(shot.bytes > 20 * 1024);
    for (const rect of shot.rects) {
      assert.ok(rect.x >= 0 && rect.y >= 0, shot.state + ' ' + rect.id + ' starts off-screen');
      assert.ok(rect.x + rect.width <= DEFAULT_WIDTH + 1, shot.state + ' ' + rect.id + ' overflows horizontally');
      assert.ok(rect.y + rect.height <= DEFAULT_HEIGHT + 1, shot.state + ' ' + rect.id + ' overflows vertically');
    }
  }
});

test('visual baseline: degraded state renders em dashes and no bar fill', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, 'manifest.json'), 'utf8'));
  const shot = manifest.shots.find(item => item.state === 'degraded');
  assert.ok(shot, 'degraded shot missing');
  assert.equal(shot.cells.length, 10);
  for (const cell of shot.cells) {
    // 挖孔/自绘模式切换不影响本断言：baseline 对比只读 manifest 里固化的快照。
    // 无条件渲染的数据格，用它断言「数据不可用必须显示 —」。
    assert.equal(cell.kda, '—', cell.id + ' KDA should be unavailable');
    assert.deepEqual(cell.fillPx, [0, 0, 0], cell.id + ' should have unknown bar placeholders');
  }
});

test('visual baseline: edge state shows live KDA, hp 0% and hp 100%', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, 'manifest.json'), 'utf8'));
  const shot = manifest.shots.find(item => item.state === 'edge');
  assert.ok(shot, 'edge shot missing');
  assert.equal(shot.cells.length, 10);
  for (const cell of shot.cells) {
    // LCDA 数据可用时 KDA 必须是 k/d/a 数字（CS 量化断言已随 CS 列移除退役）。
    assert.ok(/^\d+\/\d+\/\d+$/.test(String(cell.kda)), cell.id + ' KDA should be live numbers, got ' + cell.kda);
  }
  const hpWidths = shot.cells.map(cell => cell.fillPx[1]);
  assert.ok(hpWidths.some(width => width <= 1), 'edge must contain an empty hp bar');
  assert.ok(hpWidths.some(width => width >= 110), 'edge must contain a full hp bar');
  const resources = shot.cells.map(cell => cell.fillPx[2]);
  assert.ok(resources.some(width => width === 0), 'edge must contain a missing resource bar');
});

test('visual baseline: distinct states diff non-zero, identical input diffs to zero', () => {
  const full = readBaseline('full');
  const edge = readBaseline('edge');
  // 跨状态对比才是真断言（同 buffer 自 diff 恒零，只当廉价不变量保留）。
  const cross = diffImages(full, edge, { threshold: 0 });
  assert.ok(cross.changedPixels > 0, 'distinct baseline states must not diff to zero');
  for (const image of [full, edge]) {
    const result = diffImages(image, image, { threshold: 0 });
    assert.equal(result.changedPixels, 0, 'self diff pixels');
    assert.equal(result.changedPercent, 0, 'self diff percent');
    assert.equal(result.boundingBox, null, 'self diff bbox');
    assert.equal(result.maxChannelDelta, 0, 'self diff delta');
  }
});

test('visual baseline: a single modified pixel is reported', () => {
  const image = readBaseline('full');
  const data = Buffer.from(image.data);
  const offset = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
  data[offset] = data[offset] ^ 0xff;
  const result = diffImages(image, { width: image.width, height: image.height, channels: image.channels, colorType: image.colorType, data }, { threshold: 0 });
  assert.equal(result.changedPixels, 1);
  assert.ok(result.changedPercent > 0, 'one-pixel diff must be > 0%');
  assert.deepEqual(result.boundingBox, { x: Math.floor(image.width / 2), y: Math.floor(image.height / 2), width: 1, height: 1 });
  assert.equal(result.maxChannelDelta, 255);
});

test('visual baseline: encode/decode round-trip keeps the zero-diff contract', () => {
  const image = readBaseline('full');
  const roundTripped = decodePng(encodePng(image.width, image.height, image.data));
  const result = diffImages(image, roundTripped, { threshold: 0 });
  assert.equal(result.changedPixels, 0);
});
