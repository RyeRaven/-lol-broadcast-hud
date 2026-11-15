'use strict';

// t31：事件驱动自动导播规则引擎测试。
// 覆盖阈值、同类事件冷却、重复事件、阶段映射、禁用/非 live 模式、配置持久化与 HTTP API。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  DEFAULT_DIRECTOR_CONFIG,
  normalizeDirectorConfig,
  createDirectorEngine,
  handleDirectorApi
} = require('../src/director');
const { state: appState, saveConfig, configPath } = require('../src/app-state');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fakeResponse() {
  return {
    statusCode: null,
    headersSent: false,
    body: '',
    writeHead(code) { this.statusCode = code; this.headersSent = true; },
    end(body) { this.body = String(body || ''); }
  };
}

function sendJson(res, code, body) {
  if (res.headersSent) return;
  res.writeHead(code);
  res.end(JSON.stringify(body));
}

function callDirectorApi(method, body, deps) {
  const res = fakeResponse();
  const handled = handleDirectorApi({ method }, res, new URL('http://127.0.0.1/api/director/rules'), {
    json: sendJson,
    readBody: () => Promise.resolve(body),
    ...deps
  });
  return { handled, res };
}

test('默认规则：阈值 50、默认 cue hud-in、draft/post_game 阶段映射', () => {
  assert.equal(DEFAULT_DIRECTOR_CONFIG.enabled, true);
  assert.equal(DEFAULT_DIRECTOR_CONFIG.threshold, 50);
  assert.equal(DEFAULT_DIRECTOR_CONFIG.cue, 'hud-in');
  assert.deepEqual(DEFAULT_DIRECTOR_CONFIG.phaseCues, { draft: 'bp-in', post_game: 'result-in' });
  const normalized = normalizeDirectorConfig({ threshold: '70', cooldownMs: '12000' });
  assert.equal(normalized.threshold, 70);
  assert.equal(normalized.cooldownMs, 12000);
  assert.equal(normalized.cue, 'hud-in');
});

test('阈值：只有 score >= threshold 的高光触发，低于阈值只消费不触发', () => {
  const engine = createDirectorEngine({
    config: { enabled: true, threshold: 50, cue: 'hud-in', cooldownMs: 0 },
    initialPhase: 'in_game'
  });
  const state = {
    mode: 'live',
    phase: 'in_game',
    highlights: [
      { id: 'low', type: 'dragon', score: 30, text: '小龙' },
      { id: 'high', type: 'baron', score: 70, text: '大龙' }
    ]
  };
  const triggers = engine.evaluate(state, 100000);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].eventId, 'high');
  assert.equal(triggers[0].score, 70);
  assert.equal(triggers[0].cue, 'hud-in');
  assert.equal(engine.evaluate(state, 100001).length, 0, '同一事件不能重复触发');
});

test('冷却：同类型事件在 cooldownMs 内不重复，不同类型可立即触发', () => {
  const engine = createDirectorEngine({
    config: { enabled: true, threshold: 10, cue: 'hud-in', cooldownMs: 5000 },
    initialPhase: 'in_game'
  });
  const base = 200000;
  const state = { mode: 'live', phase: 'in_game', highlights: [] };
  state.highlights = [{ id: 'a', type: 'dragon', score: 20 }];
  assert.equal(engine.evaluate(state, base).length, 1);
  state.highlights = [{ id: 'a', type: 'dragon', score: 20 }, { id: 'b', type: 'dragon', score: 30 }];
  assert.equal(engine.evaluate(state, base + 1000).length, 0, '同类型应被冷却');
  state.highlights.push({ id: 'c', type: 'baron', score: 40 });
  const baron = engine.evaluate(state, base + 2000);
  assert.equal(baron.length, 1);
  assert.equal(baron[0].eventId, 'c');
  state.highlights.push({ id: 'd', type: 'dragon', score: 50 });
  const later = engine.evaluate(state, base + 6000);
  assert.equal(later.length, 1, '冷却结束后同类型可再次触发');
  assert.equal(later[0].eventId, 'd');
});

test('重复事件：同一 id 不重复触发，递增 combo 也不会重复触发', () => {
  const engine = createDirectorEngine({ config: { threshold: 1, cooldownMs: 0 }, initialPhase: 'in_game' });
  const state = { mode: 'live', phase: 'in_game', highlights: [{ id: 'same', type: 'dragon', score: 80 }] };
  assert.equal(engine.evaluate(state, 1000).length, 1);
  assert.equal(engine.evaluate(state, 1001).length, 0);
  state.highlights = [{ id: 'combo-11+12', type: 'combo', score: 95 }];
  assert.equal(engine.evaluate(state, 2000).length, 1);
  state.highlights = [{ id: 'combo-11+12+13', type: 'combo', score: 155 }];
  assert.equal(engine.evaluate(state, 2001).length, 0, '同一连击只允许触发一次');
});

test('新对局：进入 BP 时清空去重与冷却，新局相同 EventID 可再次触发', () => {
  const engine = createDirectorEngine({ config: { threshold: 1, cooldownMs: 60000 }, initialPhase: 'in_game' });
  const state = { mode: 'live', phase: 'post_game', highlights: [] };
  assert.equal(engine.evaluate(state, 1000)[0].cue, 'result-in');
  state.phase = 'draft';
  assert.equal(engine.evaluate(state, 2000)[0].cue, 'bp-in');
  state.phase = 'in_game';
  state.highlights = [{ id: '1', type: 'dragon', score: 80 }];
  assert.equal(engine.evaluate(state, 3000).length, 1, '第一局事件应触发');
  state.phase = 'post_game';
  assert.equal(engine.evaluate(state, 4000)[0].cue, 'result-in');
  state.phase = 'draft';
  assert.equal(engine.evaluate(state, 5000)[0].cue, 'bp-in');
  state.phase = 'in_game';
  state.highlights = [{ id: '1', type: 'dragon', score: 80 }];
  assert.equal(engine.evaluate(state, 6000).length, 1, '新局相同 EventID 不应被上一局去重记录拦截');
});

test('阶段映射：draft -> bp-in，post_game -> result-in，且每个阶段只触发一次', () => {
  const engine = createDirectorEngine({ config: { enabled: true }, initialPhase: 'in_game' });
  const state = { mode: 'live', phase: 'draft', highlights: [] };
  const draft = engine.evaluate(state, 1000);
  assert.equal(draft.length, 1);
  assert.equal(draft[0].reason, 'phase');
  assert.equal(draft[0].cue, 'bp-in');
  assert.equal(engine.evaluate(state, 1001).length, 0);
  state.phase = 'in_game';
  assert.equal(engine.evaluate(state, 2000).length, 0);
  state.phase = 'post_game';
  state.highlights = [{ id: 'late-baron', type: 'baron', score: 90 }];
  const post = engine.evaluate(state, 3000);
  assert.equal(post.length, 1, '阶段切换时同批高光不应叠加覆盖 result-in');
  assert.equal(post[0].cue, 'result-in');
  state.phase = 'in_game';
  assert.equal(engine.evaluate(state, 3100).length, 0, '阶段切换时的高光已被消费，不再补播');
  assert.equal(engine.snapshot(3000).lastTrigger.cue, 'result-in');
  assert.ok(engine.snapshot(3000).cooldownRemaining >= 0);
});

test('手动禁用与非 live 模式：不触发，恢复 live 后不补播旧高光', () => {
  const engine = createDirectorEngine({ config: { enabled: false }, initialPhase: 'in_game' });
  const state = { mode: 'live', phase: 'in_game', highlights: [{ id: 'old', type: 'pentakill', score: 100 }] };
  assert.equal(engine.evaluate(state, 1000).length, 0);
  state.phase = 'draft';
  assert.equal(engine.evaluate(state, 2000).length, 0, '禁用期间进入 draft 不应补播 bp-in');
  engine.setConfig({ enabled: true, threshold: 50, cue: 'hud-in', cooldownMs: 0 });
  assert.equal(engine.evaluate(state, 2500).length, 0, '恢复启用时已处于 draft，不应补发阶段 cue');
  state.mode = 'mock';
  state.phase = 'post_game';
  assert.equal(engine.evaluate(state, 3000).length, 0, '非 live 模式不触发');
  state.mode = 'live';
  assert.equal(engine.evaluate(state, 4000).length, 0, '非 live 期间的状态变化不补播');
});

test('HTTP API：GET 返回规则，POST 更新并持久化，非法字段返回 400', async () => {
  const engine = createDirectorEngine({ config: { enabled: true, threshold: 50 }, initialPhase: 'in_game' });
  const state = { mode: 'live', phase: 'in_game', highlights: [], director: engine.snapshot() };
  let saves = 0;
  let broadcasts = 0;
  const deps = {
    state,
    engine,
    saveConfig: () => { saves += 1; },
    broadcast: () => { broadcasts += 1; }
  };

  const get = callDirectorApi('GET', undefined, deps);
  assert.equal(get.handled, true);
  assert.equal(get.res.statusCode, 200);
  const getBody = JSON.parse(get.res.body);
  assert.equal(getBody.ok, true);
  assert.equal(getBody.rules.threshold, 50);
  assert.equal(getBody.director.enabled, true);

  const post = callDirectorApi('POST', { enabled: false, threshold: 88, cue: 'result-in', cooldownMs: 12000 }, deps);
  await delay(20);
  assert.equal(post.res.statusCode, 200);
  const postBody = JSON.parse(post.res.body);
  assert.equal(postBody.ok, true);
  assert.equal(postBody.rules.threshold, 88);
  assert.equal(postBody.director.enabled, false);
  assert.equal(saves, 1);
  assert.equal(broadcasts, 1);
  assert.equal(state.director.threshold, 88);

  const previousSaves = saves;
  const bad = callDirectorApi('POST', { threshold: 'not-a-number' }, deps);
  await delay(20);
  assert.equal(bad.res.statusCode, 400);
  assert.equal(JSON.parse(bad.res.body).error, 'invalid_director_rules');
  assert.equal(saves, previousSaves, '非法输入不得持久化');
});

test('配置持久化：saveConfig 写入 director 段，重启读取可恢复规则', () => {
  const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
  const originalDirector = JSON.parse(JSON.stringify(appState.director));
  try {
    appState.director = {
      enabled: false,
      threshold: 77,
      cue: 'result-in',
      cooldownMs: 4321,
      phaseCues: { draft: 'bp-in', post_game: 'wipe' },
      lastTrigger: null,
      cooldownRemaining: 0
    };
    saveConfig();
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(saved.director, {
      enabled: false,
      threshold: 77,
      cue: 'result-in',
      cooldownMs: 4321,
      phaseCues: { draft: 'bp-in', post_game: 'wipe' }
    });
    // app-state 启动时会用同一个 normalizeDirectorConfig 恢复磁盘配置。
    const restored = normalizeDirectorConfig(saved.director);
    assert.equal(restored.enabled, false);
    assert.equal(restored.threshold, 77);
    assert.equal(restored.cue, 'result-in');
    assert.equal(restored.phaseCues.post_game, 'wipe');
  } finally {
    if (originalConfig) fs.writeFileSync(configPath, originalConfig);
    else try { fs.unlinkSync(configPath); } catch {}
    appState.director = originalDirector;
  }
});
