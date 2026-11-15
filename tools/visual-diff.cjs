'use strict';
/* t12 极简像素 diff：纯 Node，复用 shot-hud.cjs 的零依赖 PNG 解码（RGBA/调色板/灰度均可回读）。
 * 口径：RGB 逐像素比较，max(|ΔR|,|ΔG|,|ΔB|) > threshold 记为变化；不比较 alpha
 * （基线/实拍均为黑底截图时 alpha 恒 255；透明基线的 alpha 差异不在本工具口径内）。
 * 尺寸不一致时把多出的像素按 Δ=255 计（与 tools/shot-hud.cjs diffImages 同约定）。
 * 用法:
 *   node tools/visual-diff.cjs --baseline <png> --actual <png> [--threshold 16] [--ignore x,y,w,h ...] [--json]
 * 退出码: 0=无变化, 1=有变化或尺寸不一致, 2=用法/解码错误。
 */
const fs = require('fs');
const path = require('path');
const SHOT = require(path.join(__dirname, 'shot-hud.cjs'));

function parseArgs(argv) {
  const args = { threshold: 16, ignores: [], json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--baseline') args.baseline = argv[(i += 1)];
    else if (k === '--actual') args.actual = argv[(i += 1)];
    else if (k === '--threshold') args.threshold = Number(argv[(i += 1)]);
    else if (k === '--ignore') args.ignores.push(argv[(i += 1)].split(',').map(Number));
    else if (k === '--json') args.json = true;
    else { console.error('未知参数: ' + k); process.exit(2); }
  }
  return args;
}
function main() {
  const args = parseArgs(process.argv);
  if (!args.baseline || !args.actual) {
    console.error('用法: node tools/visual-diff.cjs --baseline <png> --actual <png> [--threshold 16] [--ignore x,y,w,h ...] [--json]');
    process.exit(2);
  }
  let base;
  let act;
  try { base = SHOT.decodePng(fs.readFileSync(args.baseline)); } catch (e) { console.error('基线解码失败: ' + e.message); process.exit(2); }
  try { act = SHOT.decodePng(fs.readFileSync(args.actual)); } catch (e) { console.error('实拍解码失败: ' + e.message); process.exit(2); }
  if (!base || !base.data || !act || !act.data) { console.error('PNG 解码输出异常'); process.exit(2); }
  const inIgnore = (x, y) => args.ignores.some((r) => x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3]);
  const w = Math.max(base.width, act.width);
  const h = Math.max(base.height, act.height);
  const px = (img, x, y) => {
    if (x >= img.width || y >= img.height) return [0, 0, 0];
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  let changed = 0;
  let maxDelta = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (inIgnore(x, y)) continue;
      const p1 = px(base, x, y);
      const p2 = px(act, x, y);
      const d = Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1]), Math.abs(p1[2] - p2[2]));
      if (d > args.threshold) {
        changed += 1;
        if (d > maxDelta) maxDelta = d;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const result = {
    ok: changed === 0,
    changedPixels: changed,
    changedPercent: Math.round(1e8 * changed / (w * h)) / 1e6,
    boundingBox: changed ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    maxChannelDelta: changed ? maxDelta : 0,
    threshold: args.threshold,
    ignoreRects: args.ignores,
    baseline: { file: path.resolve(args.baseline), width: base.width, height: base.height },
    actual: { file: path.resolve(args.actual), width: act.width, height: act.height },
    sizeMismatch: base.width !== act.width || base.height !== act.height,
  };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log((result.ok ? 'PASS' : 'DIFF')
      + ' changedPixels=' + result.changedPixels
      + ' (' + result.changedPercent + '%)'
      + ' bbox=' + (result.boundingBox ? JSON.stringify([result.boundingBox.x, result.boundingBox.y, result.boundingBox.w, result.boundingBox.h]) : 'null')
      + ' maxDelta=' + result.maxChannelDelta
      + ' threshold=' + result.threshold
      + (result.sizeMismatch ? ' SIZE-MISMATCH ' + base.width + 'x' + base.height + ' vs ' + act.width + 'x' + act.height : ''));
  }
  process.exit(result.ok ? 0 : 1);
}
main();
