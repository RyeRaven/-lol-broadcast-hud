'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { htmlShell, escapeHtml } = require('../src/pages/html');
const { consolePage } = require('../src/pages/console');

test('htmlShell escapes title and leaves trusted body/scripts untouched', () => {
  assert.equal(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  const html = htmlShell('<img src=x onerror="alert(1)">', '<div id="safe">ok</div>', '<script>window.ok=1</script>');
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.equal(html.includes('<img src=x onerror="alert(1)">'), false);
  // body/scripts 明确按受信任模板处理，不做二次转义。
  assert.ok(html.includes('<div id="safe">ok</div>'));
  assert.ok(html.includes('<script>window.ok=1</script>'));
  assert.throws(() => htmlShell('title', { body: 'not a string' }), /trusted string/);
  assert.throws(() => htmlShell('title', '<div></div>', { scripts: true }), /trusted string/);
});

test('console timeline dedupe keeps a bounded 500-entry set', () => {
  const html = consolePage(3210);
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match);
  const script = match[1].replace(/\ninit\(\);\s*$/, '');
  const element = () => ({ innerHTML: '', textContent: '', className: '', value: '', style: {}, addEventListener() {} });
  const context = {
    document: { getElementById: () => element(), querySelectorAll: () => [], addEventListener() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date,
    Math,
    JSON,
    Set,
    Map,
    String,
    Number,
    Array,
    Object,
    Promise
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  const entries = Array.from({ length: 600 }, (_, index) => ({ time: index, type: 'kill', text: 'k' + index, side: 'blue' }));
  context.processTimeline({ timeline: entries });
  assert.equal(context.seenTimeline.size, 500);
  assert.equal(context.seenTimeline.has('0|kill|k0'), false);
  assert.equal(context.seenTimeline.has('599|kill|k599'), true);
});

test('console page inline script parses and exposes OBS record/stream/replay controls', () => {
  const html = consolePage(3210);
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, '控台应包含内联脚本');
  assert.doesNotThrow(() => new Function(match[1]));
  assert.ok(html.includes('data-obs-record="start"'));
  assert.ok(html.includes('data-obs-record="stop"'));
  assert.ok(html.includes('data-obs-stream="start"'));
  assert.ok(html.includes('data-obs-stream="stop"'));
  assert.ok(html.includes('data-obs-replay="save"'));
  assert.ok(html.includes('id="obsRecording"'));
  assert.ok(html.includes('id="obsStream"'));
  assert.ok(html.includes("obsCommand('/api/obs/record'"));
  assert.ok(html.includes("obsCommand('/api/obs/stream'"));
  assert.ok(html.includes("obsCommand('/api/obs/replay-buffer'"));
  assert.ok(html.includes("document.visibilityState !== 'hidden'"));
  assert.ok(html.includes('obs.record'));
  assert.ok(html.includes('obs.stream'));
  assert.ok(html.includes('obs.replayBuffer'));
  assert.ok(html.includes('查询中'));
  assert.ok(html.includes('SEEN_TIMELINE_LIMIT'));
  assert.ok(html.includes('riftbroadcast:service-down'));
  assert.ok(html.includes('riftbroadcast:service-up'));
});
