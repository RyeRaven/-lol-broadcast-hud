'use strict';

// 回放上传（rofl）测试：解析器单元用例 + 合成回放经 HTTP 导入的端到端用例。
// 合成回放只构造解析器真正读的区段（头部 magic/version + 尾部 metadata），中间字节任意。

const test = require('node:test');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');
const { parseRoflResult, buildRoflPostGame } = require('../src/rofl-result');

function statRow(over) {
  return Object.assign({
    RIOT_ID_GAME_NAME: '', RIOT_ID_TAG_LINE: '', NAME: '',
    SKIN: '', TEAM: '100', WIN: 'Win',
    INDIVIDUAL_POSITION: 'TOP',
    CHAMPIONS_KILLED: 0, NUM_DEATHS: 0, ASSISTS: 0,
    GOLD_EARNED: 10000, MINIONS_KILLED: 200, NEUTRAL_MINIONS_KILLED: 20,
    LEVEL: 18, ITEM0: '0', ITEM1: '0', ITEM2: '0', ITEM3: '0', ITEM4: '0', ITEM5: '0', ITEM6: '0',
    VISION_SCORE: 30,
    TOTAL_DAMAGE_DEALT_TO_CHAMPIONS: 20000, TOTAL_DAMAGE_TAKEN: 15000,
    TURRETS_KILLED: 1, FRIENDLY_TURRET_LOST: 9, BARRACKS_KILLED: 0, FRIENDLY_DAMPEN_LOST: 2,
    DRAGON_KILLS: 2, BARON_KILLS: 1, RIFT_HERALD_KILLS: 0, HORDE_KILLS: 0
  }, over);
}

// 10 名玩家：蓝队 5（WIN），红队 5（Fail）。
function fixtureStats() {
  const positions = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
  const blue = positions.map((pos, i) => statRow({
    RIOT_ID_GAME_NAME: '蓝方选手' + (i + 1), RIOT_ID_TAG_LINE: 'CN1',
    SKIN: 'Malzahar', TEAM: '100', WIN: 'Win', INDIVIDUAL_POSITION: pos,
    GOLD_EARNED: 12000, CHAMPIONS_KILLED: 2, VISION_SCORE: 30 + i
  }));
  const red = positions.map((pos, i) => statRow({
    RIOT_ID_GAME_NAME: '红方选手' + (i + 1), RIOT_ID_TAG_LINE: 'CN2',
    SKIN: 'Ambessa', TEAM: '200', WIN: 'Fail', INDIVIDUAL_POSITION: pos,
    GOLD_EARNED: 10000, CHAMPIONS_KILLED: 1, CHAMPIONS_KILLED_OVERRIDE: undefined,
    FRIENDLY_TURRET_LOST: 3, FRIENDLY_DAMPEN_LOST: 0,
    TOTAL_DAMAGE_DEALT_TO_CHAMPIONS: 10000, TOTAL_DAMAGE_TAKEN: 20000
  }));
  return blue.concat(red);
}

function buildRofl({ stats, gameLengthMs = 1640939, version = '16.22.1' } = {}) {
  const meta = { gameLength: gameLengthMs, lastGameChunkId: 10, lastKeyFrameId: 2, statsJson: JSON.stringify(stats === undefined ? fixtureStats() : stats) };
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
  const head = Buffer.alloc(15 + version.length);
  head.write('RIOT', 0, 'ascii');
  head.writeUInt16LE(2, 4);
  head.writeUInt8(version.length, 14);
  head.write(version, 15, 'utf8');
  const foot = Buffer.alloc(4);
  foot.writeUInt32LE(metaBuf.length, 0);
  return Buffer.concat([head, Buffer.from([0x01, 0x02, 0x03]), metaBuf, foot]);
}

test('parseRoflResult 读出版本、时长与 10 名玩家', () => {
  const parsed = parseRoflResult(buildRofl({}));
  assert.equal(parsed.formatVersion, 2);
  assert.equal(parsed.gameVersion, '16.22.1');
  assert.equal(parsed.gameLengthMs, 1640939);
  assert.equal(parsed.stats.length, 10);
});

test('parseRoflResult 拒绝非回放 / 缺统计 / 人数不对', () => {
  assert.throws(() => parseRoflResult(Buffer.from('NOPE' + 'x'.repeat(64))), /not_a_replay/);
  // 15.10 老回放：statsJson 为 null。
  assert.throws(() => parseRoflResult(buildRofl({ stats: null })), /replay_stats_missing/);
  assert.throws(() => parseRoflResult(buildRofl({ stats: fixtureStats().slice(0, 9) })), /bad_roster/);
});

test('buildRoflPostGame：字段映射、胜负、分路、目标数、占比与对位差', () => {
  const parsed = parseRoflResult(buildRofl({}));
  const pg = buildRoflPostGame(parsed);
  assert.equal(pg.source, 'rofl');
  assert.equal(pg.winSide, 'blue');
  assert.equal(pg.isWin, true);
  assert.equal(pg.gameLength, 1641);
  assert.equal(pg.players.length, 10);
  const top = pg.players[0];
  assert.equal(top.name, '蓝方选手1#CN1');
  assert.equal(top.champion, 'Malzahar');
  assert.equal(top.team, 'blue');
  assert.equal(top.position, 'TOP');
  assert.equal(top.cs, 220);
  assert.equal(top.gold, 12000);
  // 队伍目标数：towers = 对面 FRIENDLY_TURRET_LOST 常数（蓝 9 / 红 3）。
  assert.equal(pg.teams.blue.towers, 3);
  assert.equal(pg.teams.red.towers, 9);
  assert.equal(pg.teams.blue.inhibitors, 0);
  assert.equal(pg.teams.red.inhibitors, 2);
  assert.equal(pg.teams.blue.dragons, 10);
  assert.equal(pg.teams.red.dragons, 10);
  assert.equal(pg.teams.blue.barons, 5);
  assert.equal(pg.blue.score, 10);
  assert.equal(pg.red.score, 5);
  // TOP 对位经济差：蓝 12000 - 红 10000。
  assert.equal(top.gd, 2000);
  // 伤害占比：蓝队每人 20000 / 100000 = 20%。
  assert.equal(top.damagePct, 20);
  assert.equal(top.kp, 20);
});

test('buildRoflPostGame：双方胜负字段异常时 winSide=null', () => {
  const stats = fixtureStats().map(row => ({ ...row, WIN: 'Fail' }));
  const pg = buildRoflPostGame(parseRoflResult(buildRofl({ stats })));
  assert.equal(pg.winSide, null);
});

test('buildRoflPostGame：目标数常数不一致时回退 ΣTURRETS_KILLED', () => {
  const stats = fixtureStats();
  // 蓝队（前 5）FRIENDLY_TURRET_LOST 改成不一致 → 红方 towers 回退 ΣTURRETS_KILLED（蓝队每人 1 → 5）。
  for (let i = 0; i < 5; i += 1) stats[i].FRIENDLY_TURRET_LOST = 9 + i;
  const pg = buildRoflPostGame(parseRoflResult(buildRofl({ stats })));
  assert.equal(pg.teams.red.towers, 5);
});

// —— 端到端：合成回放经 POST /api/replay-result 导入真机服务 ——
function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function spawnNode(args, env) {
  return spawn(process.execPath, args, {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function waitForOutput(child, needle, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = data => {
      out += String(data);
      if (out.includes(needle)) { cleanup(); resolve(out); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; tail: ' + out.slice(-400)));
    }, timeoutMs);
    const onExit = code => { cleanup(); reject(new Error('server exited ' + code + '; tail: ' + out.slice(-400))); };
    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    }
    child.on('exit', onExit);
  });
}

function stopRun(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    child.on('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 3000).unref();
  });
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: body ? { 'content-type': 'application/octet-stream', 'content-length': body.length } : {}
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('端到端：POST /api/replay-result 导入后 /api/state 赛后数据换成回放真值', async () => {
  const port = await allocatePort();
  const child = spawnNode(['src/main.js'], {
    PORT: String(port),
    LIVE_CLIENT_URL: 'http://127.0.0.1:9',
    RIOT_LCU_PORT: '9',
    RIOT_REMOTING_AUTH_TOKEN: '',
    RIOT_CLIENT_COMMAND_LINE: '',
    RIOT_LOCKFILE: ''
  });
  try {
    await waitForOutput(child, 'Khada Jhin running at');
    const resp = await request(port, 'POST', '/api/replay-result?gameId=901134128659', buildRofl({}));
    assert.equal(resp.status, 200);
    assert.equal(resp.data.ok, true);
    assert.equal(resp.data.winSide, 'blue');
    assert.equal(resp.data.players, 10);
    const stateResp = await request(port, 'GET', '/api/state');
    const pg = stateResp.data.postGame;
    assert.ok(pg, 'postGame 应存在');
    assert.equal(pg.source, 'rofl');
    assert.equal(pg.winSide, 'blue');
    assert.equal(pg.gameId, '901134128659');
    assert.equal(pg.players.length, 10);
    assert.equal(pg.players[0].name, '蓝方选手1#CN1');
    assert.equal(pg.blue.towers, 3);
    assert.equal(stateResp.data.blue.towers, 3);
    assert.equal(stateResp.data.blue.score, 10);
    const status = await request(port, 'GET', '/api/replay-result/status');
    assert.equal(status.status, 200);
    assert.equal(status.data.active, true);
    assert.equal(status.data.winSide, 'blue');
    const bad = await request(port, 'POST', '/api/replay-result', Buffer.from('NOPE' + 'x'.repeat(64)));
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, 'not_a_replay');
  } finally {
    await stopRun(child);
  }
});
