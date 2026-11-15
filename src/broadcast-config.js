'use strict';

// 广播配置：队伍、选手、教练、赞助商与系列赛数据。纯数据模块，零依赖。
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// Electron 打包运行时由主进程注入 RB_DATA_DIR（userData），配置跟着用户走而不是跟着安装目录走；
// 直接 node src/main.js 开发/测试时无此变量，仍写项目内 config/。
const CONFIG_DIR = process.env.RB_DATA_DIR
  ? path.join(path.resolve(process.env.RB_DATA_DIR), 'config')
  : path.join(PROJECT_ROOT, 'config');
// 测试/多实例可用 RB_BROADCAST_CONFIG 指到别处，避免读写真实用户配置。
const CONFIG_PATH = process.env.RB_BROADCAST_CONFIG ? path.resolve(process.env.RB_BROADCAST_CONFIG) : path.join(CONFIG_DIR, 'broadcast.json');
const EXAMPLE_PATH = path.join(CONFIG_DIR, 'broadcast.example.json');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

const DEFAULT_BROADCAST_CONFIG = {
  teams: {
    blue: { name: '蓝方', shortName: 'BLUE', region: 'CN', rank: '', logo: '', color: '#3B82F6' },
    red: { name: '红方', shortName: 'RED', region: 'CN', rank: '', logo: '', color: '#EF4444' }
  },
  players: [],
  coaches: [],
  sponsors: [],
  series: { name: '', stage: '', patch: '', bestOf: 3, records: { blue: 0, red: 0 } },
  fearless: { pbPct: 0, pickPct: 0, wins: 0, losses: 0 }
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}
function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function integer(value, fallback = 0) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}
function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

// 图片字段允许外链/Data URL；本地路径必须真实存在，否则返回空字符串，避免裂图。
function resolveImage(value) {
  const raw = text(value);
  if (!raw) return '';
  if (/^(?:https?:|data:|blob:)/i.test(raw) || raw.startsWith('//')) return raw;
  const normalized = raw.replace(/\\/g, '/');
  const candidates = [];
  if (normalized.startsWith('/')) candidates.push(path.join(PUBLIC_DIR, normalized.replace(/^\/+/, '')));
  else if (path.isAbsolute(raw)) candidates.push(raw);
  else {
    candidates.push(path.join(PUBLIC_DIR, normalized));
    candidates.push(path.join(PROJECT_ROOT, normalized));
    candidates.push(path.join(CONFIG_DIR, normalized));
  }
  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    if (normalized.startsWith('/')) return normalized;
    if (candidate === path.join(PUBLIC_DIR, normalized)) return '/' + normalized;
    return normalized;
  }
  return '';
}

function normalizeTeam(value, defaults) {
  const team = value && typeof value === 'object' ? value : {};
  return {
    name: text(team.name, defaults.name),
    shortName: text(team.shortName, defaults.shortName),
    region: text(team.region, defaults.region),
    rank: text(team.rank, defaults.rank),
    logo: resolveImage(team.logo),
    color: text(team.color, defaults.color)
  };
}

function normalizePlayer(value) {
  const player = typeof value === 'string' ? { gameName: value } : (value && typeof value === 'object' ? value : {});
  const gameName = text(player.gameName);
  return {
    gameName,
    displayName: text(player.displayName, gameName),
    team: text(player.team),
    role: text(player.role),
    photo: resolveImage(player.photo)
  };
}

function normalizeCoach(value) {
  const coach = typeof value === 'string' ? { name: value } : (value && typeof value === 'object' ? value : {});
  return {
    name: text(coach.name),
    team: text(coach.team),
    role: text(coach.role, 'COACH'),
    photo: resolveImage(coach.photo)
  };
}

function normalizeSponsor(value) {
  const sponsor = value && typeof value === 'object' ? value : {};
  return {
    name: text(sponsor.name),
    image: resolveImage(sponsor.image),
    slot: text(sponsor.slot)
  };
}

function normalizeRecords(value) {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (item && typeof item === 'object') return { team: text(item.team), wins: integer(item.wins), losses: integer(item.losses) };
      return { team: text(item), wins: 0, losses: 0 };
    });
  }
  if (value && typeof value === 'object') {
    const records = {};
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object') records[key] = clone(item);
      else if (typeof item === 'number') records[key] = item;
      else if (typeof item === 'string' && item.trim() !== '' && Number.isFinite(Number(item))) records[key] = Number(item);
      else records[key] = text(item);
    }
    return records;
  }
  return { blue: 0, red: 0 };
}

// 左下角遮挡卡自定义内容：{ title, lines[], html }。html 优先（富文本），否则 title+lines。
function normalizeCoverCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const card = {
    title: text(value.title),
    lines: Array.isArray(value.lines) ? value.lines.map(line => text(line)).filter(Boolean) : [],
    html: typeof value.html === 'string' ? value.html : ''
  };
  if (!card.title && !card.lines.length && !card.html) return undefined;
  return card;
}

// 待机屏自定义内容：{ title, lines[] }。聚合舞台页（/broadcast/stage）等待期显示。
function normalizeStandbyCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const card = {
    title: text(value.title),
    lines: Array.isArray(value.lines) ? value.lines.map(line => text(line)).filter(Boolean) : []
  };
  if (!card.title && !card.lines.length) return undefined;
  return card;
}

function normalizeBroadcastConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const teams = source.teams && typeof source.teams === 'object' ? source.teams : {};
  const series = source.series && typeof source.series === 'object' ? source.series : {};
  const fearless = source.fearless && typeof source.fearless === 'object' ? source.fearless : {};
  return {
    teams: {
      blue: normalizeTeam(teams.blue, DEFAULT_BROADCAST_CONFIG.teams.blue),
      red: normalizeTeam(teams.red, DEFAULT_BROADCAST_CONFIG.teams.red)
    },
    players: Array.isArray(source.players) ? source.players.map(normalizePlayer) : [],
    coaches: Array.isArray(source.coaches) ? source.coaches.map(normalizeCoach) : [],
    sponsors: Array.isArray(source.sponsors) ? source.sponsors.map(normalizeSponsor) : [],
    series: {
      name: text(series.name),
      stage: text(series.stage),
      patch: text(series.patch),
      bestOf: integer(series.bestOf, DEFAULT_BROADCAST_CONFIG.series.bestOf),
      records: normalizeRecords(series.records)
    },
    fearless: {
      pbPct: number(fearless.pbPct),
      pickPct: number(fearless.pickPct),
      wins: integer(fearless.wins),
      losses: integer(fearless.losses)
    },
    coverCard: normalizeCoverCard(source.coverCard),
    standbyCard: normalizeStandbyCard(source.standbyCard),
    // 局内 A 键隐藏 HUD 的总开关（默认启用；false = 全局钩子与 /api/hud-toggle 都不触发）
    hudKeyHook: source.hudKeyHook !== false
  };
}

function readBroadcastConfig(filePath = CONFIG_PATH) {
  try {
    return normalizeBroadcastConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return clone(DEFAULT_BROADCAST_CONFIG);
  }
}

function saveBroadcastConfig(input, filePath = CONFIG_PATH) {
  const config = normalizeBroadcastConfig(input);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // tmp+rename 原子写：进程中途被杀不会留下半截 JSON（Windows 上 rename 覆盖已存在目标）。
  const tmpPath = filePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
  return config;
}

const MAX_CONFIG_BYTES = 512 * 1024;

// 接受对象或 JSON 字符串；拒绝数组/原始值，并限制序列化后的配置大小。
function parseConfigPayload(body) {
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > MAX_CONFIG_BYTES) return { error: 'invalid_config' };
    try { body = JSON.parse(body); } catch { return { error: 'invalid_json' }; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_config' };
  let source = body.config !== undefined ? body.config : body;
  if (typeof source === 'string') {
    if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) return { error: 'invalid_config' };
    try { source = JSON.parse(source); } catch { return { error: 'invalid_json' }; }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { error: 'invalid_config' };
  let serialized;
  try { serialized = JSON.stringify(source); } catch { return { error: 'invalid_config' }; }
  if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) return { error: 'invalid_config' };
  return { config: source };
}

// 处理 /api/broadcast-config：GET 读取归一化配置，POST 保存并广播。
function handleBroadcastConfigApi(req, res, url, context = {}) {
  if (url.pathname !== '/api/broadcast-config') return false;
  const { readBody, json, broadcast, state } = context;
  if (req.method === 'GET') {
    try {
      const config = readBroadcastConfig();
      if (state) state.broadcastConfig = config;
      json(res, 200, config);
    } catch (error) { json(res, 500, { ok: false, error: error.message }); }
    return true;
  }
  if (req.method === 'POST') {
    readBody(req, res).then(body => {
      const parsed = parseConfigPayload(body);
      if (parsed.error) return json(res, parsed.error === 'invalid_json' ? 400 : 400, { ok: false, error: parsed.error });
      const config = saveBroadcastConfig(parsed.config);
      if (state) state.broadcastConfig = config;
      if (typeof broadcast === 'function') broadcast();
      json(res, 200, { ok: true, config, ...config });
    }).catch(error => {
      if (!res.headersSent) json(res, error.statusCode || 500, { ok: false, error: error.statusCode === 413 ? 'payload_too_large' : error.message });
    });
    return true;
  }
  json(res, 405, { ok: false, error: 'method_not_allowed' });
  return true;
}

module.exports = {
  DEFAULT_BROADCAST_CONFIG,
  CONFIG_DIR,
  CONFIG_PATH,
  EXAMPLE_PATH,
  normalizeBroadcastConfig,
  readBroadcastConfig,
  saveBroadcastConfig,
  handleBroadcastConfigApi,
  resolveImage,
  MAX_CONFIG_BYTES
};
