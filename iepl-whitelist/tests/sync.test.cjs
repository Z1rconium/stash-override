const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../iepl-whitelist.js'), 'utf8');
function run({ mode = 'tile', state = {}, online = true, status = 200, body = '<HTML><BODY>Success</BODY></HTML>', configured = true, netError = false, serverError = false, recent = false, loon = false, api, added = false, removed = null } = {}) {
  const store = { 'ipwl.state': JSON.stringify(state), 'ipwl.cronTs': JSON.stringify(Date.now()) };
  if (recent) store['ipwl.state'] = JSON.stringify({ ...state, lastCheck: Date.now() });
  const requests = [], notices = [], done = [];
  const argument = { mode, api: api || (configured ? 'https://sync.example.com' : 'https://YOUR_DOMAIN'), token: 'test' };
  vm.runInNewContext(source, {
    ...(loon ? { $loon: 'iPhone 18.0 3.5.1(983)', $script: { name: 'iepl-whitelist-' + mode } } : {}),
    console: { log() {} },
    $argument: loon ? { api: argument.api, token: argument.token } : JSON.stringify(argument),
    $persistentStore: { read: k => store[k], write: (v, k) => { store[k] = v; return true; } },
    $httpClient: {
      get: (req, cb) => { requests.push(req); cb(online ? null : 'offline', { status }, body); },
      post: (req, cb) => { requests.push(req); cb(netError ? 'timeout' : null, { status: 200 }, JSON.stringify(serverError ? { ok: false, msg: 'invalid token' } : { ok: true, ip: '1.2.3.4', status: added ? 'added' : 'exists', count: 1, limit: 10, removed_ip: removed })); },
    },
    $notification: { post: (...args) => notices.push(args) },
    $done: v => done.push(v),
  });
  assert.equal(done.length, 1);
  for (const req of requests) {
    if (loon) {
      assert.equal(req.node, 'DIRECT');
      assert.equal(req.insecure, false);
      assert.equal(req.headers['X-Stash-Selected-Proxy'], undefined);
      assert.ok([3000, 8000].includes(req.timeout));
    } else assert.equal(req.headers['X-Stash-Selected-Proxy'], 'DIRECT');
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

for (const mode of ['cron', 'network', 'manual']) {
  test(`Loon ${mode}: direct sync with typed plugin arguments`, () => {
    const r = run({ loon: true, mode });
    assert.equal(r.requests.length, 2);
    assert.equal(r.state.ip, '1.2.3.4');
    assert.equal(r.result, undefined); // 不返回 Stash Tile 对象
    assert.equal(r.notices.length, mode === 'manual' ? 1 : 0);
    if (mode === 'manual') assert.match(r.notices[0][2], /1.2.3.4/);
  });
  test(`Loon ${mode}: offline preserves last result`, () => {
    const r = run({ loon: true, mode, online: false, state: { lastOk: 1234, lastCheck: 1234 } });
    assert.equal(r.requests.length, 1);
    assert.equal(r.state.lastCheck, 1234);
    assert.equal(r.state.lastOk, 1234);
    assert.equal(r.state.netFails, undefined);
    assert.equal(r.notices.length, mode === 'manual' ? 1 : 0);
  });
}
test('Loon network change forces check; cron retains scheduling', () => {
  assert.equal(run({ loon: true, mode: 'network', recent: true }).requests.length, 2);
  assert.equal(run({ loon: true, mode: 'cron', recent: true }).requests.length, 0);
  assert.equal(run({ loon: true, mode: 'cron', recent: true, state: { offline: true } }).requests.length, 2);
});
test('Loon placeholders and non-HTTPS URLs never send requests', () => {
  for (const mode of ['cron', 'network', 'manual']) {
    for (const opts of [{ configured: false }, { api: 'http://sync.example.com' }]) {
      const r = run({ loon: true, mode, ...opts });
      assert.equal(r.requests.length, 0);
      assert.equal(r.notices.length, mode === 'manual' ? 1 : 0);
    }
  }
});
test('Loon retries fit timeout budget; explicit server errors do not retry', () => {
  const r = run({ loon: true, mode: 'cron', netError: true, state: { netFails: 2 } });
  assert.equal(r.requests.length, 4);
  assert.equal(r.state.netFails, 3);
  assert.equal(r.notices.length, 1);
  assert.ok(r.requests.reduce((n, req) => n + req.timeout, 0) < 30000);
  assert.equal(run({ loon: true, mode: 'cron', serverError: true }).requests.length, 2);
});
test('Loon manual addition sends only one notification including eviction', () => {
  const r = run({ loon: true, mode: 'manual', added: true, removed: '4.3.2.1' });
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0][2], /4.3.2.1/);
});
test('plugin declares parameters and binds all three supported triggers', () => {
  const path = require('node:path');
  const plugin = fs.readFileSync(path.join(__dirname, '../iepl-whitelist.plugin'), 'utf8');
  assert.match(plugin, /#!loon_version = 3.5.1\(983\)/);
  const lines = plugin.split('\n').filter(l => /then script\(/.test(l));
  assert.equal(lines.length, 3);
  for (const [i, trigger] of ['cron "* * * * *"', 'network-changed', 'generic'].entries()) {
    assert.ok(lines[i].startsWith(trigger + ' then script('));
    assert.ok(lines[i].includes('{${api}, ${token}}'));
    assert.ok(lines[i].includes('timeout=30'));
    const url = lines[i].match(/script\("([^"]+)"/)[1];
    assert.equal(new URL(url).pathname.split('/').pop(), 'iepl-whitelist.js');
    assert.ok(fs.existsSync(path.join(__dirname, '..', new URL(url).pathname.split('/').pop())));
  }
});
