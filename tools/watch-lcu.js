'use strict';
// 现场观察器：盯 LCU 阶段变化，进 BP 抓真实 session，进对局抓 :2999。
// 只读客户端公开接口，不打印 token。
const fs = require('fs');
const path = require('path');
const { discoverLcuConnection, fetchLcuJson, requestJson } = require('../src/data-sources');
const { normalizeDraftSession } = require('../src/draft');
const { normalizeLiveState } = require('../src/live-data');

const OUT = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(OUT, { recursive: true });
let conn = null;
let lastPhase = null;
let lastDraftSig = '';
let lastLiveSig = '';
let busy = false;
let lcuFailStreak = 0;

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

async function ensureConn(force) {
  if (conn && !force) return conn;
  try { conn = await discoverLcuConnection(); } catch { conn = null; }
  if (conn) log('lcu-found', 'port=' + conn.port, 'source=' + conn.source, 'hasToken=' + Boolean(conn.password));
  return conn;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const c = await ensureConn(!conn);
    if (!c || !c.password) { if (lcuFailStreak++ % 15 === 0) log('lcu-pending', c ? 'no-token' : 'not-running'); return; }
    let phase;
    try {
      phase = await fetchLcuJson(c, '/lol-gameflow/v1/gameflow-phase');
      lcuFailStreak = 0;
    } catch (error) {
      log('lcu-error', error.message);
      conn = null;
      return;
    }
    if (phase !== lastPhase) { log('phase ->', phase); lastPhase = phase; }
    if (phase === 'ChampSelect') {
      try {
        const session = await fetchLcuJson(c, '/lol-champ-select/v1/session');
        const draft = normalizeDraftSession(session);
        const sig = JSON.stringify([draft.bluePicks, draft.redPicks, draft.blueBans, draft.redBans, draft.parsed, draft.timer]);
        if (sig !== lastDraftSig) {
          lastDraftSig = sig;
          fs.writeFileSync(path.join(OUT, 'session-latest.json'), JSON.stringify(session, null, 2));
          log('draft', draft.phase, 'timer=' + draft.timer, 'active=' + draft.active,
            '| blue', draft.bluePicks.join('/') || '-', '| red', draft.redPicks.join('/') || '-',
            '| bans', draft.blueBans.length + ':' + draft.redBans.length, '| parsed=' + draft.parsed);
        }
      } catch (error) { log('draft-error', error.message); }
    }
    if (phase === 'InProgress') {
      try {
        const payload = await requestJson('https://127.0.0.1:2999/liveclientdata/allgamedata', { timeout: 1500 });
        const live = normalizeLiveState(payload);
        if (live) {
          const sig = live.gameTime + ':' + live.blue.score + ':' + live.red.score;
          if (sig !== lastLiveSig) {
            lastLiveSig = sig;
            fs.writeFileSync(path.join(OUT, 'live-latest.json'), JSON.stringify(payload, null, 2));
            log('live', 't=' + Math.floor(live.gameTime), live.blue.score + ':' + live.red.score,
              'towers', live.blue.towers + ':' + live.red.towers, 'players=' + live.players.length,
              'events=' + live.eventCount);
          }
        }
      } catch (error) { log('live-error', error.message); }
    }
  } finally {
    busy = false;
  }
}

setInterval(tick, 2000);
tick();
log('watcher-started');
setTimeout(() => { log('watcher-timeout'); process.exit(0); }, 60 * 60 * 1000);
