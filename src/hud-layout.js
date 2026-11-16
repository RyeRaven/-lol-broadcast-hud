'use strict';

// HUD 布局微调的共享模型（服务端 API + 测试用）。
// 一项目的 = 对一个 HUD 元素的相对微调：位移、尺寸、缩放、字号、透明度。
// 全部存「相对量」，不改结构、不改网格：这样窗口缩放/数据变化后布局仍然成立。
const fs = require('fs');
const path = require('path');

const LAYOUT_VERSION = 1;
const MAX_LAYOUT_BYTES = 64 * 1024;
const MAX_ITEMS = 600; // 满元素面板约 300 项，留一倍余量
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,39}$/i;

// 每个字段的合法区间；0 表示「不覆盖」，只有 w/h 用 0 表示回到自适应。
const FIELD_RANGES = {
  dx: [-2000, 2000],
  dy: [-2000, 2000],
  w: [0, 3000],
  h: [0, 3000],
  scale: [0.2, 4],
  fontSize: [4, 120],
  opacity: [0, 1]
};
const FIELD_NAMES = Object.keys(FIELD_RANGES);
const NEUTRAL = { dx: 0, dy: 0, w: 0, h: 0, scale: 1, fontSize: 0, opacity: 1 };

function round3(value) { return Math.round(value * 1000) / 1000; }

function emptyLayout() { return { version: LAYOUT_VERSION, updatedAt: null, items: {} }; }

// 单项校验：只接受白名单字段，全部必须在区间内；全中性的项直接丢掉（不写进文件）。
function normalizeItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = {};
  for (const field of FIELD_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const raw = value[field];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    const range = FIELD_RANGES[field];
    if (raw < range[0] || raw > range[1]) return null;
    item[field] = round3(raw);
  }
  let neutral = true;
  for (const field of Object.keys(item)) {
    if (item[field] !== NEUTRAL[field]) { neutral = false; break; }
  }
  return neutral ? {} : item;
}

// POST 载荷 / 文件内容统一走这里。任何一项不合法 → 整体拒绝（绝不部分写入）。
function normalizeLayoutPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (!input.items || typeof input.items !== 'object' || Array.isArray(input.items)) return null;
  const keys = Object.keys(input.items);
  if (keys.length > MAX_ITEMS) return null;
  const items = {};
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) return null;
    const item = normalizeItem(input.items[key]);
    if (item === null) return null;
    if (Object.keys(item).length === 0) continue;
    items[key] = item;
  }
  return { version: LAYOUT_VERSION, updatedAt: Date.now(), items };
}

// 读盘：文件缺失 / JSON 损坏 / 字段越界一律当成「没有微调」，绝不因为一个坏文件把 HUD 打挂。
function loadLayout(filePath) {
  let raw;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_LAYOUT_BYTES) return { layout: emptyLayout(), source: 'default' };
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { layout: emptyLayout(), source: 'default' };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { return { layout: emptyLayout(), source: 'default' }; }
  const normalized = normalizeLayoutPayload(parsed);
  if (!normalized) return { layout: emptyLayout(), source: 'default' };
  normalized.updatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null;
  return { layout: normalized, source: 'file' };
}

// 原子写盘：先写 .tmp 再 rename，失败时旧文件完好（OBS 正在读的同时保存也不会读到半个 JSON）。
function saveLayout(filePath, payload) {
  const normalized = normalizeLayoutPayload(payload);
  if (!normalized) return null;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

module.exports = {
  LAYOUT_VERSION,
  MAX_LAYOUT_BYTES,
  FIELD_RANGES,
  FIELD_NAMES,
  NEUTRAL,
  emptyLayout,
  normalizeItem,
  normalizeLayoutPayload,
  loadLayout,
  saveLayout
};
