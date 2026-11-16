'use strict';

// HUD 布局微调：共享模型（src/hud-layout.js）+ /api/hud-layout 接口 + 编辑页结构。
// 不拉起完整服务：接口层用假 req/res 直接驱动，写盘指向临时目录（HUD_LAYOUT_PATH）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const {
  LAYOUT_VERSION,
  MAX_LAYOUT_BYTES,
  normalizeItem,
  normalizeLayoutPayload,
  loadLayout,
  saveLayout,
  emptyLayout
} = require('../src/hud-layout');
const { hudEditorPage, handleHudLayoutApi } = require('../src/pages/hud-editor');

function tempLayoutPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khada-hud-layout-'));
  return { dir, file: path.join(dir, 'hud-layout.json') };
}

function fakeRes() {
  return {
    headersSent: false,
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; },
    end(text) { this.body = text; this.headersSent = true; }
  };
}

// 假 req：够 handleHudLayoutApi 用的最小流对象。
function fakeReq(body, options = {}) {
  const req = new PassThrough();
  req.method = options.method || 'POST';
  req.socket = { remoteAddress: options.remoteAddress || '127.0.0.1' };
  req.headers = options.headers || {};
  if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body));
  else req.end();
  return req;
}

async function withLayoutPath(file, run) {
  const previous = process.env.HUD_LAYOUT_PATH;
  process.env.HUD_LAYOUT_PATH = file;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.HUD_LAYOUT_PATH;
    else process.env.HUD_LAYOUT_PATH = previous;
  }
}

test('normalizeItem 只收白名单字段、必须落在区间内、全中性项归一成空对象', () => {
  assert.deepEqual(normalizeItem({ dx: 12, dy: -8 }), { dx: 12, dy: -8 });
  assert.deepEqual(normalizeItem({ dx: 0, dy: 0, scale: 1, opacity: 1 }), {});
  assert.deepEqual(normalizeItem({ dx: 12, evil: 999 }), { dx: 12 }, '未知字段被丢弃，不整体拒绝');
  assert.ok(Object.is(normalizeItem({ dx: 1.23456 }).dx, 1.235), '保留三位小数');
  for (const bad of [{ dx: 5000 }, { dy: -2001 }, { w: -1 }, { scale: 0.1 }, { fontSize: 3 }, { opacity: 1.5 }]) {
    assert.equal(normalizeItem(bad), null, JSON.stringify(bad) + ' 应被拒绝');
  }
  for (const bad of [{ dx: '12' }, { dx: NaN }, { dx: null }, [], 'x', null]) {
    assert.equal(normalizeItem(bad), null, JSON.stringify(bad) + ' 应被拒绝');
  }
});

test('normalizeLayoutPayload 整包校验：坏 key / 超量 / 非对象一律拒绝', () => {
  const ok = normalizeLayoutPayload({ items: { topbar: { dy: -10 }, 'row-blue-0': { dx: 4 } } });
  assert.equal(ok.version, LAYOUT_VERSION);
  assert.equal(typeof ok.updatedAt, 'number');
  assert.deepEqual(ok.items.topbar, { dy: -10 });
  assert.deepEqual(ok.items['row-blue-0'], { dx: 4 });
  assert.deepEqual(normalizeLayoutPayload({ items: { 'bad key!': { dx: 1 } } }), null);
  assert.equal(normalizeLayoutPayload({ items: { a: { dx: 1 } } }), null, '单字符 key 不允许');
  assert.deepEqual(normalizeLayoutPayload({ items: [] }), null);
  assert.deepEqual(normalizeLayoutPayload({ items: { topbar: { dx: 9000 } } }), null);
  assert.deepEqual(normalizeLayoutPayload({}), null);
  assert.deepEqual(normalizeLayoutPayload(null), null);
  const many = {};
  for (let i = 0; i < 601; i += 1) many['item-' + i] = { dx: i + 1 };
  assert.deepEqual(normalizeLayoutPayload({ items: many }), null, '超过 600 项拒绝');
  const neutral = normalizeLayoutPayload({ items: { topbar: { dx: 0, scale: 1 } } });
  assert.deepEqual(neutral.items, {}, '中性项不写进文件');
});

test('saveLayout/loadLayout 往返；缺文件与坏文件回落到默认', () => {
  const tmp = tempLayoutPath();
  try {
    assert.deepEqual(loadLayout(tmp.file).source, 'default');
    assert.deepEqual(loadLayout(tmp.file).layout.items, {});
    const saved = saveLayout(tmp.file, { items: { topbar: { dy: -12 }, board: { scale: 1.08 } } });
    assert.deepEqual(saved.items.board, { scale: 1.08 });
    assert.deepEqual(fs.readdirSync(tmp.dir), ['hud-layout.json'], '原子写不留临时文件');
    const loaded = loadLayout(tmp.file);
    assert.equal(loaded.source, 'file');
    assert.deepEqual(loaded.layout.items.topbar, { dy: -12 });
    assert.equal(typeof loaded.layout.updatedAt, 'number');
    // 越界载荷不写盘
    assert.equal(saveLayout(tmp.file, { items: { topbar: { w: 4000 } } }), null);
    assert.deepEqual(loadLayout(tmp.file).layout.items.topbar, { dy: -12 }, '旧文件保持原样');
    // 坏 JSON 当成没有微调
    fs.writeFileSync(tmp.file, '{ oops', 'utf8');
    assert.equal(loadLayout(tmp.file).source, 'default');
    // 超大文件不解析
    fs.writeFileSync(tmp.file, '{"items":{}}' + ' '.repeat(MAX_LAYOUT_BYTES + 16), 'utf8');
    assert.equal(loadLayout(tmp.file).source, 'default');
    assert.deepEqual(emptyLayout().items, {});
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('GET /api/hud-layout 空数据返回 200 source=default', async () => {
  const tmp = tempLayoutPath();
  try {
    await withLayoutPath(tmp.file, async () => {
      const res = fakeRes();
      const handled = await handleHudLayoutApi(fakeReq(undefined, { method: 'GET' }), res, new URL('http://127.0.0.1/api/hud-layout'));
      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.source, 'default');
      assert.deepEqual(body.layout.items, {});
    });
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('POST 合法微调 200 落盘，随后 GET source=file', async () => {
  const tmp = tempLayoutPath();
  try {
    await withLayoutPath(tmp.file, async () => {
      const res = fakeRes();
      await handleHudLayoutApi(fakeReq({ items: { 'row-red-2': { dx: -6, dy: 3 }, timer: { fontSize: 18 } } }), res, new URL('http://127.0.0.1/api/hud-layout'));
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).ok, true);
      const onDisk = JSON.parse(fs.readFileSync(tmp.file, 'utf8'));
      assert.deepEqual(onDisk.items['row-red-2'], { dx: -6, dy: 3 });
      assert.deepEqual(onDisk.items.timer, { fontSize: 18 });

      const again = fakeRes();
      await handleHudLayoutApi(fakeReq(undefined, { method: 'GET' }), again, new URL('http://127.0.0.1/api/hud-layout'));
      const body = JSON.parse(again.body);
      assert.equal(body.source, 'file');
      assert.deepEqual(body.layout.items.timer, { fontSize: 18 });
    });
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('POST 越界字段 400 invalid_layout 且旧文件保留', async () => {
  const tmp = tempLayoutPath();
  try {
    saveLayout(tmp.file, { items: { topbar: { dy: -4 } } });
    await withLayoutPath(tmp.file, async () => {
      const res = fakeRes();
      await handleHudLayoutApi(fakeReq({ items: { topbar: { dx: 9000 } } }), res, new URL('http://127.0.0.1/api/hud-layout'));
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).error, 'invalid_layout');
      assert.deepEqual(JSON.parse(fs.readFileSync(tmp.file, 'utf8')).items.topbar, { dy: -4 });
    });
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('POST 非回环地址 403；超大载荷 413；非 GET/POST 405', async () => {
  const tmp = tempLayoutPath();
  try {
    await withLayoutPath(tmp.file, async () => {
      const forbidden = fakeRes();
      await handleHudLayoutApi(fakeReq({ items: {} }, { remoteAddress: '192.168.1.9' }), forbidden, new URL('http://127.0.0.1/api/hud-layout'));
      assert.equal(forbidden.statusCode, 403);
      assert.equal(JSON.parse(forbidden.body).error, 'forbidden');

      const big = fakeRes();
      const huge = JSON.stringify({ items: { topbar: { dx: 1 } }, pad: 'x'.repeat(MAX_LAYOUT_BYTES + 512) });
      await handleHudLayoutApi(fakeReq(huge), big, new URL('http://127.0.0.1/api/hud-layout'));
      assert.equal(big.statusCode, 413);
      assert.equal(JSON.parse(big.body).error, 'payload_too_large');
      assert.equal(fs.existsSync(tmp.file), false, '被拒绝的请求不写盘');

      const wrongMethod = fakeRes();
      await handleHudLayoutApi(fakeReq(undefined, { method: 'DELETE' }), wrongMethod, new URL('http://127.0.0.1/api/hud-layout'));
      assert.equal(wrongMethod.statusCode, 405);

      const otherPath = fakeRes();
      assert.equal(handleHudLayoutApi(fakeReq({ items: {} }), otherPath, new URL('http://127.0.0.1/api/state')), false, '非本接口不接管');
    });
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('编辑页包含 iframe 预览、7 个数控输入与保存按钮', () => {
  const html = hudEditorPage();
  assert.ok(html.includes('<!doctype html'));
  assert.ok(html.includes('HUD 布局微调'));
  assert.ok(html.includes('src="/overlay/hud-broadcast?hudEdit=1"'), '右侧必须是带 hudEdit=1 的 HUD 预览');
  assert.ok(html.includes('width="1920" height="1080"'));
  const fields = html.match(/data-field="/g) || [];
  assert.equal(fields.length, 7, '7 个可调字段');
  for (const id of ['he-list', 'he-panel', 'he-save', 'he-reset-all', 'he-reload', 'he-snap', 'he-status']) {
    assert.ok(html.includes('id="' + id + '"'), '缺少 #' + id);
  }
  assert.ok(html.includes("fetch('/api/hud-layout'"), '保存必须走 /api/hud-layout');
  assert.ok(html.includes('.he-stage'), '页内应内联 hud-editor.css');
  assert.ok(html.includes('data-hud-editor-theme'));
});
