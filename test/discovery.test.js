const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUxLog } = require('../src/data-sources');

test('parses app port and remoting token from Ux log command line', () => {
  const line = '--product-install-mode=--app-port=52479 --remoting-auth-token=abcDEF123ghiJKL456mno --app-region=';
  assert.deepEqual(parseUxLog(line), { port: 52479, password: 'abcDEF123ghiJKL456mno', protocol: 'https', source: 'ux_log' });
});

test('uses the last occurrence when a log holds several launches', () => {
  const text = '--app-port=1111 --remoting-auth-token=old\n--app-port=2222 --remoting-auth-token=new';
  const parsed = parseUxLog(text);
  assert.equal(parsed.port, 2222);
  assert.equal(parsed.password, 'new');
});

test('returns null when the command line is absent', () => {
  assert.equal(parseUxLog('just some log noise'), null);
  assert.equal(parseUxLog('--app-port=2222'), null);
  assert.equal(parseUxLog(''), null);
});
