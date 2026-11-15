'use strict';

// Replay API 客户端（回放模式下由游戏客户端在 127.0.0.1:2999 提供）。
// 字段名对齐 RiotGames/leaguedirector 的 api.py，避免自己发明键名。

const { requestJson } = require('./data-sources');
const BASE = process.env.REPLAY_BASE || 'https://127.0.0.1:2999';

const CAMERA_FIELDS = [
  'cameraMode', 'cameraPosition', 'cameraRotation', 'cameraAttached',
  'fieldOfView', 'nearClip', 'farClip',
  'cameraLockX', 'cameraLockY', 'cameraLockZ', 'cameraMoveSpeed', 'cameraLookSpeed'
];
const PLAYBACK_FIELDS = ['paused', 'seeking', 'time', 'speed'];

function pick(source, fields) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of fields) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function replayGet(path, timeout = 1200) { return requestJson(BASE + path, { timeout }); }
function replayPost(path, body, timeout = 2000) { return requestJson(BASE + path, { method: 'POST', body, timeout }); }

async function readReplayState() {
  try {
    const [playback, render, recording] = await Promise.all([
      replayGet('/replay/playback'),
      replayGet('/replay/render'),
      replayGet('/replay/recording').catch(() => null)
    ]);
    return { connected: true, playback, render, recording };
  } catch (error) {
    return { connected: false, error: error.message };
  }
}

async function setCamera(patch) { return replayPost('/replay/render', pick(patch, CAMERA_FIELDS)); }
async function setPlayback(patch) { return replayPost('/replay/playback', pick(patch, PLAYBACK_FIELDS)); }
async function playSequence(frames) {
  if (!Array.isArray(frames) || !frames.length) throw new Error('关键帧序列为空');
  return replayPost('/replay/sequence', frames, 5000);
}

module.exports = { BASE, CAMERA_FIELDS, PLAYBACK_FIELDS, readReplayState, setCamera, setPlayback, playSequence };
