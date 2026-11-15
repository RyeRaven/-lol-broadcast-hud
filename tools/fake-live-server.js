'use strict';
// 本地假 Live Client Data，用于端到端验证（真实对局时由客户端在 :2999 提供同样的形状）。
const http = require('http');
const port = Number(process.argv[2] || 3299);
const payload = {
  gameData: { gameTime: 812.4, gameMode: 'CLASSIC', mapName: 'Map11' },
  allPlayers: [
    { summonerName: 'TopStar', team: 'ORDER', championName: 'Jayce', level: 11, isDead: false, respawnTimer: 0, position: 'TOP', scores: { kills: 3, deaths: 1, assists: 4, creepScore: 142, wardScore: 7 }, items: [{ itemID: 3153, displayName: '破败王者之刃' }], summonerSpells: { summonerSpellOne: { displayName: '闪现' }, summonerSpellTwo: { displayName: '传送' } } },
    { summonerName: 'RiftKing', team: 'ORDER', championName: 'Sett', level: 10, isDead: false, scores: { kills: 1, deaths: 2, assists: 6, creepScore: 118 } },
    { summonerName: 'Midnight', team: 'ORDER', championName: 'Syndra', level: 11, isDead: true, respawnTimer: 9, scores: { kills: 2, deaths: 3, assists: 2, creepScore: 156 } },
    { summonerName: 'CrispAim', team: 'ORDER', championName: 'Ezreal', level: 9, isDead: false, scores: { kills: 4, deaths: 1, assists: 3, creepScore: 168 } },
    { summonerName: 'Anchor', team: 'ORDER', championName: 'Nautilus', level: 9, isDead: false, scores: { kills: 0, deaths: 2, assists: 8, creepScore: 34 } },
    { summonerName: 'RedTop', team: 'CHAOS', championName: 'Renekton', level: 10, isDead: false, scores: { kills: 2, deaths: 3, assists: 2, creepScore: 131 } },
    { summonerName: 'JungleX', team: 'CHAOS', championName: 'XinZhao', level: 10, isDead: false, scores: { kills: 1, deaths: 2, assists: 5, creepScore: 104 } },
    { summonerName: 'FoxMid', team: 'CHAOS', championName: 'Ahri', level: 11, isDead: false, scores: { kills: 3, deaths: 1, assists: 4, creepScore: 149 } },
    { summonerName: 'MoonShot', team: 'CHAOS', championName: 'Aphelios', level: 10, isDead: false, scores: { kills: 4, deaths: 2, assists: 1, creepScore: 175 } },
    { summonerName: 'Shield', team: 'CHAOS', championName: 'Leona', level: 8, isDead: false, scores: { kills: 1, deaths: 3, assists: 7, creepScore: 41 } }
  ],
  events: { Events: [
    { EventID: 1, EventName: 'TurretKilled', KillerName: 'Aphelios', EventTime: 540 },
    { EventID: 2, EventName: 'DragonKill', KillerName: 'XinZhao', EventTime: 610 },
    { EventID: 3, EventName: 'ChampionKill', KillerName: 'Jayce', EventTime: 700 },
    { EventID: 4, EventName: 'TurretKilled', KillerName: 'Ezreal', EventTime: 760 }
  ] },
  activePlayer: { summonerName: 'TopStar', currentGold: 1234.5, level: 11, championName: 'Jayce' }
};
http.createServer((req, res) => {
  if (req.url.startsWith('/liveclientdata/allgamedata')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(payload)); }
  res.writeHead(404); res.end('{}');
}).listen(port, '127.0.0.1', () => console.log('fake live client on ' + port));
