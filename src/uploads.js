// 队标本地上传：POST /api/uploads/logo（JSON { name, data: base64 }）→ 保存到 public/assets/logos/。
// 独立于全局 readBody（1MB）：base64 膨胀 4/3，这里单独收流，上限 4MB（约对应 3MB 原图）。
const fs = require('fs');
const path = require('path');

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // 请求体（JSON）上限
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 解码后原图上限
const EXT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

// 轻魔数校验：确认扩展名与真实字节一致，防止把非图片伪装成图片后由静态服务原样下发。
function magicMatches(ext, buf) {
  if (ext === '.svg') {
    const head = buf.slice(0, 512).toString('utf8').trim().toLowerCase();
    return head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!--');
  }
  if (ext === '.png') return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ext === '.jpg' || ext === '.jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === '.gif') return buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF';
  if (ext === '.webp') return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function readUploadBody(req, res, json) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (code, error) => {
      if (done) return;
      done = true;
      if (res && !res.headersSent) json(res, code, { ok: false, error });
      reject(Object.assign(new Error(error), { statusCode: code }));
    };
    const declared = Number(req.headers && req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return fail(413, 'payload_too_large');
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) return fail(413, 'payload_too_large');
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      // 先解析、后落定：fail() 靠 done 防重复响应，若先置 done，非法 JSON 的
      // fail(400) 会被挡成 no-op，promise 永不落定、响应不发、连接挂死。
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { return fail(400, 'invalid_json'); }
      done = true;
      resolve(body);
    });
    req.on('error', error => { if (!done) { done = true; reject(error); } });
  });
}

// 处理 /api/uploads/logo：校验 → 保存 → 返回可直填队标输入框的站点路径。
function handleLogoUploadApi(req, res, url, context = {}) {
  if (url.pathname !== '/api/uploads/logo') return false;
  const { json } = context;
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  readUploadBody(req, res, json).then(body => {
    const name = body && typeof body.name === 'string' ? body.name : '';
    const data = body && typeof body.data === 'string' ? body.data : '';
    const ext = path.extname(name || '').toLowerCase();
    if (!EXT_TYPES[ext]) return json(res, 400, { ok: false, error: 'unsupported_type' });
    if (!data || data.length > Math.ceil(MAX_UPLOAD_BYTES * 3 / 4)) return json(res, 413, { ok: false, error: 'payload_too_large' });
    const base64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
    let buf;
    try { buf = Buffer.from(base64, 'base64'); } catch { return json(res, 400, { ok: false, error: 'invalid_data' }); }
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return json(res, 400, { ok: false, error: 'invalid_image_size' });
    if (!magicMatches(ext, buf)) return json(res, 400, { ok: false, error: 'not_an_image' });
    // 文件名只取 basename 清洗，加毫秒时间戳防覆盖同名。
    const safeName = path.basename(name).replace(/[^\w.-]+/g, '_').slice(-64) || 'logo' + ext;
    const dir = path.join(__dirname, '..', 'public', 'assets', 'logos');
    fs.mkdirSync(dir, { recursive: true });
    const filename = Date.now() + '-' + (safeName.endsWith(ext) ? safeName : safeName + ext);
    const file = path.join(dir, filename);
    try { fs.writeFileSync(file, buf); } catch { return json(res, 500, { ok: false, error: 'write_failed' }); }
    json(res, 200, { ok: true, path: '/assets/logos/' + filename });
  }).catch(() => {});
  return true;
}

module.exports = { handleLogoUploadApi };
