'use strict';

// 只做纯解析：输入 LCU /lol-champ-select/v1/session，输出可直接渲染的 BP 结构。
// 关键点：championId 在 completed 之前会随悬停变化，必须只认 completed 的 action；
// session.bans 在现代客户端恒为空，真正的 ban 在 actions 里。

const TIMER_PHASE_LABELS = {
  PLANNING: '禁用阶段',
  BAN_PICK: '选人阶段',
  FINALIZATION: '最终调整',
  GAME_STARTING: '进入游戏'
};

function flattenActions(session) {
  if (!Array.isArray(session.actions)) return [];
  return session.actions.flat().filter(action => action && typeof action === 'object');
}

function collectCompletedPicks(actions) {
  const picks = new Map();
  for (const action of actions) {
    if (!action.completed || action.type !== 'pick') continue;
    const cellId = Number(action.actorCellId);
    const championId = Number(action.championId);
    if (Number.isFinite(cellId) && championId > 0) picks.set(cellId, championId);
  }
  return picks;
}

function collectCompletedBans(actions) {
  const bans = [];
  for (const action of actions) {
    if (!action.completed || action.type !== 'ban') continue;
    const championId = Number(action.championId);
    if (championId > 0) bans.push({ cellId: Number(action.actorCellId), championId });
  }
  return bans;
}

// 悬停预览：未 completed 的 pick action.championId 就是选手当前悬停的英雄，
// 同一 cell 后面的悬停覆盖前面的（Map set 语义天然如此）。
function collectHoverPicks(actions) {
  const hover = new Map();
  for (const action of actions) {
    if (action.completed || action.type !== 'pick') continue;
    const cellId = Number(action.actorCellId);
    const championId = Number(action.championId);
    if (Number.isFinite(cellId) && championId > 0) hover.set(cellId, championId);
  }
  return hover;
}

function collectTeamChampions(team) {
  const picks = new Map();
  for (const member of team) {
    if (!member || typeof member !== 'object') continue;
    const cellId = Number(member.cellId);
    const championId = Number(member.championId);
    if (Number.isFinite(cellId) && championId > 0) picks.set(cellId, championId);
  }
  return picks;
}

// 自定义对局/盲选的实际结构：actions 里可能只有零星几条，真正的阵容在 myTeam/theirTeam.championId。
// 但 BAN_PICK 阶段这些字段是悬停值，只有进入 FINALIZATION 之后才可信。
function resolvePicks(actions, team, timerPhase) {
  const picks = collectCompletedPicks(actions);
  const finalizing = timerPhase === 'FINALIZATION' || timerPhase === 'GAME_STARTING';
  if (!actions.length || finalizing) {
    for (const [cellId, championId] of collectTeamChampions(team)) {
      if (!picks.has(cellId)) picks.set(cellId, championId);
    }
  }
  return picks;
}

function normalizeDraftSession(session, resolveName = id => String(id)) {
  if (!session || typeof session !== 'object') return null;
  const actions = flattenActions(session);
  const team = [
    ...(Array.isArray(session.myTeam) ? session.myTeam : []),
    ...(Array.isArray(session.theirTeam) ? session.theirTeam : [])
  ];
  const timer = session.timer && typeof session.timer === 'object' ? session.timer : {};
  const picks = resolvePicks(actions, team, timer.phase);
  const bans = collectCompletedBans(actions);

  const bluePicks = [];
  const redPicks = [];
  const blueBans = [];
  const redBans = [];
  for (let cellId = 0; cellId < 10; cellId += 1) {
    const championId = picks.get(cellId);
    if (!championId) continue;
    (cellId < 5 ? bluePicks : redPicks).push(resolveName(championId));
  }
  for (const ban of bans) (ban.cellId < 5 ? blueBans : redBans).push(resolveName(ban.championId));

  const secondsLeft = Number(timer.adjustedTimeLeftInPhase);
  const inProgress = actions.find(action => action.isInProgress === true);

  // 分路：LCDA 局内 position 恒为 NONE，唯一可靠来源是 BP 阶段 champ select 的 cell.assignedPosition。
  // cellId 顺序即参赛者顺序（blue 0-4 / red 5-9，标准 5v5），回填到局内 player.position 供 HUD/赛后页排序。
  const cellRoles = new Map();
  for (const member of team) {
    if (!member || typeof member !== 'object') continue;
    const cellId = Number(member.cellId);
    const rawRole = String(member.assignedPosition || '').toUpperCase();
    const role = ROLE_ALIASES[rawRole] || null;
    if (Number.isFinite(cellId) && cellId >= 0 && cellId < 10 && role) cellRoles.set(cellId, role);
  }
  // 固定槽位映射：cellId i → 第 i 号参赛者，缺位留 null，保持 5 槽与参赛者一一对应。
  const blueRoles = [0, 1, 2, 3, 4].map(cellId => cellRoles.get(cellId) || null);
  const redRoles = [5, 6, 7, 8, 9].map(cellId => cellRoles.get(cellId) || null);

  // 悬停预览：固定 cellId 槽位（blue 0-4 / red 5-9），锁定后该 action completed，悬停自然消失。
  const hover = collectHoverPicks(actions);
  const blueHover = [null, null, null, null, null];
  const redHover = [null, null, null, null, null];
  for (let cellId = 0; cellId < 10; cellId += 1) {
    const championId = hover.get(cellId);
    if (!championId) continue;
    (cellId < 5 ? blueHover : redHover)[cellId % 5] = resolveName(championId);
  }

  return {
    blueRoles,
    redRoles,
    bluePicks,
    redPicks,
    blueBans,
    redBans,
    blueHover,
    redHover,
    timer: Number.isFinite(secondsLeft) ? Math.max(0, Math.ceil(secondsLeft / 1000)) : null,
    phase: TIMER_PHASE_LABELS[timer.phase] || null,
    // actorCellId 缺失/非数字时不能落到 red 分支（NaN < 5 为 false 的坑），归 null 表示未知。
    active: inProgress && Number.isFinite(Number(inProgress.actorCellId))
      ? (Number(inProgress.actorCellId) < 5 ? 'blue' : 'red')
      : null,
    actionCount: actions.length,
    parsed: picks.size > 0 || bans.length > 0
  };
}

// LCU assignedPosition 词表 → HUD ROLE_ORDER 词表（hud-broadcast.js）。
const ROLE_ALIASES = { TOP: 'TOP', JUNGLE: 'JUNGLE', MIDDLE: 'MID', MID: 'MID', BOTTOM: 'ADC', ADC: 'ADC', UTILITY: 'SUPPORT', SUPPORT: 'SUPPORT' };

module.exports = { normalizeDraftSession, resolvePicks, TIMER_PHASE_LABELS };
