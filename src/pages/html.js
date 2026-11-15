'use strict';

// 页面 HTML 外壳：统一的 head、样式表与内联脚本挂载点。
// body / scripts 由服务端页面模块生成，属于受信任模板；title 可能来自配置，必须转义。
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}
function htmlShell(title, body, scripts = '') {
  // body/scripts 只能来自本仓库的静态页面模板；拒绝运行时拼接的任意值，降低注入面。
  if (typeof body !== 'string') throw new TypeError('htmlShell body must be a trusted string');
  if (typeof scripts !== 'string') throw new TypeError('htmlShell scripts must be a trusted string');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"></head><body>${body}<script>${scripts}</script></body></html>`;
}

module.exports = { htmlShell, escapeHtml };
