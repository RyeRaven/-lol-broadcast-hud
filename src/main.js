'use strict';

// Khada Jhin 本地服务：HTTP 路由、SSE 推送、LCU / Live Client 轮询与状态更新。
// 页面 HTML 在 src/pages/，状态与 mock 数据在 src/app-state.js。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { requestJson, probeLcu, probeLiveClient, fetchLcuJson, discoverLcuConnection, dataDragonUrl } = require('./data-sources');
const { normalizeDraftSession } = require('./draft');
const { loadChampionIndex } = require('./champions');
const { DEFAULT_VERSION } = require('./assets');
const { normalizeLiveState, estimateTeamGold, loadItemIndex, createLcuConnectionManager, createLiveClientWatchdog, createObjectiveLedger } = require('./live-data');
const { applyPixelBarsAvailability, applyProtocolAvailability } = require('./data-capability');
const { buildTimeline, latestTimeline } = require('./timeline');
const { buildHighlights, latestHighlights, handleHighlightsApi, MAX_HIGHLIGHTS } = require('./highlights');
const { createDirectorEngine, handleDirectorApi } = require('./director');
const replay = require('./replay');
const { buildPostGame } = require('./post-game');
const { parseTimelineGold } = require('./gold-timeline');
const { ObsClient, handleObsApi, startObsAutoConnect } = require('./obs');
const { createPixelBarStore, handlePixelBarsApi, applyBarsToPlayers } = require('./pixel-bars');
const { createProtocolFeedStore, handleProtocolFeedApi, applyProtocolToPlayers, protocolPresence, isExactField } = require('./protocol-feed');
const { state, saveConfig, createMockPlayers, getObsConfig, setObsConfig, handleBroadcastCueApi, applyBroadcastCue } = require('./app-state');
const { readBroadcastConfig, handleBroadcastConfigApi } = require('./broadcast-config');
const { handleLogoUploadApi } = require('./uploads');
const { overlayPage, OVERLAY_TYPES } = require('./pages/overlays');
const { consolePage } = require('./pages/console');
const { bpBroadcastPage } = require('./pages/bp-broadcast');
const { hudBroadcastPage } = require('./pages/hud-broadcast');
const { hudCalibratePage, handleHudCalibApi } = require('./pages/hud-calibrate');
const { resultBroadcastPage, transitionPage } = require('./pages/result-broadcast');
const { mvpBroadcastPage } = require('./pages/mvp-broadcast');
const { stageBroadcastPage } = require('./pages/stage-broadcast');

const PORT = Number(process.env.PORT || 3210);
const LIVE_CLIENT_URL = process.env.LIVE_CLIENT_URL || 'https://127.0.0.1:2999';
const clients = new Set();
const MAX_SSE_CLIENTS = 500;
const publicDir = path.join(__dirname, '..', 'public');

// 进程级兜底：任何遗漏的 Promise 链（如请求体读取失败）或同步异常都只记日志，绝不退出进程。
// 直播中进程退出会让所有 OBS overlay 同时断流，代价远高于单个请求失败；这里只记录 message，
// 不打印 error 对象本身，避免把连接凭据之类的敏感字段写进日志。
process.on('unhandledRejection', reason => {
  const message = reason && reason.message ? reason.message : String(reason);
  console.error('[unhandledRejection]', message);
});
process.on('uncaughtException', error => {
  const message = error && error.message ? error.message : String(error);
  console.error('[uncaughtException]', message);
});

const obs = new ObsClient();
// 像素读条（t23）：同机独立进程经 POST /api/pixel-bars 喂进来的百分比读数。
// 超过 2000ms 没更新就失效（store 内部判 stale），归一化时对应字段回 null。
const pixelBars = createPixelBarStore();
// 协议流（t30）：同机解码器（0xdd 关键帧）经 POST /api/protocol-feed 喂进来的逐玩家精确读数。
// 与像素读条同样的时效规则：超过 2000ms 没更新就整体失效，绝不让上一包冒充当前值。
const protocolFeed = createProtocolFeedStore();
// 初始态与像素读条对齐：没有有效包时页面必须显式降级，不能靠「字段不存在」蒙混。
state.protocolFeed = { active: false, updatedAt: null, stale: false };
let championIndex = null;
state.obs = obs.snapshot();
state.timeline = [];
state.highlights = [];
state.broadcastConfig = readBroadcastConfig();
// 自动导播引擎在每次 broadcast 前评估 highlights / phase，触发时复用广播 cue 的内部函数。
const directorEngine = createDirectorEngine({ config: state.director, initialPhase: state.phase });

// :2999 在游戏结束瞬间关闭，所以局内每秒冻结一份快照，结算时拿它兜底。
let frozenSnapshot = null;
const liveClientWatchdog = createLiveClientWatchdog();
loadChampionIndex().then(index => { championIndex = index; state.patch = (index && index.version) || DEFAULT_VERSION; }).catch(() => {});
loadItemIndex().catch(() => {});

// 客户端重启会换端口和 token：请求失败时缓存立即失效，下一轮轮询（1.2s）重新发现；
// 只有发现本身失败才做 4 秒退避，避免反复拉起 PowerShell。
const lcuConnections = createLcuConnectionManager({ discover: discoverLcuConnection });
const getLcuConnection = force => lcuConnections.get(force);
function championLabel(championId) {
  const numeric = Number(championId);
  if (!numeric) return '';
  const name = championIndex && typeof championIndex.name === 'function' ? championIndex.name(numeric) : '';
  return name || '#' + numeric;
}
// 赛后经济差曲线：异步拉取本局 timeline（LCU），解析成蓝/红每分钟总经济后写入 state 供页面透传。
// 拉取失败或数据缺失时保持 null，赛后页自动回退演示曲线，不阻塞结算窗口。
async function fetchGoldTimeline(gameId) {
  if (!gameId) return;
  try {
    const connection = await getLcuConnection();
    if (!connection) return;
    const timeline = await fetchLcuJson(connection, '/lol-match-history/v1/game-timelines/' + gameId);
    const parsed = parseTimelineGold(timeline);
    if (parsed && parsed.length) {
      state.goldTimeline = parsed;
      broadcast();
    }
  } catch (error) {
    // timeline 只在赛后窗口短期可读，失败即放弃（保持 null → 页面演示曲线）。
  }
}

// :2999 断流时没有 eog 可拉，直接用最后一帧 frozenSnapshot 生成赛后数据。
function enterPostGameFromFrozen() {
  if (state.postGame) return true;
  if (!frozenSnapshot) return false;
  let postGame = null;
  try { postGame = buildPostGame({ eog: null, frozen: frozenSnapshot, championLabel }); } catch { postGame = null; }
  if (!postGame) return false;
  state.mode = 'live'; state.phase = 'post_game'; state.postGame = { ...postGame, capturedAt: Date.now() }; state.players = postGame.players;
  state.gameTime = Math.floor(postGame.gameLength) || state.gameTime;
  state.goldTimeline = null;
  void fetchGoldTimeline(postGame.gameId);
  for (const side of ['blue', 'red']) for (const key of ['score', 'towers', 'dragons', 'barons']) state[side][key] = postGame[side][key];
  return true;
}
function resetDraftState() {
  // 离开 BP 后必须清掉上一局/演示数据，否则 overlay 会继续显示旧阵容。
  state.draft = { round: '', timer: null, active: 'blue', blueBans: [], redBans: [], bluePicks: [], redPicks: [], blueHover: [], redHover: [], blueBanHover: [], redBanHover: [] };
  // 分路表跟着 BP 清空：新房间必须重新采集 assignedPosition，旧局的分路不能带进下一局。
  state.draftRoles = { blue: [null, null, null, null, null], red: [null, null, null, null, null] };
}
// live 模式在真实数据到达前保持空选手/空比分；上一局的 Live Client 玩家不能带进下一局。
// 目标事件账本跟着新局重置：LCDA events 是滚动窗口，龙/塔计数必须跨轮询增量累计（见 live-data.js）。
let objectiveLedger = createObjectiveLedger();
function resetLiveGameData() {
  objectiveLedger = createObjectiveLedger();
  state.players = [];
  state.goldEstimated = false;
  state.goldSource = 'mock';
  if (state.live && state.live.game) state.live.game = { ...state.live.game, players: 0 };
  for (const side of ['blue', 'red']) {
    if (!state[side] || typeof state[side] !== 'object') state[side] = {};
    Object.assign(state[side], { score: 0, gold: null, towers: 0, dragons: 0, barons: 0, heralds: 0, grubs: 0 });
  }
}
function applyDraftSession(session) {
  const draft = normalizeDraftSession(session, championLabel);
  if (!draft) {
    // session 为空（刚进房间）也要标记为 LCU 来源，parsed=false 只表示暂时没有可展示的 pick/ban。
    resetDraftState();
    state.live.draft = { source: 'lcu', parsed: false, actions: 0, updatedAt: Date.now() };
    return false;
  }
  state.draft.bluePicks = Array.isArray(draft.bluePicks) ? draft.bluePicks : [];
  state.draft.redPicks = Array.isArray(draft.redPicks) ? draft.redPicks : [];
  state.draft.blueBans = Array.isArray(draft.blueBans) ? draft.blueBans : [];
  state.draft.redBans = Array.isArray(draft.redBans) ? draft.redBans : [];
  state.draft.blueHover = Array.isArray(draft.blueHover) ? draft.blueHover : [];
  state.draft.redHover = Array.isArray(draft.redHover) ? draft.redHover : [];
  state.draft.blueBanHover = Array.isArray(draft.blueBanHover) ? draft.blueBanHover : [];
  state.draft.redBanHover = Array.isArray(draft.redBanHover) ? draft.redBanHover : [];
  state.draft.timer = draft.timer === null || draft.timer === undefined ? null : draft.timer;
  state.draft.round = draft.phase || '';
  state.draft.active = draft.active || 'blue';
  if (Array.isArray(draft.blueRoles) && Array.isArray(draft.redRoles)) {
    state.draftRoles = { blue: draft.blueRoles.slice(0, 5), red: draft.redRoles.slice(0, 5) };
  }
  state.live.draft = { source: 'lcu', parsed: draft.parsed, actions: draft.actionCount, updatedAt: Date.now() };
  return draft.parsed;
}
async function pollLcuDraft() {
  const connection = await getLcuConnection();
  if (!connection) {
    state.live.lcu = { ...state.live.lcu, connected: false, phase: null, lastError: state.live.lcu.lastError || '未找到 LCU 连接信息' };
    return;
  }
  if (!connection.password) { state.live.lcu = { connected: false, discovery: connection.source, port: connection.port, phase: null, lastError: '已找到 LCU 端口，但缺少 remoting-auth-token' }; return; }
  try {
    const phase = await fetchLcuJson(connection, '/lol-gameflow/v1/gameflow-phase');
    state.live.lcu = { connected: true, discovery: connection.source || 'environment', phase, lastError: null };
    // InProgress 优先级最高：新一局必须切回局内。只有同一局（gameId 相同且赛后数据刚生成）
    // 的赛后状态才保留，避免 :2999 短暂断流后刚生成的赛后数据被下一轮轮询抹掉。
    if (phase === 'InProgress' && state.phase !== 'in_game') {
      const postGame = state.postGame;
      const sameGame = postGame && postGame.gameId && state.live.game && state.live.game.gameId &&
        String(postGame.gameId) === String(state.live.game.gameId);
      const recent = postGame && postGame.capturedAt && Date.now() - postGame.capturedAt < 5 * 60 * 1000;
      if (!(sameGame && recent)) {
        state.mode = 'live';
        state.phase = 'in_game';
        state.postGame = null;
        state.goldTimeline = null;
        frozenSnapshot = null;
        resetLiveGameData();
        liveClientWatchdog.reset();
      }
    }
    // 结算窗口很短：PreEndOfGame / EndOfGame 期间 eog-stats-block 才可读，错过就只能用局内快照。
    if (phase === 'PreEndOfGame' || phase === 'EndOfGame' || phase === 'WaitForStatsScreen') {
      state.mode = 'live';
      state.phase = 'post_game';
      if (!state.postGame) {
        let eog = null;
        try { eog = await fetchLcuJson(connection, '/lol-end-of-game/v1/eog-stats-block'); } catch (error) { eog = null; }
        let postGame = null;
        try { postGame = buildPostGame({ eog, frozen: frozenSnapshot, championLabel }); } catch { postGame = null; }
        if (postGame) {
          state.postGame = { ...postGame, capturedAt: Date.now() };
          state.players = postGame.players;
          state.gameTime = Math.floor(postGame.gameLength) || state.gameTime;
          for (const side of ['blue', 'red']) {
            for (const key of ['score', 'towers', 'dragons', 'barons']) state[side][key] = postGame[side][key];
          }
          state.goldTimeline = null;
          void fetchGoldTimeline(postGame.gameId);
        }
      }
    }
    if (phase === 'ChampSelect') {
      // 进入 BP 就是实战：即使 session 还是空的（刚进房间），阶段也必须切到 draft。
      state.mode = 'live';
      state.phase = 'draft';
      state.postGame = null;
      frozenSnapshot = null;
      state.highlights = [];
      resetLiveGameData();
      liveClientWatchdog.reset();
      try {
        const session = await fetchLcuJson(connection, '/lol-champ-select/v1/session');
        applyDraftSession(session);
      } catch (e) {
        // 客户端刚进房间或 session 短暂 404：不要保留上一局的 BP。
        resetDraftState();
        state.live.draft = { source: 'lcu', parsed: false, actions: 0, error: e.message, updatedAt: Date.now() };
      }
    } else if (state.phase === 'draft') {
      // 离开 ChampSelect（Lobby/Matchmaking/None）：退出 BP，清空旧阵容。
      state.phase = 'lobby';
      resetDraftState();
      state.live.draft = { source: 'lcu', parsed: false, actions: 0, phase, updatedAt: Date.now() };
    }
  } catch (e) {
    state.live.lcu = { connected: false, discovery: connection.source, phase: null, lastError: e.message };
    lcuConnections.invalidate();
  }
}
setInterval(() => pollLcuDraft().then(() => broadcast()).catch(() => {}), 1200);

// Live Client Data：只在真实对局中可用（127.0.0.1:2999），无对局时静默失败。
let liveClientStats = { connected: false, lastSuccess: 0, lastError: null };
// 原始事件诊断落盘：LCDA events 是滚动窗口，增量账本只管计数，这里把窗口里出现过的每条事件
// 按身份键去重后原样追加到 .tmp/lcda-events.jsonl，用于核实 OBJECTIVE_EVENTS 的事件名
// （潮虫 HordeKill 等映射从未在真机上验证过）。写失败不影响主链路。
const lcdaEventSeen = new Set();
function logLcdaEvents(payload) {
  try {
    const events = payload && payload.events && Array.isArray(payload.events.Events) ? payload.events.Events : [];
    if (!events.length) return;
    const gt = Math.floor(Number(payload.gameData && payload.gameData.gameTime) || -1);
    for (const ev of events) {
      const key = JSON.stringify([ev.EventName, ev.KillerName, ev.VictimName, ev.TurretKilled, ev.DragonType, ev.AssistingUnitNames, ev.MultiKillLength]);
      if (lcdaEventSeen.has(key)) continue;
      lcdaEventSeen.add(key);
      const logPath = path.join(__dirname, '..', '.tmp', 'lcda-events.jsonl');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify({ t: gt, ev }) + '\n');
    }
  } catch (e) { /* 诊断日志不影响数据链路 */ }
}
async function pollLiveClient() {
  try {
    const payload = await requestJson(LIVE_CLIENT_URL + '/liveclientdata/allgamedata', { timeout: 1200 });
    logLcdaEvents(payload);
    // 像素读条与 Live Client Data 是两个独立数据源：这里把「这一轮还有效的 bar」一起交给归一化，
    // 由它按 (team, 行序) 回填 hpPercent/resourcePercent；过期读数在 store 里就已经被过滤掉。
    const live = normalizeLiveState(payload, {
      pixelBars: pixelBars.snapshot(),
      protocol: protocolResolver(),
      objectiveLedger,
      // 本轮 LCDA 请求已经成功：这是实测到的 liveClient 可达信号，不是为了对齐 capability.mode 而伪造。
      // 其余信号只在 state 真的记录时才传；没有 LCU 连接时 gameflowPhase 为 null，由 data-capability 的显式 mode 说明兜底。
      capabilitySources: {
        liveClient: true,
        gameflowPhase: state.live && state.live.lcu ? state.live.lcu.phase : null,
        observerServerIp: state.live && state.live.observerServerIp ? state.live.observerServerIp : null,
        isPlayingReplay: state.replay && state.replay.isPlayingReplay === true,
        timelineAvailable: state.timelineAvailable === true
      }
    });
    if (!live) throw new Error('实时对局数据为空');
    state.timeline = latestTimeline(buildTimeline(payload), 50);
    state.highlights = latestHighlights(buildHighlights(payload), MAX_HIGHLIGHTS);
    liveClientWatchdog.success(live.gameTime);
    // 赛后阶段以 state.postGame（EOG/冻结快照）为准，:2999 还没断时不要用它覆盖赛后数据。
    // 但 post_game 锁必须能被「新对局信号」自动解除：观战机上 LCU gameflow 探测不可用（lockfile 读不到），
    // 若只靠 LCU 晋级，下一局会永远卡在上一局的赛后快照上。新局判据（任一命中即解锁）：
    //   1) gameId 变了（LCDA 报出的对局 id 与赛后快照不同）；
    //   2) gameTime 明显回退（新局从 0 开始计时，比快照 gameLength 小 60s 以上）。
    let lockedPostGame = state.phase === 'post_game' && !!state.postGame;
    if (lockedPostGame) {
      const prevId = state.postGame.gameId;
      const nextId = live.gameId;
      const newGameById = prevId != null && nextId != null && String(prevId) !== '' && String(nextId) !== '' && String(prevId) !== String(nextId);
      const snapshotLength = Number(state.postGame.gameLength);
      const newGameByTime = Number.isFinite(snapshotLength) && Number.isFinite(Number(live.gameTime)) && Number(live.gameTime) + 60 < snapshotLength;
      if (newGameById || newGameByTime) {
        state.postGame = null;
        frozenSnapshot = null;
        resetLiveGameData();
        lockedPostGame = false;
      }
    }
    if (!lockedPostGame) {
      state.mode = 'live';
      state.phase = 'in_game';
      state.gameTime = Math.floor(live.gameTime);
      // LCDA 局内 position 恒 NONE：用 BP 阶段采集的 assignedPosition（cellId 顺序=参赛者顺序）
      // 按蓝红各自行序回填 player.position，HUD 才能按 上野中下辅 排序。没有分路数据的选手保持原样。
      const draftRoles = state.draftRoles || { blue: [], red: [] };
      const seen = { blue: 0, red: 0 };
      state.players = live.players.map(player => {
        if (!player) return player;
        const side = player.team === 'red' ? 'red' : 'blue';
        const role = (draftRoles[side] || [])[seen[side]] || null;
        seen[side] += 1;
        return role ? { ...player, position: role } : player;
      });
      const estimatedGold = estimateTeamGold(state.players, live.gameTime);
      for (const side of ['blue', 'red']) {
        for (const key of ['score', 'towers', 'dragons', 'barons', 'heralds', 'grubs', 'dragonTypes']) state[side][key] = live[side][key];
        // Live Client Data 没有金币字段：用装备/补刀/KDA/被动金币估算，并在 state 标记来源。
        state[side].gold = estimatedGold[side];
      }
      // 转播注记（非 LCU 标准，假 LCDA/转播台注入）：下一只元素龙类型与大龙 buff 状态；真实数据缺省 null。
      state.nextDragonType = live.nextDragonType || null;
  state.nextDragonSpawnAt = live.nextDragonSpawnAt != null ? live.nextDragonSpawnAt : null;
      state.baronBuff = live.baronBuff || null;
state.elderBuff = live.elderBuff || null;
      state.goldEstimated = true;
      state.goldSource = 'estimated';
      // 协议流解码器未接入时是 false：此时玩家只有 LCDA 的估算字段，不能当成精确值展示。
      state.protocolDecode = live.protocolDecode === true;
      // 数据可用性矩阵随每帧下发：HUD 按它决定画不画、按什么精度标（t20）。
      state.capability = live.capability || null;
      state.pixelBars = live.pixelBars || { active: false, updatedAt: null, stale: false };
      const protocolSnapshot = protocolFeed.snapshot();
      state.protocolFeed = { active: protocolSnapshot.active === true, updatedAt: protocolSnapshot.updatedAt, stale: protocolSnapshot.stale === true };
      frozenSnapshot = {
        gameId: live.gameId || null,
        gameTime: Math.floor(live.gameTime),
        gameMode: live.gameMode,
        players: live.players.map(player => ({ ...player })),
        blue: { score: live.blue.score, towers: live.blue.towers, dragons: live.blue.dragons, barons: live.blue.barons },
        red: { score: live.red.score, towers: live.red.towers, dragons: live.red.dragons, barons: live.red.barons }
      };
    }
    liveClientStats = { connected: true, lastSuccess: Date.now(), lastError: null };
    state.live.game = { source: 'live_client', parsed: true, players: live.players.length, events: live.eventCount, gameId: live.gameId || null, updatedAt: Date.now() };
  } catch (error) {
    const lost = liveClientStats.connected;
    liveClientStats = { ...liveClientStats, connected: false, lastError: error.message };
    state.live.game = { source: 'live_client', parsed: false, connected: false, error: error.message, updatedAt: Date.now() };
    if (lost && Date.now() - liveClientStats.lastSuccess > 10000) state.live.game.stale = true;
    if (state.phase === 'in_game' && liveClientWatchdog.failure(state.gameTime)) {
      if (enterPostGameFromFrozen()) state.live.game = { ...state.live.game, fallback: 'frozen', updatedAt: Date.now() };
    }
  }
}
setInterval(pollLiveClient, 1000);

// 全局 A 键钩子（uiohook-napi，被动监听不消费按键）：in_game 阶段按 A 翻转 HUD 显隐——LoL 客户端与软件同时收到 A 键。
try {
  const { uIOhook, UiohookKey } = require('uiohook-napi');
  uIOhook.on('keydown', event => {
    if (event && event.keycode === UiohookKey.A && state.phase === 'in_game') {
      if (state.broadcastConfig && state.broadcastConfig.hudKeyHook === false) return; // 控台开关禁用
      state.hudHidden = !state.hudHidden;
      broadcast();
    }
  });
  uIOhook.start();
} catch (error) {
  console.warn('[hud-key] 全局 A 键钩子不可用：' + error.message);
}

// 阶段切换时按映射自动切 OBS 场景；同一阶段只触发一次，避免每帧重复请求。
let lastAutoPhase = null;
function applyAutoScene() {
  const scene = state.autoSwitch && state.autoSwitch[state.phase];
  if (!scene || !obs.status.connected || lastAutoPhase === state.phase) return;
  lastAutoPhase = state.phase;
  obs.setScene(scene).catch(() => {});
}
// MVP 时刻不是 phase（走不了 applyAutoScene 的 phase 门控）：/api/mvp 发送后切到
// autoSwitch.mvp 场景，清除后切回 post_game 场景。OBS 未连接或未配置时静默跳过。
function switchMvpScene(sent) {
  if (!obs.status.connected) return;
  const mapping = state.autoSwitch || {};
  const target = sent ? mapping.mvp : mapping.post_game;
  if (!target) return;
  obs.setScene(target).then(snapshot => { state.obs = snapshot; broadcast(); }).catch(() => {});
}
function cloneState() { return JSON.parse(JSON.stringify(state)); }
function runDirector() {
  const triggers = directorEngine.evaluate(state);
  for (const trigger of triggers) {
    try { applyBroadcastCue(trigger.cue, trigger.payload); } catch {}
  }
  state.director = directorEngine.snapshot();
  return triggers.length;
}
function broadcast() {
  applyAutoScene();
  runDirector();
  state.obs = obs.snapshot();
  state.updatedAt = Date.now();
  let payload;
  try {
    payload = `data: ${JSON.stringify(cloneState())}\n\n`;
  } catch {
    return;
  }
  for (const res of clients) {
    try {
      if (res.writableEnded || res.destroyed) {
        clients.delete(res);
        continue;
      }
      res.write(payload);
    } catch {
      // 单个 SSE 客户端断开不能影响其他观众。
      clients.delete(res);
      try { res.end(); } catch {}
    }
  }
}
// 像素读条过期保护：读数超过 2000ms 没更新就必须把生命/资源条降回 unavailable 并把玩家字段清成 null，
// 绝不保留上一轮百分比冒充当前血量。每秒执行一次，即使 Live Client Data 断流也照样生效。
function refreshPixelBars() {
  const snapshot = pixelBars.snapshot();
  const active = snapshot.active === true;
  state.pixelBars = { active, updatedAt: snapshot.updatedAt, stale: snapshot.stale === true };
  if (active) return;
  state.capability = applyPixelBarsAvailability(state.capability, false);
  for (const player of Array.isArray(state.players) ? state.players : []) {
    if (!player || typeof player !== 'object') continue;
    player.hpPercent = null;
    player.resourcePercent = null;
    player.shieldPercent = null;
    player.resourceColor = null;
    player.pixelBars = null;
  }
}

// 像素读数可能 10Hz 上报，但 HUD 只按 1Hz 重绘就够；这里限流，避免每帧都跑一遍导播与全量序列化。
let lastPixelBroadcastAt = 0;
function onPixelBarsUpdate(snapshot) {
  state.pixelBars = { active: snapshot.active === true, updatedAt: snapshot.updatedAt, stale: snapshot.stale === true };
  state.capability = applyPixelBarsAvailability(state.capability, snapshot.active === true);
  // 只在实盘把读数写进玩家；mock 演示模式不许把真实读数混进演示数据。
  if (state.mode === 'live') applyBarsToPlayers(state.players, snapshot.bars);
  const now = Date.now();
  if (now - lastPixelBroadcastAt < 250) return;
  lastPixelBroadcastAt = now;
  broadcast();
}

// 协议流失效保护：超过 2000ms 没有新包就必须把精确字段清回 null 并把契约降回 unavailable。
// 关键帧值是真的，但过了时效就只是「上一包的数字」，继续展示等于伪造当前值。
function refreshProtocolFeed() {
  const snapshot = protocolFeed.snapshot();
  const active = snapshot.active === true;
  state.protocolFeed = { active, updatedAt: snapshot.updatedAt, stale: snapshot.stale === true };
  if (active) return;
  state.capability = applyProtocolAvailability(state.capability, false);
  state.protocolDecode = false;
  for (const player of Array.isArray(state.players) ? state.players : []) {
    if (!player || typeof player !== 'object') continue;
    player.csExact = null;
    player.totalGold = null;
    player.xp = null;
    player.csAsOf = null;
    player.xpAsOf = null;
    // KDA 的数值本身是精确的（LCDA 也给），来源切换交给下一次轮询统一处理，
    // 避免「数值还是协议流的、来源标记已经改成 LCDA」的短暂错位。
  }
}

// 把当前有效的协议流包变成 normalizePlayer 的 protocol 查询函数；
// 没有有效包时返回 null，归一化就会退回 Live Client Data，并在 capability 里标 unavailable。
function protocolResolver() {
  const snapshot = protocolFeed.snapshot();
  if (snapshot.active !== true || !Array.isArray(snapshot.players) || !snapshot.players.length) return null;
  // 逐字段精确性由每条记录自己的 precision 判定（presence 只用于上层 capability 升级）。
  const byChampion = new Map();
  const byRow = new Map();
  const rows = { blue: 0, red: 0 };
  for (const record of snapshot.players) {
    if (!record || typeof record !== 'object') continue;
    if (record.championName) byChampion.set(String(record.championName).toLowerCase(), record);
    const side = record.team === 'blue' || record.team === 'red' ? record.team : null;
    if (!side) continue;
    byRow.set(side + ':' + rows[side], record);
    rows[side] += 1;
  }
  const cursor = { blue: 0, red: 0 };
  const claimed = new Set();
  return function resolve(player) {
    if (!player || typeof player !== 'object') return null;
    const champion = String(player.championName || player.champion || '').toLowerCase();
    let record = champion ? byChampion.get(champion) : null;
    if (record) claimed.add(record);
    if (!record) {
      const side = player.team === 'BLUE' || player.team === 'ORDER' ? 'blue'
        : player.team === 'RED' || player.team === 'CHAOS' ? 'red' : null;
      if (!side) return null;
      // 行序兜底必须跳过已被认领（英雄名匹配命中）的记录，否则两个人会领到同一份 cs/gold。
      while (cursor[side] < snapshot.players.length) {
        const candidate = byRow.get(side + ':' + cursor[side]) || null;
        cursor[side] += 1;
        if (candidate && !claimed.has(candidate)) { record = candidate; break; }
      }
      if (record) claimed.add(record);
    }
    if (!record) return null;
    // 只把本条记录真的解出的 exact 字段交给 normalizePlayer：这里不能放 null。
    // live-data 的 protocolFields 用 Number(value) 取值，Number(null) === 0 会把缺席字段
    // 伪造成 0 精确值（t39 实测：只发 xp 的包曾把全队 csExact/totalGold 变 0，KDA 变 0/0/0）。
    // 缺席字段直接不返回键，protocolFields 取到 undefined 才会回落 null。
    const picked = {};
    for (const key of ['cs', 'totalGold', 'xp', 'kills', 'deaths', 'assists']) {
      if (isExactField(record, key)) picked[key] = record[key];
    }
    // asOf 只在真有精确字段时才有意义；缺席同理不能传 null（Number(null) === 0）。
    if (Object.keys(picked).length && record.asOf !== null && record.asOf !== undefined) picked.asOf = record.asOf;
    return picked;
  };
}

// 协议流包可能 10Hz 上报，HUD 只按 1Hz 重绘；限流避免每包都跑全量序列化与导播评估。
let lastProtocolBroadcastAt = 0;
function onProtocolFeedUpdate(snapshot) {
  const active = snapshot.active === true;
  state.protocolFeed = { active, updatedAt: snapshot.updatedAt, stale: snapshot.stale === true };
  const presence = protocolPresence(snapshot.players);
  const protocolKda = active && Array.isArray(snapshot.players)
    && snapshot.players.some(record => isExactField(record, 'kills') && isExactField(record, 'deaths') && isExactField(record, 'assists'));
  state.capability = applyProtocolAvailability(state.capability, active, {
    cs: presence.cs,
    gold: presence.gold,
    xp: presence.xp,
    kda: protocolKda
  });
  state.protocolDecode = active && Array.isArray(snapshot.players) && snapshot.players.length > 0;
  // 只在实盘写玩家；mock 演示数据不许被真实协议流污染。
  if (state.mode === 'live' && active) applyProtocolToPlayers(state.players, snapshot.players);
  const now = Date.now();
  if (now - lastProtocolBroadcastAt < 250) return;
  lastProtocolBroadcastAt = now;
  broadcast();
}

function tick() {
  refreshPixelBars();
  refreshProtocolFeed();
  if (state.mode === 'mock' && state.phase === 'in_game') {
    state.goldEstimated = false;
    state.goldSource = 'mock';
    state.gameTime += 1;
    if (state.gameTime % 17 === 0) state.blue.score += 1;
    if (state.gameTime % 29 === 0) state.red.score += 1;
    state.blue.gold += 38; state.red.gold += 35;
    state.players.forEach((p, i) => { p.cs += i % 2; p.level = Math.min(18, p.level + (state.gameTime % 73 === i ? 1 : 0)); });
  } else if (state.mode === 'mock' && state.phase === 'draft') {
    state.draft.timer -= 1; if (state.draft.timer <= 0) { state.draft.timer = 30; state.draft.active = state.draft.active === 'blue' ? 'red' : 'blue'; }
  }
  broadcast();
}
setInterval(tick, 1000);

const MAX_BODY_BYTES = 1024 * 1024;
function readBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = error => {
      if (done) return;
      done = true;
      if (res && !res.headersSent) json(res, 413, { ok: false, error: 'payload_too_large' });
      reject(error);
    };
    const declared = Number(req.headers && req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return fail(Object.assign(new Error('payload_too_large'), { statusCode: 413, code: 'payload_too_large' }));
    }
    req.on('data', chunk => {
      if (done) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) return fail(Object.assign(new Error('payload_too_large'), { statusCode: 413, code: 'payload_too_large' }));
      // 收 Buffer 而不是拼接字符串：多字节字符（中文）跨 chunk 边界时字符串拼接会损坏。
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      // 先解析、后落定：done 先置 true 会把错误响应挡成 no-op，连接挂死。
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch {
        done = true;
        if (res && !res.headersSent) json(res, 400, { ok: false, error: 'invalid_json' });
        reject(Object.assign(new Error('invalid_json'), { statusCode: 400, code: 'invalid_json' }));
        return;
      }
      done = true;
      resolve(body);
    });
    req.on('error', error => { if (!done) { done = true; reject(error); } });
  });
}
function json(res, code, body) {
  if (res.headersSent) return;
  // 不开 CORS：API 只被同源页面/本机工具访问；开放 * 会让任意网页跨域读写本地导播 API。
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(body));
}
function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
function normalizeSceneName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 128) throw badRequest('invalid_scene_name');
  return name;
}
function normalizeAutoSwitch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('invalid_auto_switch');
  const result = {};
  for (const key of ['draft', 'in_game', 'post_game', 'mvp']) {
    const value = body[key];
    if (value === undefined || value === null) { result[key] = ''; continue; }
    if (typeof value !== 'string' || value.trim().length > 128) throw badRequest('invalid_auto_switch');
    result[key] = value.trim();
  }
  return result;
}
function normalizePhase(value) {
  const phase = typeof value === 'string' ? value.trim() : '';
  if (!['draft', 'in_game', 'post_game'].includes(phase)) throw badRequest('invalid_phase');
  return phase;
}
function normalizeTournamentName(value) {
  if (typeof value !== 'string' || value.trim().length > 80) throw badRequest('invalid_tournament_name');
  return value.trim();
}
function addSseClient(res) {
  while (clients.size >= MAX_SSE_CLIENTS) {
    const oldest = clients.values().next().value;
    if (!oldest) break;
    clients.delete(oldest);
    try { oldest.end(); } catch {}
  }
  clients.add(res);
  if (typeof res.on === 'function') {
    res.on('error', () => { clients.delete(res); });
    res.on('close', () => { clients.delete(res); });
  }
}
function serveStyles(res) {
  const file = path.join(publicDir, 'styles.css');
  try { fs.statSync(file); } catch { return json(res, 404, { error: 'not_found' }); }
  res.writeHead(200, {'Content-Type': 'text/css; charset=utf-8'});
  const stream = fs.createReadStream(file);
  stream.on('error', error => { if (!res.headersSent) json(res, 500, { error: error.message }); else res.destroy(); });
  stream.pipe(res);
}
// 静态资源：/assets/* 只映射 public/assets 下的常规文件（本地英雄头像等），防目录穿越。
const ASSET_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function serveAsset(res, rel) {
  let safe;
  try { safe = path.normalize(decodeURIComponent(rel)); } catch { return json(res, 404, { error: 'not_found' }); }
  if (safe.startsWith('..') || path.isAbsolute(safe)) return json(res, 404, { error: 'not_found' });
  const root = path.join(publicDir, 'assets');
  const file = path.join(root, safe);
  if (!file.startsWith(root)) return json(res, 404, { error: 'not_found' });
  let stat;
  try { stat = fs.statSync(file); } catch { return json(res, 404, { error: 'not_found' }); }
  if (!stat.isFile()) return json(res, 404, { error: 'not_found' });
  const headers = { 'Content-Type': ASSET_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' };
  // SVG 可能内嵌脚本：直接导航打开时禁掉脚本与外部资源；<img> 引用本就不执行脚本。
  if (String(headers['Content-Type']).indexOf('image/svg') === 0) headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
  res.writeHead(200, headers);
  const stream = fs.createReadStream(file);
  stream.on('error', error => { if (!res.headersSent) json(res, 500, { error: error.message }); else res.destroy(); });
  stream.pipe(res);
}
// 只接受回环 Host：服务虽绑定 127.0.0.1，但 DNS rebinding 可让恶意网页以自己的域名
// 打到本机端口；Host 校验与同源策略共同挡住这类绕过（127.0.0.1/localhost/[::1] 之外一律 403）。
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const server = http.createServer((req,res)=>{
  if (!LOOPBACK_HOST_RE.test(String(req.headers.host || ''))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/health') return json(res,200,{ok:true,mode:state.mode,phase:state.phase});
  if (url.pathname === '/api/state') return json(res,200,cloneState());
  if (url.pathname === '/api/highlights') { handleHighlightsApi(req, res, url, { json, state }); return; }
  if (url.pathname === '/api/broadcast/cue') { handleBroadcastCueApi(req, res, url, { readBody, json, broadcast }); return; }
  if (url.pathname === '/api/mvp' && (req.method === 'POST' || req.method === 'GET')) {
    if (req.method === 'GET') return json(res, 200, { mvp: state.mvp });
    readBody(req, res).then(body => {
      const name = String(body && body.name || '').trim();
      const team = String(body && body.team || '').trim().toLowerCase();
      if (!name || (team !== 'blue' && team !== 'red')) {
        // 清除选择：控台撤回 MVP 时页面回到待评选占位，OBS 回到赛后场景。
        state.mvp = null;
        broadcast();
        switchMvpScene(false);
        json(res, 200, { mvp: null });
        return;
      }
      const pgPlayers = state.postGame && Array.isArray(state.postGame.players) ? state.postGame.players : [];
      const pool = pgPlayers.length ? pgPlayers : (Array.isArray(state.players) ? state.players : []);
      const hit = pool.find(p => p && String(p.name || '') === name && (p.team === team))
        || pool.find(p => p && String(p.champion || '') === name && p.team === team);
      if (!hit) { json(res, 400, { error: '候选选手不存在（无赛后/局内数据）' }); return; }
      state.mvp = {
        name: String(hit.name || ''),
        team: hit.team === 'red' ? 'red' : 'blue',
        champion: String(hit.champion || ''),
        championId: Number(hit.championId) || 0,
        at: Date.now()
      };
      broadcast();
      switchMvpScene(true);
      json(res, 200, { mvp: state.mvp });
    }).catch(error => { if (!res.headersSent) json(res, error.statusCode || 500, { ok: false, error: error && error.message ? error.message : 'invalid_request' }); });
    return;
  }
  if (url.pathname === '/api/director/rules') { handleDirectorApi(req, res, url, { readBody, json, state, engine: directorEngine, saveConfig, broadcast }); return; }
  if (url.pathname === '/api/broadcast-config') { handleBroadcastConfigApi(req, res, url, { readBody, json, broadcast, state }); return; }
  if (url.pathname === '/api/uploads/logo' && req.method === 'POST') { handleLogoUploadApi(req, res, url, { json }); return; }
  if (url.pathname === '/api/hud-calib') { handleHudCalibApi(req, res, url); return; }
  if (url.pathname === '/api/sources') { const force = url.searchParams.get('refresh') === '1'; const lockfile = process.env.RIOT_LOCKFILE || path.join(process.env.LOCALAPPDATA || '', 'Riot Games', 'Riot Client', 'Config', 'lockfile'); Promise.all([getLcuConnection(force).then(c => probeLcu(c || lockfile)), probeLiveClient({ url: LIVE_CLIENT_URL })]).then(results => json(res, 200, { results, live: state.live })).catch(error => json(res, 500, { error: error.message })); return; }
  if (url.pathname === '/api/replay' && req.method === 'GET') { replay.readReplayState().then(result => json(res, 200, result)).catch(error => json(res, 500, { connected: false, error: error.message })); return; }
  if (url.pathname === '/api/replay/camera' && req.method === 'POST') { readBody(req, res).then(body => replay.setCamera(body)).then(result => json(res, 200, { ok: true, result })).catch(error => json(res, error.statusCode || 500, { ok: false, error: error.message })); return; }
  if (url.pathname === '/api/replay/playback' && req.method === 'POST') { readBody(req, res).then(body => replay.setPlayback(body)).then(result => json(res, 200, { ok: true, result })).catch(error => json(res, error.statusCode || 500, { ok: false, error: error.message })); return; }
  if (url.pathname === '/api/replay/sequence' && req.method === 'POST') { readBody(req, res).then(body => replay.playSequence(body.frames || body)).then(result => json(res, 200, { ok: true, result })).catch(error => json(res, error.statusCode || 500, { ok: false, error: error.message })); return; }
  if (url.pathname === '/api/obs' && req.method === 'GET') return json(res, 200, obs.snapshot());
  if (url.pathname === '/api/obs/scene' && req.method === 'POST') { readBody(req, res).then(body => obs.setScene(normalizeSceneName(body && body.sceneName))).then(snapshot => { state.obs = snapshot; broadcast(); json(res, 200, { ok: true, obs: snapshot }); }).catch(error => json(res, error.statusCode || 500, { ok: false, error: error.message })); return; }
  if (url.pathname === '/api/obs/autoswitch' && req.method === 'POST') { readBody(req, res).then(body => { state.autoSwitch = normalizeAutoSwitch(body); saveConfig(); broadcast(); json(res, 200, { ok: true, autoSwitch: state.autoSwitch }); }).catch(error => json(res, error.statusCode || 500, { ok: false, error: error.message })); return; }
  // 像素读条（t23）：内部写接口，只收本机来源、不设 CORS 头，由 tools/pixel-bars-bridge.cjs 喂数据。
  if (url.pathname === '/api/pixel-bars' || url.pathname === '/api/pixel-bars/status') { handlePixelBarsApi(req, res, url, { store: pixelBars, onUpdate: onPixelBarsUpdate }); return; }
  // 协议流（t30）：同样是内部写接口，只收本机来源、不设 CORS 头，由同机解码器进程喂数据。
  if (url.pathname === '/api/protocol-feed' || url.pathname === '/api/protocol-feed/status') { handleProtocolFeedApi(req, res, url, { store: protocolFeed, onUpdate: onProtocolFeedUpdate }); return; }
  if (url.pathname.startsWith('/api/obs/')) { handleObsApi(req, res, url, { obs, json, readBody, broadcast, state, port: PORT, getObsConfig, setObsConfig, saveConfig, onObsConnected: () => { lastAutoPhase = null; } }); return; }
  if (url.pathname === '/api/datadragon-url') { try { return json(res, 200, { url: dataDragonUrl(url.searchParams.get('version') || DEFAULT_VERSION, url.searchParams.get('kind') || 'champion', url.searchParams.get('id') || 'Ahri') }); } catch (error) { return json(res, 400, { error: error.message }); } }
  if (url.pathname === '/events') { res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'}); res.write(`data: ${JSON.stringify(cloneState())}\n\n`); addSseClient(res); req.on('close',()=>clients.delete(res)); return; }
  if (url.pathname === '/api/hud-toggle' && req.method === 'POST') { if (state.broadcastConfig && state.broadcastConfig.hudKeyHook === false) return json(res, 200, { ok: false, disabled: true, hudHidden: state.hudHidden }); state.hudHidden = !state.hudHidden; broadcast(); return json(res, 200, { ok: true, hudHidden: state.hudHidden }); }
  if (url.pathname === '/api/phase' && req.method === 'POST') { readBody(req, res).then(body => { state.phase = normalizePhase(body && body.phase); broadcast(); json(res,200,{ok:true,phase:state.phase}); }).catch(error => { if (!res.headersSent) json(res, error.statusCode || 500, { ok: false, error: error.message }); }); return; }
  if (url.pathname === '/api/config' && req.method === 'POST') { readBody(req, res).then(body => { if (body.tournamentName !== undefined) state.tournamentName = normalizeTournamentName(body.tournamentName); if (body.mode !== undefined) { if (body.mode !== 'mock' && body.mode !== 'live') throw badRequest('invalid_mode'); state.mode = body.mode; if (body.mode === 'mock') { state.goldEstimated = false; state.goldSource = 'mock'; state.players = createMockPlayers(); } else { state.postGame = null; frozenSnapshot = null; resetLiveGameData(); } } if (body.phase !== undefined) state.phase = normalizePhase(body.phase); saveConfig(); broadcast(); json(res,200,{ok:true}); }).catch(error => { if (!res.headersSent) json(res, error.statusCode || 500, { ok: false, error: error.message }); }); return; }
  if (url.pathname === '/') return res.end(consolePage(PORT));
  if (url.pathname === '/overlay/hud-calibrate' || url.pathname === '/broadcast/hud-calibrate') return res.end(hudCalibratePage());
  if (url.pathname === '/overlay/bp-broadcast' || url.pathname === '/broadcast/bp') return res.end(bpBroadcastPage());
  if (url.pathname === '/overlay/hud-broadcast' || url.pathname === '/broadcast/hud') return res.end(hudBroadcastPage());
  if (url.pathname === '/broadcast/result' || url.pathname === '/overlay/result-broadcast') return res.end(resultBroadcastPage());
  if (url.pathname === '/broadcast/stage' || url.pathname === '/overlay/stage-broadcast') return res.end(stageBroadcastPage());
  if (url.pathname === '/broadcast/mvp' || url.pathname === '/overlay/mvp-broadcast') return res.end(mvpBroadcastPage());
  if (url.pathname === '/overlay/transition') return res.end(transitionPage());
  if (url.pathname.startsWith('/overlay/')) { const type=url.pathname.split('/')[2]; if (OVERLAY_TYPES.includes(type)) return res.end(overlayPage(type)); }
  if (url.pathname === '/styles.css') { serveStyles(res); return; }
  if (url.pathname.startsWith('/assets/')) { serveAsset(res, url.pathname.slice('/assets/'.length)); return; }
  res.writeHead(404); res.end('Not found');
});
// 监听失败属于启动期错误（例如端口被占用），必须显式退出并给出可读原因，
// 不能被上面的 uncaughtException 兜底吞掉而留下一个「进程活着但没在服务」的假象。
server.on('error', error => {
  console.error('[server] 无法监听 127.0.0.1:' + PORT + '：' + (error && error.message ? error.message : error));
  process.exit(1);
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Khada Jhin running at http://127.0.0.1:${PORT}`));
startObsAutoConnect({ obs, getObsConfig, setObsConfig, onChange: () => { lastAutoPhase = null; broadcast(); } });
