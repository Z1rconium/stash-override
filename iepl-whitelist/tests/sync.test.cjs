const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../iepl-whitelist.js'), 'utf8');
function run({ mode = 'tile', state = {}, online = true, status = 200, body = '<HTML><BODY>Success</BODY></HTML>', configured = true, netError = false, serverError = false, recent = false } = {}) {
  const store = { 'ipwl.state': JSON.stringify(state), 'ipwl.cronTs': JSON.stringify(Date.now()) };
  if (recent) store['ipwl.state'] = JSON.stringify({ ...state, lastCheck: Date.now() });
  const requests = [], notices = [], done = [];
  vm.runInNewContext(source, {
    $argument: JSON.stringify({ mode, api: configured ? 'https://sync.example.com' : 'https://YOUR_DOMAIN', token: 'test' }),
    $persistentStore: { read: k => store[k], write: (v, k) => { store[k] = v; return true; } },
    $httpClient: {
      get: (req, cb) => { requests.push(req); cb(online ? null : 'offline', { status }, body); },
      post: (req, cb) => { requests.push(req); cb(netError ? 'timeout' : null, { status: 200 }, JSON.stringify(serverError ? { ok: false, msg: 'invalid token' } : { ok: true, ip: '1.2.3.4', status: 'exists', count: 1, limit: 10 })); },
    },
    $notification: { post: (...args) => notices.push(args) },
    $done: v => done.push(v),
  });
  assert.equal(done.length, 1);
  for (const req of requests) {
    assert.equal(req.headers['X-Stash-Selected-Proxy'], 'DIRECT');
    assert.equal(req['auto-redirect'], false);
  }
  return { state: JSON.parse(store['ipwl.state']), requests, notices, result: done[0] };
}
for (const mode of ['cron', 'tile']) {
  test(`${mode}: offline skips POST and preserves previous result without notifications`, () => {
    const previous = { lastOk: 1234, lastCheck: 1234, ip: '4.3.2.1', netFails: 2 };
    const r = run({ mode, online: false, state: previous });
    assert.equal(r.requests.length, 1);
    for (const k of Object.keys(previous)) assert.equal(r.state[k], previous[k]);
    assert.equal(r.state.offline, true);
    assert.equal(r.notices.length, 0);
    if (mode === 'tile') assert.match(r.result.content, /跳过同步/);
  });
  test(`${mode}: online performs direct sync`, () => {
    const r = run({ mode });
    assert.equal(r.requests.length, 2);
    assert.equal(r.state.ip, '1.2.3.4');
    assert.equal(r.state.offline, false);
    assert.equal(r.requests[0].headers['X-Token'], undefined);
  });
}
test('captive portal / unexpected status fails probe', () => {
  for (const opts of [{ body: 'login' }, { status: 302 }, { status: 503 }]) {
    assert.equal(run(opts).requests.length, 1);
  }
});
test('offline recovery bypasses normal five minute interval', () => {
  const r = run({ mode: 'cron', recent: true, state: { offline: true } });
  assert.equal(r.requests.length, 2);
  assert.equal(r.state.offline, false);
});
test('normal cron interval and unconfigured entry do not probe', () => {
  assert.equal(run({ mode: 'cron', recent: true }).requests.length, 0);
  assert.equal(run({ configured: false }).requests.length, 0);
});
test('online service failures retain existing retry and notification logic', () => {
  const r = run({ netError: true, state: { netFails: 2 } });
  assert.equal(r.requests.length, 4);
  assert.equal(r.state.netFails, 3);
  assert.equal(r.notices.length, 1);
  assert.ok(r.requests.reduce((n, req) => n + req.timeout, 0) < 30);
  const s = run({ serverError: true });
  assert.equal(s.requests.length, 2);
  assert.equal(s.state.fails, 1);
});
