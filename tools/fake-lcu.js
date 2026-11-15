'use strict';

// 假 LCU（League Client Update）服务：仅用于本地端到端测试。
// 在 https://127.0.0.1:<port> 上模拟真实客户端的少量只读接口，并用自签名证书完成 TLS 握手。
// 绝不连接、读取或修改真实客户端；测试端口从 3212-3219 中挑选（默认 3299）。
//
// 用法：
//   node tools/fake-lcu.js <port> [--token <remoting-auth-token>] [--script ChampSelect,InProgress,PreEndOfGame] [--advance-ms 400]
//
// 控制接口（仅供测试，非 LCU 官方接口）：
//   GET  /__control/state           -> { phase, script, scriptIndex, requests, authFailures }
//   POST /__control/phase { phase } -> 立即切换相位
//   POST /__control/reset           -> 复位相位与计数器
//
// 模块用法：
//   const { createFakeLcu, DRAFT_SESSION, EOG_STATS_BLOCK, DEFAULT_TOKEN } = require('../tools/fake-lcu');

const https = require('https');
const { URL } = require('url');

const DEFAULT_TOKEN = ['local', 'fake', 'lcu'].join('-');

// 本地测试专用的自签名证书（CN=127.0.0.1），只用于让 https 模块完成握手；
// 不是任何真实 Riot 客户端的密钥，也不对应任何线上服务。
const TLS_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDkhA22vCB3TRXM\ntjXQP3Y8duFuxgXbxGhpFyGVRlFHNLXD2w2lEKMss2P3A5sYH82xsIyb3ycRPMN0\n5Ju8quAd5TGaZ2BaFwn/Cmoegh2Mu6HWyGrRsmZL9X5R5Kd76x44QhDp6hSNR28X\njtydMo8COzHIT0WMATq32O0i36M1ehEJjOg5eciILm505ceJCeu9mFqXf2+O/0uZ\nWL0oBuycn/zronKXH6rvGBm8feLaNhwB1wboLtUrQzbIJN4szW/NQEYNy50HgGa5\nXpOXMm1CEM0yMok2BIzE+8SRH7HCQHlbKItEdQImTpBYVlKhDudS2UGoBJsSgDA+\n/gWJJG/pAgMBAAECggEAKt2Aiw4oEujxVWi6mHlHDxmHuRVJRQvHQCtYH93EYlSH\nYhllqliAG2L9NflFrxVMKvBAt/54oBmjWnqFojL1fnYfQ2Tv5IZc2CwWcumabGtH\n9Pe8XeCWotoGm4sGRc75aLkv3gkMWOIU+zjPtmck/1imQnpoQ9Z5MsJs3TVRMrb7\n3CXlCQxXaCidn6+fA9nWzMROmFhBVYfral0N4pqsTyLmAFskux2iAUqAqqKG0gxK\nYf7pgUMhOFji+cSjOe1d+6yv4cWsZgK+e5VmIihWCyGNBsgFntcYCWlcTUIv+OL7\nVgk0/tpQz0Zvio0xAQs5z8J0sHR2GTebrCdiUH3CGQKBgQDzI5r1FiYy6toSMJU8\n90Px9WFqZoqXZo2jWZkOqgFrOjLk6khadjLU2gvWAFVqWAs/DHijJ3eQJkP+b/SL\nJiYOhc/c/CV+EgBr2ItaZvbik03cxTTSHZN8owBflMokUdmXOPOT4XWV8zdGpMDr\nxVkq6eB0Z3WC3RahWsfyfCynfQKBgQDwmm6T4TZ72vKDTjtulSEJNeHNWXkAD63O\n+c0w84+6AkmrVHJ3ifGHkR4B7aHFg5zFm9m9nX1BGDxyRg8hhqWMoj/DrNFhF5tP\nyAQHxZfsW76dahB1eLI5UpEKs2Ci8DXRPAxxMg4JqJCEyjbmuSMjT+zpjcrGaypM\nD84cdziN3QKBgQDr9sslPmi2E6yt6I59i29afA0dyQSJ6NJfDM55J86WtPW9qg2s\nFXhBkJfaCZrbyTSo7L6LgPsNX8WvQhHvlYdrorvXuLHeRzQ3dgHQK4tA2zq+nnkj\nzeZcGIl9OZZwZysoEvJ5u151t4QWwEAm0PE3r6DQ97NY3J5g3AyerZpctQKBgQDo\nOqbwZThJY5Mf2arTmW1BjphbtDhuLrP8SnAbB3t6dirVC7VQW/ycdR0Zj1vNYLM4\nqK0Jr7Dt2468XZLNMUEo9JHHNE8D/90QrGX3emig4gyhs3YfbFfZrDACvBBSNLg9\nNFBuEXorKGAVS3iiSZ/4vXRWGV3XFijFMZwnLYuQoQKBgCq6sHoHasCXt0WDXf+H\nWNSO6gwDly+vpFErH4MzYjgeSvFFZJIVC3CvFuc2G2NvPAkGfgoQcXxnP9SClMuY\nKCGMSXA34QKiWTiEkz7EuZvHXABhd4brmhFEdhO/ymMRM5jrP/35gkkHP0QLc9xf\nJ9kNzvrdiZ5PZldDpKtRpfdn\n-----END PRIVATE KEY-----";
const TLS_CERT = "-----BEGIN CERTIFICATE-----\nMIIDGjCCAgKgAwIBAgIUd8StkVHWmY6O+uqHPwE9hdDQZlcwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTExMjE4MTcxN1oXDTM2MTEw\nOTE4MTcxN1owFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEA5IQNtrwgd00VzLY10D92PHbhbsYF28RoaRchlUZRRzS1\nw9sNpRCjLLNj9wObGB/NsbCMm98nETzDdOSbvKrgHeUxmmdgWhcJ/wpqHoIdjLuh\n1shq0bJmS/V+UeSne+seOEIQ6eoUjUdvF47cnTKPAjsxyE9FjAE6t9jtIt+jNXoR\nCYzoOXnIiC5udOXHiQnrvZhal39vjv9LmVi9KAbsnJ/866Jylx+q7xgZvH3i2jYc\nAdcG6C7VK0M2yCTeLM1vzUBGDcudB4BmuV6TlzJtQhDNMjKJNgSMxPvEkR+xwkB5\nWyiLRHUCJk6QWFZSoQ7nUtlBqASbEoAwPv4FiSRv6QIDAQABo2QwYjAdBgNVHQ4E\nFgQUO676akIPYiEe9G2E6U1Z5x+hcIMwHwYDVR0jBBgwFoAUO676akIPYiEe9G2E\n6U1Z5x+hcIMwDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG\nSIb3DQEBCwUAA4IBAQAHJI/wkgtcS7i0XitSlj1387H2FnSr7ty0uLZA8ZZrc8FM\n99GXo7LLNHpEgh/VA5e9ku3lBg7EqKh/hPKL0tVhovYTEKIyRR+3ZKmcb7YuWwtU\ngo/Wlo45sJqzaMO9QeXc+Hi/Dpz+5Wp33xUoijF70qeN9JIvXg/sIlguMyVabL0A\nAbHtF8O/WIudPImWwrVxTFbKmxuNOieCggkpX71XOLci1elpmzwAgIdHvSQYpSdt\nnQgyBoAtCYZqWGrcvi8EdfiySQqQm8lBgUUEsoOEd93vfJgv4THhZhSsZNoYmM1X\nOgsVn/k1B7Vj0mph0Y8lSKtfBxlWJOmNeBs1oTOx\n-----END CERTIFICATE-----";

const POSITIONS = ['top', 'jungle', 'middle', 'bottom', 'utility'];

function draftMember(cellId, championId) {
  return {
    cellId,
    championId,
    assignedPosition: POSITIONS[cellId % 5],
    summonerId: 'fake-summoner-' + cellId,
    summonerName: 'FakePlayer' + cellId
  };
}

function draftAction(id, actorCellId, championId, type) {
  return { id, actorCellId, championId, type, completed: true, isInProgress: false, isAllyAction: actorCellId < 5 };
}

// 一份完整的 BAN_PICK 阶段 BP 会话：6 ban + 10 pick，全部 completed。
const DRAFT_SESSION = {
  gameId: 900001,
  timer: { phase: 'BAN_PICK', adjustedTimeLeftInPhase: 21000, totalTimeInPhase: 30000, isInfinite: false },
  myTeam: [0, 1, 2, 3, 4].map(cellId => draftMember(cellId, 0)),
  theirTeam: [5, 6, 7, 8, 9].map(cellId => draftMember(cellId, 0)),
  actions: [
    [
      draftAction(1, 0, 301, 'ban'),
      draftAction(2, 5, 302, 'ban'),
      draftAction(3, 1, 303, 'ban'),
      draftAction(4, 6, 304, 'ban'),
      draftAction(5, 2, 305, 'ban'),
      draftAction(6, 7, 306, 'ban')
    ],
    [
      draftAction(11, 0, 101, 'pick'),
      draftAction(12, 5, 201, 'pick'),
      draftAction(13, 1, 102, 'pick'),
      draftAction(14, 6, 202, 'pick'),
      draftAction(15, 2, 103, 'pick'),
      draftAction(16, 7, 203, 'pick'),
      draftAction(17, 3, 104, 'pick'),
      draftAction(18, 8, 204, 'pick'),
      draftAction(19, 4, 105, 'pick'),
      draftAction(20, 9, 205, 'pick')
    ]
  ]
};

function eogPlayer(championId, summonerName, stats) {
  return { championId, summonerName, championName: '', stats };
}

// 一份完整的 eog-stats-block：蓝方 25 杀/8 塔，红方 10 杀/3 塔，负方也有完整数据。
const EOG_STATS_BLOCK = {
  gameId: 900001,
  gameLength: 1520,
  gameMode: 'CLASSIC',
  isWin: true,
  teams: [
    {
      teamId: 100,
      towerKills: 8,
      inhibitorKills: 2,
      dragonKills: 3,
      baronKills: 1,
      players: [
        eogPlayer(101, 'BlueTop', { kills: 5, deaths: 2, assists: 7, goldEarned: 13500, totalDamageDealtToChampions: 24500, totalMinionsKilled: 210, neutralMinionsKilled: 12, visionScore: 24, champLevel: 15, item0: 3153, item1: 3006 }),
        eogPlayer(102, 'BlueJungle', { kills: 4, deaths: 3, assists: 11, goldEarned: 12100, totalDamageDealtToChampions: 18200, totalMinionsKilled: 96, neutralMinionsKilled: 84, visionScore: 31, champLevel: 14, item0: 3134, item1: 3111 }),
        eogPlayer(103, 'BlueMid', { kills: 8, deaths: 1, assists: 6, goldEarned: 14800, totalDamageDealtToChampions: 31200, totalMinionsKilled: 232, neutralMinionsKilled: 8, visionScore: 18, champLevel: 16, item0: 3157, item1: 3020 }),
        eogPlayer(104, 'BlueAdc', { kills: 6, deaths: 2, assists: 9, goldEarned: 15200, totalDamageDealtToChampions: 27800, totalMinionsKilled: 248, neutralMinionsKilled: 4, visionScore: 15, champLevel: 15, item0: 3508, item1: 6672 }),
        eogPlayer(105, 'BlueSupport', { kills: 2, deaths: 2, assists: 16, goldEarned: 9400, totalDamageDealtToChampions: 7600, totalMinionsKilled: 28, neutralMinionsKilled: 0, visionScore: 62, champLevel: 12, item0: 3860, item1: 3046 })
      ]
    },
    {
      teamId: 200,
      towerKills: 3,
      inhibitorKills: 0,
      dragonKills: 1,
      baronKills: 0,
      players: [
        eogPlayer(201, 'RedTop', { kills: 2, deaths: 5, assists: 3, goldEarned: 10800, totalDamageDealtToChampions: 16800, totalMinionsKilled: 198, neutralMinionsKilled: 16, visionScore: 20, champLevel: 13, item0: 3071, item1: 3006 }),
        eogPlayer(202, 'RedJungle', { kills: 1, deaths: 6, assists: 6, goldEarned: 9600, totalDamageDealtToChampions: 12400, totalMinionsKilled: 78, neutralMinionsKilled: 92, visionScore: 26, champLevel: 12, item0: 3111, item1: 3134 }),
        eogPlayer(203, 'RedMid', { kills: 3, deaths: 4, assists: 2, goldEarned: 11500, totalDamageDealtToChampions: 22100, totalMinionsKilled: 214, neutralMinionsKilled: 6, visionScore: 14, champLevel: 14, item0: 3157, item1: 3020 }),
        eogPlayer(204, 'RedAdc', { kills: 4, deaths: 3, assists: 1, goldEarned: 12600, totalDamageDealtToChampions: 24300, totalMinionsKilled: 236, neutralMinionsKilled: 8, visionScore: 12, champLevel: 14, item0: 3508, item1: 6672 }),
        eogPlayer(205, 'RedSupport', { kills: 0, deaths: 4, assists: 7, goldEarned: 8100, totalDamageDealtToChampions: 5400, totalMinionsKilled: 22, neutralMinionsKilled: 0, visionScore: 55, champLevel: 11, item0: 3860, item1: 3046 })
      ]
    }
  ]
};

function basicAuthOk(header, token) {
  if (typeof header !== 'string' || header.indexOf('Basic ') !== 0) return false;
  let decoded = '';
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  return decoded === 'riot:' + token;
}

function readRequestBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

function createFakeLcu(options = {}) {
  const token = options.token || process.env.FAKE_LCU_TOKEN || DEFAULT_TOKEN;
  const script = Array.isArray(options.script) ? options.script.map(String).filter(Boolean) : [];
  const advanceDelayMs = Number.isFinite(Number(options.advanceDelayMs)) ? Number(options.advanceDelayMs) : 400;
  const initialPhase = options.phase || script[0] || 'ChampSelect';
  let phase = initialPhase;
  let sessionMissing = Boolean(options.sessionMissing);
  let scriptIndex = 0;
  let lastServedAt = 0;
  const requests = { gameflow: 0, session: 0, eog: 0, control: 0 };
  let authFailures = 0;

  // 脚本模式：每次 gameflow 轮询按 script 顺序推进，但两次推进至少间隔 advanceDelayMs，
  // 避免同一轮轮询后紧跟着的 /lol-champ-select/v1/session 读到一个已经推进过的相位。
  function scriptedPhase() {
    const now = Date.now();
    if (lastServedAt > 0 && scriptIndex < script.length - 1 && now - lastServedAt >= advanceDelayMs) {
      scriptIndex += 1;
    }
    lastServedAt = now;
    phase = script[scriptIndex];
    return phase;
  }

  const server = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    const url = new URL(req.url || '/', 'https://127.0.0.1');
    const pathname = url.pathname;
    const send = (code, value) => {
      const body = JSON.stringify(value);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (pathname.indexOf('/__control/') === 0) {
      requests.control += 1;
      if (pathname === '/__control/state' && req.method === 'GET') {
        return send(200, { phase, script, scriptIndex, requests: { ...requests }, authFailures });
      }
      if (pathname === '/__control/phase' && (req.method === 'POST' || req.method === 'GET')) {
        const queryPhase = url.searchParams.get('value');
        if (queryPhase) {
          phase = queryPhase;
          const index = script.indexOf(queryPhase);
          if (index >= 0) scriptIndex = index;
          return send(200, { ok: true, phase });
        }
        return readRequestBody(req).then(body => {
          if (body && body.phase) {
            phase = String(body.phase);
            const index = script.indexOf(phase);
            if (index >= 0) scriptIndex = index;
          }
          send(200, { ok: true, phase });
        });
      }
      if (pathname === '/__control/reset' && req.method === 'POST') {
        phase = initialPhase;
        scriptIndex = 0;
        lastServedAt = 0;
        requests.gameflow = 0;
        requests.session = 0;
        requests.eog = 0;
        requests.control = 0;
        authFailures = 0;
        return send(200, { ok: true, phase });
      }
      return send(404, { errorCode: 'NOT_FOUND', message: 'unsupported control route: ' + pathname });
    }

    if (!basicAuthOk(req.headers.authorization, token)) {
      authFailures += 1;
      return send(401, { errorCode: 'UNAUTHORIZED', httpStatus: 401, message: 'invalid remoting auth token' });
    }

    if (pathname === '/lol-gameflow/v1/gameflow-phase' && req.method === 'GET') {
      requests.gameflow += 1;
      return send(200, script.length ? scriptedPhase() : phase);
    }

    if (pathname === '/lol-champ-select/v1/session' && req.method === 'GET') {
      requests.session += 1;
      if (sessionMissing || phase !== 'ChampSelect') return send(404, { errorCode: 'NOT_FOUND', message: 'champ select session is not available in phase ' + phase });
      return send(200, DRAFT_SESSION);
    }

    if (pathname === '/lol-end-of-game/v1/eog-stats-block' && req.method === 'GET') {
      requests.eog += 1;
      const available = phase === 'PreEndOfGame' || phase === 'EndOfGame' || phase === 'WaitForStatsScreen';
      if (!available) return send(404, { errorCode: 'NOT_FOUND', message: 'eog stats block is not available in phase ' + phase });
      return send(200, EOG_STATS_BLOCK);
    }

    return send(404, { errorCode: 'NOT_FOUND', message: 'unsupported fake LCU route: ' + pathname });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(options.port) || 0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        url: 'https://127.0.0.1:' + address.port,
        setPhase(value) { phase = String(value); },
        setSessionMissing(value) { sessionMissing = Boolean(value); },
        getState() { return { phase, script: script.slice(), scriptIndex, requests: { ...requests }, authFailures }; },
        close() { return new Promise(done => server.close(done)); }
      });
    });
  });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const port = Number(argv[0]) > 0 ? Number(argv[0]) : 3299;
  let token = null;
  let script = [];
  let advanceDelayMs = null;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--token') { token = argv[i + 1]; i += 1; }
    else if (argv[i] === '--script') { script = String(argv[i + 1] || '').split(',').map(s => s.trim()).filter(Boolean); i += 1; }
    else if (argv[i] === '--advance-ms') { advanceDelayMs = Number(argv[i + 1]); i += 1; }
  }
  createFakeLcu({ port, token, script, advanceDelayMs }).then(instance => {
    console.log('fake lcu listening on ' + instance.port);
  }).catch(error => {
    console.error('fake lcu failed: ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { createFakeLcu, DRAFT_SESSION, EOG_STATS_BLOCK, DEFAULT_TOKEN };
