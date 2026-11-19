'use strict';

// 应用状态：初始值、mock 数据与配置持久化。
// main.js 只负责轮询与写状态，页面模块只负责渲染，状态本身集中在这里。
const fs = require('fs');
const path = require('path');
const { normalizeDirectorConfig } = require('./director');

// RB_DATA_DIR（Electron 注入 userData）优先；无此变量（开发/测试）保持项目内 data/。
const dataDir = process.env.RB_DATA_DIR
  ? path.join(path.resolve(process.env.RB_DATA_DIR), 'data')
  : path.join(__dirname, '..', 'data');
const configPath = path.join(dataDir, 'config.json');
fs.mkdirSync(dataDir, { recursive: true });

let savedConfig = {};
try { savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
const initialDirectorConfig = normalizeDirectorConfig(savedConfig.director);

// OBS 连接参数只保存在模块内，并以不可枚举属性挂在 state 上，防止 /api/state 序列化时回显密码。
function normalizeObsConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const url = String(source.url || 'ws://127.0.0.1:4455').trim() || 'ws://127.0.0.1:4455';
  return { url, password: source.password == null ? '' : String(source.password) };
}
// 配置文件只恢复地址；密码仅保存在当前进程内存中，避免明文落盘。
const initialObsConfig = normalizeObsConfig({ url: savedConfig.obs && savedConfig.obs.url });
const BROADCAST_CUE_TYPES = Object.freeze(['bp-in', 'hud-in', 'result-in', 'wipe', 'reset']);

const initialMode = savedConfig.mode === 'live' ? 'live' : 'mock';
// 实盘模式在真实数据到达前必须是空比分/空选手，绝不能把演示数据带上直播画面。
const initialTeams = initialMode === 'live' ? {
  blue: { name: '蓝方', short: 'BLUE', score: 0, gold: null, towers: 0, dragons: 0, barons: 0, heralds: 0, logo: 'B' },
  red: { name: '红方', short: 'RED', score: 0, gold: null, towers: 0, dragons: 0, barons: 0, heralds: 0, logo: 'R' }
} : {
  blue: { name: '蓝方学院', short: 'BLUE', score: 7, gold: 23500, towers: 3, dragons: 2, barons: 0, heralds: 1, logo: 'B' },
  red: { name: '红方社群', short: 'RED', score: 4, gold: 21800, towers: 2, dragons: 1, barons: 0, heralds: 0, logo: 'R' }
};
const state = {
  hudHidden: false,
  mode: initialMode, phase: savedConfig.phase || 'in_game', tournamentName: savedConfig.tournamentName || 'Khada Jhin 校园赛 · 半决赛',
  patch: '25.21', gameTime: initialMode === 'live' ? 0 : 364, blue: initialTeams.blue, red: initialTeams.red,
  goldEstimated: false, goldSource: 'mock',
  // 协议流解码（t16）是否可用；false 表示逐玩家 cs/gold/xp 只有 LCDA 值，页面必须显式降级。
  protocolDecode: false,
  // 数据可用性矩阵（t20）：live 轮询时由 src/data-capability.js 生成并随 /events 下发；
  // null 表示没有契约信息（mock 演示），页面退回原有演示/占位逻辑。
  capability: null,
  // 像素读条（t23）：{active, updatedAt, stale}。active=false 表示本轮没有有效读数，
  // 页面必须画 unknown 占位，不得把上一条读数当成当前血量。
  pixelBars: { active: false, updatedAt: null, stale: false },
  // 屏幕经济面板 OCR：{active, updatedAt, stale}。语义同 pixelBars：失效即回退估算。
  econOcr: { active: false, updatedAt: null, stale: false },
  // 采集脚本托管（src/ocr-supervisor.js）：{enabled, runtime, workers}；null=尚未初始化。
  ocrSupervisor: null,
  // BP 演示数据只在 mock 模式预置；实盘模式在真实 session 到达前必须是空 BP（和比分/选手同一条原则）。
  draft: initialMode === 'live' ? emptyDraft() : createMockDraft(),
  // BP ban 快照（赛后 ban 位真值源）：BP 期间 applyDraftSession 实时刷新，进对局时固化跟局走。
  // .rofl 与 EOG 报文都不含 ban 数据，赛后页只能靠这份快照渲染真实 ban 位；缺失时回退演示。
  gameBans: { blue: [], red: [] },
  players: [],
  highlights: [],
  updatedAt: Date.now()
};
// 实盘模式在第一次 LCU 轮询回来前是「未知」而不是「已解析为空」，避免页面把空 BP 当成真实结果。
state.live = initialMode === 'live'
  ? { lcu: { connected: false, discovery: null, phase: null, lastError: null }, draft: { source: null, parsed: null }, game: { source: null, parsed: null } }
  : { lcu: { connected: false, discovery: null, phase: null, lastError: null }, draft: { source: 'mock', parsed: false }, game: { source: 'mock', parsed: false } };
state.postGame = null;
// 回放上传导入记录（/api/replay-result）：{at, gameVersion, gameLengthMs, winSide, players}；null=未导入。
state.replayResult = null;
// MVP 手选：控台 POST /api/mvp 写入 {name,team,champion,championId,at}；null=待评选。
state.mvp = null;
// OBS 快照由 main.js 创建 ObsClient 后写入。
state.obs = null;
// 阶段 → OBS 场景名。留空表示该阶段不自动切。
state.autoSwitch = savedConfig.autoSwitch || { draft: '', in_game: '', post_game: '', mvp: '' };
state.replay = { connected: false, error: null };
// 只保留当前 cue，不积累历史，避免长时间运行时增长。
state.broadcastCue = { type: '', payload: null, seq: 0, at: null };
// 自动导播规则：配置字段来自 data/config.json 的 director 段，运行状态在每次评估后刷新。
state.director = { ...initialDirectorConfig, lastTrigger: null, cooldownRemaining: 0 };
Object.defineProperty(state, 'obsConfig', { value: initialObsConfig, writable: true, enumerable: false, configurable: true });

// 无真实对局时的演示数据：10 名选手覆盖蓝红双方，字段与 Live Client Data 归一化结果对齐。
const MOCK_CHAMPIONS = ['杰斯','瑟提','辛德拉','伊泽瑞尔','泰坦','鳄鱼','赵信','阿狸','厄斐琉斯','蕾欧娜'];
const MOCK_NAMES = ['TopStar','RiftKing','Midnight','CrispAim','Anchor','RedTop','JungleX','FoxMid','MoonShot','Shield'];
const MOCK_ROLES = ['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT'];
// 演示 BP：mock 模式预置，测试也用它拼快照，避免依赖本机 data/config.json 里的 mode。
function createMockDraft() {
  return { round: '第 3 轮 · 进行中', timer: 18, active: 'blue', blueBans: ['奥恩', '蔚', '卡莎', '洛', '波比'], redBans: ['永恩', '盲僧', '霞', '卡莉丝塔', '兰博'], bluePicks: ['杰斯', '瑟提', '辛德拉', '伊泽瑞尔', '泰坦'], redPicks: ['鳄鱼', '赵信', '阿狸', '厄斐琉斯', '蕾欧娜'] };
}
// 实盘模式第一次 LCU 轮询回来前的空 BP。
function emptyDraft() {
  return { round: '', timer: null, active: 'blue', blueBans: [], redBans: [], bluePicks: [], redPicks: [], blueHover: [], redHover: [] };
}

function createMockPlayers() {
  return MOCK_NAMES.map((name, i) => ({ name, team: i < 5 ? 'blue' : 'red', champion: MOCK_CHAMPIONS[i], role: MOCK_ROLES[i % 5], level: 7 + (i % 3), kills: i < 5 ? [2,1,2,1,1][i] : [1,1,0,2,0][i], deaths: i % 4 === 0 ? 1 : 0, assists: 3 + i, cs: 58 + i * 7, alive: i !== 6, damage: 12 + i * 1.8, taken: 8 + (9 - i) * 1.7, kp: 42 + i * 3, items: ['◇','◆','◈'].slice(0, 2 + (i % 2)), summoners: ['闪现','引燃'] }));
}
function initialPlayersForMode(mode) { return mode === 'live' ? [] : createMockPlayers(); }
state.players = initialPlayersForMode(state.mode);

function saveConfig() {
  try {
    const obsConfig = normalizeObsConfig(state.obsConfig);
    const text = JSON.stringify({
      tournamentName: state.tournamentName, mode: state.mode, phase: state.phase, autoSwitch: state.autoSwitch,
      // 只持久化连接地址；密码不写入磁盘。
      obs: { url: obsConfig.url },
      director: normalizeDirectorConfig(state.director)
    }, null, 2) + '\n';
    // tmp+rename 原子写：避免半截 config.json 被下次启动读空。
    const tmpPath = configPath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmpPath, text, { mode: 0o600 });
    fs.renameSync(tmpPath, configPath);
    try { fs.chmodSync(configPath, 0o600); } catch {}
  } catch {}
}

function getObsConfig() {
  return normalizeObsConfig(state.obsConfig);
}

function setObsConfig(next = {}) {
  const current = getObsConfig();
  state.obsConfig = normalizeObsConfig({ ...current, ...(next && typeof next === 'object' ? next : {}) });
  saveConfig();
  return getObsConfig();
}

function applyBroadcastCue(type, payload) {
  const normalized = typeof type === 'string' ? type.trim() : '';
  if (!BROADCAST_CUE_TYPES.includes(normalized)) {
    const error = new Error('invalid_cue_type');
    error.code = 'invalid_cue_type';
    throw error;
  }
  const previousSeq = state.broadcastCue && Number.isFinite(Number(state.broadcastCue.seq)) ? Number(state.broadcastCue.seq) : 0;
  state.broadcastCue = {
    type: normalized,
    payload: payload === undefined ? null : payload,
    seq: previousSeq + 1,
    at: Date.now()
  };
  return state.broadcastCue;
}

function handleBroadcastCueApi(req, res, url, context = {}) {
  const { readBody, json, broadcast } = context;
  if (req.method === 'GET') { json(res, 200, state.broadcastCue); return true; }
  if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
  readBody(req, res).then(body => {
    try {
      const cue = applyBroadcastCue(body && body.type, body && body.payload);
      if (typeof broadcast === 'function') broadcast();
      json(res, 200, { ok: true, cue });
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
  }).catch(error => json(res, 400, { ok: false, error: error.message }));
  return true;
}

module.exports = { state, saveConfig, createMockPlayers, createMockDraft, emptyDraft, initialPlayersForMode, dataDir, configPath, normalizeObsConfig, getObsConfig, setObsConfig, BROADCAST_CUE_TYPES, applyBroadcastCue, handleBroadcastCueApi };
