const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDraftSession } = require('../src/draft');

const session = {
  actions: [
    [
      { actorCellId: 0, championId: 1, completed: true, type: 'ban' },
      { actorCellId: 5, championId: 2, completed: true, type: 'ban' }
    ],
    [{ actorCellId: 0, championId: 10, completed: false, type: 'pick', isInProgress: true }],
    [{ actorCellId: 1, championId: 11, completed: true, type: 'pick' }]
  ],
  myTeam: [{ cellId: 0, championId: 99 }],
  theirTeam: [{ cellId: 5, championId: 12 }],
  timer: { phase: 'BAN_PICK', adjustedTimeLeftInPhase: 21000 }
};

test('only completed actions count as picks and bans', () => {
  const draft = normalizeDraftSession(session);
  assert.deepEqual(draft.bluePicks, ['11']);
  assert.deepEqual(draft.redPicks, []);
  assert.deepEqual(draft.blueBans, ['1']);
  assert.deepEqual(draft.redBans, ['2']);
  assert.equal(draft.timer, 21);
  assert.equal(draft.phase, '选人阶段');
  assert.equal(draft.active, 'blue');
  assert.equal(draft.parsed, true);
});

test('falls back to team champions only when there are no actions', () => {
  const draft = normalizeDraftSession({ actions: [], myTeam: [{ cellId: 0, championId: 99 }], theirTeam: [{ cellId: 5, championId: 12 }] });
  assert.deepEqual(draft.bluePicks, ['99']);
  assert.deepEqual(draft.redPicks, ['12']);
  assert.equal(draft.parsed, true);
});

test('empty session is not parsed', () => {
  const draft = normalizeDraftSession({ actions: [], myTeam: [], theirTeam: [] });
  assert.equal(draft.parsed, false);
  assert.deepEqual(draft.bluePicks, []);
  assert.equal(normalizeDraftSession(null), null);
});

test('custom resolver maps champion ids to names', () => {
  const draft = normalizeDraftSession(session, id => 'champ-' + id);
  assert.deepEqual(draft.bluePicks, ['champ-11']);
  assert.deepEqual(draft.blueBans, ['champ-1']);
});

test('finalization fills gaps from team champions (real custom-game shape)', () => {
  const real = {
    actions: [
      [{ type: 'phase_transition', actorCellId: -1, championId: 0, completed: true }],
      [{ type: 'ban', actorCellId: 0, championId: 75, completed: true }],
      [{ type: 'pick', actorCellId: 0, championId: 799, completed: true }]
    ],
    myTeam: [
      { cellId: 0, championId: 799 }, { cellId: 1, championId: 29 }, { cellId: 2, championId: 201 },
      { cellId: 3, championId: 122 }, { cellId: 4, championId: 1 }
    ],
    theirTeam: [
      { cellId: 5, championId: 75 }, { cellId: 6, championId: 4 }, { cellId: 7, championId: 29 },
      { cellId: 8, championId: 16 }, { cellId: 9, championId: 19 }
    ],
    timer: { phase: 'FINALIZATION', adjustedTimeLeftInPhase: 58213 }
  };
  const draft = normalizeDraftSession(real, id => 'c' + id);
  assert.deepEqual(draft.bluePicks, ['c799', 'c29', 'c201', 'c122', 'c1']);
  assert.deepEqual(draft.redPicks, ['c75', 'c4', 'c29', 'c16', 'c19']);
  assert.deepEqual(draft.blueBans, ['c75']);
  assert.equal(draft.phase, '最终调整');
  assert.equal(draft.parsed, true);
});

test('ban_pick hover values are ignored even when team champions exist', () => {
  const draft = normalizeDraftSession({
    actions: [[{ type: 'pick', actorCellId: 2, championId: 7, completed: true }]],
    myTeam: [{ cellId: 0, championId: 99 }, { cellId: 2, championId: 7 }],
    theirTeam: [{ cellId: 5, championId: 12 }],
    timer: { phase: 'BAN_PICK', adjustedTimeLeftInPhase: 5000 }
  });
  assert.deepEqual(draft.bluePicks, ['7']);
  assert.deepEqual(draft.redPicks, []);
});

test('real matchmaking draft fixture parses 10 picks and 10 bans', () => {
  const fixture = require('./fixtures/session-real-draft.json');
  const draft = normalizeDraftSession(fixture, id => 'c' + id);
  assert.equal(draft.bluePicks.length, 5);
  assert.equal(draft.redPicks.length, 5);
  assert.equal(draft.blueBans.length, 5);
  assert.equal(draft.redBans.length, 5);
  assert.equal(draft.parsed, true);
  assert.equal(draft.phase, '最终调整');
});

test('ban hover preview lands in fixed cell slots and vanishes once completed', () => {
  const draft = normalizeDraftSession({
    actions: [
      [{ type: 'ban', actorCellId: 0, championId: 1, completed: true }],
      [{ type: 'ban', actorCellId: 5, championId: 3, completed: false, isInProgress: true }]
    ],
    myTeam: [], theirTeam: [], timer: {}
  }, id => 'c' + id);
  // 已锁定的 ban 进 blueBans，不进悬停；未锁定的红方 ban 悬停按 cellId 槽位（5 → red[0]）。
  assert.deepEqual(draft.blueBans, ['c1']);
  assert.deepEqual(draft.blueBanHover, [null, null, null, null, null]);
  assert.deepEqual(draft.redBanHover, ['c3', null, null, null, null]);
});

test('ban hover is all null when nothing is hovering', () => {
  const draft = normalizeDraftSession({ actions: [], myTeam: [], theirTeam: [], timer: {} });
  assert.deepEqual(draft.blueBanHover, [null, null, null, null, null]);
  assert.deepEqual(draft.redBanHover, [null, null, null, null, null]);
});
