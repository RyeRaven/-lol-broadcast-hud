const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPostGame, normalizeEogStats } = require('../src/post-game');

const eog = {
  gameLength: 1812,
  gameMode: 'CLASSIC',
  isWin: true,
  teams: [
    {
      teamId: 100,
      towerKills: 8, inhibitorKills: 2, dragonKills: 3, baronKills: 1,
      players: [
        { championId: 517, summonerName: 'TopStar', stats: { kills: 5, deaths: 2, assists: 3, goldEarned: 14200, totalDamageDealtToChampions: 24000, totalMinionsKilled: 180, neutralMinionsKilled: 12, visionScore: 21, item0: 6655 } },
        { championId: 99, stats: { kills: 3, deaths: 4, assists: 9, goldEarned: 11000, totalDamageDealtToChampions: 18000, totalMinionsKilled: 140, neutralMinionsKilled: 0, visionScore: 18 } }
      ]
    },
    {
      teamId: 200,
      towerKills: 2, inhibitorKills: 0, dragonKills: 1, baronKills: 0,
      players: [
        { championId: 134, summonerName: 'RedMid', stats: { kills: 4, deaths: 5, assists: 3, goldEarned: 12000, totalDamageDealtToChampions: 20000, totalMinionsKilled: 160, neutralMinionsKilled: 4, visionScore: 15 } }
      ]
    }
  ]
};

test('normalizes eog stats block into teams and players', () => {
  const data = normalizeEogStats(eog);
  assert.equal(data.players.length, 3);
  assert.equal(data.teams.blue.towers, 8);
  assert.equal(data.teams.red.dragons, 1);
  assert.equal(data.players[0].cs, 192);
  assert.equal(data.players[0].gold, 14200);
});

test('builds post game with damage share and kill participation', () => {
  const post = buildPostGame({ eog, championLabel: id => 'c' + id });
  assert.equal(post.source, 'eog');
  assert.equal(post.gameLength, 1812);
  assert.equal(post.blue.score, 8);
  assert.equal(post.red.score, 4);
  assert.equal(post.players.filter(p => p.team === 'blue').length, 2);
  const top = post.players.find(p => p.championId === 517);
  assert.equal(top.damagePct, 57.1);
  assert.equal(top.kp, 100);
});

test('falls back to frozen live snapshot when eog is missing', () => {
  const frozen = {
    gameTime: 900, gameMode: 'CLASSIC',
    players: [
      { name: 'A', team: 'blue', champion: '解脱者', kills: 3, deaths: 1, assists: 4, cs: 120, wardScore: 5, level: 12, items: ['#6655'] },
      { name: 'B', team: 'red', champion: '暗黑元首', kills: 1, deaths: 3, assists: 2, cs: 100, wardScore: 3, level: 11, items: [] }
    ],
    blue: { score: 3, towers: 2, dragons: 1, barons: 0 },
    red: { score: 1, towers: 0, dragons: 0, barons: 0 }
  };
  const post = buildPostGame({ eog: null, frozen });
  assert.equal(post.source, 'frozen');
  assert.equal(post.gameLength, 900);
  assert.equal(post.blue.towers, 2);
  assert.equal(post.players[0].name, 'A');
  assert.equal(post.players[1].champion, '暗黑元首');
});

test('frozen fallback keeps missing damage/gold as null instead of fake zeros', () => {
  const frozen = {
    gameTime: 600, gameMode: 'CLASSIC',
    players: [
      { name: 'A', team: 'blue', champion: '解脱者', kills: 3, deaths: 1, assists: 4, cs: 120, wardScore: 5, level: 12, items: [] },
      { name: 'B', team: 'red', champion: '暗黑元首', kills: 1, deaths: 3, assists: 2, cs: 100, wardScore: 3, level: 11, items: [] }
    ],
    blue: { score: 3, towers: 2, dragons: 1, barons: 0 },
    red: { score: 1, towers: 0, dragons: 0, barons: 0 }
  };
  const post = buildPostGame({ eog: null, frozen });
  const a = post.players[0];
  assert.equal(a.gold, null, 'frozen 快照没有金币，不许伪造 0');
  assert.equal(a.damage, null);
  assert.equal(a.taken, null);
  assert.equal(a.damagePct, null);
  assert.equal(a.takenPct, null);
  assert.equal(a.gd, null);
});

test('returns null when neither source has players', () => {
  assert.equal(buildPostGame({ eog: null, frozen: null }), null);
});

test('fills missing team with zero values and keeps source error', () => {
  const block = {
    gameId: 12345,
    gameLength: 100,
    gameMode: 'CLASSIC',
    teams: [{ teamId: 100, towerKills: 2, players: [{ championId: 1, summonerName: 'Blue', stats: { kills: 2 } }] }]
  };
  const data = normalizeEogStats(block);
  assert.deepEqual(data.missingTeams, ['red']);
  assert.equal(data.error, 'missing_team:red');
  assert.equal(data.teams.red.towers, 0);
  const post = buildPostGame({ eog: block });
  assert.equal(post.source, 'eog');
  assert.equal(post.error, 'missing_team:red');
  assert.equal(post.blue.towers, 2);
  assert.equal(post.red.score, 0);
});
