const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http');
const { requestJson, readRiotLockfile, dataDragonUrl, liveClientBase } = require('../src/data-sources');
test('reads Riot lockfile', () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rift-')); const f = path.join(d, 'lockfile'); fs.writeFileSync(f, 'LeagueClient:1234:54321:secret:https'); assert.deepEqual(readRiotLockfile(f), { process: 'LeagueClient', pid: 1234, port: 54321, password: 'secret', protocol: 'https' }); });
test('builds Data Dragon URL', () => assert.equal(dataDragonUrl('15.21.1', 'champion', 'Ahri'), 'https://ddragon.leagueoflegends.com/cdn/15.21.1/img/champion/Ahri.png'));
test('normalizes Live Client URL from full URL, host:port and numeric port', () => {
  assert.equal(liveClientBase('http://127.0.0.1:2999'), 'http://127.0.0.1:2999');
  assert.equal(liveClientBase({ url: 'https://127.0.0.1:4123/liveclientdata' }), 'https://127.0.0.1:4123');
  assert.equal(liveClientBase({ host: '127.0.0.1', port: 3800 }), 'https://127.0.0.1:3800');
  assert.equal(liveClientBase('3801'), 'https://127.0.0.1:3801');
  assert.equal(liveClientBase('localhost:3802'), 'https://localhost:3802');
  assert.equal(liveClientBase(''), 'https://127.0.0.1:2999');
});

test('requestJson 在响应超过 maxResponseBytes 时立即中断并报错', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"data":"');
    res.write('x'.repeat(4096));
    res.end('"}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    await assert.rejects(
      requestJson('http://127.0.0.1:' + port + '/big', { maxResponseBytes: 1024 }),
      error => error && error.code === 'response_too_large' && error.maxResponseBytes === 1024
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

const { parseRiotClientArgs, connectionFromEnv } = require("../src/data-sources");
test("parses startup args", () => assert.deepEqual(parseRiotClientArgs("LeagueClient.exe --app-port=12345 --remoting-auth-token=abcXYZ"), { port: 12345, password: "abcXYZ", protocol: "https", source: "startup_args" }));
test("reads env connection", () => assert.deepEqual(connectionFromEnv({ RIOT_LCU_PORT: "23456", RIOT_REMOTING_AUTH_TOKEN: "token" }), { port: 23456, password: "token", protocol: "https", source: "environment" }));
