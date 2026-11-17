'use strict';

// 局内 HUD 广播页（参考图 2 复刻）。旧 /overlay/ingame-top 与 /overlay/ingame-bottom 保留不动。
// public/hud-broadcast.css 与 public/anim.js 由本模块内联注入，避免增加静态路由。
// PAGE_SCRIPT 用模板字符串保存（页面脚本内无反引号、无 ${），保留真实换行以便逐行维护。
const fs = require('fs');
const path = require('path');
const { htmlShell } = require('./html');
const assets = require('../assets');

let cssCache = null;
let cssCacheMtime = 0;
function hudCss() {
  // dev 直跑时 css 会被反复改：按 mtime 失效缓存，文件变了就重读。
  let mtime = 0;
  try { mtime = fs.statSync(path.join(__dirname, '..', '..', 'public', 'hud-broadcast.css')).mtimeMs; } catch { mtime = 0; }
  if (cssCache === null || mtime !== cssCacheMtime) {
    try { cssCache = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'hud-broadcast.css'), 'utf8'); }
    catch { cssCache = ''; }
    cssCacheMtime = mtime;
  }
  return cssCache;
}

// 资源条规格：data/resource-bar-spec.json 在 Node 侧压缩成页面脚本内联的小表
// （{ champId: { cls, color, gating, states } }），页面脚本不读文件、不发请求。
// 缺文件或解析失败时返回 {}，页面脚本会退回 A 类默认（法力蓝），绝不整页崩掉。
let specCache = null;
function resourceSpecScript() {
  if (specCache !== null) return specCache;
  let table = {};
  try {
    const file = path.join(__dirname, '..', '..', 'data', 'resource-bar-spec.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const champions = raw && raw.champions && typeof raw.champions === 'object' ? raw.champions : {};
    for (const [champId, entry] of Object.entries(champions)) {
      if (!entry || typeof entry !== 'object') continue;
      const states = Array.isArray(entry.colorStates)
        ? entry.colorStates.map((s) => [Number(s.min) || 0, Number(s.max) || 0, String(s.color || '')])
        : null;
      // 刻度线只取 wiki 明确写成「危险区分界」（label = danger-zone）的阈值 —— 目前只有 Rumble
      //（热量上限 150，50 = 危险区）。Renekton 的 empowered 阈值没有原生刻度线，按 captain 要求不画。
      // 判定完全走数据字段，页面脚本里不写死任何英雄名。
      const ticks = Array.isArray(entry.thresholds)
        ? entry.thresholds
          .filter((t) => t && t.label === 'danger-zone')
          .map((t) => Number(t.at) || 0)
          .filter((n) => n > 0)
        : [];
      table[champId] = {
        cls: String(entry.class || 'A'),
        color: entry.barColor ? String(entry.barColor) : null,
        gating: String(entry.gating || 'always'),
        states: states && states.length ? states : null,
        // resourceMax 驱动「分段条」判定（Rengar 残暴 4 层）与刻度线位置换算。
        max: Number(entry.resourceMax) > 0 ? Number(entry.resourceMax) : 0,
        ticks: ticks.length ? ticks : null,
        // Kled 有两条血条（本人 + Skarl），像素读条只返回单条 → 生命条 title 必须写明未合并。
        hpNote: typeof entry.note === 'string' && entry.note.indexOf('两条血条') >= 0
          ? '像素读条只返回单条，Skarl 未合并（unverified）'
          : '',
      };
    }
  } catch {
    table = {};
  }
  // JSON.stringify 的结果只有 ASCII 引号与方括号，可安全内联进页面脚本。
  specCache = JSON.stringify(table);
  return specCache;
}

let animCache = null;
function animationJs() {
  if (animCache === null) {
    try { animCache = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'anim.js'), 'utf8'); }
    catch { animCache = ''; }
  }
  return animCache;
}

const PAGE_SCRIPT = String.raw`(function hudScript() {
  'use strict';
  var ROOT = document.getElementById('hud-broadcast');
  if (!ROOT) return;
  try { document.body.classList.add('hb-body'); } catch (error) {}
  try { if (document.documentElement) document.documentElement.classList.add('hb-html'); } catch (error) {}
  var RB = window.RBAssets || {};
  var A = window.RBAnim || {};
  var state = null;
  var config = null;
  var lastRosterKey = '';
  var lastGameTime = null;
  var lastCueSeq = null;
  var introPlayed = false;
  var timerTrack = { lastTime: null, stage: 'grubs', grubs: null, heralds: null, barons: null, baronAt: 1200, dragonAt: 300, dragons: null, soul: false, elderAt: null };
  var ROLE_CN = { TOP: '上单', JUNGLE: '打野', MID: '中单', MIDDLE: '中单', ADC: '下路', BOTTOM: '下路', SUPPORT: '辅助', UTILITY: '辅助' };
  var ROLE_ORDER = { TOP: 0, JUNGLE: 1, MID: 2, MIDDLE: 2, ADC: 3, BOTTOM: 3, SUPPORT: 4, UTILITY: 4 };
  var PHASE_CN = { lobby: '等待开局', draft: 'BP', in_game: '进行中', post_game: '赛后' };
  var OBJ_DEFS = [['towers', '塔', 'TOWER'], ['dragons', '龙', 'DRAGON'], ['barons', '男爵', 'BARON'], ['heralds', '先锋', 'HERALD']];
// 顶部栏/目标图标（内联 SVG，参考原生观战记分板的图标标识；fill=currentColor 跟随槽位颜色）。
var ICONS = {
  kills: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 3l4.1.9 8.6 8.6-2.8 2.8L4.3 6.7 3 3zm18 0l-4.1.9-8.6 8.6 2.8 2.8 8.6-8.6L21 3zM6.6 16l1.4 1.4 1.4-1.4 1.4 1.4-1.4 1.4 1.1 1.1-1.4 1.4-1.1-1.1-1.1 1.1-1.4-1.4 1.1-1.1-1.1-1.1L6.6 16zm10.8 0l1.4 1.4 1.4-1.4 1.4 1.4-1.4 1.4 1.1 1.1-1.4 1.4-1.1-1.1-1.1 1.1-1.4-1.4 1.1-1.1-1.1-1.1 1.4-1.4z"/></svg>',
  gold: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="3.6" fill="currentColor"/></svg>',
  towers: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6.5 3h3v2.2h1.6V3h1.8v2.2h1.6V3h3v4.6l-1.5 1.7v5.2l2.8 6.5H5.2L8 14.5V9.3L6.5 7.6V3z"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 7.2v5l3.4 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  dragons: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M21 6l-3.8-1.9c-2.2-1-5.2-.6-7 1C7 8 5.5 11 5.5 14c0 2 .6 3.8 1.6 5.3l1.9-1.8 1.2 2.8 1.7-2.5 1.5 2.6c4-.7 7.1-4 7.1-8.2 0-1.4-.3-2.7-.9-3.9L21 6z"/></svg>',
  barons: '<svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M12 3.5c4.6 0 8.3 3.4 8.3 7.7 0 2.5-1.2 4.7-3.1 6.1l.9 3.2-3.3-1.6c-.9.2-1.8.3-2.8.3s-1.9-.1-2.8-.3L6 20.5l.9-3.2C5 15.9 3.7 13.7 3.7 11.2 3.7 6.9 7.4 3.5 12 3.5zm-3.1 6.7a1.4 1.4 0 110 2.8 1.4 1.4 0 010-2.8zm6.2 0a1.4 1.4 0 110 2.8 1.4 1.4 0 010-2.8z"/></svg>',
  heralds: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M13.5 4.5c3.3 0 6 2.9 6 6.5 0 3.8-2.8 6.9-6.4 6.9-.5 0-1-.1-1.5-.2l.7 2.3-2.2-1.1-.6.2-1.9.9.6-2.2C6 16.7 7.5 14.6 7.5 12c0-.5 0-1 .1-1.4L5.3 8.2l2.9.5C9.3 6.2 11.2 4.5 13.5 4.5z"/></svg>'
};
  function SIGIL(key) { return '<img src="/assets/objectives/score-' + key + '.png" alt="" draggable="false">'; }
  var DEMO_NAME = 'DEMO · 待选手数据';
  // 资源条规格（由 data/resource-bar-spec.json 在 Node 侧压缩后注入）：
  //   { champId: { cls: 'A'|'B'|'C'|'D', color: '#rrggbb'|null, gating: 'always'|'r-active'|..., states: [[min,max,color]]|null } }
  // 缺省（未列入）= A 类固定法力蓝 #3b7fd4 / always。绝不在这里写死英雄列表。
  // 占位符由 Node 侧注入（data/resource-bar-spec.json）。未注入时 typeof 不会抛错，
  // 退回 A 类默认（resourceSpecFor 的兜底分支），页面绝不能因为缺注入整页脚本崩掉。
  var RESOURCE_SPEC = (typeof __RESOURCE_SPEC__ === 'undefined') ? null : __RESOURCE_SPEC__;
  // 标准等级经验阈值（1→18），用于把协议流 xp 归一化成经验条进度。
  var XP_TABLE = [0, 0, 280, 660, 1140, 1720, 2400, 3180, 4060, 5040, 6120, 7300, 8580, 9960, 11440, 13020, 14700, 16480, 18380];
  // 像素读条满宽（@1920x1080：spec 记 51px @2560x1440 × 0.75），只用于把 shieldPx 折算成叠加段宽度。
  var PIXEL_BAR_FULL_PX = 38;
  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function num(value) { var n = Number(value); return Number.isFinite(n) ? n : 0; }
  function hasNumber(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
  function text(value, fallback) { var result = value === null || value === undefined ? '' : String(value).trim(); return result || (fallback === undefined ? '' : fallback); }
  function byId(id) { return document.getElementById(id); }
  function setText(id, value) { var node = byId(id); if (node) node.textContent = value === null || value === undefined ? '' : String(value); }
  // SSE 每 ~1s 推一帧，但内容大多没变：innerHTML 直接重写会重建 <img>（英雄/符文/召唤师技能/赞助商 logo），
  // OBS 里表现为整层「一闪一闪」。带缓存的 setHtml：内容串没变就跳过，DOM 与图片保持驻留。
  function setHtml(node, html) {
    if (!node) return;
    if (node.__hbHtml === html) return;
    node.__hbHtml = html;
    node.innerHTML = html;
  }
  function fmtTime(seconds) {
    var total = Math.max(0, Math.round(num(seconds)));
    var minutes = Math.floor(total / 60);
    return (minutes < 10 ? '0' : '') + minutes + ':' + (total % 60 < 10 ? '0' : '') + (total % 60);
  }
  function fmtGold(value) {
    if (!hasNumber(value)) return '—';
    var n = num(value);
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(Math.round(n));
  }
  function fmtDiff(value) { if (!hasNumber(value)) return '—'; var n = num(value); return (n > 0 ? '+' : n < 0 ? '-' : '') + fmtGold(Math.abs(n)); }
  // 对位经济差用原生记分板口径：不带符号、不带 K 的整数，领先方向由旗标表达。
  function fmtDiffAbs(value) { if (!hasNumber(value)) return '—'; return fmtGold(Math.abs(num(value))); }
  function kda(player) { return player ? num(player.kills) + '/' + num(player.deaths) + '/' + num(player.assists) : '—'; }
  function sideName(side) { return side === 'red' ? '红方' : '蓝方'; }
  function pickValue(source, keys) {
    if (!source || typeof source !== 'object') return null;
    for (var i = 0; i < keys.length; i += 1) {
      var value = source[keys[i]];
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return null;
  }
  function configTeam(side) { return config && config.teams && config.teams[side] ? config.teams[side] : {}; }
  function scoreFromPlayers(source, side) {
    if (!source || !Array.isArray(source.players)) return 0;
    return source.players.filter(function (player) { return player && player.team === side; }).reduce(function (total, player) { return total + num(player.kills); }, 0);
  }
  function scoreOf(source, side) { if (!source) return 0; var team = source[side] || {}; return hasNumber(team.score) ? num(team.score) : scoreFromPlayers(source, side); }
  function teamInfo(side) {
    var team = configTeam(side);
    var live = state && state[side] && typeof state[side] === 'object' ? state[side] : {};
    var score = hasNumber(live.score) ? num(live.score) : scoreFromPlayers(state, side);
    return {
      name: text(team.name, text(live.name, sideName(side))), shortName: text(team.shortName, text(live.short, side === 'blue' ? 'BLUE' : 'RED')),
      region: text(team.region, ''), rank: text(team.rank, ''), logo: text(team.logo, text(live.logo, '')),
      color: text(team.color, side === 'blue' ? '#3b82f6' : '#ef4444'), score: score,
      gold: hasNumber(live.gold) ? num(live.gold) : null, towers: num(live.towers), dragons: num(live.dragons), barons: num(live.barons), heralds: num(live.heralds), grubs: num(live.grubs),
      dragonTypes: Array.isArray(live.dragonTypes) ? live.dragonTypes : []
    };
  }
  function logoMarkup(team, side) {
    var initial = text(team.shortName, side === 'blue' ? 'B' : 'R').slice(0, 1).toUpperCase();
    var html = '<span class="hb-logo-fb">' + esc(initial) + '</span>';
    if (team.logo) html += '<img src="' + esc(team.logo) + '" alt="" loading="lazy" onerror="this.remove()">';
    return html;
  }
  function icon(kind, value, label, className) {
    if (RB.icon) return RB.icon(kind, value, label, className || '', RB.version);
    var fallback = String(value === null || value === undefined ? '?' : value).slice(0, 1);
    return '<span class="icon ' + esc(kind) + '-icon ' + esc(className || '') + '"><i class="icon-fb">' + esc(fallback) + '</i></span>';
  }
  function configPlayerFor(side, player) {
    var list = config && Array.isArray(config.players) ? config.players : [];
    for (var i = 0; i < list.length; i += 1) {
      if (!list[i] || list[i].team !== side) continue;
      if (text(list[i].gameName, '') === text(player && player.name, '')) return list[i];
      if (text(list[i].displayName, '') === text(player && player.name, '')) return list[i];
    }
    return null;
  }
  // 观战模式实测（C:/Temp/live_all.json）：LCDA 的 position 恒为字符串 "NONE"，
  // 既不是地图坐标也不是 TOP/JUNGLE/MID/ADC/SUPPORT；"ORDER"/"CHAOS"/纯数字 同样不是分路。
  // 这类值一律归一化为「未知」，绝不按 CS 高低之类去猜分路（那是伪造）。
  function normalizeRole(value) {
    var role = String(value === null || value === undefined ? '' : value).trim();
    if (!role) return '';
    var upper = role.toUpperCase();
    if (upper === 'NONE' || upper === 'ORDER' || upper === 'CHAOS' || upper === 'INVALID') return '';
    if (/^[0-9.+-]+$/.test(role)) return '';
    return role;
  }
  function playerRole(player) {
    var role = normalizeRole(player && player.position);
    if (!role) role = normalizeRole(player && player.role);
    if (!role && player) { var matched = configPlayerFor(player.team, player); if (matched) role = normalizeRole(matched.role); }
    return role;
  }
  // 分路未知时退回英雄名（不再把 "NONE" 之类的原始值显示出来）。
  function playerRoleLabel(player) { var role = playerRole(player); return ROLE_CN[String(role).toUpperCase()] || role || text(player && player.champion, '—'); }
  function placeholderPlayer() {
    return { name: DEMO_NAME, champion: '', level: null, kills: 0, deaths: 0, assists: 0, cs: null, wardScore: null, items: [], summoners: [], role: '', photo: '', placeholder: true, demo: true };
  }
  function playerList(side) {
    var live = state && Array.isArray(state.players) ? state.players.filter(function (player) { return player && player.team === side; }) : [];
    var configured = config && Array.isArray(config.players) ? config.players.filter(function (player) { return player && player.team === side; }) : [];
    var liveMode = !!(state && state.mode === 'live');
    if (liveMode && !live.length) {
      var demo = [];
      for (var d = 0; d < 5; d += 1) demo.push(placeholderPlayer());
      return demo;
    }
    var list = live.slice(0, 5).map(function (player) {
      var matched = configPlayerFor(side, player);
      if (!matched) return player;
      return Object.assign({}, player, { name: text(matched.displayName, text(matched.gameName, text(player.name, '—'))), displayName: text(matched.displayName, text(matched.gameName, '')), photo: text(matched.photo, text(player.photo, '')), role: normalizeRole(player.position) || normalizeRole(player.role) || normalizeRole(matched.role) });
    });
    for (var i = list.length; i < 5; i += 1) {
      if (liveMode) { list.push(placeholderPlayer()); continue; }
      var source = configured[i] || {};
      list.push({ name: text(source.displayName, text(source.gameName, '—')), champion: '', level: null, kills: 0, deaths: 0, assists: 0, cs: null, wardScore: null, items: [], summoners: [], role: normalizeRole(source.role), photo: text(source.photo, ''), placeholder: true });
    }
    return list.slice(0, 5).sort(function (a, b) {
      var ai = ROLE_ORDER[String(playerRole(a)).toUpperCase()]; var bi = ROLE_ORDER[String(playerRole(b)).toUpperCase()];
      if (ai === undefined) ai = 9; if (bi === undefined) bi = 9; return ai - bi;
    });
  }
  function playerDisplayName(player) {
    if (!player) return '—';
    var raw = text(player && player.name, text(player && player.displayName, '—'));
    // 新 Riot ID 体系下 summonerName/riotId 形如「名字#30820」：展示层只留名字，#tag 不上屏。
    var hash = raw.lastIndexOf('#');
    if (hash > 0 && /^[A-Za-z0-9]{1,6}$/.test(raw.slice(hash + 1))) raw = raw.slice(0, hash);
    return raw;
  }
  // ---- 装备：同时兼容旧字符串与 t9 之后的 {itemID,count,slot,price} 对象 ----
  // 装备条目统一成 { value, id, count, slot, price, name }：装备图标已交给原生 HUD（挖孔），
  // 这里只保留「有几件、值多少钱、落在哪格」用于算挖孔宽度与对位经济差，不再自绘图标。
  function itemEntry(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'string') {
      return { value: raw, id: RB.itemId ? RB.itemId(raw) : null, count: 0, slot: null, price: 0, name: raw };
    }
    if (typeof raw !== 'object') return null;
    var rawId = raw.itemID !== undefined && raw.itemID !== null ? raw.itemID : (raw.itemId !== undefined && raw.itemId !== null ? raw.itemId : raw.id);
    var name = text(raw.displayName, text(raw.name, ''));
    var value = rawId !== undefined && rawId !== null && rawId !== '' ? rawId : name;
    if (value === '' || value === null || value === undefined) return null;
    var count = Math.floor(num(raw.count));
    return {
      value: value,
      id: RB.itemId ? RB.itemId(value) : null,
      count: count > 1 ? count : 0,
      slot: hasNumber(raw.slot) ? num(raw.slot) : null,
      price: Math.max(0, num(raw.price)),
      name: name
    };
  }
  function playerItems(player) {
    var source = player && Array.isArray(player.items) ? player.items : [];
    var slots = [null, null, null, null, null, null, null];
    var sequential = 0;
    for (var i = 0; i < source.length; i += 1) {
      var entry = itemEntry(source[i]);
      if (!entry) continue;
      if (entry.slot !== null && entry.slot >= 0 && entry.slot <= 6) { if (!slots[entry.slot]) slots[entry.slot] = entry; continue; }
      while (sequential < 6 && slots[sequential]) sequential += 1;
      if (sequential < 6) { slots[sequential] = entry; sequential += 1; }
      else if (!slots[6]) slots[6] = entry;
    }
    return slots;
  }
  function demoMode() { return !(state && state.mode === 'live'); }
  // ---- 数据可用性契约（t20）：state.capability 由 src/data-capability.js 生成 ----
  // 没有契约（mock 演示、老快照）时一律按老逻辑走；有契约时只有 available 且非 unavailable 才画数值，
  // quantized 必须带 ≈ 与量子步长提示，estimated 必须带「估算」，绝不把量化/估算值当精确值。
  function capability() { return state && state.capability && typeof state.capability === 'object' ? state.capability : null; }
  function capEntry(key) { var matrix = capability(); return matrix && matrix.fields && matrix.fields[key] ? matrix.fields[key] : null; }
  function capPrecision(key) { var entry = capEntry(key); return entry ? entry.precision : null; }
  function capUsable(key) { var entry = capEntry(key); return entry ? entry.available === true && entry.precision !== 'unavailable' : true; }
  function capClass(key) { return capUsable(key) ? '' : ' unknown'; }
  function capTitle(key, label) {
    var entry = capEntry(key);
    if (!entry) return label;
    if (entry.precision === 'quantized') return label + '（量化值 ≈' + entry.quantum + '，不是精确值）';
    if (entry.precision === 'estimated') return label + '（估算）';
    if (entry.precision === 'unavailable') return label + '：' + text(entry.reason, '当前数据源未提供');
    return label;
  }
  // CS：优先用协议流解码出的精确值 csExact（t9 已输出、t16 解码器接入）；
  // 没有精确值时才退回 LCDA creepScore —— 它是 floor(exact/10)*10，必须标「≈ 量化」，
  // 绝不把 70 当 76 冒充精确值。两者都没有就显示 —。
  function csMarkup(player) {
    if (!player) return '—';
    if (hasNumber(player.csExact) && capUsable('csExact')) return String(num(player.csExact));
    if (!capUsable('cs') || !hasNumber(player.cs)) return '—';
    // 只有 quantized 才加 ≈；estimated（回放 timeline 插值）按估算原值展示，不能借 ≈ 混同两种精度。
    return capPrecision('cs') === 'quantized' ? '≈' + num(player.cs) : String(num(player.cs));
  }
  function csTitle(player) {
    if (player && hasNumber(player.csExact) && capUsable('csExact')) return 'CS（协议流解码精确值）';
    if (capPrecision('cs') === 'estimated') return 'CS（估算值：回放 timeline 插值，不是精确补刀）';
    if (capPrecision('cs') === 'quantized') return 'CS（LCDA creepScore 量化值：向下取整到 10，不是精确补刀）';
    return 'CS';
  }
  function kdaOf(player) { return capUsable('kills') ? kda(player) : '—'; }
  function demoItemAt(index, globalIndex) {
    var sets = RB.demoItems || [];
    if (!sets.length) return null;
    var set = sets[Math.abs(globalIndex) % sets.length] || [];
    var value = set[index] === undefined ? null : set[index];
    // DEMO_ITEM_SETS 存的是纯 itemID 数字，而 itemEntry 只认字符串/对象（数字返回 null），
    // 这里包一层对象让饰品槽（第 7 位）也能被 playerItemSlots 正确填充。
    // 演示里给守卫一个 ×2 堆叠，让自绘模式的数量角标有东西可看。
    if (typeof value === 'number') return { itemID: value, count: value === 2055 ? 2 : 1 };
    return value;
  }
  // ---- 原生装备栏 / 饰品栏「挖孔」（?hbNativeItems=1 才启用） ----
  // 挖孔模式下装备图标与饰品槽由游戏原生 HUD 自己绘制（自带层数角标、冷却转圈、可主动高亮），我们一格都不画；
  // 只按 items 的数量算出原生栏位占多宽，把那块底色挖成透明孔让原生透出来。默认走自绘装备栏。
  // 孔位几何全部走 CSS 变量（.hb-bottom 里的 --hb-native-*），也可用 URL query 现场覆盖：
  //   ?hbNativeItemPitch=24.4&hbNativeBlueX=672&hbNativeRedX=1117&hbNativeRow1Y=846&hbDebugHoles=1
  var QUERY_VARS = {
    hbNativeItemSize: '--hb-native-item-size', hbNativeItemPitch: '--hb-native-item-pitch',
    hbNativeRowPitch: '--hb-native-row-pitch', hbNativeBlueX: '--hb-native-blue-x',
    hbNativeRedX: '--hb-native-red-x', hbNativeRow1Y: '--hb-native-row1-y',
    hbNativeTrinketBlueX: '--hb-native-trinket-blue-x', hbNativeTrinketRedX: '--hb-native-trinket-red-x'
  };
  // 默认值 = 用户实机 1920x1080 原生观战截图逐像素实测（2026-11-15，见 holeRects 处注释）：
  // 装备带蓝 643-794 / 红 1140-1291（6 格 pitch 25.6、图标 24px），行中心 876.5 + 43.4×i，
  // 饰品蓝框 612-642 / 红框 1294-1320。旧值（2560x1440×0.75 标定）与实机 UI 缩放不符，
  // 会导致挖孔整体偏移（蓝左列/红右列被面板盖住）——如需微调用 /broadcast/hud-calibrate 写 hud-calib.json。
  var NATIVE_DEFAULTS = { size: 24, pitch: 25.6, rowPitch: 43.4, row1Y: 876.5, blueX: 643, redX: 1140, trinketBlueX: 619, trinketRedX: 1294 };
  // 运行时标定（data/hud-calib.json，经 /api/hud-calib 读取）：优先级 query > 文件值 > 内置默认。
  // 文件不存在或字段不合法时 CALIB 保持 null，行为与引入标定前完全一致。
  var CALIB = null;
  // 每行纵向微调（来自 /api/hud-calib 的 rowOffsets）；默认全 0，保证无文件时行为不变。
  var ROW_OFFSETS = [0, 0, 0, 0, 0];
  var CALIB_KEYS = {
    '--hb-native-item-size': 'itemSize', '--hb-native-item-pitch': 'itemPitch',
    '--hb-native-row-pitch': 'rowPitch', '--hb-native-row1-y': 'row1CenterY',
    '--hb-native-blue-x': 'blueX', '--hb-native-red-x': 'redX',
    '--hb-native-trinket-blue-x': 'trinketBlueX', '--hb-native-trinket-red-x': 'trinketRedX'
  };
  var QUERY_VALUES = {};
  function searchString() {
    try { return String((window.location && window.location.search) || ''); } catch (error) { return ''; }
  }
  function debugHoles() { return /(?:^|[?&])hbDebugHoles=1(?:&|$)/.test(searchString()); }
  // 1920×1080 是设计基准；底部整块按 min(视口宽/1920, 视口高/1080) 等比缩放。
  // 这样 1366×768 只是 1920 的缩略图，不会出现「行高缩了字没缩」的错位。
  var HB_SCALE = 1;
  function syncScale() {
    var stage = byId('hb-bottom-stage');
    if (!stage || !stage.style || !stage.style.setProperty) return;
    var width = 0; var height = 0;
    try {
      width = (typeof window !== 'undefined' && window.innerWidth) || 1920;
      height = (typeof window !== 'undefined' && window.innerHeight) || 1080;
    } catch (error) { width = 1920; height = 1080; }
    var scale = Math.min(width / 1920, height / 1080);
    if (!(scale > 0)) scale = 1;
    HB_SCALE = scale;
    stage.style.setProperty('--hb-scale', String(scale));
  }
  // 自绘装备栏是默认（2026-11-17 定案：按 X 呼出的原生经济面板与原生装备栏互斥——
  // 面板一开，原生装备栏整个消失，挖孔必然露出游戏世界）。要回到「透出原生装备栏」的
  // 挖孔模式，用 ?hbNativeItems=1 显式开启（校准/编辑器里的挖孔组仅供该模式使用）。
  function nativeItemsEnabled() { return /(?:^|[?&])hbNativeItems=1(?:&|$)/.test(searchString()); }
  // 符文 / 召唤师技能 / 大招徽记在 40.7px 行高里默认不渲染（塞不下），?hbExtras=1 才开。
  function extrasEnabled() { return /(?:^|[?&])hbExtras=1(?:&|$)/.test(searchString()); }
  function applyQueryOverrides() {
    var node = byId('hb-bottom');
    if (!node || !node.style || !node.style.setProperty) return;
    var search = searchString();
    if (!search) return;
    var pairs = search.replace(/^\?/, '').split('&');
    for (var i = 0; i < pairs.length; i += 1) {
      var eq = pairs[i].indexOf('=');
      if (eq <= 0) continue;
      var name = QUERY_VARS[pairs[i].slice(0, eq)];
      if (!name) continue;
      var value = parseFloat(decodeURIComponent(pairs[i].slice(eq + 1)));
      if (isFinite(value) && value >= 0) { QUERY_VALUES[name] = value; node.style.setProperty(name, value + 'px'); }
    }
  }
  function readPx(name, fallback) {
    // 1) URL query 显式覆盖优先；2) /api/hud-calib 文件值；3) CSS 变量（内置默认/媒体查询）；4) 调用方 fallback。
    if (Object.prototype.hasOwnProperty.call(QUERY_VALUES, name)) return QUERY_VALUES[name];
    if (CALIB && CALIB_KEYS[name] && typeof CALIB[CALIB_KEYS[name]] === 'number') {
      var calibrated = Number(CALIB[CALIB_KEYS[name]]);
      if (isFinite(calibrated)) return calibrated;
    }
    var node = byId('hb-bottom');
    var raw = '';
    try { if (node && window.getComputedStyle) raw = window.getComputedStyle(node).getPropertyValue(name); } catch (error) { raw = ''; }
    var value = parseFloat(raw);
    return isFinite(value) && value > 0 ? value : fallback;
  }
  function nativeGeometry() {
    return {
      size: readPx('--hb-native-item-size', NATIVE_DEFAULTS.size),
      pitch: readPx('--hb-native-item-pitch', NATIVE_DEFAULTS.pitch),
      rowPitch: readPx('--hb-native-row-pitch', NATIVE_DEFAULTS.rowPitch),
      row1Y: readPx('--hb-native-row1-y', NATIVE_DEFAULTS.row1Y),
      blueX: readPx('--hb-native-blue-x', NATIVE_DEFAULTS.blueX),
      redX: readPx('--hb-native-red-x', NATIVE_DEFAULTS.redX),
      trinketBlueX: readPx('--hb-native-trinket-blue-x', NATIVE_DEFAULTS.trinketBlueX),
      trinketRedX: readPx('--hb-native-trinket-red-x', NATIVE_DEFAULTS.trinketRedX),
      rowOffsets: ROW_OFFSETS
    };
  }
  // 读 /api/hud-calib：文件不存在（source=default）时保持内置默认，行为不变；读到 file 值后重算孔位。
  function loadCalibration() {
    if (typeof fetch !== 'function') return;
    fetch('/api/hud-calib', { cache: 'no-store' }).then(function (response) {
      return response && response.ok ? response.json() : null;
    }).then(function (data) {
      if (!data || !data.calibration || typeof data.calibration !== 'object') return;
      CALIB = data.calibration;
      if (Array.isArray(data.rowOffsets) && data.rowOffsets.length === 5) {
        ROW_OFFSETS = data.rowOffsets.map(function (value) {
          return typeof value === 'number' && isFinite(value) ? value : 0;
        });
      }
      // 关键：把标定值同步写进 --hb-native-* CSS 变量。readPx/nativedeometry 会直接读 CALIB，
      // 但 .hb-bottom / .hb-row 的布局（行高、板高等）走的是 CSS 变量——不回写就会变成
      // 「孔用标定 42.75、行用默认 40.7」的混合态：板顶落进首行孔区、行内容整体下漂。
      var bottom = byId('hb-bottom');
      if (bottom && bottom.style && bottom.style.setProperty) {
        for (var key in CALIB_KEYS) {
          // query 覆盖优先级高于标定文件：已被 URL 覆盖的变量不回写。
          if (Object.prototype.hasOwnProperty.call(QUERY_VALUES, key)) continue;
          var value = Number(CALIB[CALIB_KEYS[key]]);
          if (isFinite(value) && value > 0) bottom.style.setProperty(key, value + 'px');
        }
      }
      syncBottomOffset();
      syncHoles();
    }).catch(function () { /* 读不到标定不影响 overlay 正常出图 */ });
  }
  // ---- 布局微调（data/hud-layout.json，经 /api/hud-layout 读写） ----
  // 目的：让用户自己在编辑页里拖位置、改尺寸，而不是每次描述需求等我改代码。
  // 只做「相对微调」——位移 / 宽高 / 缩放 / 字号 / 透明度，写成元素内联样式；
  // 结构、网格、挖孔公式一概不动，所以任何一项归零都能回到出厂布局。
  // 元素清单是唯一事实源：编辑页列表、命中框、保存键全部从这里派生。
  // 元素清单是唯一事实源：编辑页列表、命中框、保存键全部从这里派生。
  // 「满元素」原则——凡是屏幕上看得见的东西，都给它一条可调项；有 id 的用 id（重建后仍稳定），
  // 没有 id 的用「父级限定 + class/nth-child」选择器。动态元素（龙、增益、遮罩文案）可能当帧不存在，
  // 编辑页会把它们灰显，等出现后即可调。
  var LAYOUT_TARGETS = (function () {
    var list = [];
    function add(group, rows) {
      for (var i = 0; i < rows.length; i += 1) {
        list.push({ key: rows[i][0], label: rows[i][1], group: group, sel: rows[i][2] });
      }
    }
    add('顶部 · 容器', [
      ['topbar', '顶部整条', '#hb-topbar'],
      ['demo-badge', 'DEMO 提示徽标', '#hb-demo-badge'],
      ['left-boxes', '左侧两个计时盒', '#hb-topbar .hb-left-boxes'],
      ['scorebar', '比分条', '#hb-scorebar'],
      ['score-cluster', '比分中区', '#hb-scorebar .hb-cluster'],
      ['score-row1', '比分第一行（塔 / 金币 / 击杀）', '#hb-scorebar .hb-row1'],
      ['score-row2', '比分第二行（龙 / 潮虫 / 时钟）', '#hb-scorebar .hb-row2']
    ]);
    add('顶部 · 队标卡', [
      ['badge-blue', '蓝方队标卡', '#hb-scorebar .hb-badge.blue'],
      ['badge-blue-accent', '蓝方 · 侧边竖条', '#hb-scorebar .hb-badge.blue .hb-accent'],
      ['pips-blue', '蓝方 · 小局比分点', '#hb-pips-blue'],
      ['logo-blue', '蓝方 · 队徽', '#hb-logo-blue'],
      ['name-blue', '蓝方 · 队名', '#hb-name-blue'],
      ['meta-blue', '蓝方 · 英文副标', '#hb-meta-blue'],
      ['badge-red', '红方队标卡', '#hb-scorebar .hb-badge.red'],
      ['badge-red-accent', '红方 · 侧边竖条', '#hb-scorebar .hb-badge.red .hb-accent'],
      ['pips-red', '红方 · 小局比分点', '#hb-pips-red'],
      ['logo-red', '红方 · 队徽', '#hb-logo-red'],
      ['name-red', '红方 · 队名', '#hb-name-red'],
      ['meta-red', '红方 · 英文副标', '#hb-meta-red']
    ]);
    add('顶部 · 数据块', [
      ['towers-blue', '蓝方 · 塔（图标+数字）', '#hb-towers-stat-blue'],
      ['towers-blue-icon', '蓝方 · 塔图标', '#hb-towers-stat-blue i'],
      ['towers-blue-num', '蓝方 · 塔数字', '#hb-towers-blue'],
      ['gold-blue', '蓝方 · 金币（图标+数字）', '#hb-goldstat-blue'],
      ['gold-blue-icon', '蓝方 · 金币图标', '#hb-goldstat-blue i'],
      ['gold-blue-num', '蓝方 · 金币数字', '#hb-gold-blue'],
      ['grubs-blue', '蓝方 · 潮虫（图标+数字）', '#hb-grubs-stat-blue'],
      ['grubs-blue-icon', '蓝方 · 潮虫图标', '#hb-grubs-stat-blue i'],
      ['grubs-blue-num', '蓝方 · 潮虫数字', '#hb-grubs-blue'],
      ['kills-blue', '蓝方击杀数', '#hb-kills-blue'],
      ['killicon', '中区击杀图标', '#hb-killicon'],
      ['kills-red', '红方击杀数', '#hb-kills-red'],
      ['gold-red', '红方 · 金币（图标+数字）', '#hb-goldstat-red'],
      ['gold-red-icon', '红方 · 金币图标', '#hb-goldstat-red i'],
      ['gold-red-num', '红方 · 金币数字', '#hb-gold-red'],
      ['towers-red', '红方 · 塔（图标+数字）', '#hb-towers-stat-red'],
      ['towers-red-icon', '红方 · 塔图标', '#hb-towers-stat-red i'],
      ['towers-red-num', '红方 · 塔数字', '#hb-towers-red'],
      ['grubs-red', '红方 · 潮虫（图标+数字）', '#hb-grubs-stat-red'],
      ['grubs-red-icon', '红方 · 潮虫图标', '#hb-grubs-stat-red i'],
      ['grubs-red-num', '红方 · 潮虫数字', '#hb-grubs-red'],
      ['gold-diff', '经济差徽标', '#hb-gold-diff'],
      ['gold-diff-num', '经济差 · 数字', '#hb-gold-diff b'],
      ['clock', '比赛时钟', '#hb-clock'],
      ['stack-blue', '蓝方 · 龙堆', '#hb-stack-blue'],
      ['stack-red', '红方 · 龙堆', '#hb-stack-red'],
      ['timer-phase', '左侧 · 潮虫盒', '#hb-timer-phase'],
      ['timer-phase-icon', '左侧 · 潮虫盒图标', '#hb-timer-phase-icon'],
      ['timer-phase-value', '左侧 · 潮虫盒倒计时', '#hb-timer-phase-value'],
      ['timer-dragon', '左侧 · 小龙盒', '#hb-timer-dragon'],
      ['timer-dragon-icon', '左侧 · 小龙盒图标', '#hb-timer-dragon-icon'],
      ['timer-dragon-value', '左侧 · 小龙盒倒计时', '#hb-timer-dragon-value'],
      ['buff-blue', '左侧 · 蓝方增益卡', '#hb-buff-slot-blue'],
      ['buff-red', '右侧 · 红方增益卡', '#hb-buff-slot-red']
    ]);
    // 一方最多 4 条龙（第 5 条是龙魂/远古龙，不占坑位），逐条单独可调。
    for (var d = 1; d <= 4; d += 1) {
      list.push({ key: 'dragon-blue-' + d, label: '蓝方 · 第 ' + d + ' 条龙图标', group: '顶部 · 龙', sel: '#hb-stack-blue > img:nth-child(' + d + ')' });
      list.push({ key: 'dragon-red-' + d, label: '红方 · 第 ' + d + ' 条龙图标', group: '顶部 · 龙', sel: '#hb-stack-red > img:nth-child(' + d + ')' });
    }
    add('底部 · 容器', [
      ['bottom-stage', '底部整块（含等比缩放）', '#hb-bottom-stage'],
      ['bottom', '底部板体', '#hb-bottom'],
      ['board', '棋盘', '#hb-board'],
      ['board-cover', '棋盘底色', '#hb-board > .hb-board-cover'],
      ['board-foot', '棋盘底缘填边', '#hb-board > .hb-board-foot'],
      ['rows-blue', '蓝方五行容器', '#hb-rows-blue'],
      ['rows-red', '红方五行容器', '#hb-rows-red'],
      ['mid', '中栏（对位经济差）', '#hb-mid'],
      ['cover-left', '左侧对阵信息卡', '#hb-native-cover-left'],
      ['cover-title', '信息卡 · 标题', '#hb-cover-title'],
      ['cover-line-0', '信息卡 · 第 1 行', '#hb-cover-line-0'],
      ['cover-line-1', '信息卡 · 第 2 行', '#hb-cover-line-1'],
      ['cover-line-2', '信息卡 · 第 3 行', '#hb-cover-line-2']
    ]);
    for (var m = 0; m < 5; m += 1) {
      list.push({ key: 'diff-cell-' + m, label: '第 ' + (m + 1) + ' 行 · 经济差格', group: '中栏 · 对位经济差', sel: '#hb-diff-cell-' + m });
      list.push({ key: 'diff-bar-' + m, label: '第 ' + (m + 1) + ' 行 · 领先旗标', group: '中栏 · 对位经济差', sel: '#hb-diff-cell-' + m + ' .hb-diff-bar' });
      list.push({ key: 'diff-num-' + m, label: '第 ' + (m + 1) + ' 行 · 差值数字', group: '中栏 · 对位经济差', sel: '#hb-diff-cell-' + m + ' b' });
    }
    ['blue', 'red'].forEach(function (side) {
      var sideName = side === 'blue' ? '蓝方' : '红方';
      for (var r = 0; r < 5; r += 1) {
        var id = side + '-' + r;
        var who = sideName + '第 ' + (r + 1) + ' 行';
        list.push({ key: 'row-' + id, label: who + ' · 整行（改尺寸会撞挖孔）', group: sideName + ' · 整行', sel: '#hb-row-' + id });
        var kids = [
          ['extras', '符文 / 技能块', '#hb-extras-' + id],
          ['runes', '符文列', '#hb-runes-' + id],
          ['spells', '召唤师技能列', '#hb-spells-' + id],
          ['ult', '大招徽标', '#hb-ult-' + id],
          ['champ', '头像（含等级角标）', '#hb-champ-' + id],
          ['champ-ico', '头像图', '#hb-champ-' + id + ' .hb-champ-ico'],
          ['level', '等级数字', '#hb-level-' + id],
          ['info', '名字块（名 + KDA）', '#hb-info-' + id],
          ['name-line', '名字行', '#hb-info-' + id + ' .hb-name-line'],
          ['pname', '玩家名', '#hb-pname-' + id],
          ['prole', '复活 / 分路小字', '#hb-prole-' + id],
          ['kda', 'KDA', '#hb-kda-' + id],
          ['vision', '视野分', '#hb-vision-' + id],
          ['items', '自绘装备', '#hb-items-' + id],
          ['bars', '三条状态条', '#hb-bars-' + id],
          ['bar-xp', '经验条', '#hb-bars-' + id + ' .hb-bar.xp'],
          ['bar-hp', '生命条', '#hb-bars-' + id + ' .hb-bar.hp'],
          ['bar-res', '资源条', '#hb-bars-' + id + ' .hb-bar.res']
        ];
        // 自绘模式的行内元素单独成组：挖孔模式（?hbNativeItems=1）下装备/视野不渲染，
        // 分成一组让人不会以为面板漏了东西。
        for (var k = 0; k < kids.length; k += 1) {
          var selfDrawn = ['extras', 'runes', 'spells', 'ult', 'vision', 'items'].indexOf(kids[k][0]) >= 0;
          list.push({ key: id + '-' + kids[k][0], label: who + ' · ' + kids[k][1], group: sideName + ' · ' + (selfDrawn ? '行内元素（自绘模式）' : '行内元素'), sel: kids[k][2] });
        }
      }
    });
    // 挖孔：几何只由 holeRects 写，layoutApply 会跳过 hole 目标（单独走位移 / 绝对宽高）。
    ['blue', 'red'].forEach(function (side) {
      var sideName = side === 'blue' ? '蓝方' : '红方';
      for (var r = 0; r < 5; r += 1) {
        list.push({ key: 'hole-' + side + '-' + r + '-items', label: sideName + '第 ' + (r + 1) + ' 行 · 装备栏挖孔', group: '挖孔（透出原生装备栏，?hbNativeItems=1）', sel: '#hb-hole-' + side + '-' + r + '-items', hole: true });
        list.push({ key: 'hole-' + side + '-' + r + '-trinket', label: sideName + '第 ' + (r + 1) + ' 行 · 饰品位挖孔', group: '挖孔（透出原生装备栏，?hbNativeItems=1）', sel: '#hb-hole-' + side + '-' + r + '-trinket', hole: true });
      }
    });
    return list;
  })();

  var LAYOUT_FIELDS = ['dx', 'dy', 'w', 'h', 'scale', 'fontSize', 'opacity'];
  var LAYOUT_ITEMS = null;
  function layoutEditMode() { return /(?:^|[?&])hudEdit=1(?:&|$)/.test(searchString()); }
  function layoutQuery(selector) {
    try { return document.querySelector(selector); } catch (error) { return null; }
  }
  // 首次触碰时把「原厂样式」记下来：transform 可能来自样式表（不是内联），
  // 直接写内联 transform 会把它整个抹掉——所以取一次 computed matrix 当底座。
  function layoutBase(el) {
    if (el.__hbBase) return el.__hbBase;
    var computed = '';
    var display = '';
    try {
      var cs = window.getComputedStyle(el);
      computed = cs.transform || '';
      display = cs.display || '';
    } catch (error) { computed = ''; }
    el.__hbBase = {
      transform: el.style.transform || (computed && computed !== 'none' ? computed : ''),
      width: el.style.width || '', height: el.style.height || '',
      fontSize: el.style.fontSize || '', opacity: el.style.opacity || '',
      position: el.style.position || '', left: el.style.left || '', top: el.style.top || '',
      // 行内盒（<b>/<em> 等）不参与 transform，位移改用相对定位，否则拖了没反应。
      inline: display === 'inline'
    };
    return el.__hbBase;
  }
  // 幂等：同一个 items 反复 apply 的结果一致，所以可以在每次 renderAll 之后重放，
  // 行节点被 ensureRows 重建后也能自动恢复微调。
  function layoutApply(items) {
    if (typeof document === 'undefined') return;
    var source = items && typeof items === 'object' ? items : {};
    for (var i = 0; i < LAYOUT_TARGETS.length; i += 1) {
      var target = LAYOUT_TARGETS[i];
      // 挖孔的几何由 holeRects 直接消费（div + mask 同源），这里绝不写内联样式，
      // 否则会跟 syncHoles 每帧重建的 left/top 打架。
      if (target.hole) continue;
      var el = layoutQuery(target.sel);
      if (!el || !el.style) continue;
      var base = layoutBase(el);
      var item = source[target.key] && typeof source[target.key] === 'object' ? source[target.key] : null;
      var dx = item && hasNumber(item.dx) ? num(item.dx) : 0;
      var dy = item && hasNumber(item.dy) ? num(item.dy) : 0;
      var scale = item && hasNumber(item.scale) ? num(item.scale) : 1;
      if (base.inline) {
        // 行内盒没有 transform 盒子：位移用相对定位（left/top 对行内盒同样有效），
        // 缩放/宽高对行内文本没有意义，交给字号。这样拖名字、拖时钟数字都跟手。
        el.style.transform = base.transform;
        el.style.position = (dx || dy) ? 'relative' : base.position;
        el.style.left = dx ? dx + 'px' : base.left;
        el.style.top = dy ? dy + 'px' : base.top;
      } else {
        var parts = [];
        if (base.transform) parts.push(base.transform);
        if (dx || dy) parts.push('translate(' + dx + 'px,' + dy + 'px)');
        if (scale !== 1) parts.push('scale(' + scale + ')');
        el.style.transform = parts.join(' ');
      }
      el.style.width = item && hasNumber(item.w) && num(item.w) > 0 ? num(item.w) + 'px' : base.width;
      el.style.height = item && hasNumber(item.h) && num(item.h) > 0 ? num(item.h) + 'px' : base.height;
      el.style.fontSize = item && hasNumber(item.fontSize) && num(item.fontSize) > 0 ? num(item.fontSize) + 'px' : base.fontSize;
      el.style.opacity = item && hasNumber(item.opacity) && num(item.opacity) < 1 ? String(num(item.opacity)) : base.opacity;
    }
  }
  function loadLayoutOverrides() {
    return fetchJson('/api/hud-layout').then(function (data) {
      var items = data && data.layout && data.layout.items && typeof data.layout.items === 'object' ? data.layout.items : {};
      LAYOUT_ITEMS = items;
      layoutApply(LAYOUT_ITEMS);
      layoutSyncHolesSoon();
      return LAYOUT_ITEMS;
    }).catch(function () { LAYOUT_ITEMS = {}; return LAYOUT_ITEMS; });
  }
  // 挖孔微调动的是 mask/描边几何：重跑一次 syncHoles（60ms 去抖，拖拽时不必每像素重算 SVG）。
  var holeSyncTimer = null;
  function layoutSyncHolesSoon() {
    if (typeof setTimeout !== 'function') { syncHoles(); return; }
    if (holeSyncTimer) return;
    holeSyncTimer = setTimeout(function () { holeSyncTimer = null; syncHoles(); }, 60);
  }
  function layoutSetItem(key, value) {
    if (!LAYOUT_ITEMS) LAYOUT_ITEMS = {};
    var clean = {};
    if (value && typeof value === 'object') {
      for (var i = 0; i < LAYOUT_FIELDS.length; i += 1) {
        var field = LAYOUT_FIELDS[i];
        if (hasNumber(value[field])) clean[field] = num(value[field]);
      }
    }
    if (Object.keys(clean).length) LAYOUT_ITEMS[key] = clean; else delete LAYOUT_ITEMS[key];
    layoutApply(LAYOUT_ITEMS);
    if (key.indexOf('hole-') === 0) layoutSyncHolesSoon();
  }
  // 编辑层（/assets/hud-layout-edit.js）唯一依赖的桥：清单 + 读写当前值。生产路径不加载它。
  window.__hbLayout = {
    targets: LAYOUT_TARGETS,
    enabled: false,
    items: function () { return LAYOUT_ITEMS ? JSON.parse(JSON.stringify(LAYOUT_ITEMS)) : {}; },
    setItem: layoutSetItem,
    reload: loadLayoutOverrides
  };
  function mountLayoutEditor() {
    if (!layoutEditMode() || typeof document === 'undefined') return;
    if (window.HBLayoutEdit) { window.HBLayoutEdit.mount(); return; }
    var script = document.createElement('script');
    // 带个版本参数：/assets/* 是 public,max-age=86400，不加会很自然地跑昨天那份旧编辑层。
    script.src = '/assets/hud-layout-edit.js?v=' + Date.now();
    script.onload = function () { if (window.HBLayoutEdit) window.HBLayoutEdit.mount(); };
    script.onerror = function () { /* 编辑层没加载成功不影响 HUD 出图 */ };
    document.head.appendChild(script);
  }
  // 装备槽（0..5）+ 饰品槽（6）；演示模式补 demoItems，live 模式不补，绝不伪造。
  function playerItemSlots(player, globalIndex) {
    var usable = capUsable('items');
    var slots = usable ? playerItems(player) : [null, null, null, null, null, null, null];
    if (usable && demoMode()) {
      for (var i = 0; i < 7; i += 1) if (!slots[i]) slots[i] = itemEntry(demoItemAt(i, globalIndex || 0));
    }
    return slots;
  }
  function ownedItemCount(player, globalIndex) {
    var slots = playerItemSlots(player, globalIndex);
    var count = 0;
    for (var i = 0; i < 6; i += 1) if (slots[i]) count += 1;
    return count;
  }
  function hasTrinket(player, globalIndex) { return !!playerItemSlots(player, globalIndex)[6]; }
  function round2(value) { return Math.round(value * 100) / 100; }
  // 孔位矩形：换算成「相对 .hb-half 左上角」的本地坐标，绝对定位 div 与 mask 共用同一组数字。
  function holeRects(side) {
    var half = byId('hb-rows-' + side);
    var empty = { rects: [], box: null };
    if (!half || !half.getBoundingClientRect) return empty;
    var screenBox = half.getBoundingClientRect();
    if (!screenBox || !(screenBox.width > 0) || !(screenBox.height > 0)) return empty;
    // getBoundingClientRect 受 --hb-scale 变换影响；换成 1920×1080 设计坐标，
    // 孔位/掩膜在任何分辨率下都按同一套像素几何计算。
    var scale = HB_SCALE > 0 ? HB_SCALE : 1;
    var stage = byId('hb-bottom-stage');
    var stageBox = stage && stage.getBoundingClientRect ? stage.getBoundingClientRect() : { left: 0, top: 0 };
    var box = {
      left: (screenBox.left - stageBox.left) / scale,
      top: (screenBox.top - stageBox.top) / scale,
      width: screenBox.width / scale,
      height: screenBox.height / scale
    };
    // 自绘装备模式（默认；挖孔 ?hbNativeItems=1）不挖孔，但行内落位仍要用这个 box 计算 CSS 变量，
    // 否则 .hb-info / .hb-champ 全退回 left:0，整行会被挤到半区左边缘。
    if (!nativeItemsEnabled()) return { rects: [], box: box };
    var geo = nativeGeometry();
    var usable = capUsable('items');
    var list = playerList(side);
    var rects = [];
    if (usable) {
      for (var i = 0; i < 5; i += 1) {
        var player = list[i] || {};
        var globalIndex = i + (side === 'red' ? 5 : 0);
        // 标定的 --hb-native-row1-y 是「第 1 行行中心」；装备图标要以行中心为基准上下居中，
        // 否则孔位整体比原生图标低半个图标高（22.5 / 2 ≈ 11px），原生图标顶部会露出来。
        var rowOffset = geo.rowOffsets && typeof geo.rowOffsets[i] === 'number' ? geo.rowOffsets[i] : 0;
        var y = geo.row1Y + i * geo.rowPitch + rowOffset - geo.size / 2 - box.top;
        // 原生固定排 6 个装备格（2026-11-15 用户实机 1920x1080 截图逐像素实测：蓝 643-794、
        // 红 1140-1291，pitch 25.6、图标 24px）+ 独立饰品孔（蓝框 612-642 / 红框 1294-1320）。
        // 空槽不画任何纹理 → 固定挖满 6+1 全孔即可覆盖所有原生图标（件数无关，满 6 件也全覆盖）。
        // 原生 KDA 从 811(蓝)/1335(红) 起 —— 孔带右端 797/1294 与 KDA 之间留 ≥14px 边距，数字不会漏进孔里。
        rects.push({ key: 'hole-' + side + '-' + i + '-items', x: (side === 'blue' ? geo.blueX : geo.redX) - box.left, y: y, w: 5 * geo.pitch + geo.size, h: geo.size });
        // 视野得分数字叠印在饰品图标左下角并向下溢出（实测数字底缘到 band+3~+6px），
        // 饰品孔向下扩 8px、向上扩 1px；蓝侧图标框左缘比标定槽位左 ~5px，向左扩 7px
        // 露出完整槽框；红侧左缘与孔带相接不能重叠，只向右扩 3px。
        rects.push({
          key: 'hole-' + side + '-' + i + '-trinket',
          x: (side === 'blue' ? geo.trinketBlueX - 7 : geo.trinketRedX) - box.left,
          y: y - 1,
          w: geo.size + (side === 'blue' ? 7 : 3),
          h: geo.size + 9
        });
      }
    }
    // 逐孔微调（编辑页「挖孔」组）：dx/dy = 相对出厂孔的位移，w/h = 孔的绝对宽高。
    // 因为 div 与 mask 共用这份 rects，改一个数字就同时改了「透出多大」与描边框。
    var overrides = LAYOUT_ITEMS && typeof LAYOUT_ITEMS === 'object' ? LAYOUT_ITEMS : {};
    for (var q = 0; q < rects.length; q += 1) {
      var item = overrides[rects[q].key];
      if (!item || typeof item !== 'object') continue;
      if (hasNumber(item.dx)) rects[q].x += num(item.dx);
      if (hasNumber(item.dy)) rects[q].y += num(item.dy);
      if (hasNumber(item.w) && num(item.w) > 0) rects[q].w = num(item.w);
      if (hasNumber(item.h) && num(item.h) > 0) rects[q].h = num(item.h);
      rects[q].overridden = true;
      rects[q].x = Math.max(rects[q].x, 0);
      rects[q].y = Math.max(rects[q].y, 0);
      rects[q].w = Math.max(rects[q].w, 2);
      rects[q].h = Math.max(rects[q].h, 2);
    }
    return { rects: rects, box: box };
  }
  // 把孔位同时落成 ①绝对定位的空 div（唯一几何来源，便于 ?hbDebugHoles=1 描边检查）
  // ②.hb-half::before 上的 SVG mask（只挖我们自己的底色层，绝不遮原生头像/血条）。
  // 行内元素落位：把「原生孔带」当成不可占用区，其余元素按它的实际像素位置摆。
  // 每个偏移都从本半区自己的左边缘量（蓝红各算一次），所以镜像与中线都精确。
  // 状态条与原生装备孔带之间的统一间隙（设计 px）：蓝侧条左缘 = 孔带右缘 + GAP，
  // 红侧条右缘 = 孔带左缘 - GAP，两侧到孔带的距离相等且不贴死原生装备图标。
  var BAR_GAP = 10;
  // 自绘模式：名字块宽度按当前 5 行最长内容实测收窄（fit-content 的 JS 版——grid track 无法直接表达）。
  // 行内容宽 = 名字 b.scrollWidth（被截断时仍是完整文本宽）+ 4px 间隙 + 分路标签实宽，与 stat-line 实宽取大者；
  // +31 = 名字块右缘距装备带的固定安全距离（装备带溢出 21px + 10px 间隙）；64..202 封顶截断。
  function measureInfoW(half) {
    if (!half.querySelectorAll) return 202;
    var maxW = 0;
    var rows = half.querySelectorAll('.hb-row');
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var nameB = row.querySelector('.hb-name-line b');
      var roleS = row.querySelector('.hb-name-line small');
      var stat = row.querySelector('.hb-stat-line');
      var w = 0;
      // 名字位置固定预算 100px：不随内容伸缩（用户拍板），超过 100px 的 ID 在文本层截断。
      if (nameB) w += 100;
      if (roleS) w += roleS.getBoundingClientRect().width;
      if (nameB && roleS) w += 4;
      if (stat) { var statW = stat.getBoundingClientRect().width; if (statW > w) w = statW; }
      if (w > maxW) maxW = w;
    }
    var infoW = Math.ceil(maxW) + 31;
    if (infoW > 202) infoW = 202;
    if (infoW < 64) infoW = 64;
    return infoW;
  }
  function syncLayout(side, box) {
    var half = byId('hb-rows-' + side);
    if (!half || !box || !half.style || !half.style.setProperty) return;
    if (ROOT.classList) ROOT.classList.toggle('hb-native-items', nativeItemsEnabled());
    var geo = nativeGeometry();
    var bandW = 6 * geo.pitch;
    var halfLeft = box.left;
    var halfRight = box.left + box.width;
    var bandLeft, infoLeft, infoW, levelLeft, champLeft, extrasLeft, visionLeft;
    if (side === 'blue') {
      bandLeft = geo.blueX - halfLeft;
      infoLeft = geo.blueX + bandW + 4 - halfLeft;
      infoW = halfRight - (geo.blueX + bandW + 4);
      levelLeft = geo.blueX - 6 - 24 - halfLeft;
      if (nativeItemsEnabled()) {
        // 原生饰品槽（trinketBlueX..+size）必须整块留白给挖孔：头像贴到饰品孔左缘，
        // 视野分在原生装备模式下不渲染（见 rowMarkup），不再占用饰品槽位置。
        // 饰品孔向左扩 7px（见 holeRects），头像必须再让出 7px，否则安全网删孔。
        champLeft = geo.trinketBlueX - 9 - 36 - halfLeft;
        // 等级徽章/头像实际由 grid 第 3/2 列定位（385-409 / 347-385，名字左侧），
        // 这两个 left 变量在现 CSS 里已无消费者（仅作 fallback 保留），保持数值自洽即可。
        var levelGap = geo.blueX - (geo.trinketBlueX + geo.size);
        if (!(levelGap >= 32)) levelLeft = champLeft - 26;
        // 头像距板左缘的间距 = vision 列宽（native 模式该列不渲染 vision 图标），
        // 必须与红侧尾隙（--hb-grid-red-tail-w）镜像相等。原生红饰品孔比蓝侧镜像位
        // 宽约 12px，这个差全部吸进不可见的 info/band 列：
        // 蓝列 [vision 22][champ 38][level 24][info 210][band 190][bars 114][tail 25]
        // 红列 [lead 25][bars 114][band 202][info 198][24][38][tail 22]
        // → 头像/等级/文本/状态条全部中线镜像，外缘间距 22/22。两侧各写一份常量。
        // 紧凑改版：分路/#tag/CS 文本下掉后 info 列收窄，省出的空间让头像+文本向内缩进
        //（蓝侧右移/红侧左移，外缘留白变多）。vision 列在 native 模式不渲染，正好当缩进量用。
        var blueVision = 22 + 90;
        half.style.setProperty('--hb-grid-blue-vision-w', round2(blueVision) + 'px');
        // 板体左右边界随缩进收进来：clip 只裁板体外缘（内容/孔位几何不动），
        // 边界 = 头像外缘再留 5px；被裁掉的区域在原生截图里是纯游戏画面。
        var boardEl = half.closest('.hb-board');
        if (boardEl) boardEl.style.setProperty('--hb-clip-x', round2(Math.max(blueVision - 5, 0)) + 'px');
        // 名字块是第 4 个 grid 列（起点 = vision+38+24），右缘必须停在加宽后的饰品孔
        // 左 2px 之外，否则安全网（syncHoles）会以 hole overlaps content 为由把孔整个删掉。
        var blueNameRight = geo.trinketBlueX - 7 - 2;
        var blueHeadW = blueVision + 38 + 24;
        var blueInfoW = blueNameRight - blueHeadW - box.left;
        if (!(blueInfoW > 100)) blueInfoW = 100;
        half.style.setProperty('--hb-grid-info-w', round2(blueInfoW) + 'px');
        // 第 5 列（装备带占位）加宽补差：状态条左缘钉在孔带右缘 + BAR_GAP（blueX+5×pitch+size+GAP），
        // 与原生装备列保持可见间隙，两侧（蓝右缘/红左缘）到各自孔带的距离严格相等。
        var blueBarsLeft = geo.blueX + 5 * geo.pitch + geo.size + BAR_GAP;
        half.style.setProperty('--hb-grid-blue-band-w', round2(blueBarsLeft - blueHeadW - blueInfoW - box.left) + 'px');
        // 尾隙（靠中线一端）= 总宽 623 减去其余各列，吸收模板死空隙；红侧镜像会复用
        // 这个值作首隙（red-lead），两侧状态条到中线的距离才严格对称。
        var blueTail = Math.max(halfRight - (blueBarsLeft + 114), 0);
        half.style.setProperty('--hb-grid-blue-tail-w', round2(blueTail) + 'px');
      } else {
        champLeft = geo.blueX - 6 - 24 - 2 - 36 - halfLeft;
        var boardEl = half.closest('.hb-board');
        if (boardEl) boardEl.style.removeProperty('--hb-clip-x');
        half.style.removeProperty('--hb-grid-blue-vision-w');
        half.style.removeProperty('--hb-grid-blue-band-w');
        half.style.removeProperty('--hb-grid-blue-tail-w');
        // 自绘：名字列实测收窄（头像/等级列被 1fr 外侧空列推向装备带），板左缘裁到头像外 8px（252 = 行宽 623 - 363 固定列 - 8）。
        var selfInfoW = measureInfoW(half);
        half.style.setProperty('--hb-grid-info-w', round2(selfInfoW) + 'px');
        if (boardEl) boardEl.style.setProperty('--hb-clip-left', round2(Math.max(252 - selfInfoW, 0)) + 'px');
      }
      extrasLeft = champLeft - 74;
      // 视野分贴在头像外侧（外沿），不要飘到半区最左边。
      visionLeft = champLeft - 40;
    } else {
      bandLeft = geo.redX - halfLeft;
      infoLeft = 0;
      infoW = geo.redX - 4 - halfLeft;
      if (nativeItemsEnabled()) {
        // 红方镜像：等级徽章与头像依次挪到饰品孔右缘之后，给饰品孔整块让位。
        // 饰品孔向右扩 3px（见 holeRects），等级徽章相应右移，否则安全网删孔。
        levelLeft = geo.trinketRedX + geo.size + 5 - halfLeft;
        champLeft = levelLeft + 24 + 2;
        // 红方名字块宽度与蓝侧严格同宽（镜像）：起点取「红饰品孔右缘+2px」与
        // 「蓝侧名字列右缘的中线镜像」的较大者（原生红饰品孔比镜像位宽约 9px，
        // 被迫让出，等级/头像随之后移，只有视野列变窄）。
        var blueHalfEl = byId('hb-rows-blue');
        var blueBox = blueHalfEl && blueHalfEl.getBoundingClientRect ? blueHalfEl.getBoundingClientRect() : null;
        var blueNameRight = geo.trinketBlueX - 9;
        var blueInfoW = blueBox ? Math.max(blueNameRight - 96 - blueBox.left, 100) : 198;
        var blueBarsLeft = geo.blueX + 5 * geo.pitch + geo.size + BAR_GAP;
        var blueTail = blueBox ? Math.max(blueBox.left + blueBox.width - (blueBarsLeft + 114), 0) : 20;
        var center = blueBox ? (blueBox.left + box.left + box.width) / 2 : box.left - 24;
        var redInfoStart = Math.max(geo.trinketRedX + geo.size + 5, 2 * center - blueNameRight);
        // 红侧状态条改为与蓝侧严格中线镜像：lead = mirror(蓝状态条右缘) - 红半区左缘，
        // 中栏两根边线到两侧状态条的距离严格相等（用户可见的对称基准是中缝线）。
        // 旧方案把红条右缘钉在红孔带左缘 - BAR_GAP，与蓝侧到孔带的间隙相等；但原生红
        // 装备列本身比蓝侧镜像位宽 ~11px（redX=1139 vs mirror(792)=1128），这 11px 全部
        // 漏进红首隙 → 中缝两侧 20/31 不对称。原生 11px 不对称总量守恒，只能选边落：
        // 现在让它落在红侧状态条↔孔带间隙（10→~21），孔带是透孔，远不如中缝线显眼。
        var redLead = Math.max(2 * center - (blueBarsLeft + 114) - halfLeft, 0);
        var redBandW = Math.max((redInfoStart - box.left) - redLead - 114, 60);
        // 红 info 右缘 = mirror(蓝 info 左缘) = 2*center - (blueBox.left + blueVision + 62)。
        // 不能直接用 blueInfoW：红侧起点被更宽的原生红饰品孔强制（redInfoStart=max(1325,1313)），
        // 12px 差必须由红 band/info 列宽吸收；如此推导后红尾隙恒等于 blueVision=22
        //（镜像恒等式），红侧头像外缘间距与蓝侧一致。（blueVision 两侧各写一份常量。）
        // 112 = 22 外缘基线 + 90 缩进，与蓝侧 blueVision 同值（镜像恒等式）。
        var redInfoW = Math.max(2 * center - (blueBox.left + 112 + 62) - redInfoStart, 100);
        var redTail = Math.max(box.width - (redLead + 114 + redBandW + redInfoW + 24 + 38), 0);
        half.style.setProperty('--hb-grid-red-lead-w', round2(redLead) + 'px');
        half.style.setProperty('--hb-grid-red-band-w', round2(redBandW) + 'px');
        half.style.setProperty('--hb-grid-red-info-w', round2(redInfoW) + 'px');
        half.style.setProperty('--hb-grid-red-tail-w', round2(redTail) + 'px');
        // .hb-info 元素宽度走的是 --hb-grid-info-w（红侧未设置时回退 202px），必须与
        // 红侧第 4 列轨宽保持一致，否则名字块右缘会盖到等级徽章上（红文本右对齐）。
        half.style.setProperty('--hb-grid-info-w', round2(redInfoW) + 'px');
        levelLeft = redInfoStart + redInfoW - halfLeft;
        champLeft = levelLeft + 24 + 2;
      } else {
        levelLeft = geo.redX + bandW + 6 - halfLeft;
        champLeft = geo.redX + bandW + 6 + 24 + 2 - halfLeft;
        half.style.removeProperty('--hb-grid-red-lead-w');
        half.style.removeProperty('--hb-grid-red-band-w');
        half.style.removeProperty('--hb-grid-red-tail-w');
        // 自绘：红侧镜像（固定轨道锚在左，剩余空隙自然落在行尾），板右缘裁到头像外 8px（252 = 行宽 623 - 363 固定列 - 8）。
        var selfInfoWRed = measureInfoW(half);
        half.style.setProperty('--hb-grid-red-info-w', round2(selfInfoWRed) + 'px');
        half.style.setProperty('--hb-grid-info-w', round2(selfInfoWRed) + 'px');
        var boardElRed = half.closest('.hb-board');
        if (boardElRed) boardElRed.style.setProperty('--hb-clip-right', round2(Math.max(252 - selfInfoWRed, 0)) + 'px');
      }
      extrasLeft = champLeft + 36 + 8;
      visionLeft = champLeft + 36 + 4;
    }
    if (infoW > 138) infoW = 138;
    if (infoW < 40) infoW = 40;
    half.style.setProperty('--hb-band-left', round2(bandLeft) + 'px');
    half.style.setProperty('--hb-band-w', round2(bandW) + 'px');
    half.style.setProperty('--hb-info-left', round2(infoLeft) + 'px');
    half.style.setProperty('--hb-info-w', round2(infoW) + 'px');
    half.style.setProperty('--hb-level-left', round2(levelLeft) + 'px');
    half.style.setProperty('--hb-champ-left', round2(champLeft) + 'px');
    half.style.setProperty('--hb-extras-left', round2(extrasLeft) + 'px');
    half.style.setProperty('--hb-vision-left', round2(visionLeft) + 'px');
  }
  // 安全网：孔位绝不能压住任何自绘内容 —— 逐个孔与内容元素做包围盒相交检测，
  // 有交集就报错并跳过该孔（宁可少一个孔，也不能把玩家名 / 状态条盖掉）。
  function rectHit(a, b) { return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y); }
  function contentRects(half, box) {
    var selectors = ['.hb-bars', '.hb-name', '.hb-cs', '.hb-kda', '.hb-vert', '.hb-diff', '.hb-champ', '.hb-level', '.hb-vision', '.hb-items'];
    var out = [];
    var scale = HB_SCALE > 0 ? HB_SCALE : 1;
    var stage = byId('hb-bottom-stage');
    var stageBox = stage && stage.getBoundingClientRect ? stage.getBoundingClientRect() : { left: 0, top: 0 };
    for (var s = 0; s < selectors.length; s += 1) {
      var nodes = half.querySelectorAll ? half.querySelectorAll(selectors[s]) : [];
      for (var i = 0; i < nodes.length; i += 1) {
        var r = nodes[i].getBoundingClientRect();
        if (!r || !(r.width > 0) || !(r.height > 0)) continue;
        out.push({
          x: (r.left - stageBox.left) / scale - box.left,
          y: (r.top - stageBox.top) / scale - box.top,
          w: r.width / scale,
          h: r.height / scale,
          sel: selectors[s]
        });
      }
    }
    return out;
  }
  // 整块垂直位置：原生面板底边 ≈1072，距屏幕底 ≈8px（2026-11-15 实测行带 876.5..1050）。
  // 若 bottom:0，5 行会整体比原生低约 8px，孔就挖到原生面板下方去了；
  // 这里按「第 1 行中心 = --hb-native-row1-y」反算底边偏移，让 5 行中心正好压在
  // 876.5 / 919.9 / 963.3 / 1006.7 / 1050.1 上。要强制贴底用 ?hbBottom=0。
  function syncBottomOffset() {
    var bottom = byId('hb-bottom');
    if (!bottom || !bottom.style || !bottom.style.setProperty) return;
    if (/(?:^|[?&])hbBottom=0(?:&|$)/.test(searchString())) { bottom.style.setProperty('bottom', '0px'); bottom.style.setProperty('--hb-board-foot', '0px'); return; }
    // 设计坐标固定 1080 高：底边偏移 = 1080 - 第1行中心 - 4.5×行距。
    // 1920×1080 下 = 8.2px；其他分辨率由 stage 的 --hb-scale 整块缩放，不参与这里的计算。
    var geo = nativeGeometry();
    var offset = 1080 - geo.row1Y - geo.rowPitch * 4.5;
    if (!(offset > 0)) offset = 0;
    // bottom 归零 + 板体高度加 foot（= 旧 offset 值）：行位严格不变
    //（rows top = 1080 - 0 - (rows+extend+foot) + extend = 1080 - rows - foot，
    // 与旧 1080 - offset - rows 相同），但板体连同下边界线延伸到视口底，
    // 行区之下的空隙由 .hb-board-foot 实心条补齐，边界线落在屏幕最底边。
    bottom.style.setProperty('bottom', '0px');
    bottom.style.setProperty('--hb-board-foot', round2(offset) + 'px');
    // 原生记分板面板顶边在首行孔带上沿再往上 ≈17px（2560×1440 观战图实测 ≈840）：
    // 板体只包 5 行，顶部会露出原生面板金边 + 等级徽章顶 + 红方名字上沿。
    // 这里把板体向上延伸到 y≈848（实机面板顶边 ≈849、时间控制轴底 ≈841，之下留 1px），行位置不变。
    var extend = 1080 - offset - geo.rowPitch * 5 - 848;
    if (!(extend > 0)) extend = 0;
    bottom.style.setProperty('--hb-board-extend', round2(extend) + 'px');
  }
  function syncHoles() {
    ['blue', 'red'].forEach(function (side) {
      var layer = byId('hb-holes-' + side);
      var half = byId('hb-rows-' + side);
      if (!layer || !half) return;
      var info = holeRects(side);
      if (info.box) syncLayout(side, info.box);
      var guard = info.rects.length && info.box ? contentRects(half, info.box) : [];
      var kept = [];
      for (var k = 0; k < info.rects.length; k += 1) {
        var bad = null;
        for (var c = 0; c < guard.length; c += 1) { if (rectHit(info.rects[k], guard[c])) { bad = guard[c]; break; } }
        // 用户手工放大的孔（编辑页「挖孔」组）不再被安全网删掉：那是明确的取景意图。
        if (bad && info.rects[k].overridden) bad = null;
        if (bad) {
          if (typeof console !== 'undefined' && console.error) console.error('[hud] hole overlaps content ' + side + ' ' + JSON.stringify(info.rects[k]) + ' ' + JSON.stringify(bad));
          continue;
        }
        kept.push(info.rects[k]);
      }
      var rects = kept;
      var html = '';
      for (var i = 0; i < rects.length; i += 1) {
        var rect = rects[i];
        html += '<span class="hb-native-hole" id="hb-' + rect.key + '" data-hole="' + rect.key + '" style="left:' + round2(rect.x) + 'px;top:' + round2(rect.y) + 'px;width:' + round2(rect.w) + 'px;height:' + round2(rect.h) + 'px"></span>';
      }
      layer.innerHTML = html;
      if (layer.classList) layer.classList.toggle('hb-debug', debugHoles());
      if (!half.style || !half.style.setProperty) return;
      var box = info.box;
      if (!rects.length || !box) { if (half.style.removeProperty) half.style.removeProperty('--hb-hole-mask'); return; }
      var path = 'M0 0H' + round2(box.width) + 'V' + round2(box.height) + 'H0Z';
      for (var j = 0; j < rects.length; j += 1) {
        var hole = rects[j];
        path += 'M' + round2(hole.x) + ' ' + round2(hole.y) + 'H' + round2(hole.x + hole.w) + 'V' + round2(hole.y + hole.h) + 'H' + round2(hole.x) + 'Z';
      }
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + round2(box.width) + ' ' + round2(box.height) + '" preserveAspectRatio="none"><path fill="#fff" fill-rule="evenodd" d="' + path + '"/></svg>';
      half.style.setProperty('--hb-hole-mask', 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")');
      // 顶/底装饰横线（.hb-board::before/::after，height 2px）不能压进首/末行装备孔：
      // clip-path 由孔位几何推导 —— 顶线在孔带以左可见（右半裁掉），底线在孔带以右可见。
      if (half.style && half.style.setProperty) {
        var clips = [];
        for (var v = 0; v < rects.length; v += 1) {
          var hx = rects[v].x, hw = rects[v].w, hy = rects[v].y, hh = rects[v].h;
          if (hy <= 3) clips.push('inset(0 ' + round2(box.width - hx) + 'px 0 0)');
          else if (hy + hh >= box.height - 3) clips.push('inset(0 0 0 ' + round2(hx + hw) + 'px)');
        }
        if (clips.length) half.style.setProperty('--hb-edge-line-clip', clips.join(' '));
        else half.style.removeProperty('--hb-edge-line-clip');
      }
    });
  }
  // ---- 符文基石 / 分路任务 / 召唤师技能：两列竖排，各两格 ----
  function labelOf(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return text(value.displayName, text(value.name, text(value.id, '')));
    return text(value, '');
  }
  function runeLabel(player) {
    var runes = player && player.runes;
    if (runes && typeof runes === 'object') return labelOf(runes.keystone);
    return labelOf(player && player.keystone);
  }
  function laneMissionLabel(player) {
    var direct = text(player && player.laneMission, '');
    if (direct) return direct;
    var matched = configPlayerFor(player && player.team, player);
    return text(matched && matched.laneMission, '');
  }
  function spellValues(player) {
    var source = player && Array.isArray(player.summoners) ? player.summoners : (player && Array.isArray(player.summonerSpells) ? player.summonerSpells : []);
    var out = [];
    for (var i = 0; i < 2; i += 1) out.push(labelOf(source[i]));
    return out;
  }
  function glyphCell(value, className, title, fallback) {
    var label = text(value, '');
    var initial = label ? (RB.fallbackInitial ? RB.fallbackInitial(label) : label.slice(0, 1)) : (fallback || '?');
    return '<span class="hb-cell ' + className + (label ? '' : ' unknown') + '" title="' + esc(label || title + '（官方接口未提供）') + '"><i>' + esc(initial) + '</i></span>';
  }
  function runeCells(player) {
    var keystone = capUsable('runes') ? runeLabel(player) : '';
    return glyphCell(keystone, 'hb-rune', capTitle('runes', '符文基石'), '?') + glyphCell(laneMissionLabel(player), 'hb-lane', '分路任务', '?');
  }
  function spellCells(player) {
    if (!capUsable('summoners')) {
      var unknownTitle = esc(capTitle('summoners', '召唤师技能'));
      return '<span class="hb-cell hb-spell unknown" title="' + unknownTitle + '"><i>?</i></span>' +
        '<span class="hb-cell hb-spell unknown" title="' + unknownTitle + '"><i>?</i></span>';
    }
    var values = spellValues(player);
    var html = '';
    for (var i = 0; i < 2; i += 1) {
      var value = values[i];
      html += value
        ? '<span class="hb-cell hb-spell" title="' + esc(value) + '">' + icon('spell', value, value, 'hb-spell-ico') + '</span>'
        : '<span class="hb-cell hb-spell unknown" title="召唤师技能（官方接口未提供）"><i>?</i></span>';
    }
    return html;
  }
  // ---- 大招圆徽：官方只在 activePlayer 暴露 abilities，十人拿不到 → unknown 占位 ----
  function ultMarkup(player) {
    var info = player && player.ult && typeof player.ult === 'object' ? player.ult : null;
    var remaining = info && hasNumber(info.remaining) ? num(info.remaining) : null;
    var ready = info && info.ready === true;
    var known = remaining !== null || ready;
    var label = remaining !== null ? String(Math.max(0, Math.ceil(remaining))) : 'R';
    var stateClass = !known ? ' unknown' : (ready || (remaining !== null && remaining <= 0) ? ' ready' : ' cooling');
    return '<span class="hb-ult' + stateClass + '" title="' + (known ? '大招' : '大招（官方接口未提供）') + '"><i>' + esc(label) + '</i></span>';
  }
  // ---- 三条状态条：紫=经验、绿=生命、蓝/琥珀=资源；无数据源时渲染 unknown 占位 ----
  function ratioOf(current, max) {
    if (!hasNumber(current) || !hasNumber(max) || num(max) <= 0) return null;
    return Math.max(0, Math.min(1, num(current) / num(max)));
  }
  // 演示模式（非 live）没有真实血量/经验，按名字做确定性伪随机，让版式可验收；
  // live 模式一律返回 null，交给 unknown 占位，绝不伪造官方数据。
  function demoBars(player) {
    var label = text(player && player.name, '') + '|' + text(player && player.champion, '');
    var seed = 7;
    for (var i = 0; i < label.length; i += 1) seed = (seed * 31 + label.charCodeAt(i)) % 99991;
    var level = hasNumber(player && player.level) ? num(player.level) : 8;
    return {
      xp: Math.min(1, 0.14 + (seed % 53) / 100 + level / 60),
      hp: Math.min(1, 0.4 + (seed % 47) / 100),
      res: Math.min(1, 0.26 + (seed % 61) / 100),
      resAlt: seed % 5 === 0
    };
  }
  // ---- 三条状态条的取值 ----
  // 紫=经验：协议流 xp 按标准等级阈值归一化（progress = (xp - thr[level]) / (thr[level+1] - thr[level])，18 级满条）。
  function xpProgress(player) {
    // t26 协议流区间：xpProgress 是可选的 0..1 低界，存在时优先于旧版 xp 阈值换算。
    var direct = pickValue(player, ['xpProgress']);
    if (hasNumber(direct)) return Math.max(0, Math.min(1, num(direct)));
    var xp = pickValue(player, ['xp']);
    var level = hasNumber(player && player.level) ? num(player.level) : null;
    if (!hasNumber(xp) || level === null || level < 1) return null;
    if (level >= 18) return 1;
    var low = XP_TABLE[level]; var high = XP_TABLE[level + 1];
    if (!hasNumber(low) || !hasNumber(high) || high <= low) return null;
    return Math.max(0, Math.min(1, (num(xp) - low) / (high - low)));
  }
  // 经验条不确定性区间的高界（可选 0..1）。没有高界 = 普通单值条。
  function xpProgressHi(player) {
    var hi = pickValue(player, ['xpProgressHi']);
    if (!hasNumber(hi)) return null;
    return Math.max(0, Math.min(1, num(hi)));
  }
  // 绿=生命 / 资源：来自像素读条（只有百分比、没有绝对值，所以永远不显示数字）。
  // 数据形状（t15 交付、t23 接入）：{ fillPercent:0..100|null, dominantColor:[r,g,b], shieldPx, status }。
  // fillPercent 为 null = 没读到（≠ 0%）；status absent/unsupported = 该条不存在。
  function pixelBar(player, kind) {
    var nested = player && player.pixelBars && typeof player.pixelBars === 'object' ? player.pixelBars[kind] : null;
    var keys = kind === 'hp'
      ? ['hpPercent', 'healthPercent', 'hpFillPercent', 'healthFillPercent']
      : ['resourcePercent', 'resourceFillPercent', 'manaPercent', 'resourceFillPercent'];
    var fill = nested ? pickValue(nested, ['fillPercent', 'fill', 'percent']) : pickValue(player, keys);
    var status = text(nested ? nested.status : pickValue(player, [kind === 'hp' ? 'hpStatus' : 'resourceStatus']), '');
    if (status === 'absent' || status === 'unsupported') return { pct: null, color: '', shield: 0 };
    if (!hasNumber(fill)) return { pct: null, color: '', shield: 0 };
    return {
      pct: Math.max(0, Math.min(1, num(fill) / 100)),
      color: rgbOf(nested ? nested.dominantColor : pickValue(player, [kind === 'hp' ? 'hpColor' : 'resourceColor'])),
      shield: nested && hasNumber(nested.shieldPx) ? Math.max(0, num(nested.shieldPx)) : 0
    };
  }
  function rgbOf(color) {
    if (!color) return '';
    if (typeof color === 'string') return color;
    if (Array.isArray(color) && color.length >= 3) return 'rgb(' + Math.round(num(color[0])) + ',' + Math.round(num(color[1])) + ',' + Math.round(num(color[2])) + ')';
    return '';
  }
  // 资源类型/颜色/是否绘制全部由 data/resource-bar-spec.json 驱动，这里不写死任何英雄名单。
  function resourceSpecFor(player) {
    var champId = text(player && player.champion, '');
    if (champId && RB.championKey) { try { champId = RB.championKey(champId) || champId; } catch (error) { /* 用原值兜底 */ } }
    var spec = champId && RESOURCE_SPEC ? RESOURCE_SPEC[champId] : null;
    return spec && typeof spec === 'object' ? spec : { cls: 'A', color: '#3b7fd4', gating: 'always', states: null };
  }
  function playerBars(player) {
    // 契约说不可用时即便对象上真有数字也不画（例如回放 timeline 里没有生命值）。
    var xp = capUsable('xpProgress') ? xpProgress(player) : null;
    var xpHi = capUsable('xpProgress') ? xpProgressHi(player) : null;
    var hpBar = capUsable('hpPercent') ? pixelBar(player, 'hp') : { pct: null, color: '', shield: 0 };
    var resBar = capUsable('resourcePercent') ? pixelBar(player, 'resource') : { pct: null, color: '', shield: 0 };
    var hp = hpBar.pct; var res = resBar.pct;
    var demo = false;
    if (xp === null && hp === null && res === null && demoMode() && player && !player.placeholder) {
      var d = demoBars(player);
      xp = d.xp; hp = d.hp; res = d.res; demo = true;
    }
    return { xp: xp, xpHi: xpHi, hp: hp, res: res, hpColor: hpBar.color, hpShield: hpBar.shield, resColor: resBar.color, spec: resourceSpecFor(player), demo: demo };
  }
  // 渐变锚点（保真关键）：原生是「整条轨道一条固定渐变，按填充长度裁切」，不是「渐变铺满当前填充宽」。
  // CSS 渐变默认铺满元素自身宽度，所以这里把 background-size 设成 (100/pct)% —— pct 越小渐变被拉得越宽，
  // 取到的颜色段越靠前，与原生「短条尖端 ≠ 满血颜色」一致。pct 钳到 0.02 防止除零。
  // 注意：background 简写会重置 background-size，所以必须把 background 写在 background-size 之前。
  function barFillStyle(pct, color) {
    var safe = Math.max(0.02, Math.min(1, pct));
    return 'width:' + (pct * 100).toFixed(1) + '%'
      + (color ? ';background:' + color : '')
      + ';background-size:' + (100 / safe).toFixed(2) + '% 100%';
  }
  // 分段资源条（Rengar 残暴 4 层）：原生是 4 段 pips 而不是连续条。
  // 段数 = spec.max（resourceMax），点亮段数 = floor(pct*4)，满 4 段时整条转橙 #e07a2a。
  function pipsMarkup(kind, label, pct, demo, info) {
    var total = Math.max(1, num(info.pips));
    var lit = Math.max(0, Math.min(total, Math.floor(pct * total)));
    var full = lit >= total;
    var color = full ? '#e07a2a' : (text(info.color, '') || '#e8e8e8');
    var html = '<span class="hb-bar ' + kind + ' hb-pips" title="' + esc(label) + ' ' + lit + '/' + total + (demo ? '（演示数据）' : '') + '">';
    for (var i = 0; i < total; i += 1) {
      html += '<i class="hb-pip"' + (i < lit ? ' style="background:' + esc(color) + '"' : '') + '></i>';
    }
    return html + '</span>';
  }
  // 护盾段接在「生命填充的右端之后」（血 60% + 盾 10% → 盾画在 60%~70% 处），不是贴整条右端。
  function shieldMarkup(hpPct, shieldPx) {
    var left = Math.max(0, Math.min(1, hpPct)) * 100;
    var width = Math.min(100 - left, Math.max(0, (shieldPx / PIXEL_BAR_FULL_PX) * 100));
    if (!(width > 0)) return '';
    return '<i class="hb-bar-shield" style="left:' + left.toFixed(1) + '%;width:' + width.toFixed(1) + '%"></i>';
  }
  function barMarkup(kind, label, pct, demo, extra) {
    var note = demo ? '（演示数据）' : '';
    var info = extra || {};
    var tip = text(info.tip, '');
    if (pct !== null && info.pips) return pipsMarkup(kind, label, pct, demo, info);
    if (pct === null) return '<span class="hb-bar ' + kind + ' unknown" title="' + esc(label) + '：暂无数据源（unknown）' + esc(tip) + '"><i class="hb-bar-fill" style="width:0%"></i></span>';
    var fill = '<i class="hb-bar-fill" style="' + barFillStyle(pct, info.color) + '"></i>';
    // 经验区间：实心紫条画到 xpProgress（低界），再补一段半透明带画到 xpProgressHi（高界）。
    var range = '';
    if (hasNumber(info.hi)) {
      var hi = Math.max(pct, Math.min(1, num(info.hi)));
      if (hi > pct) range = '<i class="hb-bar-range" style="left:' + (pct * 100).toFixed(1) + '%;width:' + ((hi - pct) * 100).toFixed(1) + '%"></i>';
    }
    // 掉血残影：只有生命条有这一层（原生经验条/资源条没有残影）。
    var lag = info.lag ? '<i class="hb-bar-lag" style="width:' + (pct * 100).toFixed(1) + '%"></i>' : '';
    // 刻度线位置 = 阈值 / resourceMax（Rumble: 50/150 = 33.3%），由 spec.ticks 驱动。
    var tick = hasNumber(info.tickAt) ? '<i class="hb-bar-tick" style="left:' + (num(info.tickAt) * 100).toFixed(1) + '%"></i>' : '';
    // 原生观战 UI 不显示护盾段，这里也不再渲染（shieldPx 仍在 payload schema 里，只是不上屏）。
  var shield = '';
    var titleText = hasNumber(info.hi) && num(info.hi) > pct
      ? label + ' ' + Math.round(pct * 100) + '%~' + Math.round(num(info.hi) * 100) + '%（协议流区间，60s 解析一跳）'
      : label + ' ' + Math.round(pct * 100) + '%';
    return '<span class="hb-bar ' + kind + '" title="' + esc(titleText) + note + esc(tip) + '">' + fill + range + lag + tick + shield + '</span>';
  }
  // 三条状态条的统一取值（barCells 渲染与 updateBarsInto 就地更新共用同一份语义）。
  // 资源条三态门控：D 类永不绘制；gating==='always' 照旧绘制（读不到画 unknown 占位）；
  // gating 非 always（Aatrox/Yone/Briar/Belveth）只在像素读到数字时才绘制 —— 条是否存在
  // 像素层已经用 null 告诉我们了，HUD 侧不再猜一次，也不画 0%。
  function barParts(player) {
    var bars = playerBars(player || {});
    var spec = bars.spec || {};
    var hpExtra = { color: bars.hpColor, shield: bars.hpShield, lag: true, tip: spec.hpNote ? '（' + spec.hpNote + '）' : '' };
    var parts = [
      { kind: 'xp', label: '经验', pct: bars.xp, extra: { hi: bars.xpHi } },
      { kind: 'hp', label: '生命', pct: bars.hp, extra: hpExtra }
    ];
    var gating = text(spec.gating, 'always');
    var drawRes = spec.cls !== 'D' && (gating === 'always' || bars.res !== null);
    if (drawRes) {
      // B 类优先用像素读到的 dominantColor（比 spec 静态色更真实），spec 的 colorStates 只做兜底。
      var color = bars.resColor || text(spec.color, '');
      var states = spec.states;
      if (!bars.resColor && states && states.length && hasNumber(bars.res)) {
        var pct100 = bars.res * 100;
        for (var i = 0; i < states.length; i += 1) {
          if (pct100 >= num(states[i][0]) && pct100 <= num(states[i][1])) { color = text(states[i][2], color); break; }
        }
      }
      var resExtra = { color: color };
      var resMax = hasNumber(spec.max) ? num(spec.max) : 0;
      // 只有 resourceMax 恰为 4 的英雄（Rengar 残暴）才画分段；其他英雄保持连续条，不猜分段。
      if (resMax === 4) resExtra.pips = 4;
      else if (resMax > 0 && spec.ticks && spec.ticks.length) resExtra.tickAt = Math.max(0, Math.min(1, num(spec.ticks[0]) / resMax));
      parts.push({ kind: 'res', label: '资源', pct: bars.res, extra: resExtra });
    }
    return { bars: bars, parts: parts };
  }
  function barCells(player) {
    var info = barParts(player);
    var html = '';
    for (var i = 0; i < info.parts.length; i += 1) {
      var part = info.parts[i];
      html += barMarkup(part.kind, part.label, part.pct, info.bars.demo, part.extra);
    }
    return html;
  }
  // 结构签名：条数 / 是否 unknown / 分段 / 刻度 / 护盾 变化时才重建 DOM，
  // 其余情况就地改宽度 —— 否则每帧重建 innerHTML，transition 与掉血残影永远不会生效。
  function barSignature(player) {
    var info = barParts(player);
    var sig = info.parts.map(function (part) {
      var e = part.extra || {};
      return part.kind + (part.pct === null ? 'x' : 'v') + (e.pips ? 'p' : '') + (hasNumber(e.tickAt) ? 't' : '') + (e.shield ? 's' : '') + (hasNumber(e.hi) && num(e.hi) > part.pct ? 'r' : '');
    }).join('|');
    return sig + (info.bars.demo ? '|demo' : '');
  }
  // 掉血残影：主填充 90ms 缩短，残影层按 CSS 的 400ms ease-out 追上来。
  // 回血/升级/首帧时残影直接对齐（原生回血是直接涨，没有残影）。
  var lagMemory = {};
  function applyLag(bar, pct, key) {
    if (!bar || !bar.querySelector) return;
    var lag = bar.querySelector('.hb-bar-lag');
    if (!lag) return;
    var next = pct * 100;
    var prev = hasNumber(lagMemory[key]) ? lagMemory[key] : null;
    if (prev === null || next >= prev) {
      if (lag.style) {
        lag.style.transition = 'none';
        lag.style.width = next.toFixed(1) + '%';
        if (typeof lag.offsetWidth === 'number') lag.offsetWidth; // 强制回流，让 transition:none 立即生效
        lag.style.transition = '';
      }
    } else if (lag.style) {
      lag.style.width = next.toFixed(1) + '%';
    }
    lagMemory[key] = next;
  }
  function updateBarsInto(node, player, key) {
    if (!node) return;
    var sig = barSignature(player);
    if (!node.getAttribute || node.getAttribute('data-sig') !== sig) {
      node.innerHTML = barCells(player);
      if (node.setAttribute) node.setAttribute('data-sig', sig);
      lagMemory[key] = null;
      return;
    }
    var info = barParts(player);
    for (var i = 0; i < info.parts.length; i += 1) {
      var part = info.parts[i];
      if (part.pct === null || !node.querySelector) continue;
      var bar = node.querySelector('.hb-bar.' + part.kind);
      if (!bar) continue;
      var fill = bar.querySelector('.hb-bar-fill');
      if (fill && fill.setAttribute) fill.setAttribute('style', barFillStyle(part.pct, part.extra && part.extra.color));
      var range = bar.querySelector('.hb-bar-range');
      if (range && range.setAttribute) {
        var hi = part.extra && hasNumber(part.extra.hi) ? Math.max(part.pct, Math.min(1, num(part.extra.hi))) : part.pct;
        range.setAttribute('style', 'left:' + (part.pct * 100).toFixed(1) + '%;width:' + ((hi - part.pct) * 100).toFixed(1) + '%');
      }
      if (part.kind === 'hp') applyLag(bar, part.pct, key);
      var shield = bar.querySelector('.hb-bar-shield');
      if (shield && shield.setAttribute) {
        // 护盾段跟着生命填充的右端走：left = 当前血量百分比，宽度 = 盾像素 / 满宽基准。
        var left = part.pct * 100;
        var width = part.extra && part.extra.shield ? Math.min(100 - left, Math.max(0, (part.extra.shield / PIXEL_BAR_FULL_PX) * 100)) : 0;
        shield.setAttribute('style', 'left:' + left.toFixed(1) + '%;width:' + width.toFixed(1) + '%');
      }
    }
  }
  // ---- 对位经济差：中线两侧同一行是同分路对位 ----
  // 只显示解码出的 totalGold 真值（OCR / 协议流）；拿不到就显示 —，不做估算口径（已删）。
  // currentGold 仍未解出，任何地方都不显示它。
  function playerGoldOf(player) {
    // 经济差只认解码出的 totalGold 真值（OCR / 协议流）；拿不到就返回 null，页面显示 —。
    // 解码值可能只有 quantized 精度（残差字节解出的关键帧浮点值，±1 以内），要按精度标注，
    // 不能一律写成「精确值」。
    if (player && hasNumber(player.totalGold) && capUsable('totalGold')) {
      var tier = player.totalGoldPrecision || capPrecision('totalGold');
      return { value: num(player.totalGold), decoded: true, exact: tier === 'exact' };
    }
    return null;
  }
  function diffMarkup(bluePlayer, redPlayer) {
    var blue = playerGoldOf(bluePlayer);
    var red = playerGoldOf(redPlayer);
    if (blue === null || red === null) {
      return '<span class="hb-diff unknown" title="对位经济差：数据不足（unknown）"><i class="hb-diff-bar"></i><b>—</b></span>';
    }
    var diff = blue.value - red.value;
    var cls = diff > 0 ? 'blue' : diff < 0 ? 'red' : 'even';
    var note = blue.exact && red.exact ? '对位经济差（totalGold 真值：经济面板 OCR / 协议流精确值）'
      : '对位经济差（协议流解码值：关键帧金币，±1 以内）';
    return '<span class="hb-diff ' + cls + '" title="' + esc(note) + '"><i class="hb-diff-bar"></i><b>' + esc(fmtDiffAbs(diff)) + '</b></span>';
  }
  function championMarkup(player) {
    var champion = text(player && player.champion, '');
    if (!champion) return '<span class="icon hb-champ-ico"><i class="icon-fb">?</i></span>';
    return icon('champion', champion, champion, 'hb-champ-ico');
  }
  // 自绘装备（默认模式；挖孔 ?hbNativeItems=1）：6 格 + 饰品，消耗型/叠层型角标只在 count>1 时显示。
  // 默认模式一格都不画 —— 那块交给原生 HUD（挖孔）。
  function itemCells(player, globalIndex) {
    var slots = playerItemSlots(player, globalIndex);
    var html = '';
    // 视野得分常驻饰品槽（第 7 格）左上角；饰品为空时整格居中显示数字。
    var ward = capUsable('wardScore') && hasNumber(player.wardScore)
      ? '<i class="hb-item-ward" title="' + esc(capTitle('wardScore', '视野得分')) + '">' + Math.round(num(player.wardScore)) + '</i>'
      : '';
    for (var i = 0; i < 7; i += 1) {
      var slot = slots[i];
      if (!slot) {
        html += '<span class="hb-item empty">' + (i === 6 && ward ? ward : '<i>' + (i === 6 ? '◇' : '·') + '</i>') + '</span>';
        continue;
      }
      html += '<span class="hb-item"' + (slot.count ? ' title="' + esc(text(slot.name, '装备') + ' ×' + slot.count) + '"' : '') + '>' +
        icon('item', slot.value, text(slot.name, ''), 'hb-item-ico') +
        (slot.count ? '<b class="hb-item-count">' + slot.count + '</b>' : '') +
        (i === 6 ? ward : '') +
        '</span>';
    }
    return html;
  }
  // 单行 DOM：与 .hb-row.blue/.red 的 grid 列一一对应。
  // 蓝：视野 | 头像(等级角标叠角) | 等级空占位列 | 名字/CS/KDA 两行(202) | 空孔带(207) | 三条状态条(114) | 空隙(4)
  // 红方镜像。孔带是空 span，绝不放任何内容。
  function rowMarkup(side, index, player, globalIndex) {
    var p = player || {};
    var id = side + '-' + index;
    var level = capUsable('level') && hasNumber(p.level) ? num(p.level) : '—';
    var extras = extrasEnabled()
      ? '<span class="hb-extras" id="hb-extras-' + id + '">' +
          '<span class="hb-vert hb-runes" id="hb-runes-' + id + '">' + runeCells(p) + '</span>' +
          '<span class="hb-vert hb-spells" id="hb-spells-' + id + '">' + spellCells(p) + '</span>' +
          '<span class="hb-ult-cell" id="hb-ult-' + id + '">' + ultMarkup(p) + '</span>' +
        '</span>'
      : '';
    var items = nativeItemsEnabled() ? '' : '<span class="hb-items" id="hb-items-' + id + '">' + itemCells(p, globalIndex) + '</span>';
    return '<div class="hb-row ' + side + '" id="hb-row-' + id + '">' +
      extras +
      '<span class="hb-champ" id="hb-champ-' + id + '">' + championMarkup(p) +
        '<span class="hb-level" id="hb-level-' + id + '">' + level + '</span>' + '</span>' +
      items +
      '<span class="hb-info" id="hb-info-' + id + '">' +
        '<span class="hb-name-line hb-name"><b id="hb-pname-' + id + '">' + esc(playerDisplayName(p)) + '</b><small id="hb-prole-' + id + '"></small></span>' +
        '<span class="hb-stat-line">' +
          '<b class="hb-kda' + capClass('kills') + '" id="hb-kda-' + id + '" title="' + esc(capTitle('kills', 'KDA')) + '">' + kdaOf(p) + '</b>' +
        '</span>' +
      '</span>' +
      '<span class="hb-band" aria-hidden="true"></span>' +
      '<span class="hb-bars" id="hb-bars-' + id + '" data-sig="' + esc(barSignature(p)) + '">' + barCells(p) + '</span>' +
    '</div>';
  }
  function rosterKey() {
    return ['blue', 'red'].map(function (side) {
      return side + ':' + playerList(side).map(function (player) { return playerDisplayName(player) + '|' + text(player.champion, '') + '|' + playerRole(player); }).join(',');
    }).join('||');
  }
  function animateRows() {
    if (!ROOT.querySelectorAll) return;
    var rows = ROOT.querySelectorAll('.hb-row');
    if (A.staggerIn) A.staggerIn(rows, { step: 45, className: 'hb-in' });
    else Array.prototype.forEach.call(rows, function (row) { row.classList.add('hb-in'); });
  }
  function ensureRows() {
    var key = rosterKey();
    if (key === lastRosterKey) return false;
    lastRosterKey = key;
    ['blue', 'red'].forEach(function (side) {
      var node = byId('hb-rows-' + side);
      if (!node) return;
      var list = playerList(side); var html = '';
      for (var i = 0; i < 5; i += 1) html += rowMarkup(side, i, list[i], i + (side === 'red' ? 5 : 0));
      // 挖孔层必须跟行一起重建：绝对定位的空 div 描述原生装备栏/饰品栏的位置。
      node.innerHTML = html + '<div class="hb-holes" id="hb-holes-' + side + '"></div>';
    });
    var mid = byId('hb-mid');
    if (mid) {
      var cells = '';
      for (var m = 0; m < 5; m += 1) cells += '<span class="hb-diff-cell" id="hb-diff-cell-' + m + '"></span>';
      mid.innerHTML = cells;
    }
    if (introPlayed) animateRows();
    return true;
  }
  function updateRows() {
    var lists = { blue: playerList('blue'), red: playerList('red') };
    ['blue', 'red'].forEach(function (side) {
      var list = lists[side];
      for (var i = 0; i < 5; i += 1) {
        var player = list[i]; var row = byId('hb-row-' + side + '-' + i); if (!row) continue;
        var id = side + '-' + i;
        var dead = player && player.alive === false;
        row.classList.toggle('dead', !!dead);
        if (player) row.setAttribute('title', playerDisplayName(player) + ' · ' + text(player.champion, ''));
        setText('hb-vision-' + id, player && capUsable('wardScore') && hasNumber(player.wardScore) ? Math.round(num(player.wardScore)) : '—');
        setText('hb-level-' + id, player && capUsable('level') && hasNumber(player.level) ? num(player.level) : '—');
        var champ = byId('hb-champ-' + id);
        setHtml(champ, championMarkup(player || {}) + '<span class="hb-level" id="hb-level-' + id + '">' + (player && capUsable('level') && hasNumber(player.level) ? num(player.level) : '—') + '</span>');
        var ult = byId('hb-ult-' + id); setHtml(ult, ultMarkup(player || {}));
        setText('hb-pname-' + id, player ? playerDisplayName(player) : '—');
        var roleNode = byId('hb-prole-' + id);
        // 分路标注按需求下掉：prole 槽位只在死亡时短暂显示复活倒计时。
        if (roleNode) roleNode.textContent = dead && num(player.respawnTimer) > 0 ? '复活 ' + Math.round(num(player.respawnTimer)) + 's' : '';
        // 就地更新（不重建 innerHTML），否则每帧重建会让 transition 与掉血残影失效。
        updateBarsInto(byId('hb-bars-' + id), player || {}, id);
        setText('hb-kda-' + id, player ? kdaOf(player) : '—');
        setHtml(byId('hb-runes-' + id), runeCells(player || {}));
        setHtml(byId('hb-spells-' + id), spellCells(player || {}));
        setHtml(byId('hb-items-' + id), itemCells(player || {}, i + (side === 'red' ? 5 : 0)));
      }
    });
    // 挖孔几何依赖行内容（装备件数）与真实像素坐标，必须在本轮内容刷新之后再算一次。
    syncHoles();
  }
  function renderMatchups() {
    var blue = playerList('blue'); var red = playerList('red');
    for (var i = 0; i < 5; i += 1) {
      setHtml(byId('hb-diff-cell-' + i), diffMarkup(blue[i], red[i]));
    }
  }
  // LCU DragonKill 事件的 DragonType -> score sigil 资产 key（/assets/objectives/score-<key>.png）。
  var DRAGON_SIGIL = {
    fire: 'infernal', infernal: 'infernal',
    water: 'ocean', ocean: 'ocean',
    earth: 'mountain', mountain: 'mountain',
    air: 'cloud', cloud: 'cloud',
    chemtech: 'chemtech', hextech: 'hextech', elder: 'elder'
  };
  function dragonStackMarkup(team) {
    var types = Array.isArray(team.dragonTypes) ? team.dragonTypes : [];
    // 一方最多 4 条龙（第 5 条起是龙魂 / 远古龙，不占坑位）。
    if (!types.length) return SIGIL('dragon').repeat(Math.max(0, Math.min(4, num(team.dragons))));
    return types.slice(0, 4).map(function (t) {
      var key = DRAGON_SIGIL[String(t).toLowerCase()] || 'dragon';
      return SIGIL(key);
    }).join('');
  }
  // 编辑模式专用：龙堆按 4 个坑位补齐占位框，还没打的第 3/4 条龙也能直接拖位置。
  // 只在 ?hudEdit=1 里生效，生产 HUD 的 DOM 与原来一致。
  function layoutGhosts() {
    if (!layoutEditMode()) return;
    ['blue', 'red'].forEach(function (side) {
      var stack = byId('hb-stack-' + side);
      if (!stack) return;
      var have = stack.querySelectorAll(':scope > img').length;
      for (var i = have; i < 4; i += 1) {
        var ghost = document.createElement('img');
        ghost.className = 'hb-ghost';
        ghost.setAttribute('alt', '');
        ghost.src = '/assets/objectives/score-dragon.png';
        stack.appendChild(ghost);
      }
    });
  }
  function renderObjectives() {
    ['blue', 'red'].forEach(function (side) {
      var team = teamInfo(side);
      setHtml(byId('hb-stack-' + side), dragonStackMarkup(team));
      var grubs = byId('hb-grubs-' + side);
      if (grubs) grubs.textContent = num(team.grubs);
    });
  }
  // 左侧计时盒阶段机：潮虫盒→先锋盒→大龙盒。潮虫被清一只或 9:00（距先锋 5 分钟）切先锋；
  // 先锋被杀或 16:00（距大龙 4 分钟）切大龙。大龙/元素龙无人打不离场：在场=纯图标，被杀=倒计时。
  var PHASE_SIGIL = { grubs: 'grub', herald: 'herald', baron: 'baron' };
  var PHASE_SPAWN = { grubs: 360, herald: 840 };
  function timerTrackReset() {
    timerTrack = { lastTime: null, stage: 'grubs', grubs: null, heralds: null, barons: null, baronAt: 1200, dragonAt: 300, dragons: null, soul: false, elderAt: null };
  }
  function updateTimerTrack() {
    var gameTime = num(state && state.gameTime);
    if (timerTrack.lastTime !== null && gameTime + 5 < timerTrack.lastTime) timerTrackReset();
    timerTrack.lastTime = gameTime; lastGameTime = gameTime;
    var blue = state && state.blue ? state.blue : {}; var red = state && state.red ? state.red : {};
    var grubs = num(blue.grubs) + num(red.grubs);
    var heralds = num(blue.heralds) + num(red.heralds);
    var barons = num(blue.barons) + num(red.barons);
    var dragons = num(blue.dragons) + num(red.dragons);
    if (timerTrack.grubs === null) {
      timerTrack.grubs = grubs; timerTrack.heralds = heralds; timerTrack.barons = barons; timerTrack.dragons = dragons;
      timerTrack.dragonAt = dragons > 0 ? gameTime + 300 : 300;
      timerTrack.baronAt = barons > 0 ? gameTime + 360 : 1200;
      timerTrack.soul = num(blue.dragons) >= 4 || num(red.dragons) >= 4;
      if (timerTrack.soul) timerTrack.elderAt = gameTime + 360;
      if (grubs > 0 || gameTime >= 540) timerTrack.stage = 'herald';
      if (heralds > 0 || gameTime >= 960) timerTrack.stage = 'baron';
      return;
    }
    if (timerTrack.stage === 'grubs' && (grubs > timerTrack.grubs || gameTime >= 540)) timerTrack.stage = 'herald';
    if (timerTrack.stage === 'herald' && (heralds > timerTrack.heralds || gameTime >= 960)) timerTrack.stage = 'baron';
    if (!timerTrack.soul && (num(blue.dragons) >= 4 || num(red.dragons) >= 4)) {
      timerTrack.soul = true;
      timerTrack.elderAt = timerTrack.baronAt + 360; // 暂估：大龙被杀后改为精确 gameTime+360
    }
    if (barons > timerTrack.barons) {
      timerTrack.baronAt = gameTime + 360;
      if (timerTrack.soul) timerTrack.elderAt = gameTime + 360;
    }
    if (dragons > timerTrack.dragons) {
      if (timerTrack.soul) timerTrack.elderAt = gameTime + 360;
      else timerTrack.dragonAt = gameTime + 300;
    }
    timerTrack.grubs = grubs; timerTrack.heralds = heralds; timerTrack.barons = barons; timerTrack.dragons = dragons;
  }
  function renderTimerBox(nodeId, iconId, sigilKey, at) {
    var node = byId(nodeId); if (!node) return;
    var iconHolder = byId(iconId);
    if (iconHolder) {
      var html = SIGIL(sigilKey);
      if (iconHolder.innerHTML !== html) iconHolder.innerHTML = html;
    }
    var gameTime = num(state && state.gameTime);
    var left = Math.round(at - gameTime);
    var onField = left <= 0;
    var em = node.querySelector('em');
    if (em) {
      em.style.display = '';
      if (!onField) em.textContent = fmtTime(left);
    }
    node.classList.toggle('hb-onfield', onField);
    node.classList.toggle('hb-pulse', !onField && left <= 30);
  }
  function renderPhaseTimer() {
    updateTimerTrack();
    renderTimerBox('hb-timer-phase', 'hb-timer-phase-icon', PHASE_SIGIL[timerTrack.stage] || 'baron',
      timerTrack.stage === 'baron' ? timerTrack.baronAt : PHASE_SPAWN[timerTrack.stage]);
  }
  function renderDragonTimer() {
    var key = timerTrack.soul
      ? 'elder'
      : (state && state.nextDragonType ? (DRAGON_SIGIL[String(state.nextDragonType).toLowerCase()] || 'dragon') : 'dragon');
    var at = timerTrack.soul
      ? (timerTrack.elderAt || (timerTrack.baronAt + 360))
      : (state && state.nextDragonSpawnAt != null ? num(state.nextDragonSpawnAt) : timerTrack.dragonAt);
    renderTimerBox('hb-timer-dragon', 'hb-timer-dragon-icon', key, at);
  }
  function goldOf(source, side) { if (!source || !source[side]) return null; return hasNumber(source[side].gold) ? num(source[side].gold) : null; }
  function updateGold(previous, side, value) {
    var node = byId('hb-gold-' + side); if (!node) return;
    if (value === null) { node.textContent = '—'; return; }
    var before = goldOf(previous, side);
    if (before === null || !introPlayed || !A.tweenNumber || Math.abs(before - value) < 1) { node.textContent = fmtGold(value); return; }
    A.tweenNumber(node, before, value, { duration: 650, decimals: 1, format: function (n) { return fmtGold(n); } });
  }
  function positionGoldDiff() {
    var node = byId('hb-gold-diff'); if (!node) return;
    var row = node.closest('.hb-row1') || (node.parentElement && node.parentElement.closest('.hb-row1'));
    if (!row) return;
    var rowRect = row.getBoundingClientRect();
    var lead = node.classList.contains('blue') ? byId('hb-gold-blue') : node.classList.contains('red') ? byId('hb-gold-red') : null;
    var x;
    if (lead) {
      var r2 = lead.getBoundingClientRect();
      x = r2.left + r2.width / 2 - rowRect.left;
    } else {
      x = rowRect.width / 2;
    }
    node.style.right = 'auto';
    node.style.left = Math.round(x) + 'px';
    node.style.transform = 'translateX(-50%)';
  }
  function renderGoldDiff() {
    var node = byId('hb-gold-diff'); if (!node) return;
    var blue = goldOf(state, 'blue'); var red = goldOf(state, 'red');
    if (blue === null || red === null) { node.className = 'hb-gold-diff even'; setHtml(node, '<b>—</b>'); return; }
    var diff = blue - red;
    node.className = 'hb-gold-diff ' + (diff > 0 ? 'blue' : diff < 0 ? 'red' : 'even');
    setHtml(node, '<b>' + fmtDiff(diff) + '</b>');
    positionGoldDiff();
  }
  // buff 盒×4（大龙/远古 × 蓝/红）：跟随归属队；类型固定槽，大龙内/远古外；单 buff 永占内侧。
  // 注记优先（state.baronBuff/elderBuff），缺注记时客户端从计数跳变推断。
  var BUFF_DUR = { baron: 180, elder: 150 };
  var buffTrack = { lastTime: null, barons: null, baronSide: null, baronStartAt: 0, baronDiffAt: null, elderSide: null, elderStartAt: 0, elderDiffAt: null, dragons: null };
  function buffReset() {
    buffTrack = { lastTime: null, barons: null, baronSide: null, baronStartAt: 0, baronDiffAt: null, elderSide: null, elderStartAt: 0, elderDiffAt: null, dragons: null };
  }
  function buffEarned(side, diffAtStart) {
    var gb = goldOf(state, 'blue'); var gr = goldOf(state, 'red');
    if (diffAtStart === null || gb === null || gr === null) return null;
    return ((gb - gr) - diffAtStart) * (side === 'blue' ? 1 : -1);
  }
  function buffState(kind) {
    var gameTime = num(state && state.gameTime);
    var ann = state && (kind === 'baron' ? state.baronBuff : state.elderBuff);
    if (ann) return { side: ann.side, remaining: BUFF_DUR[kind] - (gameTime - num(ann.startedAt)), earned: Number(ann.goldDiffEarned) || 0 };
    if (buffTrack.lastTime !== null && gameTime + 5 < buffTrack.lastTime) buffReset();
    buffTrack.lastTime = gameTime;
    var blue = state && state.blue ? state.blue : {}; var red = state && state.red ? state.red : {};
    var barons = num(blue.barons) + num(red.barons);
    var dragons = num(blue.dragons) + num(red.dragons);
    if (buffTrack.barons === null) { buffTrack.barons = barons; buffTrack.dragons = dragons; }
    if (barons > buffTrack.barons) {
      buffTrack.baronSide = num(blue.barons) > num(red.barons) ? 'blue' : 'red';
      buffTrack.baronStartAt = gameTime;
      var gb = goldOf(state, 'blue'); var gr = goldOf(state, 'red');
      buffTrack.baronDiffAt = gb !== null && gr !== null ? gb - gr : null;
    }
    buffTrack.barons = barons;
    if (dragons > buffTrack.dragons) {
      var blueTypes = Array.isArray(blue.dragonTypes) ? blue.dragonTypes : [];
      var redTypes = Array.isArray(red.dragonTypes) ? red.dragonTypes : [];
      var elderSide = blueTypes.length && String(blueTypes[blueTypes.length - 1]).toLowerCase() === 'elder' ? 'blue'
        : redTypes.length && String(redTypes[redTypes.length - 1]).toLowerCase() === 'elder' ? 'red' : null;
      if (elderSide) {
        buffTrack.elderSide = elderSide;
        buffTrack.elderStartAt = gameTime;
        var gb2 = goldOf(state, 'blue'); var gr2 = goldOf(state, 'red');
        buffTrack.elderDiffAt = gb2 !== null && gr2 !== null ? gb2 - gr2 : null;
      }
    }
    buffTrack.dragons = dragons;
    if (kind === 'baron') {
      if (!buffTrack.baronSide || gameTime - buffTrack.baronStartAt >= BUFF_DUR.baron) return null;
      return { side: buffTrack.baronSide, remaining: BUFF_DUR.baron - (gameTime - buffTrack.baronStartAt), earned: buffEarned(buffTrack.baronSide, buffTrack.baronDiffAt) };
    }
    if (!buffTrack.elderSide || gameTime - buffTrack.elderStartAt >= BUFF_DUR.elder) return null;
    return { side: buffTrack.elderSide, remaining: BUFF_DUR.elder - (gameTime - buffTrack.elderStartAt), earned: buffEarned(buffTrack.elderSide, buffTrack.elderDiffAt) };
  }
  function buffCard(kind, side) {
    var node = byId('hb-buff-' + kind + '-' + side);
    if (node) return node;
    node = document.createElement('div');
    node.className = 'hb-baron-buff hb-buff-' + kind;
    node.id = 'hb-buff-' + kind + '-' + side;
    node.style.display = 'none';
    node.innerHTML = '<span class="hb-buff-sigil">' + SIGIL(kind === 'elder' ? 'elder' : 'baron') + '</span>' +
      '<span class="hb-buff-text"><b>—</b><em>—</em></span>' +
      '<span class="hb-buff-progress"></span>';
    var slot = byId('hb-buff-slot-' + side);
    if (slot) slot.appendChild(node);
    return node;
  }
  function renderBuffs() {
    ['blue', 'red'].forEach(function (side) {
      ['baron', 'elder'].forEach(function (kind) {
        var node = buffCard(kind, side); if (!node) return;
        var info = buffState(kind);
        var active = info && info.side === side && info.remaining > 0;
        node.style.display = active ? 'flex' : 'none';
        if (!active) return;
        var gold = node.querySelector('.hb-buff-text b');
        if (gold) gold.textContent = info.earned === null ? '—' : (info.earned > 0 ? '+' : '') + Math.round(info.earned) + 'G';
        var time = node.querySelector('.hb-buff-text em');
        if (time) time.textContent = fmtTime(Math.max(0, info.remaining));
        var prog = node.querySelector('.hb-buff-progress');
        if (prog) prog.style.width = Math.max(0, Math.min(100, (info.remaining / BUFF_DUR[kind]) * 100)) + '%';
      });
    });
  }
  // 小局比分 pips：?series=蓝:红 现场覆盖，否则读 state.series（转播台注入），缺省全空。
  function renderPips() {
    var series = demoSeries || (state && state.series && typeof state.series === 'object' ? { blue: num(state.series.blue), red: num(state.series.red) } : null);
    ['blue', 'red'].forEach(function (side) {
      var node = byId('hb-pips-' + side); if (!node) return;
      var wins = series ? Math.max(0, Math.min(3, num(series[side]))) : 0;
      var slots = node.querySelectorAll('i');
      for (var i = 0; i < slots.length; i += 1) slots[i].classList.toggle('filled', i < wins);
    });
  }
  function renderTop(previous) {
    ['blue', 'red'].forEach(function (side) {
      var team = teamInfo(side);
      setText('hb-name-' + side, team.name);
      setText('hb-meta-' + side, [team.region, team.rank].filter(Boolean).join(' · ') || (side === 'blue' ? 'BLUE SIDE' : 'RED SIDE'));
      setText('hb-kills-' + side, team.score === null ? '—' : team.score);
      setText('hb-towers-' + side, team.towers);
      setHtml(byId('hb-logo-' + side), logoMarkup(team, side));
      updateGold(previous, side, team.gold);
    });
    setText('hb-clock', fmtTime(state && state.gameTime));
    renderObjectives(); renderPhaseTimer(); renderDragonTimer(); renderGoldDiff();
    renderBuffs(); renderPips();
  }
  function flashObjectives(previous) {
    if (!previous) return;
    ['blue', 'red'].forEach(function (side) {
      var before = previous[side] || {}; var after = state && state[side] ? state[side] : {};
      OBJ_DEFS.forEach(function (def) {
        if (num(after[def[0]]) <= num(before[def[0]])) return;
        var node = ROOT.querySelector('[data-obj="' + side + '-' + def[0] + '"]'); if (!node) return;
        node.classList.remove('hb-flash'); void node.offsetWidth; node.classList.add('hb-flash');
        window.setTimeout(function () { node.classList.remove('hb-flash'); }, 720);
      });
    });
  }
  function bumpScore(side) {
    var node = byId('hb-kills-' + side); if (!node) return;
    node.classList.remove('hb-bump'); void node.offsetWidth; node.classList.add('hb-bump');
    window.setTimeout(function () { node.classList.remove('hb-bump'); }, 620);
  }
  function applyScoreEffects(previous) {
    if (!previous) return;
    ['blue', 'red'].forEach(function (side) {
      if (scoreOf(state, side) <= scoreOf(previous, side)) return;
      bumpScore(side);
      if (A.sceneWipe) A.sceneWipe(ROOT, { duration: 420, className: side === 'blue' ? 'hb-wipe-blue' : 'hb-wipe-red' });
    });
  }
  // 左下角遮挡卡：盖住原生导播控件面板。默认内容=赛事名+游戏版本，
  // 可用 config.coverCard { title, lines[], html } 全量自定义（html 优先，供富文本/自定义排版）。
  function renderCoverCard() {
    var node = byId('hb-native-cover-left'); if (!node) return;
    var cfg = config || {};
    var card = (cfg && cfg.coverCard && typeof cfg.coverCard === 'object') ? cfg.coverCard : null;
    var series = (cfg && cfg.series && typeof cfg.series === 'object') ? cfg.series : {};
    var tournament = text(cfg.tournamentName, text(series.name, text(state && state.tournamentName, 'KHADA JHIN')));
    var patch = text(cfg.patch, text(series.patch, text(state && state.patch, '')));
    var phase = PHASE_CN[text(state && state.phase, '')] || '';
    var title = text(card && card.title, tournament);
    var lines = card && Array.isArray(card.lines) && card.lines.length
      ? card.lines.map(function (line) { return text(line, ''); }).filter(Boolean)
      : [patch ? 'PATCH ' + patch : '', phase].filter(Boolean);
    if (!lines.length) lines = ['LIVE BROADCAST'];
    var html = card && typeof card.html === 'string' && card.html
      ? card.html
      : '<div class="hb-cover-title" id="hb-cover-title">' + esc(title) + '</div>' +
        lines.map(function (line, index) {
          // id 供布局编辑器单独调整每一行（第 4 行起的极少数情况仍可整体调 cover-left）。
          return '<div class="hb-cover-line" id="hb-cover-line-' + index + '">' + esc(line) + '</div>';
        }).join('');
    if (node.__coverHtml !== html) { node.innerHTML = html; node.__coverHtml = html; }
  }
  function renderSponsor() {
    var node = byId('hb-sponsor'); if (!node) return;
    var list = config && Array.isArray(config.sponsors) ? config.sponsors : []; var sponsor = null;
    for (var i = 0; i < list.length; i += 1) { if (list[i] && list[i].slot === 'bottom') { sponsor = list[i]; break; } }
    if (!sponsor) sponsor = list[0] || null;
    var name = text(sponsor && sponsor.name, 'KHADA JHIN');
    setHtml(node, '<span class="hb-sponsor-name">' + esc(name) + '</span>' + (sponsor && sponsor.image ? '<img src="' + esc(sponsor.image) + '" alt="' + esc(name) + '" onerror="this.remove()">' : ''));
  }
  function playIntro() {
    var top = byId('hb-topbar');
    if (top) { top.classList.remove('hb-in'); void top.offsetWidth; top.classList.add('hb-in'); }
    animateRows();
  }
  function replayIntro(withWipe) { if (withWipe && A.sceneWipe) A.sceneWipe(ROOT, { duration: 360 }); playIntro(); }
  function renderAll(previous) {
    renderTop(previous); ensureRows(); updateRows(); renderMatchups(); renderCoverCard(); renderSponsor();
    layoutGhosts();
    // 行节点每次 ensureRows 都可能被重建，微调必须在每次渲染后重放（幂等）。
    layoutApply(LAYOUT_ITEMS);
    ROOT.classList.add('hb-ready');
    var demoBadge = byId('hb-demo-badge');
    if (demoBadge) demoBadge.style.display = state && state.mode === 'live' && (!Array.isArray(state.players) || !state.players.length) ? 'block' : 'none';
    if (!introPlayed) { introPlayed = true; playIntro(); }
    flashObjectives(previous);
  }
  function update(next) {
    if (!next || typeof next !== 'object') return;
    var previous = state; var previousCue = lastCueSeq; state = next;
    ROOT.classList.toggle('hb-hud-hidden', !!(next && next.hudHidden));
    renderAll(previous); applyScoreEffects(previous);
    var cue = next.broadcastCue || {}; var cueSeq = Number(cue.seq);
    var triggered = previous !== null && cue.type === 'hud-in' && Number.isFinite(cueSeq) && cueSeq !== previousCue;
    if (Number.isFinite(cueSeq)) lastCueSeq = cueSeq;
    if (triggered) replayIntro(true);
  }
  function fetchJson(url) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    return fetch(url, { cache: 'no-store' }).then(function (response) { return response && response.ok ? response.json() : null; }).catch(function () { return null; });
  }
  function buildShell() {
    ROOT.innerHTML = '<div class="hb-loading" id="hb-loading">正在连接比赛数据…</div>' +
      '<header class="hb-top" id="hb-topbar">' +
        '<span class="hb-demo-badge" id="hb-demo-badge" style="display:none;position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:80;padding:6px 14px;border:1px solid rgba(255,255,255,.35);border-radius:999px;background:rgba(8,12,22,.82);color:#fff;font:600 12px/1.2 sans-serif;letter-spacing:.12em;pointer-events:none;">DEMO · 等待比赛数据</span>' +
        '<div class="hb-timerboxes hb-left-boxes">' +
          '<div class="hb-timerbox" id="hb-timer-phase"><i id="hb-timer-phase-icon">' + SIGIL('grub') + '</i><em id="hb-timer-phase-value">—</em></div>' +
          '<div class="hb-timerbox" id="hb-timer-dragon"><i id="hb-timer-dragon-icon">' + SIGIL('dragon') + '</i><em id="hb-timer-dragon-value">—</em></div>' +
        '</div>' +
        '<div class="hb-scorebar" id="hb-scorebar">' +
          '<div class="hb-badge blue"><span class="hb-accent"></span><span class="hb-pips" id="hb-pips-blue"><i></i><i></i><i></i></span><span class="hb-logo" id="hb-logo-blue"><span class="hb-logo-fb">B</span></span><div class="hb-team-text"><b id="hb-name-blue">BLUE</b><small id="hb-meta-blue">BLUE SIDE</small></div></div>' +
          '<div class="hb-cluster">' +
            '<div class="hb-row1">' +
              '<span class="hb-stat hb-towers" id="hb-towers-stat-blue" data-obj="blue-towers" title="TOWER"><i>' + SIGIL('turret') + '</i><b id="hb-towers-blue">0</b></span>' +
              '<span class="hb-stat hb-gold" id="hb-goldstat-blue"><i>' + SIGIL('gold') + '</i><b id="hb-gold-blue">—</b></span>' +
              '<b class="hb-killnum" id="hb-kills-blue">0</b>' +
              '<span class="hb-killicon" id="hb-killicon">' + ICONS.kills + '</span>' +
              '<b class="hb-killnum" id="hb-kills-red">0</b>' +
              '<span class="hb-stat hb-gold" id="hb-goldstat-red"><i>' + SIGIL('gold') + '</i><b id="hb-gold-red">—</b></span>' +
              '<span class="hb-stat hb-towers" id="hb-towers-stat-red" data-obj="red-towers" title="TOWER"><b id="hb-towers-red">0</b><i>' + SIGIL('turret') + '</i></span>' +
              '<span class="hb-gold-diff" id="hb-gold-diff"><b>—</b></span>' +
            '</div>' +
            '<div class="hb-row2">' +
              '<span class="hb-stack" id="hb-stack-blue" data-obj="blue-dragons"></span>' +
              '<span class="hb-herald" id="hb-grubs-stat-blue" data-obj="blue-grubs" title="GRUBS"><i>' + SIGIL('grub') + '</i><b id="hb-grubs-blue">0</b></span>' +
              '<b class="hb-clock" id="hb-clock">00:00</b>' +
              '<span class="hb-herald" id="hb-grubs-stat-red" data-obj="red-grubs" title="GRUBS"><b id="hb-grubs-red">0</b><i>' + SIGIL('grub') + '</i></span>' +
              '<span class="hb-stack" id="hb-stack-red" data-obj="red-dragons"></span>' +
            '</div>' +
          '</div>' +
          '<div class="hb-badge red"><div class="hb-team-text"><b id="hb-name-red">RED</b><small id="hb-meta-red">RED SIDE</small></div><span class="hb-logo" id="hb-logo-red"><span class="hb-logo-fb">R</span></span><span class="hb-accent"></span><span class="hb-pips" id="hb-pips-red"><i></i><i></i><i></i></span></div>' +
        '</div>' +
        '<div class="hb-buff-slot hb-left" id="hb-buff-slot-blue"></div>' +
        '<div class="hb-buff-slot hb-right" id="hb-buff-slot-red"></div>' +
      '</header>' +
      '<div class="hb-native-cover hb-left" id="hb-native-cover-left"></div>' +
      '<div class="hb-bottom-stage" id="hb-bottom-stage"><div class="hb-bottom" id="hb-bottom">' +
        '<div class="hb-left-rail">' +
        '</div>' +
        '<div class="hb-board" id="hb-board">' +
          '<div class="hb-board-cover"></div>' +
          '<div class="hb-board-foot"></div>' +
          '<div class="hb-half blue" id="hb-rows-blue"><div class="hb-holes" id="hb-holes-blue"></div></div>' +
          '<div class="hb-mid" id="hb-mid"></div>' +
          '<div class="hb-half red" id="hb-rows-red"><div class="hb-holes" id="hb-holes-red"></div></div>' +
        '</div>' +
      '</div></div>';
  }
  // 小局比分演示覆盖：?series=1:0（蓝:红）。
  var demoSeries = null;
  try {
    var mSeries = /(?:^|&)series=([^&]+)/.exec(String(location.search || '').slice(1));
    if (mSeries) { var pSeries = decodeURIComponent(mSeries[1]).split(/[:\-]/); demoSeries = { blue: num(pSeries[0]), red: num(pSeries[1]) }; }
  } catch (eSeries) {}
  buildShell();
  // URL query 可现场覆盖原生 HUD 几何（OBS 里微调），再算一次孔位。
  applyQueryOverrides();
  loadCalibration();
  // 布局微调：先读文件再决定是否挂编辑层（?hudEdit=1 才挂）。
  loadLayoutOverrides().then(mountLayoutEditor);
  syncScale();
  syncBottomOffset();
  // 视口变化会改变整块缩放比例与 .hb-half 的屏幕像素尺寸，必须一起重算。
  try { window.addEventListener('resize', function () { syncScale(); syncBottomOffset(); syncHoles(); }); } catch (error) { /* 无 window 时忽略 */ }
  // 按 A 键一键隐藏/恢复全部 HUD 覆盖层（导播临时切干净画面）。
  try {
    document.addEventListener('keydown', function (event) {
      var key = event && event.key;
      if (key !== 'a' && key !== 'A') return;
      var t = event.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      // 全局 A 键钩子在服务端统一翻转 hudHidden（SSE 回推应用）；页面聚焦时走 POST 保证单一状态源。
      fetch('/api/hud-toggle', { method: 'POST' }).then(function (r) { return r && r.ok ? r.json() : null; }).then(function (data) { if (data && typeof data.hudHidden === 'boolean') ROOT.classList.toggle('hb-hud-hidden', data.hudHidden); }).catch(function () {});
    });
  } catch (error) { /* 无 document 时忽略 */ }
  if (typeof EventSource === 'function') {
    try {
      var stream = new EventSource('/events');
      stream.onmessage = function (event) { try { update(JSON.parse(event.data)); } catch (error) { /* 保留上一帧 */ } };
      // 编辑页保存后服务端推一份新布局过来：立刻套用，OBS 里的源不用重载。
      stream.addEventListener('hud-layout', function (event) {
        try {
          var items = JSON.parse(event.data);
          LAYOUT_ITEMS = items && typeof items === 'object' ? items : {};
          layoutApply(LAYOUT_ITEMS);
          layoutSyncHolesSoon();
        } catch (error) { /* 坏包忽略，保留当前布局 */ }
      });
    } catch (error) { /* 离线时保持静态占位 */ }
  }
  Promise.all([fetchJson('/api/state'), fetchJson('/api/broadcast-config')]).then(function (results) {
    var loadedState = results[0]; var loadedConfig = results[1];
    if (loadedConfig && typeof loadedConfig === 'object') config = loadedConfig;
    else if (loadedState && loadedState.broadcastConfig) config = loadedState.broadcastConfig;
    if (loadedState && typeof loadedState === 'object') { state = loadedState; renderAll(null); }
    else if (!state) { state = { blue: {}, red: {}, players: [], gameTime: 0 }; renderAll(null); }
    else renderAll(state);
  });
})();`;

function hudBroadcastPage() {
  const body = '<style data-hud-broadcast-theme>' + hudCss() + '</style>' +
    '<main id="hud-broadcast" class="hud-broadcast"><div class="hb-loading">正在连接比赛数据…</div></main>';
  // 资源条规格表在这里注入；函数式替换避免 $ 被当成替换模式。
  const pageScript = PAGE_SCRIPT.replace(/^  var RESOURCE_SPEC = .*$/m, () => '  var RESOURCE_SPEC = ' + resourceSpecScript() + ';');
  return htmlShell('Khada Jhin · HUD Broadcast', body, assets.clientScript() + '\n' + animationJs() + '\n' + pageScript);
}

module.exports = { hudBroadcastPage };
