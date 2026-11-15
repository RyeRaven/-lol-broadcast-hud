'use strict';

// 语料回放桥（t32）：把 obs4 解码产物（C:/Temp/obs4/dec8/*.json；dec_check.json 为真值校准版）
// 按帧 POST 到 /api/protocol-feed，验证「解码器 → 主进程 → capability → HUD」整条链路。
//
// 用法：
//   node tools/protocol-corpus-replay.cjs --file C:/Temp/obs4/dec_check.json \
//        --url http://127.0.0.1:3314/api/protocol-feed [--interval-ms 1000] [--speed 1]
//        [--frames N] [--start N] [--loop] [--conservative] [--dry-run]
//
// 精度矩阵（默认）：
//   kills / deaths / minionsKilled → exact（产物 precision=exact，floor 校验 100%）
//   cs            → exact（minions lane exact cov1 + jungle floorPass 296/299；约 1% 玩家帧可能 ±1，
//                    仍远好于 LCDA 的 10 步量化；见 DECODE-CAPABILITY 白皮书）
//   xp / totalGold → exact（floor(decoded)==真值 100%，n=256/252），解码缺口帧发 null
//   assists       → estimated（union rank 不严格；LCDA 的 KDA 本身可信，协议流不抢 KDA）
// --conservative：全部回落到产物自带 precision 标签（xp/gold=estimated、cs=quantized）。
//
// team 说明：dec8 语料 players[].team 为 null，本桥按 Riot 观战协议约定
// participantId 1..5=蓝方(100)、6..10=红方(200) 推 side——这是协议定义，不是猜测。
// events：从 KDA 序列的逐帧增量合成 kill（killer/victim 贪心配对），confidence 留空。

const http = require('node:http');

// 语料 f32 lane 是浮点数（floor==真值）；cs = floor(minions) + floor(jungle)。
function laneVal(series, name, frameIndex, playerIndex) {
  const arr = series && series[name];
  if (!Array.isArray(arr) || !Array.isArray(arr[frameIndex])) return null;
  const v = arr[frameIndex][playerIndex];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// 默认精度矩阵；--conservative 时回落产物标签。
function decidePrecision(fields, conservative) {
  if (conservative) {
    return {
      kills: fields.kills.precision,
      deaths: fields.deaths.precision,
      assists: fields.assists.precision,
      cs: fields.cs.precision,
      xp: fields.xp.precision,
      totalGold: fields.totalGold.precision
    };
  }
  return { kills: 'exact', deaths: 'exact', assists: 'estimated', cs: 'exact', xp: 'exact', totalGold: 'exact' };
}

// 把一个解码 JSON 变成逐帧 feed payload 数组（纯函数，测试直接调用）。
function buildFrames(dec, options = {}) {
  if (!dec || typeof dec !== 'object') throw new Error('dec 必须是解码 JSON 对象');
  const series = dec.series || {};
  const playersMeta = Array.isArray(dec.players) ? dec.players : [];
  if (!playersMeta.length) throw new Error('dec.players 为空');
  const times = Array.isArray(dec.times) ? dec.times : [];
  const precision = decidePrecision(dec.fields || {}, options.conservative === true);
  const gameId = options.gameId !== undefined && options.gameId !== null && String(options.gameId).trim() !== ''
    ? String(options.gameId).trim()
    : (typeof dec.game === 'string' && dec.game.trim() ? dec.game.trim()
      : (dec.game && dec.game.gameId !== undefined && dec.game.gameId !== null ? String(dec.game.gameId) : null));
  const nPlayers = playersMeta.length;
  const frames = [];
  for (let fi = 0; fi < times.length; fi += 1) {
    const gameTime = times[fi];
    const records = playersMeta.map((meta, i) => {
      const kills = laneVal(series, 'kills', fi, i);
      const deaths = laneVal(series, 'deaths', fi, i);
      const assists = laneVal(series, 'assists', fi, i);
      const minions = laneVal(series, 'minionsKilled', fi, i);
      const jungle = laneVal(series, 'jungleMinionsKilled', fi, i);
      const xpRaw = laneVal(series, 'xp', fi, i);
      const goldRaw = laneVal(series, 'totalGold', fi, i);
      const cs = minions === null || jungle === null ? null : Math.floor(minions) + Math.floor(jungle);
      const record = {
        netid: null,
        puuid: null,
        participantId: meta.participantId,
        // Riot 观战协议约定：participantId 1..5=team 100（蓝）、6..10=team 200（红）。
        team: meta.participantId <= 5 ? 'blue' : 'red',
        kills: kills === null ? null : Math.max(0, Math.round(kills)),
        deaths: deaths === null ? null : Math.max(0, Math.round(deaths)),
        assists: assists === null ? null : Math.max(0, Math.round(assists)),
        cs,
        totalGold: goldRaw === null ? null : Math.max(0, Math.floor(goldRaw)),
        xp: xpRaw === null ? null : Math.max(0, Math.floor(xpRaw)),
        asOf: typeof gameTime === 'number' && Number.isFinite(gameTime) ? gameTime : null,
        championName: meta.champion || null,
        precision
      };
      return record;
    });
    const events = synthesizeEvents(series, fi, nPlayers, gameTime);
    frames.push({
      source: 'corpus',
      gameId,
      gameTime,
      updatedAt: null,
      players: records,
      events
    });
  }
  return frames;
}

// 逐帧增量合成 kill 事件：kills/deaths 都是非负单调序列，某帧的差值即该帧发生的击杀/死亡数。
function synthesizeEvents(series, frameIndex, nPlayers, gameTime) {
  if (frameIndex === 0) return [];
  const prev = Array.isArray(series.kills) && Array.isArray(series.kills[frameIndex - 1]) ? series.kills[frameIndex - 1] : null;
  const curr = Array.isArray(series.kills) && Array.isArray(series.kills[frameIndex]) ? series.kills[frameIndex] : null;
  const prevD = Array.isArray(series.deaths) && Array.isArray(series.deaths[frameIndex - 1]) ? series.deaths[frameIndex - 1] : null;
  const currD = Array.isArray(series.deaths) && Array.isArray(series.deaths[frameIndex]) ? series.deaths[frameIndex] : null;
  if (!prev || !curr || !prevD || !currD) return [];
  const killers = [];
  const victims = [];
  for (let i = 0; i < nPlayers; i += 1) {
    const dk = typeof curr[i] === 'number' && typeof prev[i] === 'number' ? curr[i] - prev[i] : 0;
    const dd = typeof currD[i] === 'number' && typeof prevD[i] === 'number' ? currD[i] - prevD[i] : 0;
    for (let k = 0; k < Math.max(0, dk); k += 1) killers.push(i + 1);
    for (let k = 0; k < Math.max(0, dd); k += 1) victims.push(i + 1);
  }
  const events = [];
  const pairs = Math.min(killers.length, victims.length);
  for (let j = 0; j < pairs; j += 1) {
    events.push({ t: gameTime, type: 'kill', killer: killers[j], victim: victims[j], assists: [], confidence: null });
  }
  for (let j = pairs; j < victims.length; j += 1) {
    events.push({ t: gameTime, type: 'death', killer: null, victim: victims[j], assists: [], confidence: null });
  }
  return events;
}

function postFeed(urlString, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        resolve({ statusCode: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('post timeout')));
    req.end(body);
  });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--loop') args.loop = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--conservative') args.conservative = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1];
    else args._.push(a);
  }
  return args;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('用法: node tools/protocol-corpus-replay.cjs --file <dec8/dec_check.json> --url http://127.0.0.1:3314/api/protocol-feed [--interval-ms 1000] [--speed 1] [--frames N] [--start N] [--loop] [--conservative] [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const fs = require('node:fs');
  const dec = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  const url = args.url || 'http://127.0.0.1:3314/api/protocol-feed';
  const intervalMs = Math.max(50, Number(args['interval-ms']) > 0 ? Number(args['interval-ms']) : 1000) / Math.max(0.1, Number(args.speed) > 0 ? Number(args.speed) : 1);
  const frames = buildFrames(dec, { conservative: args.conservative === true, gameId: args['game-id'] });
  let start = Math.max(0, Number(args.start) > 0 ? Math.floor(Number(args.start)) : 0);
  let count = Number(args.frames) > 0 ? Math.floor(Number(args.frames)) : frames.length;
  if (start >= frames.length) start = 0;
  const sliced = frames.slice(start, start + count);
  console.log('[replay] file=' + args.file + ' frames=' + sliced.length + '/' + frames.length + ' interval=' + Math.round(intervalMs) + 'ms precision=' + JSON.stringify(decidePrecision(dec.fields, args.conservative === true)));
  const posted = [];
  do {
    for (let i = 0; i < sliced.length; i += 1) {
      const payload = Object.assign({}, sliced[i], { updatedAt: Date.now() });
      if (args.dryRun) {
        console.log('[replay] frame ' + i + ' t=' + payload.gameTime + ' (dry-run) players=' + payload.players.length + ' events=' + payload.events.length);
        continue;
      }
      try {
        const res = await postFeed(url, payload);
        const b = res.body || {};
        posted.push({ ok: res.statusCode === 200 && b.accepted !== false });
        console.log('[replay] frame ' + i + ' t=' + payload.gameTime + ' http=' + res.statusCode
          + ' committed=' + (b.committed === true) + ' duplicate=' + (b.duplicate === true) + ' rewind=' + (b.rewind === true)
          + ' players=' + (b.players !== undefined ? b.players : '?') + ' events=' + (b.events !== undefined ? b.events : '?')
          + (res.statusCode !== 200 ? ' detail=' + String(b.detail || b.raw || res.raw).slice(0, 300) : ''));
        if (res.statusCode !== 200) { process.exitCode = 1; return; }
      } catch (error) {
        console.error('[replay] frame ' + i + ' POST 失败: ' + error.message);
        process.exitCode = 1;
        return;
      }
      if (i < sliced.length - 1 || args.loop) await sleep(intervalMs);
    }
  } while (args.loop && !args.dryRun);
  const okCount = posted.filter(p => p.ok).length;
  console.log('[replay] 完成: ' + okCount + '/' + (posted.length || sliced.length) + ' 帧被接受' + (args.loop ? '（循环模式已中断才打印）' : ''));
}

module.exports = { laneVal, decidePrecision, buildFrames, synthesizeEvents, postFeed, parseArgs };

if (require.main === module) main();
