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

// 赛后逐人金币真值：frames[].participantFrames[participantId].totalGold 每 60s 一帧、全 10 人。
// 与 parseTimelineGold 的差别：保留每个参与者自己的序列，供赛后页画 10 条逐人曲线。
// 阵营判定顺序：timeline.participants（官方 match-v5 形状，LCU 端点目前不回）→ 开局出生点分簇
// （蓝方泉水在低坐标角，两簇 (x+y) 间隔 > 4000 才认，实测 16.22 蓝方出生点 x,y 均 < 700）
// → 惯例 1-5 蓝 / 6-10 红。
// 英雄/名字标签只在调用方给出 participantId → 选手 映射时才有（eog 暴露 participantId 或
// timeline.participants）；没有映射就只画线不写名，绝不按顺序猜（队伍内出场顺序 ≠ participantId）。
function sidesFromSpawns(frame, out) {
  const pf = frame && frame.participantFrames && typeof frame.participantFrames === 'object' ? frame.participantFrames : {};
  const spots = [];
  for (const key of Object.keys(pf)) {
    const id = Number(key);
    const pos = pf[key] && pf[key].position;
    if (!id || !pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) continue;
    spots.push({ id, sum: Number(pos.x) + Number(pos.y) });
  }
  spots.sort((a, b) => a.sum - b.sum);
  if (spots.length < 10 || !(spots[4].sum + 4000 < spots[5].sum)) {
    for (let pid = 1; pid <= 10; pid += 1) out[pid] = pid <= 5 ? 'blue' : 'red';
    return false;
  }
  for (let i = 0; i < 5; i += 1) out[spots[i].id] = 'blue';
  for (let i = 5; i < 10; i += 1) out[spots[i].id] = 'red';
  return true;
}

function parseTimelineGoldPlayers(timeline, rosterByPid) {
  if (!timeline || typeof timeline !== 'object') return null;
  const source = timeline.timeline && typeof timeline.timeline === 'object' ? timeline.timeline : timeline;
  const frames = Array.isArray(source.frames) ? source.frames : [];
  const participants = Array.isArray(source.participants) ? source.participants : [];
  if (!frames.length) return null;
  const sideOf = Object.create(null);
  for (const p of participants) {
    const id = Number(p && (p.participantId !== undefined ? p.participantId : p.participant_id));
    if (!id) continue;
    sideOf[id] = Number(p && p.teamId) === 200 ? 'red' : 'blue';
  }
  if (!Object.keys(sideOf).length) sidesFromSpawns(frames[0], sideOf);
  const series = Object.create(null);
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue;
    const t = Math.floor(Number(frame.timestamp) / 60000);
    if (!Number.isFinite(t) || t < 0) continue;
    const pf = frame.participantFrames && typeof frame.participantFrames === 'object' ? frame.participantFrames : {};
    for (const key of Object.keys(pf)) {
      const pid = Number(key);
      if (!pid) continue;
      const gold = Number(pf[key] && pf[key].totalGold);
      if (!Number.isFinite(gold)) continue;
      let s = series[pid];
      if (!s) {
        s = series[pid] = { pid, side: sideOf[pid] === 'red' ? 'red' : 'blue', champion: null, name: null, points: [] };
      }
      const last = s.points.length ? s.points[s.points.length - 1] : null;
      if (last && last.t === t) { last.gold = gold; continue; }
      s.points.push({ t, gold });
    }
  }
  const roster = rosterByPid && typeof rosterByPid === 'object' ? rosterByPid : null;
  const out = [];
  for (const pid of Object.keys(series).map(Number).sort((a, b) => a - b)) {
    const s = series[pid];
    const entry = roster ? roster[pid] : null;
    if (entry) {
      if (entry.champion) s.champion = String(entry.champion);
      if (entry.name) s.name = String(entry.name);
    }
    out.push(s);
  }
  return out.length ? out : null;
}

// 观战经济曲线：赛中屏幕经济面板 OCR 的采样序列（[{ t: 秒, g: [十人金币或 null] }]）
// 组装成与 parseTimelineGold 同构的蓝/红每分钟总经济 [{ t: 分钟, blue, red }]。
// 背景：观战位赛后 LCU 战报 404，这条 OCR 记录是观赛流程里经济差曲线的唯一真值来源。
// sides 是与 g 对齐的阵营数组（'blue'/'red'），缺省按惯例 1-5 蓝 / 6-10 红。
// 金币累计只涨不跌：读到比上一帧小的值视为 OCR 错读，沿用上一帧；缺读也沿用上一帧。
function buildGoldTimelineFromSamples(samples, sides) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const carried = new Array(10).fill(null);
  const points = [];
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') continue;
    const t = Math.floor(Number(sample.t) / 60);
    if (!Number.isFinite(t) || t < 0) continue;
    const golds = Array.isArray(sample.g) ? sample.g : [];
    // 注意 Number(null)===0：缺读必须显式排除，否则整帧缺读会被当成「十人都 0 金币」。
    if (!golds.some(v => v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0)) continue;
    let blue = 0;
    let red = 0;
    let counted = 0;
    for (let i = 0; i < 10; i += 1) {
      const raw = golds[i] === null || golds[i] === undefined ? NaN : Number(golds[i]);
      if (Number.isFinite(raw) && raw >= 0 && (carried[i] === null || raw >= carried[i])) carried[i] = raw;
      const value = carried[i];
      if (value === null) continue;
      const side = Array.isArray(sides) && (sides[i] === 'red' || sides[i] === 'blue')
        ? sides[i]
        : (i < 5 ? 'blue' : 'red');
      if (side === 'red') red += value; else blue += value;
      counted += 1;
    }
    if (!counted) continue;
    const last = points.length ? points[points.length - 1] : null;
    if (last && last.t === t) { last.blue = blue; last.red = red; continue; }
    points.push({ t, blue, red });
  }
  return points.length ? points : null;
}

module.exports = { parseTimelineGold, parseTimelineGoldPlayers, buildGoldTimelineFromSamples };
