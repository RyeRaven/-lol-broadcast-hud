'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data');
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const VERSION_URL = 'https://ddragon.leagueoflegends.com/api/versions.json';
let cached = null;
let loading = null;

function fetchJson(url, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
  });
}

function buildIndex(entries, version) {
  const byId = new Map();
  for (const [key, champion] of Object.entries(entries || {})) {
    const numeric = Number(champion && champion.key);
    if (!Number.isFinite(numeric)) continue;
    byId.set(numeric, { id: numeric, key, name: (champion && champion.name) || key });
  }
  return {
    version,
    size: byId.size,
    name(id) { const entry = byId.get(Number(id)); return entry ? entry.name : ''; },
    key(id) { const entry = byId.get(Number(id)); return entry ? entry.key : ''; }
  };
}

function readCache(version) {
  try {
    const file = path.join(CACHE_DIR, 'champions-' + version + '.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!saved || Date.now() - Number(saved.savedAt || 0) > CACHE_TTL) return null;
    return buildIndex(saved.data, version);
  } catch { return null; }
}

function writeCache(version, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, 'champions-' + version + '.json'), JSON.stringify({ savedAt: Date.now(), version, data }));
  } catch {}
}

async function resolveVersion(preferred) {
  if (preferred) return preferred;
  const versions = await fetchJson(VERSION_URL, 4000);
  if (!Array.isArray(versions) || !versions.length) throw new Error('versions.json empty');
  return versions[0];
}

async function loadChampionIndex(options = {}) {
  if (cached) return cached;
  if (loading) return loading;
  loading = (async () => {
    const version = await resolveVersion(options.version).catch(() => null);
    if (!version) return buildIndex({}, null);
    const disk = readCache(version);
    if (disk) return disk;
    const payload = await fetchJson('https://ddragon.leagueoflegends.com/cdn/' + version + '/data/zh_CN/champion.json').catch(() => null);
    if (!payload || !payload.data) return buildIndex({}, version);
    writeCache(version, payload.data);
    return buildIndex(payload.data, version);
  })();
  try { cached = await loading; } finally { loading = null; }
  return cached;
}

module.exports = { loadChampionIndex, buildIndex, CACHE_DIR };
