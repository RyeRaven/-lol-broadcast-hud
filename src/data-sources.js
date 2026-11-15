const https = require('https');
const fs = require('fs');
const { execFile } = require('child_process');
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('http://') ? require('http') : https;
    const headers = { ...(options.headers || {}) };
    const maxResponseBytes = Number(options.maxResponseBytes) > 0 ? Number(options.maxResponseBytes) : DEFAULT_MAX_RESPONSE_BYTES;
    let payload = null;
    if (options.body !== undefined && options.body !== null) {
      payload = Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = transport.request(url, { method: options.method || 'GET', rejectUnauthorized: false, timeout: options.timeout || 1200, headers }, res => {
      let body = '';
      let responseSize = 0;
      res.on('data', chunk => {
        if (settled) return;
        responseSize += Buffer.byteLength(chunk);
        if (responseSize > maxResponseBytes) {
          // 超限立即断开连接，避免把异常大的响应堆积在内存里。
          finish(reject, Object.assign(new Error('Response too large'), { code: 'response_too_large', maxResponseBytes }));
          res.destroy();
          return;
        }
        body += chunk;
      });
      res.on('error', error => finish(reject, error));
      res.on('end', () => {
        if (settled) return;
        if (res.statusCode < 200 || res.statusCode >= 300) return finish(reject, new Error(`HTTP ${res.statusCode}`));
        if (!body.trim()) return finish(resolve, null);
        try { finish(resolve, JSON.parse(body)); } catch { finish(reject, new Error('Invalid JSON')); }
      });
    });
    req.on('error', error => finish(reject, error));
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
function readRiotLockfile(file) { if (!fs.existsSync(file)) return null; const p = fs.readFileSync(file, 'utf8').trim().split(':'); if (p.length < 5) return null; return { process: p[0], pid: Number(p[1]), port: Number(p[2]), password: p[3], protocol: p[4] }; }
async function probeLcu(file) { const lock = readRiotLockfile(file); if (!lock) return { ok: false, source: 'lcu', reason: 'lockfile_not_found' }; try { const auth = Buffer.from(`riot:${lock.password}`).toString('base64'); const phase = await requestJson(`https://127.0.0.1:${lock.port}/lol-gameflow/v1/gameflow-phase`, { headers: { Authorization: `Basic ${auth}` } }); return { ok: true, source: 'lcu', phase, port: lock.port }; } catch (e) { return { ok: false, source: 'lcu', reason: e.message, port: lock.port }; } }
function liveClientBase(input = process.env.LIVE_CLIENT_URL || 'https://127.0.0.1:2999') {
  if (input && typeof input === 'object') {
    if (input.url) return liveClientBase(input.url);
    if (input.port) return 'https://' + (input.host || '127.0.0.1') + ':' + Number(input.port);
  }
  const text = String(input == null ? '' : input).trim();
  if (!text) return 'https://127.0.0.1:2999';
  if (/^https?:\/\//i.test(text)) { try { const u = new URL(text); return u.protocol + '//' + u.host; } catch { return 'https://127.0.0.1:2999'; } }
  if (/^\d+$/.test(text)) return 'https://127.0.0.1:' + text;
  return 'https://' + text.replace(/^\/+/, '');
}
async function probeLiveClient(target = process.env.LIVE_CLIENT_URL || 'https://127.0.0.1:2999') {
  const base = liveClientBase(target);
  let port = 2999;
  try { const parsed = new URL(base); port = Number(parsed.port) || (parsed.protocol === 'http:' ? 80 : 443); } catch {}
  try { return { ok: true, source: 'live_client', data: await requestJson(base + '/liveclientdata/allgamedata', { maxResponseBytes: MAX_RESPONSE_BYTES }) }; } catch (e) { return { ok: false, source: 'live_client', reason: e.message, port, url: base }; }
}
function dataDragonUrl(v, k, id) { const b = `https://ddragon.leagueoflegends.com/cdn/${v}`; if (k === 'champion') return `${b}/img/champion/${id}.png`; if (k === 'item') return `${b}/img/item/${id}.png`; if (k === 'summoner') return `${b}/img/spell/${id}.png`; throw new Error('Unsupported Data Dragon kind'); }
function ensureCacheDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
module.exports = { requestJson, readRiotLockfile, probeLcu, probeLiveClient, liveClientBase, dataDragonUrl, ensureCacheDir, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES };

// 国服客户端优先使用启动参数：--app-port 与 --remoting-auth-token。

function parseRiotClientArgs(commandLine) {
  const text = String(commandLine || "");
  const portMatch = text.match(/--app-port[=\s]+(\d+)/i);
  const tokenMatch = text.match(/--remoting-auth-token[=\s]+([^\s]+)/i);
  if (!portMatch || !tokenMatch) return null;
  return { port: Number(portMatch[1]), password: tokenMatch[1].replace(/^"|"$/g, ""), protocol: "https", source: "startup_args" };
}
function connectionFromEnv(env = process.env) {
  if (env.RIOT_LCU_PORT && env.RIOT_REMOTING_AUTH_TOKEN) return { port: Number(env.RIOT_LCU_PORT), password: env.RIOT_REMOTING_AUTH_TOKEN, protocol: "https", source: "environment" };
  return null;
}
function findCachedLcuPort(roots = []) {
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    try {
      const files = fs.readdirSync(root, { recursive: true });
      for (const file of files) {
        const full = require('path').join(root, file);
        if (!/\.log$|\.ldb$|CURRENT$/.test(file) || !fs.statSync(full).isFile()) continue;
        const text = fs.readFileSync(full);
        const matches = text.toString('latin1').match(/https?:\/\/127\.0\.0\.1:(\d{4,5})/g) || [];
        for (const match of matches.reverse()) { const port = Number(match.match(/(\d{4,5})$/)[1]); if (port >= 1000 && port <= 65535) return { port, source: 'client_cache', protocol: 'https' }; }
      }
    } catch {}
  }
  return null;
}
function findClientCommandLine() {
  return new Promise(resolve => {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='LeagueClient.exe' OR Name='RiotClientServices.exe'\" | Select-Object -ExpandProperty CommandLine";
    execFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], { windowsHide: true, timeout: 2500 }, (error, stdout) => resolve(error ? null : String(stdout || '').trim() || null));
  });
}
// --- Ux 日志发现：国服不写 lockfile、WMI 也拿不到 CommandLine 时，日志里的启动参数是唯一可靠来源 ---
// 日志可能很大（真实 Ux 日志 900KB+），但启动参数固定在前几行；
// 只读头部 128KB，避免旧实现只读尾部 96KB 时漏掉第 8 行的 Command line arguments。
function readHead(file, bytes = 128 * 1024) {
  const { statSync, openSync, readSync, closeSync } = fs;
  const stat = statSync(file);
  const length = Math.min(bytes, stat.size);
  if (!length) return '';
  const buf = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, length, 0); return buf.toString('utf8'); }
  finally { closeSync(fd); }
}
function commandLineScope(source) {
  const lines = String(source || '').split(/\r?\n/).filter(line => /Command line arguments:/i.test(line));
  if (lines.length) return lines.join('\n');
  // 兼容只传入一段参数文本的单测/调用；含有 Cef CommandLine 的日志绝不退化为全篇扫描。
  return /Cef CommandLine/i.test(source) ? '' : source;
}
function parseUxLog(text) {
  const source = String(text || '');
  const scope = commandLineScope(source);
  // 只认 --app-port，避免把 --riotclient-app-port 或 Cef 调试端口误当游戏端口。
  const tokens = [...scope.matchAll(/--remoting-auth-token(?:=|\s+)"?([^\s"']+)"?/g)];
  const ports = [...scope.matchAll(/--app-port(?:=|\s+)"?(\d+)"?/g)];
  if (!tokens.length || !ports.length) return null;
  const password = tokens[tokens.length - 1][1].replace(/^"|"$/g, '');
  const port = Number(ports[ports.length - 1][1]);
  if (!Number.isFinite(port) || !password) return null;
  return { port, password, protocol: 'https', source: 'ux_log' };
}
function leagueClientDirFromProcess() {
  return new Promise(resolve => {
    const script = "(Get-Process LeagueClient -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 2000 }, (error, stdout) => {
      const exe = String(stdout || '').trim().split(/\r?\n/)[0];
      resolve(!error && exe ? require('path').dirname(exe) : null);
    });
  });
}
const DEFAULT_CLIENT_DIRS = [
  'D:/WeGameApps/英雄联盟（含经典模式）/LeagueClient',
  'D:/WeGameApps/英雄联盟/LeagueClient',
  'C:/Riot Games/League of Legends/LeagueClient',
  'D:/Riot Games/League of Legends/LeagueClient',
  'E:/Riot Games/League of Legends/LeagueClient'
];
let cachedClientDirs = null;
let resolvingClientDirs = null;
function isDirectory(dir) { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }
// 已知安装路径优先，命中就不必去问 PowerShell（进程查询要 1~2 秒）。
async function resolveClientDirs(options = {}) {
  if (cachedClientDirs) return cachedClientDirs;
  if (resolvingClientDirs) return resolvingClientDirs;
  resolvingClientDirs = (async () => {
    const fixed = [];
    for (const key of ['RIOT_LEAGUE_CLIENT_DIR', 'LEAGUE_CLIENT_DIR', 'LOL_CLIENT_DIR']) if (process.env[key]) fixed.push(process.env[key]);
    if (options.clientDir) fixed.push(options.clientDir);
    const known = [...new Set([...fixed, ...DEFAULT_CLIENT_DIRS].filter(Boolean))].filter(isDirectory);
    if (known.length) return (cachedClientDirs = known);
    const fromProcess = await leagueClientDirFromProcess();
    return (cachedClientDirs = [...new Set([fromProcess].filter(Boolean))].filter(isDirectory));
  })();
  try { return await resolvingClientDirs; } finally { resolvingClientDirs = null; }
}
async function findUxLogConnections(options = {}) {
  const dirs = options.dirs || await resolveClientDirs(options);
  const found = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(name => /_LeagueClientUx\.log$/i.test(name)); } catch { continue; }
    const ranked = names.map(name => {
      const full = require('path').join(dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      return { full, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    for (const item of ranked.slice(0, 5)) {
      let parsed = null;
      try { parsed = parseUxLog(readHead(item.full)); } catch { continue; }
      if (parsed) { parsed.logPath = item.full; parsed.logMtime = item.mtime; found.push(parsed); break; }
    }
  }
  return found.sort((a, b) => b.logMtime - a.logMtime);
}
async function firstReachable(candidates) {
  for (const candidate of candidates) {
    try {
      const auth = Buffer.from(`riot:${candidate.password}`).toString('base64');
      await requestJson(`https://127.0.0.1:${candidate.port}/lol-gameflow/v1/gameflow-phase`, { headers: { Authorization: `Basic ${auth}` }, timeout: 900 });
      return candidate;
    } catch {}
  }
  return null;
}
async function discoverLcuConnection(options = {}) {
  if (options.commandLine) return parseRiotClientArgs(options.commandLine);
  if (process.env.RIOT_CLIENT_COMMAND_LINE) return parseRiotClientArgs(process.env.RIOT_CLIENT_COMMAND_LINE);
  const env = connectionFromEnv(options.env || process.env);
  if (env) return env;
  const uxConnections = await findUxLogConnections(options);
  if (uxConnections.length) {
    const alive = await firstReachable(uxConnections);
    return alive || uxConnections[0];
  }
  const commandLine = await findClientCommandLine();
  const fromArgs = parseRiotClientArgs(commandLine);
  if (fromArgs) return fromArgs;
  return findCachedLcuPort([process.env.LOCALAPPDATA + '/Riot Games/League of Legends/Cache/Local Storage/leveldb']);
}
module.exports.parseRiotClientArgs = parseRiotClientArgs;
module.exports.connectionFromEnv = connectionFromEnv;
module.exports.findClientCommandLine = findClientCommandLine;
module.exports.discoverLcuConnection = discoverLcuConnection;
module.exports.findCachedLcuPort = findCachedLcuPort;
module.exports.parseUxLog = parseUxLog;
module.exports.readHead = readHead;
module.exports.findUxLogConnections = findUxLogConnections;
module.exports.resolveClientDirs = resolveClientDirs;

async function probeLcuConnection(input, options = {}) {
  let connection = null;
  if (input && typeof input === "object" && input.port) connection = input;
  if (!connection && options.commandLine) connection = parseRiotClientArgs(options.commandLine);
  if (!connection && process.env.RIOT_CLIENT_COMMAND_LINE) connection = parseRiotClientArgs(process.env.RIOT_CLIENT_COMMAND_LINE);
  if (!connection) connection = connectionFromEnv(options.env || process.env);
  if (!connection && typeof input === "string") connection = readRiotLockfile(input);
  if (!connection) return { ok: false, source: "lcu", reason: "connection_details_not_found" };
  try {
    const auth = Buffer.from(`riot:${connection.password}`).toString("base64");
    const phase = await requestJson(`https://127.0.0.1:${connection.port}/lol-gameflow/v1/gameflow-phase`, { headers: { Authorization: `Basic ${auth}` } });
    return { ok: true, source: "lcu", phase, port: connection.port, discovery: connection.source || "lockfile" };
  } catch (e) {
    return { ok: false, source: "lcu", reason: e.message, port: connection.port, discovery: connection.source || "lockfile" };
  }
}
module.exports.probeLcu = probeLcuConnection;

async function fetchLcuJson(connection, endpoint) {
  const auth = Buffer.from(`riot:${connection.password}`).toString('base64');
  return requestJson(`https://127.0.0.1:${connection.port}${endpoint}`, { headers: { Authorization: `Basic ${auth}` }, timeout: 1800 });
}
module.exports.fetchLcuJson = fetchLcuJson;
