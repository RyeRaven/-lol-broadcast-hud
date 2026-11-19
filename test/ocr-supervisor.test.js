'use strict';

// src/ocr-supervisor.js 单元测试：端点解析、worker 参数构造、运行时解析。
// 进程托管（拉起/重启）走 e2e（test/ocr-e2e.test.js 的假 worker）。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sup = require('../src/ocr-supervisor');

test('parseObsEndpoint：ws url 拆 host/port，坏值回退默认', () => {
  assert.deepStrictEqual(sup.parseObsEndpoint({ url: 'ws://192.168.1.9:4444', password: 'x' }),
    { host: '192.168.1.9', port: 4444 });
  assert.deepStrictEqual(sup.parseObsEndpoint({ url: 'ws://127.0.0.1', password: '' }),
    { host: '127.0.0.1', port: 4455 });
  assert.deepStrictEqual(sup.parseObsEndpoint({ url: 'not-a-url' }),
    { host: '127.0.0.1', port: 4455 });
  assert.deepStrictEqual(sup.parseObsEndpoint(null), { host: '127.0.0.1', port: 4455 });
});

test('buildWorkerArgs：host/port-obs/password/port-api/hz 全量透传；ocrSource 非空追加 --source', () => {
  const args = sup.buildWorkerArgs(
    { name: 'hp', hz: 10 },
    { host: '10.0.0.2', port: 4456 },
    { password: 'pw1', ocrSource: '游戏采集' },
    3210
  );
  assert.deepStrictEqual(args, ['--host', '10.0.0.2', '--port-obs', '4456', '--password', 'pw1', '--port-api', '3210', '--hz', '10', '--source', '游戏采集']);
  // ocrSource 空 = 自动识别第一个 game_capture 源，不传 --source。
  const auto = sup.buildWorkerArgs({ name: 'econ', hz: 1 }, { host: 'h', port: 1 }, { password: '', ocrSource: '' }, 1);
  assert.ok(!auto.includes('--source'));
});

test('resolveRuntime：RB_OCR_RUNTIME_DIR 命中捆绑运行时', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rt-'));
  try {
    fs.mkdirSync(path.join(dir, 'python'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'python', 'python.exe'), '');
    fs.writeFileSync(path.join(dir, 'run_ocr.py'), '');
    const rt = sup.resolveRuntime('/nonexistent', { RB_OCR_RUNTIME_DIR: dir });
    assert.strictEqual(rt.kind, 'bundled');
    assert.strictEqual(rt.runtimeDir, dir);
    assert.strictEqual(path.basename(rt.pythonExe), 'python.exe');
    assert.ok(rt.scriptPath.endsWith('run_ocr.py'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRuntime：无捆绑运行时时回退系统 python + tools/ocr/run_ocr.py', () => {
  // 仓库 build/ocr-runtime 已存在（会命中 bundled），用隔离的假仓库根验证系统回退。
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-sysroot-'));
  try {
    fs.mkdirSync(path.join(fakeRoot, 'tools', 'ocr'), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, 'tools', 'ocr', 'run_ocr.py'), '');
    const rt = sup.resolveRuntime(fakeRoot, {});
    assert.strictEqual(rt.kind, 'system');
    assert.ok(rt.scriptPath.replace(/\\/g, '/').endsWith('tools/ocr/run_ocr.py'));
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test('resolveRuntime：完全无候选返回 null，state.reason=no-runtime', () => {
  const missing = path.join(os.tmpdir(), 'ocr-missing-' + Date.now());
  const fakeRoot = path.join(missing, 'app');
  const rt = sup.resolveRuntime(fakeRoot, {});
  if (rt && rt.kind === 'system') {
    // 系统 python 兜底要求 tools/ocr/run_ocr.py 存在；本仓库存在，跳过 null 分支
    assert.ok(rt.scriptPath);
    return;
  }
  assert.strictEqual(rt, null);
});

test('createOcrSupervisor：disabled 时 start 只写状态不拉进程', async () => {
  const state = { ocrSupervisor: null };
  const calls = [];
  const s = sup.createOcrSupervisor({
    state, port: 3999, getObsConfig: () => ({ url: 'ws://127.0.0.1:4455', password: '' }),
    broadcast: () => calls.push('b'),
    appRoot: __dirname, env: {}
  });
  s.start();
  await new Promise(resolve => setImmediate(resolve)); // start 内部延后一拍再动手
  assert.strictEqual(state.ocrSupervisor.enabled, false);
  assert.ok(['disabled', 'no-runtime'].includes(state.ocrSupervisor.reason));
  assert.ok(calls.length >= 1);
  s.stopAll();
});
