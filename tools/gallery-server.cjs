'use strict';

// RiftBroadcast 本地截图相册：零依赖，给远程控制页面/手机浏览器看截图用。
// 用法：node tools/gallery-server.cjs  -> http://127.0.0.1:3220/
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '.tmp');
const PORT = Number(process.env.PORT || 3220);
const EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
// 内部 QA 截图目录不进入相册，避免用户看到半成品/局部裁图。
const SKIP_DIRS = new Set(['visual-qa', 'qa1366', 'gallery-shot', 'test', 'tests', 'probe', 'node_modules']);

function walk(dir, out, depth) {
  if (depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name.toLowerCase())) walk(p, out, depth + 1); }
    else if (EXT.has(path.extname(ent.name).toLowerCase())) {
      try { const st = fs.statSync(p); out.push({ p: p, rel: path.relative(ROOT, p), mtime: st.mtimeMs, size: st.size }); } catch (e) {}
    }
  }
}

function images() {
  const out = [];
  walk(ROOT, out, 0);
  out.sort(function (a, b) { return b.mtime - a.mtime; });
  const seen = new Set();
  const unique = [];
  for (const item of out) {
    const key = path.basename(item.rel).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.slice(0, 80);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); });
}

const CSS = '*{box-sizing:border-box}body{margin:0;background:#070b10;color:#e5e7eb;font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}header{position:sticky;top:0;z-index:2;background:#0b1118ee;border-bottom:1px solid #1e293b;padding:14px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}h1{font-size:16px;margin:0;letter-spacing:.08em}header span{color:#94a3b8;font-size:12px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;padding:16px}.card{display:block;background:#0b0f14;border:1px solid #1e293b;border-radius:10px;overflow:hidden;color:inherit;text-decoration:none}.card:hover{border-color:#22d3ee}.card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#000}.meta{padding:8px 10px;display:flex;flex-direction:column;gap:2px}.meta b{font-size:12px;word-break:break-all}.meta span{color:#94a3b8;font-size:11px}.empty{padding:40px;color:#94a3b8}';

function html() {
  const list = images();
  const cards = list.map(function (x) {
    const url = '/img?p=' + encodeURIComponent(x.rel);
    return '<a class="card" href="' + url + '" target="_blank"><img src="' + url + '" loading="lazy"><div class="meta"><b>' + esc(x.rel) + '</b><span>' + new Date(x.mtime).toLocaleString('zh-CN') + ' · ' + Math.round(x.size / 1024) + ' KB</span></div></a>';
  }).join('');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RiftBroadcast 截图相册</title><style>' + CSS + '</style></head><body><header><h1>RIFTBROADCAST</h1><span>成品截图 · 共 ' + list.length + ' 张 · 刷新页面即可看到最新截图</span></header><div class="grid">' + (cards || '<div class="empty">还没有截图</div>') + '</div></body></html>';
}

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true,images:images().length})); }
  if (u.pathname === '/img') {
    const rel = String(u.searchParams.get('p') || '');
    const p = path.resolve(ROOT, rel);
    if (!p.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(p, function (err, buf) {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(p).toLowerCase();
      const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, {'Content-Type': type, 'Cache-Control':'no-cache'});
      res.end(buf);
    });
    return;
  }
  if (u.pathname === '/') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return res.end(html()); }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', function () { console.log('RiftBroadcast gallery: http://127.0.0.1:' + PORT + '/'); });
