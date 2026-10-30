/*
 * iepl-whitelist.js — Stash / Loon：自动把「直连出口 IP」同步到 IEPL 白名单
 *
 * 服务地址与 token 从 argument 传入：Stash 在覆写中填写；Loon 在插件参数界面填写。
 * Loon 的入口由插件固定 tag 区分：iepl-whitelist-cron / -network / -manual。
 *
 * argument（Stash 为 JSON 字符串；Loon 为插件参数对象）：
 *   mode  : "cron" 或 "tile"（由覆写里的两个入口各自设置，不要改）
 *   api   : 你的同步服务地址，如 "https://your.domain.example"（不要以 / 结尾）
 *   token : 访问同步服务的 token（对应请求头 X-Token）
 *
 * Stash 两种入口（Loon 另有网络变化入口，立即探测同步）：
 *   cron : 每分钟触发一次，但本地先判断是否需要同步，只有以下情况才联网
 *          - 代理刚启动（距离上次 cron 超过 150 秒，说明中间代理是关着的）
 *          - 距离上次成功同步已满 5 分钟
 *          - 上次同步失败，且已过 1 分钟（失败重试）
 *   所有入口：先以 DIRECT 探测联网；未通过则静默跳过，不累计失败，下一分钟重试。
 *   tile : 点击面板 / 面板刷新时执行，总是立即检查并同步（手动同步）
 *
 * 需要的服务端接口（脚本只依赖这一个，详见 README）：
 *   POST {api}/sync   请求头 X-Token: <token>
 *   成功 -> {"ok":true,"ip":"1.2.3.4","status":"exists"|"added","count":3,"limit":10,
 *            "mode":"ip","whitelist":[...],"removed_ip":"可选，满额时被移除的 IP"}
 *   失败 -> {"ok":false,"msg":"原因","ip":"可选"}
 *   服务端把“它看到的请求来源 IP”当作你的直连 IP，所以请求必须走 DIRECT（见覆写里的规则）；这不等同于绕过 Stash 的 iOS 原生网络栈。
 *
 * 超时处理：
 *   服务端收到请求后会一直做完，所以超时不一定是失败。网络层失败会立即重试（最多 3 次）；
 *   仍失败按“网络超时”处理：面板显示橙色并保留上次成功状态，连续 3 次才提醒；
 *   服务端明确报错（如 token 无效）才按失败处理，连续 2 次提醒。
 */
const STATE_KEY = 'ipwl.state';
const CRON_KEY = 'ipwl.cronTs';
const INTERVAL = 5 * 60 * 1000;      // 正常检查间隔
const RETRY = 60 * 1000;             // 失败后重试间隔
const FRESH_GAP = 150 * 1000;        // 超过此间隙认为代理刚(重新)启动
const ATTEMPTS = 3;                  // 网络层失败时的最多尝试次数
const PROBE_URL = 'https://www.apple.com/library/test/success.html';
const PROBE_TIMEOUT = 3;             // 加上同步最多 24 秒，总计 27 秒
const REQ_TIMEOUT = 8;               // 单次请求超时（秒）；3 × 8 = 24 秒，小于 cron 的 30 秒

const rawArgument = typeof $argument === 'undefined' ? undefined : $argument;
const args = parseArgs(rawArgument);
const isStash = typeof $environment !== 'undefined' && !!($environment['stash-version'] || $environment['stash-build']);
const isLoon = !isStash && typeof $loon !== 'undefined';
const scriptName = typeof $script !== 'undefined' ? $script.name : '';
// 原生 Stash 覆写显式传 mode；插件通过固定 tag 区分入口，与 HTTP 运行时分开。
const isPlugin = isLoon || (!args.mode && /^iepl-whitelist-(cron|network|manual)$/.test(scriptName));
const mode = isPlugin
  ? (scriptName === 'iepl-whitelist-cron' ? 'cron' : scriptName === 'iepl-whitelist-network' ? 'network' : 'manual')
  : (args.mode || 'tile');
const API = (isPlugin ? String(args.api || '').trim() : String(args.api || '')).replace(/\/+$/, '');
const TOKEN = isPlugin ? String(args.token || '').trim() : String(args.token || '');
const now = Date.now();

let state = load(STATE_KEY, {});

function parseArgs(s) {
  if (s && typeof s === 'object' && !Array.isArray(s)) return s;
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) { return {}; }
}
function load(k, d) {
  try { const v = $persistentStore.read(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
}
function save(k, v) { try { $persistentStore.write(JSON.stringify(v), k); } catch (e) {} }
function hhmm(ts) {
  const d = new Date(ts);
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
function ago(ts) {
  if (!ts) return '从未';
  const m = Math.round((now - ts) / 60000);
  return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : hhmm(ts);
}

// 没填、或仍是覆写里的占位符（YOUR_…）都视为未配置
function configured() {
  return API && TOKEN && (!isPlugin || /^https:\/\/[^/\s?#]+(?:\/[^\s?#]*)?$/.test(API)) && !/YOUR_/.test(API) && !/YOUR_/.test(TOKEN);
}

// 仅输出字段是否到达及格式检查结果，不输出原始参数、URL 或 token。
function loonFieldStatus(key, value) {
  if (!Object.prototype.hasOwnProperty.call(args, key)) return '未传入';
  if (args[key] === null || args[key] === undefined || !value) return '为空';
  if (typeof args[key] !== 'string') return '类型错误';
  if (/YOUR_/.test(value)) return '仍为占位符';
  if (key === 'api' && !/^https:\/\/[^/\s?#]+(?:\/[^\s?#]*)?$/.test(value)) return '不是有效 HTTPS 地址';
  return '已收到';
}
function loonConfigIssue() {
  const apiStatus = loonFieldStatus('api', API);
  const tokenStatus = loonFieldStatus('token', TOKEN);
  if (apiStatus === '已收到' && tokenStatus === '已收到') return '';
  return 'api：' + apiStatus + '；token：' + tokenStatus;
}

// Loon 的 timeout 单位是毫秒，Stash 是秒；两端都强制 DIRECT。
// Loon 默认允许不可信证书，因此必须显式关闭 insecure。
function directOptions(options) {
  if (isLoon) {
    options.node = 'DIRECT';
    options.timeout *= 1000;
    options.insecure = false;
  } else {
    options.headers['X-Stash-Selected-Proxy'] = encodeURIComponent('DIRECT');
  }
  return options;
}

// 探测和同步都固定使用 DIRECT，不查询代理节点健康状态。
// HTTPS + 预期响应可排除大部分登录门户；失败仅表示直连探测未通过。
function checkConnection(cb) {
  $httpClient.get(directOptions({
    url: PROBE_URL,
    headers: { 'Cache-Control': 'no-cache' },
    timeout: PROBE_TIMEOUT,
    'auto-redirect': false,
    'auto-cookie': false,
  }), (err, resp, data) => {
    cb(!err && resp && Number(resp.status) === 200 && /<BODY>Success<\/BODY>/i.test(String(data)));
  });
}

// 回调 cb(err, j)：err = { kind: 'net' | 'server', msg }
function request(path, cb) {
  $httpClient.post(directOptions({
    url: API + path,
    headers: {
      'X-Token': TOKEN,
      'Accept': 'application/json',
    },
    body: '',
    timeout: REQ_TIMEOUT,
    'auto-redirect': false, // 不把 token 随重定向发送到其他地址
  }), (err, resp, data) => {
    if (err) return cb({ kind: 'net', msg: String(err) });
    let j = null;
    try { j = JSON.parse(data); } catch (e) {}
    // 反代/CDN/运营商的 5xx、返回不是 JSON：当作网络层问题，值得重试
    if (!j) return cb({ kind: 'net', msg: '服务端无有效响应（HTTP ' + (resp && resp.status) + '）' });
    if (!j.ok) return cb({ kind: 'server', msg: j.msg || ('HTTP ' + resp.status), ip: j.ip });
    cb(null, j);
  });
}

function sync(done) {
  const attempt = (n) => request('/sync', (err, j) => {
    if (err && err.kind === 'net' && n < ATTEMPTS) return attempt(n + 1);
    done(err, j, n);
  });
  attempt(1);
}

function record(err, j) {
  state.lastCheck = now;
  if (err) {
    state.error = err.msg;
    state.errKind = err.kind;
    if (err.ip) state.ip = err.ip;
    if (err.kind === 'net') {
      // 超时 / 连不上：保留上次成功状态，连续 3 次才提醒，之后每 12 次一次
      state.netFails = (state.netFails || 0) + 1;
      if (state.netFails === 3 || state.netFails % 12 === 0) {
        $notification.post('IEPL 白名单同步超时', '已连续 ' + state.netFails + ' 次连不上同步服务',
          '网络不稳定时会自动重试；上次成功：' + ago(state.lastOk));
      }
    } else {
      // 服务端明确报错：连续 2 次提醒，之后每 12 次一次
      state.fails = (state.fails || 0) + 1;
      if (state.fails === 2 || state.fails % 12 === 0) {
        $notification.post('IEPL 白名单同步失败', '已连续失败 ' + state.fails + ' 次', err.msg);
      }
    }
    return;
  }
  if ((state.fails || 0) >= 2 || (state.netFails || 0) >= 3) $notification.post('IEPL 白名单同步已恢复', j.ip, '');
  state.fails = 0;
  state.netFails = 0;
  state.error = null;
  state.errKind = null;
  state.lastOk = now;
  state.ip = j.ip;
  state.status = j.status;
  state.count = j.count;
  state.limit = j.limit;
  state.mode = j.mode;
  state.whitelist = j.whitelist;
  if (j.status === 'added') {
    state.lastAdded = now;
    state.removed = j.removed_ip || null;
    $notification.post(
      '已将直连 IP 加入白名单',
      j.ip + '（' + j.count + '/' + j.limit + '）',
      j.removed_ip ? '白名单已满，自动移除了最早的一条：' + j.removed_ip : ''
    );
  }
}

function tile() {
  const s = state;
  const next = hhmm(now + INTERVAL);
  let title, icon, color, lines = [];
  if (s.offline) {
    title = 'IEPL 白名单 ⏸';
    icon = 'wifi.slash';
    color = '#8E8E93';
    lines.push('直连联网探测未通过，已跳过同步');
    lines.push(s.lastOk ? '上次成功 ' + ago(s.lastOk) + ' · ' + (s.ip || '') : '尚无成功记录');
    lines.push('每分钟重新检测；也可点击重试');
  } else if (s.error && s.errKind === 'net') {
    title = 'IEPL 白名单 ⚠️';
    icon = 'wifi.exclamationmark';
    color = '#EF6C00';
    lines.push('网络超时，连不上同步服务（第 ' + (s.netFails || 1) + ' 次）');
    lines.push(s.lastOk ? '上次成功 ' + ago(s.lastOk) + ' · ' + (s.ip || '') : '尚无成功记录');
    lines.push('稍后自动重试');
  } else if (s.error) {
    title = 'IEPL 白名单 ❌';
    icon = 'xmark.shield.fill';
    color = '#C62828';
    lines.push('同步失败：' + s.error);
    lines.push('直连 IP  ' + (s.ip || '未知'));
    lines.push('上次成功  ' + ago(s.lastOk));
  } else {
    const full = s.count >= s.limit;
    const justAdded = s.status === 'added' && now - (s.lastAdded || 0) < 10 * 60 * 1000;
    title = 'IEPL 白名单 ' + (justAdded ? '🆕' : full ? '⚠️' : '✅');
    icon = full ? 'exclamationmark.shield.fill' : 'checkmark.shield.fill';
    color = full ? '#E65100' : '#2E7D32';
    lines.push('直连 IP  ' + s.ip);
    lines.push(justAdded ? '已新加入白名单' : '已在白名单中');
    lines.push('白名单  ' + s.count + '/' + s.limit + (full ? '（已满，下次新增会移除最早一条）' : ''));
    if (s.removed && justAdded) lines.push('已移除  ' + s.removed);
    lines.push('检查于 ' + hhmm(s.lastCheck) + ' · 下次约 ' + next);
  }
  if (isPlugin) {
    const content = lines.join('\n');
    console.log(title + '\n' + content);
    // 新增通知已由 record() 发送，避免一次手动同步重复提示。
    if (!(s.status === 'added' && s.lastAdded === now && !s.error && !s.offline)) {
      $notification.post(title, '', content);
    }
    $done();
  } else {
    $done({ title, content: lines.join('\n'), icon, backgroundColor: color });
  }
}

function finish() {
  if (mode !== 'cron' && mode !== 'network') return tile();
  if (isPlugin) {
    console.log(state.offline ? '直连联网探测未通过，已跳过同步'
      : state.error ? 'IEPL 同步失败（详见状态与通知）' : 'IEPL 同步成功：' + state.ip);
  }
  $done();
}

// 离线跳过不计作同步失败，也不更新 lastCheck / lastOk。
function runSync() {
  checkConnection((online) => {
    state.offline = !online;
    if (!online) {
      save(STATE_KEY, state);
      finish();
      return;
    }
    sync((err, j) => {
      record(err, j);
      save(STATE_KEY, state);
      finish();
    });
  });
}

const loonIssue = isPlugin ? loonConfigIssue() : '';
if (isPlugin || !configured()) {
  const argumentType = rawArgument === null ? 'null' : Array.isArray(rawArgument) ? 'array' : typeof rawArgument;
  console.log('[IEPL 1.2.1] runtime=' + (isStash ? 'Stash' : isLoon ? 'Loon' : 'unknown')
    + '；entry=' + (isPlugin ? mode : 'native') + '；argument=' + argumentType + '；api=' + loonFieldStatus('api', API)
    + '；token=' + loonFieldStatus('token', TOKEN));
}

if (!configured() || loonIssue) {
  // 还没填自定义信息：面板上提示去哪里填；cron 静默退出，避免每分钟打扰
  if (mode === 'cron' || mode === 'network') {
    $done();
  } else if (isPlugin) {
    $notification.post('IEPL 白名单 ⚙️', '配置未就绪', loonIssue
      + '\n请保存插件参数并重载配置，从插件的手动脚本入口运行。');
    $done();
  } else {
    $done({
      title: 'IEPL 白名单 ⚙️',
      content: '尚未配置\n请在覆写文件里把 api 与 token 的\nYOUR_… 占位符改成你自己的',
      icon: 'gearshape.fill',
      backgroundColor: '#8E8E93',
    });
  }
} else if (mode === 'cron') {
  const last = load(CRON_KEY, 0);
  save(CRON_KEY, now);
  const fresh = !last || now - last > FRESH_GAP;
  const since = now - (state.lastCheck || 0);
  const due = state.error ? since >= RETRY - 5000 : since >= INTERVAL - 10000;
  if (!fresh && !due && !state.offline) {
    $done();
  } else {
    runSync();
  }
} else {
  runSync();
}
