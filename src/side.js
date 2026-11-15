'use strict';

// 队伍归属的统一口径。LCU/LCDA 数据里同一件事有多种写法：
// 队伍字段用 ORDER/CHAOS（偶尔出现 100/200、1/2、BLUE/RED），塔名用 Turret_TOrder_*/Turret_TChaos_* 或 T1/T2。
// live-data 与 highlights 过去各写一份且实现漂移（T1/T2 只有 highlights 认），这里合并成单一实现。

// 玩家/事件队伍字段：CHAOS→red，ORDER→blue；缺失或未知按蓝方兜底（调用方依赖非空归属）。
function sideOf(team) {
  const t = String(team || '').toUpperCase();
  if (t === 'CHAOS') return 'red';
  if (t === 'ORDER') return 'blue';
  return 'blue';
}

// 自由文本队伍值：认 CHAOS/RED/200 与 ORDER/BLUE/100（含 TEAM_ 前缀与裸数字），其余返回 null（未知不硬判）。
function sideFromTeamValue(raw) {
  const t = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!t) return null;
  if (/CHAOS|RED|TEAM[ _]?200|^2$|^200$/.test(t)) return 'red';
  if (/ORDER|BLUE|TEAM[ _]?100|^1$|^100$/.test(t)) return 'blue';
  return null;
}

// 推塔事件的塔名归属：TOrder_*/T1_* 是蓝方（ORDER）的塔 → 推掉方记 red；TChaos_*/T2_* 反之；认不出返回 null。
function sideFromTurretName(turretKilled) {
  const raw = String(turretKilled || '');
  if (/TOrder/i.test(raw)) return 'red';
  if (/TChaos/i.test(raw)) return 'blue';
  if (/T1(?:_|$)/i.test(raw)) return 'red';
  if (/T2(?:_|$)/i.test(raw)) return 'blue';
  return null;
}

module.exports = { sideOf, sideFromTeamValue, sideFromTurretName };
