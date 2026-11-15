#!/usr/bin/env node
'use strict';

// RiftBroadcast OBS 场景包安装器：可重复执行（幂等）。
// 直接通过 obs-websocket 创建/更新独立的 RiftBroadcast 场景集合，
// 并验证 4 个 Browser Source 的尺寸、透明与“不重载”设置。
// 不修改用户原有场景集合的内容；默认保留 RiftBroadcast 集合供使用。
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { ObsClient, SCENE_PACKAGE } = require('../src/obs');

const DEFAULT_APP_URL = 'http://127.0.0.1:3210';
const DEFAULT_OBS_URL = 'ws://127.0.0.1:4455';
const AUTO_SWITCH = { ...SCENE_PACKAGE.autoSwitch };

function usage() {
  return [
    '用法: node tools/setup-obs-scenes.js [选项]',
    '',
    '创建或更新 OBS 场景集合 RiftBroadcast（4 个场景/浏览器源），可重复执行。',
    '',
    '选项:',
    '  --obs-url <url>        OBS WebSocket 地址，默认 ws://127.0.0.1:4455',
    '  --password <password>  OBS WebSocket 密码（也可用 OBS_PASSWORD 环境变量）',
    '  --app-url <url>        RiftBroadcast 本地服务地址，默认 http://127.0.0.1:3210',
    '  --base-url <url>       Browser Source 基础地址，默认 http://127.0.0.1:3210',
    '  --collection <name>    场景集合名称，默认 RiftBroadcast',
    '  --restore-original     安装并验证后切回运行前的场景集合和场景',
    '  --skip-autoswitch      不写入 autoSwitch 映射',
    '  --json                 以 JSON 输出结果',
    '  --help                 显示帮助',
    '',
    '说明:',
    '  - 所有 Browser Source 均为 1920×1080、透明背景、shutdown_when_not_visible=false、restart_when_active=false。',
    '  - autoSwitch 会优先 POST 到 --app-url /api/obs/autoswitch；本地服务未运行时写入 data/config.json。',
    '  - 不改动原有场景集合中的任何场景/来源；--restore-original 只切换当前集合，不删除任何内容。'
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    obsUrl: process.env.OBS_URL || DEFAULT_OBS_URL,
    password: process.env.OBS_PASSWORD || '',
    appUrl: DEFAULT_APP_URL,
    baseUrl: DEFAULT_APP_URL,
    collection: SCENE_PACKAGE.collectionName,
    restoreOriginal: false,
    skipAutoswitch: false,
    json: false,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--restore-original') { opts.restoreOriginal = true; continue; }
    if (arg === '--skip-autoswitch') { opts.skipAutoswitch = true; continue; }
    if (arg === '--obs-url' || arg === '--password' || arg === '--app-url' || arg === '--base-url' || arg === '--collection') {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) throw new Error('缺少参数值: ' + arg);
      i += 1;
      if (arg === '--obs-url') opts.obsUrl = value;
      else if (arg === '--password') opts.password = value;
      else if (arg === '--app-url') opts.appUrl = value;
      else if (arg === '--base-url') opts.baseUrl = value;
      else opts.collection = value;
      continue;
    }
    throw new Error('未知参数: ' + arg);
  }
  opts.obsUrl = String(opts.obsUrl || DEFAULT_OBS_URL).trim();
  opts.appUrl = String(opts.appUrl || DEFAULT_APP_URL).replace(/\/+$/, '');
  opts.baseUrl = String(opts.baseUrl || DEFAULT_APP_URL).replace(/\/+$/, '');
  opts.collection = String(opts.collection || SCENE_PACKAGE.collectionName).trim();
  if (!opts.collection) throw new Error('场景集合名称不能为空');
  return opts;
}

function requestJson(urlString, method, body, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(urlString); } catch (error) { reject(error); return; }
    const transport = target.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers: payload ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length } : {}
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ statusCode: res.statusCode || 0, body: json, text });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function updateConfigFile(autoSwitch) {
  const configPath = path.join(__dirname, '..', 'data', 'config.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {}; } catch {}
  const next = { ...current, autoSwitch: { ...(current.autoSwitch || {}), ...autoSwitch } };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(configPath, 0o600); } catch {}
  return configPath;
}

async function writeAutoSwitch(opts) {
  if (opts.skipAutoswitch) return { ok: true, skipped: true, target: null, mapping: AUTO_SWITCH };
  try {
    const response = await requestJson(opts.appUrl + '/api/obs/autoswitch', 'POST', AUTO_SWITCH);
    if (response.statusCode >= 200 && response.statusCode < 300 && response.body && response.body.ok) {
      return { ok: true, skipped: false, target: 'app', url: opts.appUrl + '/api/obs/autoswitch', mapping: response.body.autoSwitch || AUTO_SWITCH };
    }
    throw new Error('HTTP ' + response.statusCode);
  } catch (error) {
    const configPath = updateConfigFile(AUTO_SWITCH);
    return { ok: true, skipped: false, target: 'config', file: configPath, warning: '本地服务不可用（' + error.message + '），已写入 data/config.json，下次启动生效', mapping: AUTO_SWITCH };
  }
}

function getCurrentSceneName(client) {
  return client.request('GetCurrentProgramScene')
    .then(data => data.currentProgramSceneName || data.sceneName || null)
    .catch(() => null);
}

function normalizeInputSettings(data) {
  if (data && data.inputSettings && typeof data.inputSettings === 'object') return data.inputSettings;
  return data && typeof data === 'object' ? data : {};
}

async function verifySceneEntry(client, source) {
  const settings = normalizeInputSettings(await client.getInputSettings(source.inputName));
  const itemsData = await client.getSceneItemList(source.sceneName);
  const items = Array.isArray(itemsData.sceneItems) ? itemsData.sceneItems : [];
  const inScene = items.some(item => item && (item.sourceName === source.inputName || item.inputName === source.inputName));
  const problems = [];
  if (!inScene) problems.push('场景中缺少来源');
  if (String(settings.url || '') !== source.url) problems.push('URL 不匹配: ' + String(settings.url || ''));
  if (Number(settings.width) !== 1920) problems.push('width=' + settings.width);
  if (Number(settings.height) !== 1080) problems.push('height=' + settings.height);
  if (!/background\s*:\s*transparent/i.test(String(settings.css || ''))) problems.push('缺少透明背景 CSS');
  if (settings.shutdown_when_not_visible !== false) problems.push('shutdown_when_not_visible=' + settings.shutdown_when_not_visible);
  if (settings.restart_when_active !== false) problems.push('restart_when_active=' + settings.restart_when_active);
  return {
    sceneName: source.sceneName,
    sourceName: source.inputName,
    url: settings.url || '',
    width: Number(settings.width) || null,
    height: Number(settings.height) || null,
    cssTransparent: /background\s*:\s*transparent/i.test(String(settings.css || '')),
    shutdownWhenNotVisible: settings.shutdown_when_not_visible,
    restartWhenActive: settings.restart_when_active,
    inScene,
    ok: problems.length === 0,
    problems
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(usage()); return 0; }

  const client = new ObsClient();
  let originalCollection = null;
  let originalScene = null;
  try {
    await client.connect({ url: opts.obsUrl, password: opts.password, autoReconnect: false });
    const before = await client.getSceneCollectionList();
    originalCollection = before.currentSceneCollectionName || null;
    originalScene = await getCurrentSceneName(client);
    const packageInfo = await client.createScenePackage({ baseUrl: opts.baseUrl, collectionName: opts.collection, autoSwitch: AUTO_SWITCH });

    const verification = [];
    for (const source of packageInfo.sources) {
      verification.push(await verifySceneEntry(client, source));
    }
    for (const sceneName of packageInfo.scenes) {
      await client.setScene(sceneName);
      const current = await getCurrentSceneName(client);
      if (current !== sceneName) verification.push({ sceneName, sourceName: null, ok: false, problems: ['切换场景失败: 当前为 ' + current] });
    }

    const autoSwitch = await writeAutoSwitch(opts);

    let restored = false;
    if (opts.restoreOriginal && originalCollection) {
      await client.setCurrentSceneCollection(originalCollection);
      if (originalScene && packageInfo.scenes.includes(originalScene) === false) {
        try { await client.setScene(originalScene); } catch {}
      }
      restored = true;
    }

    const failures = verification.filter(item => !item.ok);
    const result = {
      ok: failures.length === 0,
      collectionName: packageInfo.collectionName,
      baseUrl: opts.baseUrl,
      createdCollection: packageInfo.createdCollection,
      createdScenes: packageInfo.createdScenes,
      scenes: packageInfo.scenes,
      sources: packageInfo.sources,
      autoSwitch: autoSwitch.mapping,
      autoSwitchResult: autoSwitch,
      originalCollection,
      originalScene,
      restored,
      verification,
      failures
    };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('[RiftBroadcast] OBS 场景集合: ' + result.collectionName + (result.createdCollection ? '（新建）' : '（已存在，已更新）'));
      console.log('[RiftBroadcast] 场景: ' + result.scenes.join(' / '));
      console.log('[RiftBroadcast] 浏览器源:');
      for (const source of result.sources) console.log('  - ' + source.sceneName + ' ← ' + source.inputName + ' ' + source.url);
      console.log('[RiftBroadcast] autoSwitch: draft→' + result.autoSwitch.draft + '，in_game→' + result.autoSwitch.in_game + '，post_game→' + result.autoSwitch.post_game);
      if (autoSwitch.warning) console.log('[RiftBroadcast] 提示: ' + autoSwitch.warning);
      if (result.restored) console.log('[RiftBroadcast] 已还原运行前场景集合: ' + originalCollection + (originalScene ? ' / ' + originalScene : ''));
      console.log(result.ok ? '[RiftBroadcast] 验证通过：4 个 Browser Source 均为 1920×1080、透明、不重载。' : '[RiftBroadcast] 验证失败: ' + failures.map(item => item.sceneName + ': ' + item.problems.join(', ')).join('; '));
    }
    return result.ok ? 0 : 1;
  } finally {
    if (opts.restoreOriginal && originalCollection && client.status && client.status.connected && client.status.sceneCollection !== originalCollection) {
      try {
        await client.setCurrentSceneCollection(originalCollection);
        if (originalScene) { try { await client.setScene(originalScene); } catch {} }
      } catch {}
    }
    try { client.disconnect(); } catch {}
  }
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error('[RiftBroadcast] 安装场景包失败: ' + (error && error.message ? error.message : error));
  if (process.argv.includes('--json')) console.error(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
