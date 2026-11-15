'use strict';

// 解析 LCU /lol-match-history/v1/game-timelines/{gameId} 为蓝/红双方每分钟总经济序列。
// 输出 [{ t: 分钟, blue, red }]，供赛后页 GOLD DIFFERENCE OVER TIME 曲线消费。
// participants 缺失或 frames 为空时返回 null，页面自动回退演示曲线。
function parseTimelineGold(timeline) {
  if (!timeline || typeof timeline !== 'object') return null;
  const source = timeline.timeline && typeof timeline.timeline === 'object' ? timeline.timeline : timeline;
  const participants = Array.isArray(source.participants) ? source.participants : [];
  const frames = Array.isArray(source.frames) ? source.frames : [];
  if (!frames.length || !participants.length) return null;
  const sideOf = Object.create(null);
  let mapped = 0;
  for (const p of participants) {
    const id = Number(p && (p.participantId !== undefined ? p.participantId : p.participant_id));
    if (!id) continue;
    const teamId = Number(p && p.teamId);
    sideOf[id] = teamId === 200 ? 'red' : 'blue';
    mapped += 1;
  }
  if (!mapped) return null;
  const points = [];
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue;
    const t = Math.floor(Number(frame.timestamp) / 60000);
    if (!Number.isFinite(t) || t < 0) continue;
    const pf = frame.participantFrames && typeof frame.participantFrames === 'object' ? frame.participantFrames : {};
    let blue = 0;
    let red = 0;
    for (const key of Object.keys(pf)) {
      const entry = pf[key];
      const gold = Number(entry && entry.totalGold);
      if (!Number.isFinite(gold)) continue;
      if (sideOf[Number(key)] === 'red') red += gold; else blue += gold;
    }
    points.push({ t, blue, red });
  }
  if (!points.length) return null;
  points.sort((a, b) => a.t - b.t);
  const dedup = [];
  for (const pt of points) {
    const last = dedup.length ? dedup[dedup.length - 1] : null;
    if (last && last.t === pt.t) {
      last.blue = pt.blue;
      last.red = pt.red;
    } else {
      dedup.push(pt);
    }
  }
  return dedup;
}

module.exports = { parseTimelineGold };
