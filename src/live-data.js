'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { DEFAULT_VERSION, itemId, spellKey } = require('./assets');
const { buildCapabilityMatrix, MODES } = require('./data-capability');
const { applyBarsToPlayers } = require('./pixel-bars');
const { applyEconOcrToPlayers } = require('./econ-ocr');
const { sideOf, sideFromTurretName } = require('./side');

// 把 /liveclientdata/allgamedata 的原始结构压成渲染层直接可用的形状。
// 注意：Live Client Data 没有金币字段（只有本地玩家 activePlayer.currentGold），
// 所以经济只能靠补刀/装备侧写，不要伪造一个"官方金币"。

function playerName(player) {
  return player.summonerName || player.riotIdGameName || player.riotId || player.rawChampionName || 'Unknown';
}

// 装备：保留 itemID/count/slot/displayName/price，HUD 要用它画角标（消耗品数量、叠层层数）和装备总值。
// 价格口径与 estimateTeamGold 一致：优先 Data Dragon 总价（data/items-*.json 的 gold.total），
// 其次 Live Client Data 自带 price（通常只是合成基础价），两者都没有就记 0 —— 未知价格不编造。
function normalizeItemEntry(item, itemIndex) {
  if (!item || typeof item !== 'object') return null;
  const rawId = item.itemID != null ? item.itemID : (item.itemId != null ? item.itemId : item.id);
  const displayName = String(item.displayName || item.name || '').trim();
  const resolved = rawId != null && rawId !== '' ? Number(rawId) : itemId(displayName);
  const known = Number.isFinite(resolved) ? resolved : null;
  // 既没有 id 也没有名字（例如 Live Client Data 里的空 {}）不是装备，直接丢掉，别留空壳。
  if (known === null && !displayName) return null;
  const entry = itemIndex && typeof itemIndex.find === 'function'
    ? itemIndex.find(known != null ? known : displayName)
    : null;
  const count = Math.max(1, Math.floor(Number(item.count) || 1));
  const price = entry ? Math.max(0, Number(entry.total) || 0) : Math.max(0, Number(item.price) || 0);
  const slotValue = Number(item.slot);
  const slot = Number.isFinite(slotValue) && slotValue >= 0 && slotValue <= 6 ? Math.floor(slotValue) : null;
  return {
    itemID: known,
    count,
    slot,
    displayName: displayName || (entry && entry.name) || (known != null ? '#' + known : ''),
    price
  };
}

// 符文：观战/回放模式下 Live Client Data 的 runes 可能是 null，缺就整体返回 null，由页面显式占位。
function normalizeRunes(runes) {
  if (!runes || typeof runes !== 'object') return null;
  const keystone = runes.keystone && typeof runes.keystone === 'object' ? runes.keystone : null;
  const primary = runes.primaryRuneTree && typeof runes.primaryRuneTree === 'object' ? runes.primaryRuneTree : null;
  const secondary = runes.secondaryRuneTree && typeof runes.secondaryRuneTree === 'object' ? runes.secondaryRuneTree : null;
  if (!keystone && !primary && !secondary) return null;
  const idOf = value => {
    if (!value || typeof value !== 'object') return null;
    const numeric = Number(value.id);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const nameOf = value => String((value && (value.displayName || value.name)) || '');
  return {
    keystone: { id: idOf(keystone), displayName: nameOf(keystone) },
    primaryRuneTree: { id: idOf(primary), displayName: nameOf(primary) },
    secondaryRuneTree: { id: idOf(secondary), displayName: nameOf(secondary) }
  };
}

// 召唤师技能：Live Client Data 只给中文名 + rawDisplayName，没有数字 id。
// 用 Data Dragon 的 spell key（SummonerFlash / SummonerBoost …）作稳定 id，正好是 assets.spellIconUrl 需要的值。
// 原始串形如 GeneratedTip_SummonerSpell_SummonerBoost_DisplayName：第一段 SummonerSpell 是提示命名空间，
// 真正的技能 key 在它后面，所以取最后一个匹配；正则不带下划线，否则会把 _DisplayName 尾巴一起吞进来。
// 取不到 key 时再回退中文名查表；占位技能（Summoner_UltBookPlaceholder）只可能靠中文名命中。
function spellIdOf(spell) {
  if (!spell || typeof spell !== 'object') return null;
  const raw = String(spell.rawDisplayName || spell.rawDescription || '');
  const matched = raw.match(/Summoner[A-Za-z0-9]+/g);
  if (matched && matched.length) {
    const key = matched[matched.length - 1];
    if (key !== 'SummonerSpell') return key;
  }
  return spellKey(spell.displayName || spell.name) || null;
}

// 观战/回放协议流（0xdd 包）解码结果接入点：t16 的解码器交付后，由调用方把逐玩家的
// { cs, totalGold, xp } 传进来（normalizeLiveState 的 options.protocolFor）。
// 这里只认精确值：缺一项就是 null，绝不拿 LCDA 的估算值顶上去冒充精确值。
function protocolFields(record) {
  const source = record && typeof record === 'object' ? record : null;
  const pick = key => {
    if (!source) return null;
    const value = Number(source[key]);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  // asOf 是这组数值对应的游戏时间（秒）。协议流按关键帧解码，值是真的但时刻是过去的，
  // 页面必须能标「N 秒前」，所以精确值一律带 asOf，绝不让人误以为是当前帧。
  const asOf = (() => {
    if (!source) return null;
    const value = Number(source.asOf);
    return Number.isFinite(value) && value >= 0 ? value : null;
  })();
  // 精度声明：gold/xp 可能是 quantized（残差字节解出的关键帧值，亚单位漂移）；
  // 没带 precision 的老包按 exact 兼容（它只有走 exact 路径才进得来）。
  const precisionOf = key => {
    const precision = source && source.precision && typeof source.precision === 'object' ? source.precision[key] : null;
    return precision === 'exact' || precision === 'quantized' ? precision : null;
  };
  // KDA 三项必须同时存在才算精确：缺一项就整组作废，绝不用 0 补齐。
  const kills = pick('kills');
  const deaths = pick('deaths');
  const assists = pick('assists');
  const kdaExact = kills !== null && deaths !== null && assists !== null
    ? { kills, deaths, assists, asOf }
    : null;
  const totalGold = pick('totalGold');
  const xp = pick('xp');
  return {
    csExact: pick('cs'),
    totalGold,
    xp,
    // 值可用但精度只有 quantized 时，页面必须标注「解码值 ±1」，不能写成精确值。
    goldPrecision: totalGold === null ? null : (precisionOf('totalGold') || 'exact'),
    xpPrecision: xp === null ? null : (precisionOf('xp') || 'exact'),
    kdaExact,
    asOf
  };
}

function normalizePlayer(player, options = {}) {
  if (!player || typeof player !== 'object') return null;
  const scores = player.scores || {};
  const spells = player.summonerSpells || {};
  // 默认用启动时读到的 Data Dragon 磁盘缓存（见文件末尾的 defaultItemIndex），测试可注入小型索引。
  const itemIndex = options.itemIndex || defaultItemIndex;
  const items = (Array.isArray(player.items) ? player.items : [])
    .map(item => normalizeItemEntry(item, itemIndex))
    .filter(Boolean);
  const spellOne = spells.summonerSpellOne && typeof spells.summonerSpellOne === 'object' ? spells.summonerSpellOne : null;
  const spellTwo = spells.summonerSpellTwo && typeof spells.summonerSpellTwo === 'object' ? spells.summonerSpellTwo : null;
  const protocolSource = typeof options.protocol === 'function' ? options.protocol(player) : options.protocol;
  const protocol = protocolFields(protocolSource);
  // 协议流的 KDA 是逐帧精确值，优先于 Live Client Data；三项齐全才覆盖，否则保持 LCDA。
  const kdaExact = protocol.kdaExact;
  return {
    name: playerName(player),
    team: sideOf(player.team),
    champion: player.championName || '',
    level: Number(player.level) || 1,
    kills: kdaExact ? kdaExact.kills : Number(scores.kills) || 0,
    deaths: kdaExact ? kdaExact.deaths : Number(scores.deaths) || 0,
    assists: kdaExact ? kdaExact.assists : Number(scores.assists) || 0,
    cs: Number(scores.creepScore) || 0,
    wardScore: Number(scores.wardScore) || 0,
    alive: !player.isDead,
    respawnTimer: Number(player.respawnTimer) || 0,
    items,
    // 兼容访问器：老页面（overlays / console）只想要名字，不必自己拆对象。
    itemNames: items.map(item => item.displayName).filter(Boolean),
    summoners: [spellOne && spellOne.displayName, spellTwo && spellTwo.displayName].filter(Boolean),
    summonerSpellIds: [spellIdOf(spellOne), spellIdOf(spellTwo)],
    runes: normalizeRunes(player.runes),
    // 协议流精确值；解码器不可用时是 null，页面必须显式降级，不能当成 0 或估算值。
    csExact: protocol.csExact,
    totalGold: protocol.totalGold,
    totalGoldPrecision: protocol.goldPrecision,
    xp: protocol.xp,
    xpPrecision: protocol.xpPrecision,
    // 精确值对应的游戏时间（秒）；对应字段为 null 时也必须是 null，不能挂一个假时刻。
    csAsOf: protocol.csExact === null ? null : protocol.asOf,
    xpAsOf: protocol.xp === null ? null : protocol.asOf,
    kdaExact,
    position: options.isAram ? null : player.position || null,
    isBot: Boolean(player.isBot),
    // 像素读条（t23）：只有百分比，没有绝对值。这里恒为 null，由 normalizeLiveState 在
    // 拿到本轮 bar 后按 (team, 行序) 回填；没读到的必须是 null，绝不补 0 或满条。
    hpPercent: null,
    resourcePercent: null,
    shieldPercent: null,
    resourceColor: null,
    pixelBars: null
  };
}

// Live Client Data 的 summonerName 带 #tag，而事件里的 KillerName 不带，必须剥掉再比。
function stripTag(name) { return String(name || '').replace(/#.*$/, '').trim(); }

// Live Client Data 的事件容器在不同版本里可能是 events.Events、events 数组或缺失。
function readEvents(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.events)) return payload.events.filter(Boolean);
  if (payload.events && Array.isArray(payload.events.Events)) return payload.events.Events.filter(Boolean);
  return [];
}

// 极地大乱斗没有 ban 阶段、也没有分路（position 常为 Invalid），按模式/地图识别后不伪造分路。
function isAramGame(gameData = {}) {
  const mode = String(gameData.gameMode || '');
  const mapName = String(gameData.mapName || '');
  const mapNumber = Number(gameData.mapNumber);
  return /ARAM|极地大乱斗/i.test(mode) || mapNumber === 12 || /Map12/i.test(mapName);
}

const OBJECTIVE_EVENTS = { TurretKilled: 'towers', DragonKill: 'dragons', BaronKill: 'barons', HeraldKill: 'heralds', HordeKill: 'grubs' };

// ---- 经济估算 ------------------------------------------------------------
// Live Client Data 不提供对手/全队金币，只能按可见信息估算：
// 装备总价（Data Dragon item.json 的 gold.total）+ 补刀 + 击杀/助攻 + 随时间被动金币。
// 这里不读取游戏内存，也不伪造“官方金币”；数值统一取整，供 HUD 做相对经济展示。
const ITEM_CACHE_DIR = path.join(__dirname, '..', 'data');
const ITEM_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const ITEM_VERSION = DEFAULT_VERSION;
const GOLD_WEIGHTS = Object.freeze({ cs: 20, kill: 300, assist: 150, passivePerSecond: 2.4 });
let defaultItemIndex = null;
const itemIndexes = new Map();
const pendingItemIndexes = new Map();

function fetchJson(url, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
  });
}

function buildItemIndex(entries, version = ITEM_VERSION) {
  const byId = new Map();
  const byName = new Map();
  for (const [key, item] of Object.entries(entries || {})) {
    if (!item || typeof item !== 'object') continue;
    const numeric = Number(item.id != null ? item.id : key);
    if (!Number.isFinite(numeric)) continue;
    const gold = item.gold && typeof item.gold === 'object' ? item.gold : {};
    const rawTotal = gold.total != null ? gold.total : gold.base;
    const total = Math.max(0, Number(rawTotal) || 0);
    const entry = { id: numeric, name: item.name || String(key), total };
    byId.set(numeric, entry);
    if (entry.name) {
      byName.set(entry.name, entry);
      byName.set(String(entry.name).toLowerCase(), entry);
    }
  }
  function find(value) {
    if (value == null) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && byId.has(numeric)) return byId.get(numeric);
    const key = String(value).trim();
    return byName.get(key) || byName.get(key.toLowerCase()) || null;
  }
  return {
    version,
    size: byId.size,
    find,
    price(value) { const entry = find(value); return entry ? entry.total : 0; },
    name(value) { const entry = find(value); return entry ? entry.name : ''; }
  };
}

function itemCacheFile(version, cacheDir = ITEM_CACHE_DIR) {
  return path.join(cacheDir, 'items-' + version + '.json');
}

function readItemCache(version = ITEM_VERSION, options = {}) {
  try {
    const saved = JSON.parse(fs.readFileSync(itemCacheFile(version, options.cacheDir || ITEM_CACHE_DIR), 'utf8'));
    const ttl = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : ITEM_CACHE_TTL;
    if (!saved || !saved.data || Date.now() - Number(saved.savedAt || 0) > ttl) return null;
    return buildItemIndex(saved.data, version);
  } catch { return null; }
}

function writeItemCache(version, data, options = {}) {
  try {
    const dir = options.cacheDir || ITEM_CACHE_DIR;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(itemCacheFile(version, dir), JSON.stringify({ savedAt: Date.now(), version, data }));
  } catch {}
}

async function loadItemIndex(options = {}) {
  const version = String(options.version || ITEM_VERSION);
  const cacheDir = options.cacheDir || ITEM_CACHE_DIR;
  const key = version + '|' + cacheDir;
  if (itemIndexes.has(key)) return itemIndexes.get(key);
  if (pendingItemIndexes.has(key)) return pendingItemIndexes.get(key);
  const pending = (async () => {
    const disk = readItemCache(version, { cacheDir });
    if (disk) { itemIndexes.set(key, disk); defaultItemIndex = disk; return disk; }
    const payload = await fetchJson('https://ddragon.leagueoflegends.com/cdn/' + version + '/data/zh_CN/item.json').catch(() => null);
    if (!payload || !payload.data) return buildItemIndex({}, version);
    writeItemCache(version, payload.data, { cacheDir });
    const index = buildItemIndex(payload.data, version);
    itemIndexes.set(key, index);
    defaultItemIndex = index;
    return index;
  })();
  pendingItemIndexes.set(key, pending);
  try { return await pending; } finally { pendingItemIndexes.delete(key); }
}

function itemGold(item, itemIndex) {
  if (typeof item === 'string') return itemIndex ? itemIndex.price(item) : 0;
  if (!item || typeof item !== 'object') return 0;
  const id = item.itemID != null ? item.itemID : (item.itemId != null ? item.itemId : item.id);
  const name = item.displayName || item.name || '';
  const entry = itemIndex && typeof itemIndex.find === 'function'
    ? (itemIndex.find(id) || itemIndex.find(name))
    : null;
  // 未知物品优先用 Live Client Data 自带的 price（通常是基础价），没有再按 0 处理。
  const unit = entry ? entry.total : Math.max(0, Number(item.price) || 0);
  const count = Math.max(1, Math.floor(Number(item.count) || 1));
  return unit * count;
}

function playerGold(player, itemIndex) {
  if (!player || typeof player !== 'object') return 0;
  const scores = player.scores && typeof player.scores === 'object' ? player.scores : {};
  const cs = Number(player.cs != null ? player.cs : scores.creepScore) || 0;
  const kills = Number(player.kills != null ? player.kills : scores.kills) || 0;
  const assists = Number(player.assists != null ? player.assists : scores.assists) || 0;
  const items = Array.isArray(player.items) ? player.items : [];
  return items.reduce((total, item) => total + itemGold(item, itemIndex), 0) +
    cs * GOLD_WEIGHTS.cs + kills * GOLD_WEIGHTS.kill + assists * GOLD_WEIGHTS.assist;
}

function estimateTeamGold(players, gameTime, options = {}) {
  const totals = { blue: 0, red: 0 };
  const itemIndex = options.itemIndex || options.items || defaultItemIndex;
  if (!Array.isArray(players)) return totals;
  const time = Math.max(0, Number(gameTime) || 0);
  for (const player of players) {
    if (!player || typeof player !== 'object') continue;
    const rawTeam = String(player.team || '').toUpperCase();
    const side = rawTeam === 'CHAOS' || rawTeam === 'RED' ? 'red' : (rawTeam === 'ORDER' || rawTeam === 'BLUE' ? 'blue' : null);
    if (!side) continue;
    totals[side] += playerGold(player, itemIndex) + time * GOLD_WEIGHTS.passivePerSecond;
  }
  return { blue: Math.round(totals.blue), red: Math.round(totals.red) };
}

// 进程启动时先读 7 天内的磁盘缓存，首个轮询就能拿到真实装备价，不必等网络。
try { defaultItemIndex = readItemCache(ITEM_VERSION); } catch {}

function countObjectives(events, sideByChampion) {
  const totals = {
    blue: { towers: 0, dragons: 0, barons: 0, heralds: 0, grubs: 0, dragonTypes: [] },
    red: { towers: 0, dragons: 0, barons: 0, heralds: 0, grubs: 0, dragonTypes: [] }
  };
  const sideOfKiller = name => {
    const raw = String(name || '').trim();
    if (!raw) return null;
    const plain = stripTag(raw);
    return sideByChampion.get(raw) || sideByChampion.get(plain) ||
      sideByChampion.get(raw.toLowerCase()) || sideByChampion.get(plain.toLowerCase()) || null;
  };
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const bucket = OBJECTIVE_EVENTS[event.EventName];
    if (!bucket) continue;
    let side = sideOfKiller(event.KillerName);
    if (!side && event.EventName === 'TurretKilled') side = sideFromTurretName(event.TurretKilled);
    if (side) totals[side][bucket] += 1;
    // 元素龙类型随击杀事件记录，HUD 按类型渲染对应元素 sigil（LCU DragonKill 事件自带 DragonType）。
    if (side && bucket === 'dragons' && event.DragonType) totals[side].dragonTypes.push(String(event.DragonType));
  }
  return totals;
}

// LCDA 的 events 是滚动窗口，只保留最近一段事件：全量重算会让长局的塔/龙/男爵漏掉
// 窗口外事件、数值随窗口滑动跳变。所以目标物计数必须跨轮询增量累计（ledger）：
// 新事件按身份去重合并（回放拖动导致事件重放也不会重复计数），只增不减。
function createObjectiveLedger() {
  return {
    seen: new Set(),
    totals: {
      blue: { towers: 0, dragons: 0, barons: 0, heralds: 0, grubs: 0, dragonTypes: [] },
      red: { towers: 0, dragons: 0, barons: 0, heralds: 0, grubs: 0, dragonTypes: [] }
    }
  };
}

function accumulateObjectives(ledger, events, sideByChampion) {
  const sideOfKiller = name => {
    const raw = String(name || '').trim();
    if (!raw) return null;
    const plain = stripTag(raw);
    return sideByChampion.get(raw) || sideByChampion.get(plain) ||
      sideByChampion.get(raw.toLowerCase()) || sideByChampion.get(plain.toLowerCase()) || null;
  };
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const bucket = OBJECTIVE_EVENTS[event.EventName];
    if (!bucket) continue;
    // 身份键：真机实测（训练模式 2026-11-18）LCDA 每条事件带全局递增 EventID（每局从 0 重来，
    // 账本随新局重置所以不会跨局撞键）——同局同玩家杀 3 只潮虫的 3 条 HordeKill 字段完全一样，
    // 只有 EventID 能区分，必须优先按它去重；个别来源没有 EventID 时回退字段组合键
    // （同类同 victim 且助攻名单完全一致的重复在真实对局里可忽略）。
    const key = event.EventID != null
      ? 'id:' + String(event.EventID)
      : JSON.stringify([
        event.EventName,
        event.KillerName || null,
        event.VictimName || null,
        event.TurretKilled || null,
        event.DragonType || null,
        Array.isArray(event.AssistingUnitNames) ? event.AssistingUnitNames : null
      ]);
    if (ledger.seen.has(key)) continue;
    ledger.seen.add(key);
    let side = sideOfKiller(event.KillerName);
    if (!side && event.EventName === 'TurretKilled') side = sideFromTurretName(event.TurretKilled);
    if (side) ledger.totals[side][bucket] += 1;
    // 元素龙类型随击杀事件记录，HUD 按类型渲染对应元素 sigil（LCU DragonKill 事件自带 DragonType）。
    if (side && bucket === 'dragons' && event.DragonType) ledger.totals[side].dragonTypes.push(String(event.DragonType));
  }
  return {
    blue: { ...ledger.totals.blue, dragonTypes: [...ledger.totals.blue.dragonTypes] },
    red: { ...ledger.totals.red, dragonTypes: [...ledger.totals.red.dragonTypes] }
  };
}

function normalizeLiveState(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const gameData = payload.gameData && typeof payload.gameData === 'object' ? payload.gameData : {};
  const isAram = isAramGame(gameData);
  const itemIndex = options.itemIndex || defaultItemIndex;
  // 协议流解码器（t16）的逐玩家精确字段入口；未接入时传 null，全部降级到 Live Client Data。
  const protocolFor = typeof options.protocol === 'function' ? options.protocol : null;
  const players = Array.isArray(payload.allPlayers)
    ? payload.allPlayers.map(player => normalizePlayer(player, { isAram, itemIndex, protocol: protocolFor })).filter(Boolean)
    : [];
  if (!players.length) return null;
  const sideByChampion = new Map();
  // 事件里的 KillerName 是英雄名；部分队列会给召唤师名，两个都登记以防漏算。
  for (const player of players) {
    for (const variant of [player.champion, player.name, stripTag(player.name)].filter(Boolean)) {
      sideByChampion.set(variant, player.team);
      sideByChampion.set(String(variant).toLowerCase(), player.team);
    }
  }
  const events = readEvents(payload);
  // 传入 ledger（main.js 跨轮询持有、新局重置）就走增量累计；不传保持旧的窗口全量计数（测试兼容）。
  const objectives = options.objectiveLedger
    ? accumulateObjectives(options.objectiveLedger, events, sideByChampion)
    : countObjectives(events, sideByChampion);
  const sum = side => players.filter(p => p.team === side).reduce((total, p) => total + p.kills, 0);
  // 只要有一名玩家拿到协议流精确字段就算解码可用；全都没有就是 false，调用方必须显式降级。
  const protocolDecode = players.some(player => player.csExact !== null || player.totalGold !== null || player.xp !== null);
  // 逐字段 presence：协议流本轮真正解出的字段才允许在 capability 里标 exact。
  // 不能用 protocolDecode 一个布尔值把 cs/gold/xp 一起升级——全队 cs 都是 null 时那样会伪造精确补刀。
  const strongest = key => {
    const tiers = players.map(player => player[key]);
    if (tiers.includes('exact')) return 'exact';
    if (tiers.includes('quantized')) return 'quantized';
    return null;
  };
  const goldTier = strongest('totalGoldPrecision');
  const xpTier = strongest('xpPrecision');
  const protocolFields = {
    cs: players.some(player => player.csExact !== null),
    // gold/xp 是「有值就存在」，另带精度档：quantized 时 capability 只能标量化值。
    gold: players.some(player => player.totalGold !== null),
    xp: players.some(player => player.xp !== null),
    goldPrecision: goldTier,
    xpPrecision: xpTier
  };
  // 数据可用性矩阵：页面按它决定画不画、按什么精度标（exact/quantized/estimated/unavailable）。
  // 模式默认 live-spectate（本函数只在 Live Client Data 有数据时才有意义），回放/离线由调用方显式指定。
  // 像素读条（t23）：bars 由同机像素进程经 POST /api/pixel-bars 喂进来，这里按 (team, 行序) 回填。
  // pixelBars 只描述「这一轮读数是否还有效」，绝不参与任何数值推算。
  const pixelBars = options.pixelBars && typeof options.pixelBars === 'object'
    ? {
      active: options.pixelBars.active === true,
      updatedAt: Number.isFinite(Number(options.pixelBars.updatedAt)) ? Number(options.pixelBars.updatedAt) : null,
      stale: options.pixelBars.stale === true
    }
    : { active: false, updatedAt: null, stale: false };
  const pixelBarList = Array.isArray(options.pixelBars && options.pixelBars.bars) ? options.pixelBars.bars : [];
  // 没有有效读数时不调用（保持 normalizePlayer 给出的全 null），避免把旧值带进来。
  if (pixelBars.active && pixelBarList.length) applyBarsToPlayers(players, pixelBarList);
  // 屏幕经济面板 OCR（econ-ocr）：截屏解析出的逐玩家总金币按 (team, 行序) 回填，
  // 稀疏行只覆盖命中的玩家；econOcr 只描述「这一轮解析是否还有效」，绝不参与数值推算。
  const econOcr = options.econOcr && typeof options.econOcr === 'object'
    ? {
      active: options.econOcr.active === true,
      updatedAt: Number.isFinite(Number(options.econOcr.updatedAt)) ? Number(options.econOcr.updatedAt) : null,
      stale: options.econOcr.stale === true
    }
    : { active: false, updatedAt: null, stale: false };
  const econOcrRows = Array.isArray(options.econOcr && options.econOcr.rows) ? options.econOcr.rows : [];
  if (econOcr.active && econOcrRows.length) applyEconOcrToPlayers(players, econOcrRows);
  const capabilityMode = MODES.includes(options.mode) ? options.mode : 'live-spectate';
  // pixelBars 可用时把 hpPercent/resourcePercent 从 unavailable 升为 estimated(source='pixel-bars')；
  // 不可用时保持 unavailable，HUD 会画显式占位（见 src/data-capability.js）。
  // KDA 来源：只要有一名玩家拿到三项齐全的协议流 KDA，就把契约里的 KDA 标成 protocol-feed。
  const protocolKda = players.some(player => player.kdaExact !== null && player.kdaExact !== undefined);
  const capability = buildCapabilityMatrix(capabilityMode, {
    ...(options.capabilitySources || {}),
    protocolDecode,
    protocolFields,
    protocolKda,
    pixelBars: pixelBars.active === true,
    econOcr: econOcr.active === true
  });
  return {
    gameTime: Number(gameData.gameTime) || 0,
    gameId: gameData.gameId || payload.gameId || null,
    gameMode: gameData.gameMode || '',
    isAram,
    mapName: gameData.mapName || '',
    players,
    blue: { score: sum('blue'), towers: objectives.blue.towers, dragons: objectives.blue.dragons, barons: objectives.blue.barons, heralds: objectives.blue.heralds, grubs: objectives.blue.grubs, dragonTypes: objectives.blue.dragonTypes },
    red: { score: sum('red'), towers: objectives.red.towers, dragons: objectives.red.dragons, barons: objectives.red.barons, heralds: objectives.red.heralds, grubs: objectives.red.grubs, dragonTypes: objectives.red.dragonTypes },
    eventCount: events.length,
    lastEvent: events.length ? events[events.length - 1] : null,
    activePlayer: payload.activePlayer || null,
    // 转播注记（非 LCU 标准字段，由假 LCDA/转播台注入）：下一只元素龙类型与大龙 buff 状态。
    nextDragonType: typeof payload.nextDragonType === 'string' && payload.nextDragonType ? payload.nextDragonType : null,
    nextDragonSpawnAt: Number.isFinite(Number(payload.nextDragonSpawnAt)) ? Number(payload.nextDragonSpawnAt) : null,
    baronBuff: payload.baronBuff && typeof payload.baronBuff === 'object' && (payload.baronBuff.side === 'blue' || payload.baronBuff.side === 'red') && Number.isFinite(Number(payload.baronBuff.startedAt))
      ? { side: payload.baronBuff.side, startedAt: Number(payload.baronBuff.startedAt), goldDiffEarned: Number(payload.baronBuff.goldDiffEarned) || 0 }
      : null,
    elderBuff: payload.elderBuff && typeof payload.elderBuff === 'object' && (payload.elderBuff.side === 'blue' || payload.elderBuff.side === 'red') && Number.isFinite(Number(payload.elderBuff.startedAt))
      ? { side: payload.elderBuff.side, startedAt: Number(payload.elderBuff.startedAt), goldDiffEarned: Number(payload.elderBuff.goldDiffEarned) || 0 }
      : null,
    protocolDecode,
    capability,
    pixelBars,
    econOcr
  };
}

// LCU 连接发现缓存：正常复用；请求失败时 invalidate() 立即失效，下一轮（约 1.2s）重新发现；
// 只有发现本身失败才进入 4 秒退避，避免反复拉起 PowerShell。纯逻辑，可注入时钟与发现函数。
function createLcuConnectionManager(options = {}) {
  const discover = options.discover;
  if (typeof discover !== 'function') throw new TypeError('createLcuConnectionManager requires a discover function');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const backoffMs = Number.isFinite(Number(options.backoffMs)) ? Number(options.backoffMs) : 4000;
  let cached = null;
  let blockedUntil = 0;
  let pending = null;
  let discoveries = 0;

  async function get(force = false) {
    if (cached && !force) return cached;
    if (!force && now() < blockedUntil) return null;
    if (pending) return pending;
    discoveries += 1;
    pending = (async () => {
      try {
        const connection = await discover();
        cached = connection || null;
        if (!cached) blockedUntil = now() + backoffMs;
        return cached;
      } catch (error) {
        cached = null;
        blockedUntil = now() + backoffMs;
        return null;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  function invalidate() {
    cached = null;
    blockedUntil = 0;
  }

  return {
    get,
    invalidate,
    get cached() { return cached; },
    get discoveries() { return discoveries; },
    get blockedUntil() { return blockedUntil; }
  };
}

// Live Client Data（:2999）断流兜底：连续失败 5 秒，且本局在游戏内已超过 60 秒
// （或最后已知 gameTime 已超过 60 秒）时，允许调用方用 frozenSnapshot 进入 post_game。
function createLiveClientWatchdog(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const failureAfterMs = Number.isFinite(Number(options.failureAfterMs)) ? Number(options.failureAfterMs) : 5000;
  const minInGameMs = Number.isFinite(Number(options.minInGameMs)) ? Number(options.minInGameMs) : 60000;
  let failureSince = null;
  let inGameSince = null;
  let maxGameTime = 0;

  function success(gameTime) {
    if (inGameSince === null) inGameSince = now();
    const time = Number(gameTime);
    if (Number.isFinite(time) && time > maxGameTime) maxGameTime = time;
    failureSince = null;
  }
  function failure(gameTime) {
    if (inGameSince === null) return false;
    const time = Number(gameTime);
    if (Number.isFinite(time) && time > maxGameTime) maxGameTime = time;
    if (failureSince === null) failureSince = now();
    return now() - failureSince >= failureAfterMs &&
      (now() - inGameSince >= minInGameMs || maxGameTime >= 60);
  }
  function reset() { failureSince = null; inGameSince = null; maxGameTime = 0; }

  return {
    success,
    failure,
    reset,
    get failureSince() { return failureSince; },
    get inGameSince() { return inGameSince; },
    get maxGameTime() { return maxGameTime; }
  };
}

module.exports = {
  normalizeLiveState, normalizePlayer, normalizeItemEntry, normalizeRunes, spellIdOf, protocolFields,
  countObjectives, createObjectiveLedger, accumulateObjectives, sideOf, stripTag, readEvents, isAramGame,
  createLcuConnectionManager, createLiveClientWatchdog,
  estimateTeamGold, buildItemIndex, loadItemIndex, readItemCache, writeItemCache,
  ITEM_CACHE_DIR, ITEM_CACHE_TTL, GOLD_WEIGHTS
};
