'use strict';
// 观察 RiftBroadcast 服务的阶段变化与赛后数据落盘，用于无人值守验证。
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', '.tmp');
const logFile = path.join(OUT, 'app-watch.log');
let lastPhase = '';
async function tick() {
  try {
    const res = await fetch('http://127.0.0.1:3210/api/state');
    const s = await res.json();
    if (s.phase !== lastPhase) {
      lastPhase = s.phase;
      fs.appendFileSync(logFile, new Date().toLocaleTimeString() + ' phase=' + s.phase + ' mode=' + s.mode + ' t=' + s.gameTime + ' players=' + (s.players ? s.players.length : 0) + '\n');
    }
    if (s.postGame) fs.writeFileSync(path.join(OUT, 'postgame-latest.json'), JSON.stringify(s.postGame, null, 2));
  } catch (error) {}
  setTimeout(tick, 5000);
}
tick();
