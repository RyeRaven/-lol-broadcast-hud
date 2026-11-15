'use strict';

// 事件驱动自动导播规则引擎。
// 订阅 state.highlights 和 state.phase 的变化，只返回触发意图；真正的 cue 写入由 main.js
// 复用 /api/broadcast/cue 的 applyBroadcastCue 完成，避免把 HTTP 逻辑耦合进规则模块。
// 规则：高光分数达到阈值触发 cue；同类型事件冷却；仅 live 模式；可手动禁用；阶段切换映射。

const DEFAULT_DIRECTOR_CONFIG = Object.freeze({
  enabled: true,
  threshold: 50,
  cue: 'hud-in',
  cooldownMs: 15000,
  phaseCues: Object.freeze({ draft: 'bp-in', post_game: 'result-in' })
});

const DIRECTOR_CUES = Object.freeze(['bp-in', 'hud-in', 'result-in', 'wipe', 'reset']);
const MAX_SEEN_EVENTS = 500;

function copyConfig(config) {
  return {
    enabled: config.enabled,
    threshold: config.threshold,
    cue: config.cue,
    cooldownMs: config.cooldownMs,
    phaseCues: { draft: config.phaseCues.draft, post_game: config.phaseCues.post_game }
  };
}

function highlightKeys(entry) {
  if (!entry || entry.id === undefined || entry.id === null) return [];
  const id = String(entry.id);
  if (!id) return [];
  // combo 的 id 形如 combo-33+35；任一组成事件已触发过就不再重复触发递增中的同一条连击。
  if (id.indexOf('combo-') === 0) {
    const parts = id.slice(6).split('+').map(part => part.trim()).filter(Boolean);
    if (parts.length) return parts;
  }
  return [id];
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeCue(value, fallback = '') {
  const cue = typeof value === 'string' ? value.trim() : '';
  if (!cue) return fallback;
  return DIRECTOR_CUES.includes(cue) ? cue : fallback;
}

// 宽容读取磁盘配置：非法字段回落到默认值，保证老配置文件仍能启动。
function normalizeDirectorConfig(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const phaseCues = source.phaseCues && typeof source.phaseCues === 'object' && !Array.isArray(source.phaseCues)
    ? source.phaseCues
    : {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_DIRECTOR_CONFIG.enabled,
    threshold: Math.round(clamp(toNumber(source.threshold, DEFAULT_DIRECTOR_CONFIG.threshold), 0, 100000)),
    cue: normalizeCue(source.cue, DEFAULT_DIRECTOR_CONFIG.cue),
    cooldownMs: Math.round(clamp(toNumber(source.cooldownMs, DEFAULT_DIRECTOR_CONFIG.cooldownMs), 0, 24 * 60 * 60 * 1000)),
    phaseCues: {
      draft: normalizeCue(phaseCues.draft, DEFAULT_DIRECTOR_CONFIG.phaseCues.draft),
      post_game: normalizeCue(phaseCues.post_game, DEFAULT_DIRECTOR_CONFIG.phaseCues.post_game)
    }
  };
}

function configOnly(value) {
  return copyConfig(normalizeDirectorConfig(value));
}

function validateDirectorPatch(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return 'invalid_director_rules';
  if (source.enabled !== undefined && typeof source.enabled !== 'boolean') return 'invalid_director_rules';
  if (source.threshold !== undefined) {
    const threshold = Number(source.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100000) return 'invalid_director_rules';
  }
  if (source.cue !== undefined && !DIRECTOR_CUES.includes(String(source.cue).trim())) return 'invalid_director_rules';
  if (source.cooldownMs !== undefined) {
    const cooldown = Number(source.cooldownMs);
    if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 24 * 60 * 60 * 1000) return 'invalid_director_rules';
  }
  if (source.phaseCues !== undefined) {
    if (!source.phaseCues || typeof source.phaseCues !== 'object' || Array.isArray(source.phaseCues)) return 'invalid_director_rules';
    for (const key of ['draft', 'post_game']) {
      const value = source.phaseCues[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string' || !DIRECTOR_CUES.includes(value.trim())) return 'invalid_director_rules';
    }
  }
  return null;
}

// POST body 支持 { ...rules }、{ rules: {...} }、{ director: {...} } 或 { config: {...} }。
function extractDirectorPatch(body) {
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return { error: 'invalid_json' }; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_director_rules' };
  let source = body;
  if (body.rules !== undefined) source = body.rules;
  else if (body.director !== undefined) source = body.director;
  else if (body.config !== undefined) source = body.config;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { return { error: 'invalid_json' }; }
  }
  const invalid = validateDirectorPatch(source);
  if (invalid) return { error: invalid };
  return { rules: source };
}

function createDirectorEngine(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  let config = normalizeDirectorConfig(opts.config);
  let lastPhase = Object.prototype.hasOwnProperty.call(opts, 'initialPhase') ? opts.initialPhase : null;
  let lastTrigger = null;
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
  const maxSeen = Number.isFinite(Number(opts.maxSeenEvents)) && Number(opts.maxSeenEvents) > 0
    ? Math.floor(Number(opts.maxSeenEvents)) : MAX_SEEN_EVENTS;
  const seen = new Map();
  const lastTypeAt = new Map();

  function remember(eventId, at) {
    seen.delete(eventId);
    seen.set(eventId, at);
    while (seen.size > maxSeen) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }

  function cooldownRemaining(now = nowFn()) {
    let remaining = 0;
    for (const at of lastTypeAt.values()) {
      remaining = Math.max(remaining, Math.max(0, config.cooldownMs - Math.max(0, now - at)));
    }
    return Math.round(remaining);
  }

  function snapshot(now = nowFn()) {
    return {
      ...copyConfig(config),
      lastTrigger: lastTrigger ? JSON.parse(JSON.stringify(lastTrigger)) : null,
      cooldownRemaining: cooldownRemaining(now)
    };
  }

  function evaluate(state, now = nowFn()) {
    const triggers = [];
    const highlights = state && Array.isArray(state.highlights) ? state.highlights.filter(Boolean) : [];
    const currentPhase = state ? state.phase : null;
    const isLive = !!state && state.mode === 'live';

    // 新一局 BP 开始时清空去重/冷却，避免新局复用 EventID 时被误判为重复事件。
    if (currentPhase !== lastPhase && currentPhase === 'draft') {
      seen.clear();
      lastTypeAt.clear();
    }
    // 跨局直接进对局（新局跳过 draft，如 lobby→in_game）同样会撞 EventID：高光事件编号
    // 每局从头计数。进入 in_game 时若高光列表已空，说明管线已随新局重置，旧局去重记录
    // 必须清空，否则新局相同 EventID 会被永久拦截；列表非空则是同一局的阶段回切，
    // 已消费事件不能补播（见 director.test 阶段映射用例的契约）。
    if (currentPhase !== lastPhase && currentPhase === 'in_game' && highlights.length === 0) {
      seen.clear();
      lastTypeAt.clear();
    }

    if (!config.enabled || !isLive) {
      // 禁用/非 live 期间发生的事件直接标记为已消费，避免重新启用后补触发旧高光。
      for (const entry of highlights) {
        for (const key of highlightKeys(entry)) remember(key, now);
      }
      lastPhase = currentPhase;
      return triggers;
    }

    let phaseTrigger = null;
    if (currentPhase !== lastPhase) {
      const cue = config.phaseCues[currentPhase];
      if (cue) {
        phaseTrigger = {
          reason: 'phase',
          phase: currentPhase,
          cue,
          at: now,
          payload: { reason: 'phase', phase: currentPhase }
        };
      }
      lastPhase = currentPhase;
    }
    if (phaseTrigger) {
      // 阶段切换优先：同一次广播里不要把刚结束对局的高光 cue 覆盖到 result-in/bp-in 上。
      // 进入 draft 时 highlights 仍是上一局残留，不能记入新一局的去重集合。
      if (currentPhase !== 'draft') {
        for (const entry of highlights) {
          for (const key of highlightKeys(entry)) remember(key, now);
        }
      }
      lastTrigger = phaseTrigger;
      return [phaseTrigger];
    }

    const ordered = highlights.slice().sort((a, b) => {
      const scoreDiff = (Number(b && b.score) || 0) - (Number(a && a.score) || 0);
      if (scoreDiff) return scoreDiff;
      return (Number(b && b.time) || 0) - (Number(a && a.time) || 0);
    });

    for (const entry of ordered) {
      const eventKeys = highlightKeys(entry);
      if (!eventKeys.length || eventKeys.some(key => seen.has(key))) continue;
      const eventId = String(entry.id);
      const score = Number(entry.score);
      const type = String(entry.type || 'highlight');
      // 未达阈值的事件也记录为已消费：之后调低阈值不能把陈年高光补播出来。
      if (!Number.isFinite(score) || score < config.threshold) {
        for (const key of eventKeys) remember(key, now);
        continue;
      }
      const lastAt = lastTypeAt.get(type);
      if (lastAt !== undefined && now - lastAt < config.cooldownMs) {
        for (const key of eventKeys) remember(key, now);
        continue;
      }
      lastTrigger = {
        reason: 'highlight',
        eventId,
        type,
        score,
        cue: config.cue,
        at: now,
        payload: {
          reason: 'highlight',
          eventId,
          type,
          score,
          text: String(entry.text || ''),
          side: entry.side || null,
          champion: entry.champion || ''
        }
      };
      triggers.push(lastTrigger);
      lastTypeAt.set(type, now);
      for (const key of eventKeys) remember(key, now);
    }

    return triggers;
  }

  return {
    getConfig() { return copyConfig(config); },
    setConfig(next = {}) {
      config = normalizeDirectorConfig({ ...config, ...(next && typeof next === 'object' ? next : {}) });
      return copyConfig(config);
    },
    evaluate,
    snapshot,
    reset() {
      seen.clear();
      lastTypeAt.clear();
      lastTrigger = null;
      lastPhase = null;
    }
  };
}

// GET 返回当前规则与运行状态；POST 支持部分字段更新并持久化。
function handleDirectorApi(req, res, url, context = {}) {
  if (!url || url.pathname !== '/api/director/rules') return false;
  const { json, readBody, state, engine, saveConfig, broadcast } = context;
  if (req.method === 'GET') {
    const snapshot = engine && typeof engine.snapshot === 'function'
      ? engine.snapshot()
      : { ...configOnly(state && state.director), lastTrigger: null, cooldownRemaining: 0 };
    if (state) state.director = snapshot;
    if (typeof json === 'function') json(res, 200, { ok: true, rules: configOnly(snapshot), director: snapshot, ...snapshot });
    return true;
  }
  if (req.method !== 'POST') {
    if (typeof json === 'function') json(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  Promise.resolve().then(() => readBody(req, res)).then(body => {
    const parsed = extractDirectorPatch(body);
    if (parsed.error) {
      json(res, parsed.error === 'invalid_json' ? 400 : 400, { ok: false, error: parsed.error });
      return;
    }
    const current = engine && typeof engine.getConfig === 'function'
      ? engine.getConfig()
      : configOnly(state && state.director);
    const next = normalizeDirectorConfig({ ...current, ...parsed.rules });
    let snapshot;
    if (engine && typeof engine.setConfig === 'function') {
      engine.setConfig(next);
      snapshot = engine.snapshot();
    } else {
      snapshot = { ...next, lastTrigger: null, cooldownRemaining: 0 };
    }
    if (state) state.director = snapshot;
    if (typeof saveConfig === 'function') saveConfig();
    if (typeof broadcast === 'function') broadcast();
    if (engine && typeof engine.snapshot === 'function') snapshot = engine.snapshot();
    if (state) state.director = snapshot;
    json(res, 200, { ok: true, rules: configOnly(snapshot), director: snapshot, ...snapshot });
  }).catch(error => {
    if (!res.headersSent) json(res, error.statusCode || 500, { ok: false, error: error.statusCode === 413 ? 'payload_too_large' : error.message });
  });
  return true;
}

module.exports = {
  DEFAULT_DIRECTOR_CONFIG,
  DIRECTOR_CUES,
  MAX_SEEN_EVENTS,
  normalizeDirectorConfig,
  createDirectorEngine,
  handleDirectorApi
};
