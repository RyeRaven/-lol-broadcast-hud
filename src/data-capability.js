'use strict';

// 数据可用性矩阵：把「这个字段现在到底能不能画、能画到什么精度」变成显式契约。
// 背景：HUD 底部条要等级/KDA/CS/装备/经验条/生命条/资源条/对位经济差，而实时观战（Live Client Data）
// 与回放（timeline 帧）能拿到的字段并不一样，精度也不一样。没有这层契约，页面只能靠猜，
// 猜错就会把量化值当精确值、把队伍级估算当逐人金币，直接违反「数据缺失必须显式占位，绝不伪造」。
//
// 精度只有四档，语义互不重叠：
//   exact        官方接口逐玩家给出、可直接当精确值展示
//   quantized    官方值本身带量化步长（如补刀以 10 为单位），必须带 quantum，不得当 exact 用
//   estimated    由别的数据推算/插值得到，必须写明推算方式
//   unavailable  当前链路拿不到，页面必须画显式占位（—/unknown），不得用任何数值顶上

const FIELD_KEYS = Object.freeze([
  'level', 'kills', 'deaths', 'assists', 'cs', 'csExact', 'totalGold', 'xp',
  // csAsOf/xpAsOf 不是数值本身，而是「这个精确值对应哪个游戏时刻」的可用性。
  // 协议流按关键帧解码（60s 粒度），值是真的但时刻在过去，页面必须能标「60s 前」；
  // 没有 asOf 就只能把关键帧值当成当前值展示，那是在骗观众。
  'csAsOf', 'xpAsOf',
  'xpProgress', 'hpPercent', 'resourcePercent', 'items', 'runes', 'summoners', 'wardScore'
]);

const PRECISIONS = Object.freeze(['exact', 'quantized', 'estimated', 'unavailable']);
const MODES = Object.freeze(['live-spectate', 'replay', 'offline']);

// Live Client Data 的 creepScore 官方按 10 取整（观战接口只给量化值），所以展示必须标量化。
const CS_QUANTUM = 10;
// 回放/离线允许用 timeline 的 60s 帧做线性插值，但跨度超过 90s 就没有可信度，必须降级为 unavailable。
const MAX_INTERPOLATION_SPAN = 90;

function makeEntry(available, source, precision, reason, quantum) {
  const entry = {
    available: available === true && precision !== 'unavailable',
    source: available === true && precision !== 'unavailable' ? source : null,
    precision: PRECISIONS.includes(precision) ? precision : 'unavailable',
    reason: String(reason || '')
  };
  if (entry.precision === 'quantized') {
    const step = Number(quantum);
    entry.quantum = Number.isFinite(step) && step > 0 ? step : CS_QUANTUM;
  }
  return entry;
}

function exact(source, reason) { return makeEntry(true, source, 'exact', reason); }
function quantized(source, quantum, reason) { return makeEntry(true, source, 'quantized', reason, quantum); }
function estimated(source, reason) { return makeEntry(true, source, 'estimated', reason); }
function unavailable(reason) { return makeEntry(false, null, 'unavailable', reason); }

// 模式判定只吃「调用方真实观测到的信号」，不做任何网络请求，保证纯函数可测。
// sources:
//   gameflowPhase      LCU /lol-gameflow/v1/gameflow-phase（如 'InProgress'）
//   isPlayingReplay    LCU /lol-replays/v1/configuration 的 isPlayingReplay
//   observerServerIp   观战服务器地址（非空表示挂在观战链路上）
//   liveClient         Live Client Data（127.0.0.1:2999）本轮是否可达
//   timelineAvailable  /lol-match-history/v1/game-timelines/{gameId} 是否返回 200
function detectMode(sources = {}) {
  const source = sources && typeof sources === 'object' ? sources : {};
  const phase = String(source.gameflowPhase || '');
  const observerServerIp = String(source.observerServerIp || '').trim();
  if (source.isPlayingReplay === true) {
    return { mode: 'replay', reason: 'LCU /lol-replays/v1/configuration 的 isPlayingReplay=true（正在回放）' };
  }
  if (phase === 'InProgress' && (source.liveClient === true || observerServerIp)) {
    return {
      mode: 'live-spectate',
      reason: source.liveClient === true
        ? 'gameflow-phase=InProgress 且 Live Client Data 可达'
        : 'gameflow-phase=InProgress 且 observerServerIp 非空'
    };
  }
  if (source.timelineAvailable === true) {
    return { mode: 'replay', reason: 'timeline 端点可用，按 60s 帧回放（/lol-match-history/v1/game-timelines）' };
  }
  return { mode: 'offline', reason: '未检测到观战链路、回放标志或 timeline 数据' };
}

// 像素读条（t23）：同机独立进程截屏读原生血条/资源条，只给百分比，没有绝对值。
// 读到了就是 estimated（1px≈1.96%、延迟 ~14ms），没读到就保持 unavailable——绝不补 0% 或满条。
const PIXEL_BAR_REASON = '像素读条（同机截屏）：1px≈1.96%，延迟 ~14ms；只有百分比、没有绝对数值';
const PIXEL_BAR_MISSING = '像素读条进程本轮未上报（未启动 / 无对局 / 读数超过 2000ms 失效）';

function liveSpectateFields(protocolDecode, pixelBars, protocolKda, protocolFields) {
  const protocol = protocolDecode === true;
  const pixel = pixelBars === true;
  // 协议流逐字段 presence：本次真正解出的字段才允许标 exact；未传时按旧行为全开（直接调用方默认）。
  // normalizeLiveState 会按玩家对象算出 { cs, gold, xp } 再传进来，避免全队 cs/gold 都 null 时仍标 exact。
  const presence = protocolFields && typeof protocolFields === 'object'
    ? { cs: protocolFields.cs === true, gold: protocolFields.gold === true, xp: protocolFields.xp === true }
    : { cs: protocol, gold: protocol, xp: protocol };
  const hasCs = protocol && presence.cs;
  const hasGold = protocol && presence.gold;
  const hasXp = protocol && presence.xp;
  // 协议流解出的 KDA 与 LCDA 的 KDA 都是精确值，区别只在来源：前者来自 0xdd 关键帧
  // （t16 用单调码点秩解码，脱离真值 300/300），后者来自官方 REST。标清来源，
  // 控台才能看出「这块 KDA 是协议流给的」还是「LCDA 给的」。
  const protocolReason = '协议流解码器（t16/t19）逐玩家字段';
  const kda = protocolKda === true
    ? exact('protocol-feed', '协议流 0xdd 逐玩家 KDA（t16 单调码点秩解码，脱离真值 kills 300/300、deaths 300/300）')
    : exact('live-client-data', 'Live Client Data allPlayers[].scores.kills/deaths/assists');
  return {
    level: exact('live-client-data', 'Live Client Data allPlayers[].level 逐玩家给出'),
    kills: kda,
    deaths: kda,
    assists: kda,
    cs: quantized('live-client-data', CS_QUANTUM, 'Live Client Data scores.creepScore 官方按 10 量化，只能当量化值展示'),
    csExact: hasCs
      ? exact('spectator-protocol', protocolReason + '：精确补刀（关键帧时刻的精确值，必须配合 csAsOf 标「N 秒前」）')
      : unavailable(protocol ? '协议流本轮没有精确补刀（该字段未解出），不能用 LCDA 的 10 补刀量化值冒充' : '协议流精确补刀尚未接入（t19 仍在攻坚），当前只有 LCDA 的 10 补刀量化值'),
    totalGold: hasGold
      ? exact('spectator-protocol', protocolReason + '：逐玩家金币')
      : unavailable(protocol ? '协议流本轮没有逐玩家金币（该字段未解出），不得用 estimateTeamGold 冒充' : 'Live Client Data 没有逐玩家金币字段；estimateTeamGold 是队伍级估算，不得冒充 totalGold'),
    xp: hasXp
      ? exact('spectator-protocol', protocolReason + '：逐玩家经验（关键帧时刻的精确值，必须配合 xpAsOf）')
      : unavailable(protocol ? '协议流本轮没有逐玩家经验（该字段未解出），不得用任何估算值冒充' : 'Live Client Data 没有逐玩家经验字段；t17 已证明 0xdd 的 gold/xp 无法用真值锚定'),
    csAsOf: hasCs
      ? exact('spectator-protocol', protocolReason + '：精确补刀对应的游戏时间（秒）')
      : unavailable('没有精确补刀就没有对应的关键帧时刻，页面只能用当前帧展示'),
    xpAsOf: hasXp
      ? exact('spectator-protocol', protocolReason + '：精确经验对应的游戏时间（秒）')
      : unavailable('没有精确经验就没有对应的关键帧时刻，页面只能用当前帧展示'),
    xpProgress: hasXp
      ? exact('spectator-protocol', '由精确 xp + 标准等级阈值换算的经验条进度')
      : unavailable('Live Client Data allPlayers 不含 experience/experienceToNext，算不出经验条进度'),
    hpPercent: pixel
      ? estimated('pixel-bars', PIXEL_BAR_REASON)
      : unavailable('Live Client Data allPlayers 不含 health/maxHealth；' + PIXEL_BAR_MISSING),
    resourcePercent: pixel
      ? estimated('pixel-bars', PIXEL_BAR_REASON)
      : unavailable('Live Client Data allPlayers 不含 resourceValue/resourceMax；' + PIXEL_BAR_MISSING),
    items: exact('live-client-data', 'Live Client Data allPlayers[].items（itemID/count/slot）'),
    runes: exact('live-client-data', 'Live Client Data allPlayers[].runes.keystone'),
    summoners: exact('live-client-data', 'Live Client Data allPlayers[].summonerSpells + Data Dragon key'),
    wardScore: exact('live-client-data', 'Live Client Data allPlayers[].scores.wardScore')
  };
}

function replayFields(timelineAvailable) {
  const timeline = timelineAvailable === true;
  const interpolated = reason => estimated('timeline-interpolated', reason + '；插值跨度超过 ' + MAX_INTERPOLATION_SPAN + 's 时降级为 unavailable');
  const missing = reason => unavailable('回放时间线不可用（/lol-match-history/v1/game-timelines 未返回 200）：' + reason);
  return {
    level: timeline ? estimated('timeline-interpolated', 'timeline 帧的等级是阶跃值，取最近帧原值并标估算；跨度超过 ' + MAX_INTERPOLATION_SPAN + 's 时降级为 unavailable') : missing('无等级数据'),
    kills: timeline ? estimated('timeline-events', '由 CHAMPION_KILL 事件按时间戳累加') : missing('无击杀事件'),
    deaths: timeline ? estimated('timeline-events', '由 CHAMPION_KILL 事件按时间戳累加') : missing('无死亡事件'),
    assists: timeline ? estimated('timeline-events', '由 CHAMPION_KILL 的 assistingParticipantIds 累加') : missing('无助攻事件'),
    cs: timeline ? interpolated('补刀 = minionsKilled + jungleMinionsKilled 的 60s 帧线性插值') : missing('无补刀帧'),
    csExact: timeline ? interpolated('补刀 = minionsKilled + jungleMinionsKilled 的 60s 帧线性插值') : missing('无补刀帧'),
    totalGold: timeline ? interpolated('totalGold 的 60s 帧线性插值') : missing('无金币帧'),
    xp: timeline ? interpolated('xp 的 60s 帧线性插值') : missing('无经验帧'),
    // 回放的每一帧自带 time 字段，页面直接读帧时间即可，不需要额外的 asOf。
    csAsOf: unavailable('回放 timeline 每帧自带 time 字段，页面直接读帧时间，不需要额外 asOf'),
    xpAsOf: unavailable('回放 timeline 每帧自带 time 字段，页面直接读帧时间，不需要额外 asOf'),
    xpProgress: unavailable('timeline 不提供升级所需经验曲线，算不出经验条进度'),
    hpPercent: unavailable('timeline 不含生命值'),
    resourcePercent: unavailable('timeline 不含法力/能量'),
    items: timeline ? estimated('timeline-events', '由 ITEMS_PURCHASED / ITEM_SOLD 事件折叠出装备，尚未接入前必须按估算展示') : missing('无装备事件'),
    runes: missing('timeline 不含符文配置'),
    summoners: missing('timeline 不含召唤师技能')
  };
}

function offlineFields() {
  const reason = '未连接任何数据源（既没有 Live Client Data，也没有回放 timeline）';
  const fields = {};
  for (const key of FIELD_KEYS) fields[key] = unavailable(reason);
  return fields;
}

// mode 只接受三种取值，写错直接抛错，避免调用方把拼错的模式静默当成 offline。
function buildCapabilityMatrix(mode, sources = {}) {
  const source = sources && typeof sources === 'object' ? sources : {};
  const normalized = String(mode || '');
  if (!MODES.includes(normalized)) {
    throw new TypeError('buildCapabilityMatrix requires mode in ' + MODES.join('/') + ', got ' + JSON.stringify(mode));
  }
  let fields;
  let detail = '';
  if (normalized === 'live-spectate') {
    fields = liveSpectateFields(source.protocolDecode === true, source.pixelBars === true, source.protocolKda === true, source.protocolFields);
    detail = source.protocolDecode === true
      ? '实时观战 + 协议流解码可用'
      : '实时观战：只有 Live Client Data 字段，金币/经验/精确补刀不可用';
  } else if (normalized === 'replay') {
    const timelineAvailable = source.timelineAvailable === true;
    fields = replayFields(timelineAvailable);
    detail = timelineAvailable
      ? '回放：timeline 60s 帧线性插值（estimated）'
      : '回放：timeline 不可用，全部字段降级';
  } else {
    fields = offlineFields();
    detail = '离线：没有任何可用数据源';
  }
  // detectMode 只吃真实探测信号；normalizeLiveState 只在 LCDA 请求成功后才会调用这里，
  // 但调用方可能还没来得及把 gameflow-phase 等信号接进来。此时 detectMode 会返回 offline，
  // 而 capability.mode 是调用方显式指定的合法模式，若原样保留就会自相矛盾
  // （页面/控台显示「mode=live-spectate，但 detected=offline」）。
  // 这里只把这个「未收到探测信号」的事实改写成显式模式说明，绝不伪造真实探测信号；
  // 真实信号接上后仍由 detectMode 返回真实判定。不要为了掩盖 wiring 缺失而删除本兜底。
  const detected = detectMode(source);
  const resolvedDetected = detected.mode === 'offline' && normalized !== 'offline'
    ? { mode: normalized, reason: 'mode 由调用方显式指定（本轮未收到探测信号）' }
    : detected;
  const matrix = {
    mode: normalized,
    detail,
    // 与模式判定同源，方便页面与控台直接展示「为什么是这个模式」。
    detected: resolvedDetected,
    fields,
    exact: [],
    quantized: [],
    estimated: [],
    unavailable: []
  };
  for (const key of FIELD_KEYS) {
    const entry = fields[key] || unavailable('字段未定义');
    fields[key] = entry;
    matrix[entry.precision].push(key);
  }
  return matrix;
}

// 像素读条失效时（超过 2000ms 没有新读数）必须立刻把生命/资源条降回 unavailable，
// 不能等下一轮 Live Client Data 轮询——否则 HUD 会继续用上一轮百分比冒充当前血量。
// 返回新对象，不改动传入的矩阵（SSE 快照是共享引用，就地改会污染历史帧）。
function applyPixelBarsAvailability(matrix, active) {
  if (!matrix || !matrix.fields) return matrix;
  const on = active === true;
  const fields = { ...matrix.fields };
  let changed = false;
  for (const key of ['hpPercent', 'resourcePercent']) {
    const entry = fields[key] || unavailable('字段未定义');
    if (on) {
      if (entry.precision === 'estimated' && entry.source === 'pixel-bars') continue;
      fields[key] = estimated('pixel-bars', PIXEL_BAR_REASON);
      changed = true;
    } else if (entry.source === 'pixel-bars') {
      fields[key] = unavailable('Live Client Data 不含生命/资源字段；' + PIXEL_BAR_MISSING);
      changed = true;
    }
  }
  if (!changed) return matrix;
  const next = { ...matrix, fields, exact: [], quantized: [], estimated: [], unavailable: [] };
  for (const key of FIELD_KEYS) next[fields[key] ? fields[key].precision : 'unavailable'].push(key);
  return next;
}

// 协议流失效时（超过 2000ms 没有新包）同样必须立刻把精确字段降回 unavailable：
// 关键帧值是真的，但过了时效就变成「上一局的数字」，继续展示就是伪造当前值。
// 与 applyPixelBarsAvailability 一样返回新对象，不改动传入的矩阵。
const PROTOCOL_KEYS = Object.freeze(['csExact', 'totalGold', 'xp', 'csAsOf', 'xpAsOf', 'xpProgress']);
// KDA 与上面几项不同：LCDA 本来就有精确 KDA，协议流只是换了个来源。
// 所以失效时回落到 live-client-data，而不是 unavailable——这条永远不降级。
const PROTOCOL_KDA_KEYS = Object.freeze(['kills', 'deaths', 'assists']);

function applyProtocolAvailability(matrix, active, options = {}) {
  if (!matrix || !matrix.fields) return matrix;
  const on = active === true;
  const protocolDecode = options.protocolDecode !== false;
  // presence 必须由调用方按本包实际解出的字段传入：只有某字段真的有 exact 值时才允许升级，
  // 否则「包还新鲜」会把全队都解不出的 csExact 也标成精确值（BUG B）。
  // 兼容旧的 protocolKda 选项，但正式调用统一走 { cs, gold, xp, kda }。
  const presence = {
    cs: options.cs === true,
    gold: options.gold === true,
    xp: options.xp === true,
    kda: options.kda === true || options.protocolKda === true
  };
  const fieldPresence = key => {
    if (key === 'csExact' || key === 'csAsOf') return presence.cs;
    if (key === 'totalGold') return presence.gold;
    if (key === 'xp' || key === 'xpAsOf' || key === 'xpProgress') return presence.xp;
    return false;
  };
  // 只有本包真的带了三项齐全的 KDA，才把 KDA 的来源标成协议流；否则保持 LCDA。
  const kdaOn = on && protocolDecode && presence.kda;
  const protocolReason = '观战协议流（0xdd 关键帧）解码可用';
  const fields = { ...matrix.fields };
  let changed = false;
  for (const key of PROTOCOL_KEYS) {
    const entry = fields[key] || unavailable('字段未定义');
    if (on && protocolDecode && fieldPresence(key)) {
      if (entry.precision === 'exact' && entry.source === 'spectator-protocol') continue;
      const label = key === 'csExact' ? '精确补刀（关键帧时刻的精确值，必须配合 csAsOf 标「N 秒前」）'
        : key === 'totalGold' ? '逐玩家金币（关键帧时刻的精确值）'
          : key === 'xp' ? '逐玩家经验（关键帧时刻的精确值，必须配合 xpAsOf）'
            : key === 'csAsOf' ? '精确补刀对应的游戏时间（秒）'
              : key === 'xpAsOf' ? '精确经验对应的游戏时间（秒）'
                : '经验条进度（由精确 xp 与等级阈值计算）';
      fields[key] = exact('spectator-protocol', protocolReason + '：' + label);
      changed = true;
    } else if (entry.source === 'spectator-protocol') {
      const reason = key === 'csExact' ? '协议流精确补刀尚未接入（t19 仍在攻坚），当前只有 LCDA 的 10 补刀量化值'
        : key === 'totalGold' ? 'Live Client Data 不含金币；t17 已证明 0xdd 的 gold 无法用真值锚定，不得用 estimateTeamGold 冒充逐玩家金币'
          : key === 'xp' ? 'Live Client Data 没有逐玩家经验字段；t17 已证明 0xdd 的 gold/xp 无法用真值锚定'
            : key === 'xpProgress' ? '协议流没有精确 xp，经验条无法计算'
              : '没有精确值就没有对应的关键帧时刻，页面只能用当前帧展示';
      fields[key] = unavailable(reason);
      changed = true;
    }
  }
  for (const key of PROTOCOL_KDA_KEYS) {
    // KDA 只在「协议流可用」这个方向上切；失效方向交给下一次 Live Client Data 轮询。
    // 原因是失效瞬间玩家对象上还是协议流的 KDA 值，若此刻把来源改成 live-client-data，
    // 就会出现「数值是协议流的、标签写着官方 REST」的错位（最长 1s，但那是实打实的错标）。
    if (!on) continue;
    const entry = fields[key] || unavailable('字段未定义');
    if (kdaOn) {
      if (entry.source === 'protocol-feed') continue;
      fields[key] = exact('protocol-feed', '协议流 0xdd 逐玩家 KDA（t16 单调码点秩解码，脱离真值 kills 300/300、deaths 300/300）');
      changed = true;
    } else if (entry.source === 'protocol-feed') {
      // 协议流失效不等于 KDA 失效：官方 REST 的 KDA 仍然是精确值，回落而不是标 unavailable。
      fields[key] = exact('live-client-data', 'Live Client Data allPlayers[].scores.kills/deaths/assists');
      changed = true;
    }
  }
  if (!changed) return matrix;
  const next = { ...matrix, fields, exact: [], quantized: [], estimated: [], unavailable: [] };
  for (const key of FIELD_KEYS) next[fields[key] ? fields[key].precision : 'unavailable'].push(key);
  return next;
}

function fieldOf(matrix, key) {
  return matrix && matrix.fields && matrix.fields[key] ? matrix.fields[key] : null;
}

function precisionOf(matrix, key) {
  const entry = fieldOf(matrix, key);
  return entry ? entry.precision : 'unavailable';
}

// 只有 exact 才算精确值。quantized 必须走 isQuantized 分支单独展示（带 ≈ 与量子步长）。
function isExact(matrix, key) {
  return precisionOf(matrix, key) === 'exact';
}

function isQuantized(matrix, key) {
  return precisionOf(matrix, key) === 'quantized';
}

function isUsable(matrix, key) {
  const entry = fieldOf(matrix, key);
  return !!entry && entry.available === true && entry.precision !== 'unavailable';
}

// timeline 帧插值：60s 一帧，线性插值；跨度（含首尾外推）超过 90s 直接降级 unavailable。
// options.step=true 用于等级这类阶跃字段，取最近帧原值而不是插值。
function interpolateAt(frames, gameTime, key, options = {}) {
  const target = Number(gameTime);
  const list = (Array.isArray(frames) ? frames : [])
    .filter(frame => frame && Number.isFinite(Number(frame.time)))
    .map(frame => ({ time: Number(frame.time), value: Number(frame[key]) }))
    .filter(frame => Number.isFinite(frame.value))
    .sort((a, b) => a.time - b.time);
  if (!list.length || !Number.isFinite(target)) {
    return { available: false, value: null, source: 'timeline-interpolated', precision: 'unavailable', span: null, reason: 'timeline 帧不足，无法插值' };
  }
  const first = list[0];
  const last = list[list.length - 1];
  let span = 0;
  let value = first.value;
  if (target <= first.time) {
    span = first.time - target;
    value = first.value;
  } else if (target >= last.time) {
    span = target - last.time;
    value = last.value;
  } else {
    let before = first;
    let after = last;
    for (const frame of list) {
      if (frame.time <= target) before = frame;
      if (frame.time >= target && after.time >= target && frame.time < after.time) after = frame;
    }
    if (after.time <= target) after = before;
    span = after.time - before.time;
    const step = options.step === true || span <= 0;
    value = step ? before.value : before.value + (after.value - before.value) * ((target - before.time) / span);
  }
  if (span > MAX_INTERPOLATION_SPAN) {
    return {
      available: false, value: null, source: 'timeline-interpolated', precision: 'unavailable', span,
      reason: '最近帧跨度 ' + Math.round(span) + 's 超过 ' + MAX_INTERPOLATION_SPAN + 's 上限，降级为 unavailable'
    };
  }
  return {
    available: true,
    value: Math.round(value * 100) / 100,
    source: 'timeline-interpolated',
    precision: 'estimated',
    span,
    reason: (options.step === true ? '取最近帧原值（阶跃字段），跨度 ' : '60s 帧线性插值，跨度 ') + Math.round(span) + 's'
  };
}

module.exports = {
  FIELD_KEYS,
  PRECISIONS,
  MODES,
  CS_QUANTUM,
  MAX_INTERPOLATION_SPAN,
  detectMode,
  buildCapabilityMatrix,
  applyPixelBarsAvailability,
  applyProtocolAvailability,
  PROTOCOL_KEYS,
  PROTOCOL_KDA_KEYS,
  interpolateAt,
  fieldOf,
  precisionOf,
  isExact,
  isQuantized,
  isUsable
};
