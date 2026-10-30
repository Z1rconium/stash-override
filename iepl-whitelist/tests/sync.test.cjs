const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../iepl-whitelist.js'), 'utf8');
function run({ mode = 'tile', state = {}, online = true, status = 200, body = '<HTML><BODY>Success</BODY></HTML>', configured = true, netError = false, serverError = false, recent = false, loon = false, api, added = false, removed = null, argumentOverride = false, argumentValue, stashPlugin = false, stashNative = false, emulateLoon = false } = {}) {
  const store = { 'ipwl.state': JSON.stringify(state), 'ipwl.cronTs': JSON.stringify(Date.now()) };
  if (recent) store['ipwl.state'] = JSON.stringify({ ...state, lastCheck: Date.now() });
  const requests = [], notices = [], done = [], logs = [];
  const argument = { mode, api: api || (configured ? 'https://sync.example.com' : 'https://YOUR_DOMAIN'), token: 'test' };
  vm.runInNewContext(source, {
    ...(loon || emulateLoon ? { $loon: 'iPhone 18.0 3.5.1(983)' } : {}),
    ...(loon || stashPlugin || stashNative ? { $script: { name: 'iepl-whitelist-' + mode } } : {}),
    ...(stashPlugin || stashNative ? { $environment: { 'stash-version': '3.6.0', 'stash-build': 'test' } } : {}),
    console: { log(value) { logs.push(value); } },
    $argument: argumentOverride ? argumentValue : loon || stashPlugin ? { api: argument.api, token: argument.token } : JSON.stringify(argument),
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
    if (loon && !stashPlugin && !stashNative) {
      assert.equal(req.node, 'DIRECT');
      assert.equal(req.insecure, false);
      assert.equal(req.headers['X-Stash-Selected-Proxy'], undefined);
      assert.ok([3000, 8000].includes(req.timeout));
    } else assert.equal(req.headers['X-Stash-Selected-Proxy'], 'DIRECT');
    assert.equal(req['auto-redirect'], false);
  }
  return { logs, state: JSON.parse(store['ipwl.state']), requests, notices, result: done[0] };
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

test('Loon missing / null arguments report missing fields without crashing', () => {
  for (const argumentValue of [undefined, null, 'null', '[]', 'invalid', {}]) {
    const r = run({ loon: true, mode: 'manual', argumentOverride: true, argumentValue });
    assert.equal(r.requests.length, 0);
    assert.match(r.notices[0][2], /api：未传入；token：未传入/);
  }
});
test('Loon differentiates received address errors from absent parameters', () => {
  const r = run({ loon: true, mode: 'manual', api: 'sync.example.com' });
  assert.equal(r.requests.length, 0);
  assert.match(r.notices[0][2], /api：不是有效 HTTPS 地址；token：已收到/);
});
test('Loon trims pasted whitespace and preserves token punctuation', () => {
  const token = 'secret-"=&%,+test';
  const r = run({ loon: true, mode: 'manual', argumentOverride: true,
    argumentValue: { api: ' https://sync.example.com/ \n', token: ' ' + token + '\n' } });
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1].url, 'https://sync.example.com/sync');
  assert.equal(r.requests[1].headers['X-Token'], token);
  assert.match(r.logs[0], /api=已收到；token=已收到/);
});
test('Loon diagnostics distinguish null, placeholder and invalid types without leaking values', () => {
  for (const [argumentValue, expected] of [
    [{ api: null, token: null }, /api：为空；token：为空/],
    [{ api: 'https://YOUR_DOMAIN', token: 'YOUR_TOKEN' }, /api：仍为占位符；token：仍为占位符/],
    [{ api: 123, token: 456 }, /api：类型错误；token：类型错误/],
    [{ api: 'private.example.com', token: 'sensitive-test-token' }, /token：已收到/],
  ]) {
    const r = run({ loon: true, mode: 'manual', argumentOverride: true, argumentValue });
    assert.equal(r.requests.length, 0);
    assert.match(r.notices[0][2], expected);
    const diagnostics = r.logs.join('\n') + JSON.stringify(r.notices);
    assert.doesNotMatch(diagnostics, /private\.example\.com|sensitive-test-token/);
  }
});

for (const mode of ['cron', 'network', 'manual']) {
  test(`Stash plugin ${mode}: entry independent of HTTP runtime`, () => {
    const r = run({ stashPlugin: true, mode });
    assert.equal(r.requests.length, 2);
    assert.equal(r.result, undefined);
    assert.equal(r.notices.length, mode === 'manual' ? 1 : 0);
    assert.equal(r.requests[0].timeout, 3);
    assert.equal(r.requests[1].timeout, 8);
    assert.match(r.logs[0], /runtime=Stash/);
    assert.match(r.logs[0], /api=已收到；token=已收到/);
  });
}
test('Stash runtime wins over emulated Loon global', () => {
  const r = run({ stashPlugin: true, emulateLoon: true, mode: 'manual' });
  assert.equal(r.requests[1].headers['X-Stash-Selected-Proxy'], 'DIRECT');
  assert.equal(r.requests[1].node, undefined);
  assert.equal(r.requests[1].timeout, 8);
});
test('Stash native mode retains its existing entry points', () => {
  const tile = run({ stashNative: true, mode: 'tile' });
  assert.match(tile.result.content, /1.2.3.4/);
  assert.equal(tile.notices.length, 0);
  const cron = run({ stashNative: true, mode: 'cron', recent: true });
  assert.equal(cron.requests.length, 0);
  // 原生 Stash 的旧配置不引入插件的 HTTPS 必填校验。
  assert.equal(run({ stashNative: true, mode: 'cron', api: 'http://sync.example.com' }).requests.length, 2);
});
test('Stash plugin diagnostics handle JSON string and missing argument', () => {
  const received = run({ stashPlugin: true, mode: 'manual', argumentOverride: true,
    argumentValue: JSON.stringify({ api: 'https://sync.example.com', token: 'secret-test-token' }) });
  assert.equal(received.requests.length, 2);
  assert.match(received.logs[0], /argument=string；api=已收到；token=已收到/);
  const missing = run({ stashPlugin: true, mode: 'manual', argumentOverride: true, argumentValue: null });
  assert.equal(missing.requests.length, 0);
  assert.match(missing.notices[0][2], /api：未传入；token：未传入/);
});
