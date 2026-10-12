/*
 * media-unlock.js — Stash Tile：流媒体解锁检测
 *
 * 测试逻辑移植自 MediaUnlockTest (https://github.com/HsukqiLee/MediaUnlockTest)
 * 的 Go 实现（pkg/providers/*.go）。全部为 HTTP(S) 请求，无原始 socket，可完整移植。
 *
 * 用法（由一个覆写里的多个 Tile 共用本脚本，通过 argument 区分服务）：
 *   argument: '{"service":"netflix"}'  → 只测 Netflix，返回单服务 Tile
 *   argument 为空 / 服务名无效          → 测全部服务，返回合并 Tile
 *
 * 每个服务 Tile：解锁=绿色背景，未解锁(或封禁)=红色背景，超时/异常=灰色；
 * content 显示解锁地区。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

const REQ_TIMEOUT = 8 // 单次 HTTP 请求超时（秒）
const SERVICE_TIMEOUT = 12000 // 单个服务整体超时（毫秒）

const COLOR_OK = '#34C759'
const COLOR_NO = '#FF3B30'
const COLOR_ERR = '#8E8E93'

/* -------------------------------------------------------------------------- */
/* HTTP 辅助                                                                   */
/* -------------------------------------------------------------------------- */

function request(method, opts) {
  return new Promise((resolve, reject) => {
    const o = Object.assign({ timeout: REQ_TIMEOUT }, opts)
    o.headers = Object.assign({ 'User-Agent': UA }, opts.headers || {})
    const cb = (err, resp, data) => {
      if (err) {
        reject(err)
        return
      }
      resolve({
        status: resp ? resp.status : 0,
        headers: (resp && resp.headers) || {},
        body: data == null ? '' : String(data),
      })
    }
    switch (method) {
      case 'POST':
        $httpClient.post(o, cb)
        break
      case 'PUT':
        $httpClient.put(o, cb)
        break
      default:
        $httpClient.get(o, cb)
    }
  })
}

const GET = (o) => request('GET', typeof o === 'string' ? { url: o } : o)
const POST = (o) => request('POST', o)

function header(headers, name) {
  const lower = name.toLowerCase()
  for (const k in headers) {
    if (k.toLowerCase() === lower) return headers[k]
  }
  return undefined
}

function traceLoc(body) {
  const m = body.match(/(?:^|\n)loc=([^\n]+)/)
  return m ? m[1].trim() : ''
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

/* -------------------------------------------------------------------------- */
/* 各服务测试：返回 { ok: Bool, region: String, note: String }                 */
/* -------------------------------------------------------------------------- */

// Netflix —— 移植 Netflix.go NetflixRegion
async function testNetflix() {
  const [r1, r2] = await Promise.all([
    GET({ url: 'https://www.netflix.com/title/81280792', 'auto-redirect': false }),
    GET({ url: 'https://www.netflix.com/title/70143836', 'auto-redirect': false }),
  ])
  const ok = (s) => s === 200 || s === 301 || s === 302

  if (r1.status === 404 && r2.status === 404) return { ok: false, note: '仅原创' }
  if (r1.status === 403 && r2.status === 403) return { ok: false, note: 'IP 被封' }
  if (!(ok(r1.status) || ok(r2.status))) return { ok: false }

  const r3 = await GET({ url: 'https://www.netflix.com/title/80018499', 'auto-redirect': false })
  const loc = header(r3.headers, 'location') || header(r3.headers, 'x-originating-url')
  if (!loc) return { ok: true, region: 'US' }
  const parts = loc.split('/')
  let region = (parts[3] || '').split('-')[0]
  if (!region || region === 'title') region = 'US'
  return { ok: true, region: region.toUpperCase() }
}

// Disney+ —— 移植 DisneyPlus.go 的多步流程
async function testDisneyPlus() {
  const AUTH =
    'Bearer ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84'
  const RAW =
    'ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84'

  const r1 = await POST({
    url: 'https://disney.api.edge.bamgrid.com/devices',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceFamily: 'browser',
      applicationRuntime: 'chrome',
      deviceProfile: 'windows',
      attributes: {},
    }),
  })
  if (r1.body.includes('403 ERROR')) return { ok: false }
  let assertion
  try {
    assertion = JSON.parse(r1.body).assertion
  } catch (e) {
    return { ok: false }
  }
  if (!assertion) return { ok: false }

  const tokenBody =
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&latitude=0&longitude=0&platform=browser&subject_token=' +
    assertion +
    '&subject_token_type=urn%3Abamtech%3Aparams%3Aoauth%3Atoken-type%3Adevice'
  const r2 = await POST({
    url: 'https://disney.api.edge.bamgrid.com/token',
    headers: { authorization: RAW, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  })
  if (r2.status === 403 || r2.body.includes('forbidden-location')) return { ok: false }
  let refreshToken
  try {
    refreshToken = JSON.parse(r2.body).refresh_token
  } catch (e) {
    return { ok: false }
  }
  if (!refreshToken) return { ok: false }

  const r3 = await GET({ url: 'https://www.disneyplus.com', 'auto-redirect': true })
  const finalLoc = header(r3.headers, 'location') || ''
  if (/\/preview|\/unavailable/.test(finalLoc)) return { ok: false }

  const gql = {
    query:
      'mutation refreshToken($input: RefreshTokenInput!) {\n            refreshToken(refreshToken: $input) {\n                activeSession {\n                    sessionId\n                }\n            }\n        }',
    variables: { input: { refreshToken } },
  }
  const r4 = await POST({
    url: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(gql),
  })
  const cm = r4.body.match(/"countryCode"\s*:\s*"([^"]+)"/)
  const region = cm ? cm[1].toUpperCase() : ''
  if (!/"inSupportedLocation"\s*:\s*true/.test(r4.body)) return { ok: false, region }
  return { ok: true, region }
}

// YouTube Premium —— 移植 YouTube.go YoutubeRegion
async function testYouTube() {
  const cookie =
    'YSC=BiCUU3-5Gdk; CONSENT=YES+cb.20220301-11-p0.en+FX+700; GPS=1; VISITOR_INFO1_LIVE=4VwPMkB7W5A; SOCS=CAISOAgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwNTIxLjA3X3AxGgV6aC1DTiACGgYIgNTEsgY; PREF=f7=4000&tz=Asia.Shanghai&f4=4000000'
  const r = await GET({ url: 'https://www.youtube.com/premium', headers: { Cookie: cookie } })
  if (r.status !== 200) return { ok: false }
  const s = r.body
  if (s.includes('www.google.cn')) return { ok: false, region: 'CN', note: '仅中国' }
  if (s.includes('Premium is not available in your country')) return { ok: false }
  const m = s.match(/"countryCode":"(.*?)"/)
  if (m) return { ok: true, region: m[1].toUpperCase() }
  if (s.includes('premiumPurchaseButton') || s.includes('manageSubscriptionButton')) {
    return { ok: true, region: 'US' }
  }
  return { ok: false }
}

// Spotify —— 移植 Spotify.go
async function testSpotify() {
  const body =
    'birth_day=11&birth_month=11&birth_year=2000&collect_personal_info=undefined&creation_flow=&creation_point=https%3A%2F%2Fwww.spotify.com%2Fhk-en%2F&displayname=Gay%20Lord&gender=male&iagree=1&key=a1e486e2729f46d6bb368d6b2bcda326&platform=www&referrer=&send-email=0&thirdpartyemail=0&identifier_token=AgE6YTvEzkReHNfJpO114514'
  const r = await POST({
    url: 'https://spclient.wg.spotify.com/signup/public/v1/account',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' },
    body,
  })
  if (r.status === 403) return { ok: false, note: 'IP 被封' }
  let j
  try {
    j = JSON.parse(r.body)
  } catch (e) {
    return { ok: false }
  }
  if (j.status === 320) return { ok: false }
  if (j.status === 311 && j.is_country_launched) {
    return { ok: true, region: (j.country || '').toUpperCase() }
  }
  return { ok: false }
}

// ChatGPT —— 移植 ChatGPT.go
const GPT_COUNTRIES =
  'AL DZ AD AO AG AR AM AU AT AZ BS BD BB BE BZ BJ BT BA BW BR BG BF CV CA CL CO KM CR HR CY DK DJ DM DO EC SV EE FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IQ IE IL IT JM JP JO KZ KE KI KW KG LV LB LS LR LI LT LU MG MW MY MV ML MT MH MR MU MX MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG MK NO OM PK PW PA PG PE PH PL PT QA RO RW KN LC VC WS SM ST SN RS SC SL SG SK SI SB ZA ES LK SR SE CH TH TG TO TT TN TR TV UG AE US UY VU ZM BO BN CG CZ VA FM MD PS KR TW TZ TL GB AQ'.split(
    ' '
  )

async function testChatGPT() {
  const trace = await GET('https://chatgpt.com/cdn-cgi/trace')
  const loc = traceLoc(trace.body)
  const r = await GET('https://chatgpt.com')
  if (r.body.includes('VPN')) return { ok: false, note: 'VPN 被封锁' }
  if (r.status === 429) return { ok: false, region: loc, note: '429 限流' }
  if (loc === 'T1') return { ok: true, region: 'TOR' }
  if (GPT_COUNTRIES.includes(loc)) return { ok: true, region: loc }
  return { ok: false, region: loc }
}

// Claude —— 移植 Claude.go
const CLAUDE_COUNTRIES =
  'AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA TD CL CO KM CG CR CI HR CY CZ DK DJ DM DO EC EG SV GQ EE SZ FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IQ IE IL IT JM JP JO KZ KE KI KW KG LA LV LB LS LR LI LT LU MG MW MY MV MT MH MR MU MX FM MD MC MN ME MA MZ NA NR NP NL NZ NE NG MK NO OM PK PW PS PA PG PY PE PH PL PT QA RO RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB ZA KR ES LK SR SE CH TW TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VA VN ZM ZW'.split(
    ' '
  )

async function testClaude() {
  const trace = await GET('https://claude.ai/cdn-cgi/trace')
  const loc = traceLoc(trace.body)
  if (loc === 'T1') return { ok: true, region: 'TOR' }
  if (CLAUDE_COUNTRIES.includes(loc)) return { ok: true, region: loc }
  return { ok: false, region: loc }
}

// TikTok —— 移植 TikTok.go
// 注意：不受支持的地区 /explore 会 302 跳到 /hk/about 等页面，
// 跟随跳转后页面里会带一个误导性的 "region"，因此必须不跟随跳转（与 Go 默认行为一致）。
async function testTikTok() {
  const r = await GET({ url: 'https://www.tiktok.com/explore', 'auto-redirect': false })
  const s = r.body
  if (s.includes('https://www.tiktok.com/hk/notfound')) {
    return { ok: false, region: 'HK', note: '仅香港' }
  }
  const loc = header(r.headers, 'location') || ''
  if (/\/hk\//.test(loc)) return { ok: false, region: 'HK', note: '仅香港' }
  const m = s.match(/"region":"(\w+)"/)
  if (m) return { ok: true, region: m[1].toUpperCase() }
  return { ok: false }
}

/* -------------------------------------------------------------------------- */
/* 服务登记表                                                                  */
/* -------------------------------------------------------------------------- */

const SERVICES = {
  netflix: { name: 'Netflix', icon: 'play.tv.fill', test: testNetflix },
  disney: { name: 'Disney+', icon: 'sparkles', test: testDisneyPlus },
  youtube: { name: 'YouTube', icon: 'play.rectangle.fill', test: testYouTube },
  spotify: { name: 'Spotify', icon: 'music.note', test: testSpotify },
  chatgpt: { name: 'ChatGPT', icon: 'bubble.left.and.bubble.right.fill', test: testChatGPT },
  claude: { name: 'Claude', icon: 'text.bubble.fill', test: testClaude },
  tiktok: { name: 'TikTok', icon: 'play.square.stack', test: testTikTok },
}

/* -------------------------------------------------------------------------- */
/* 服务选择：优先 argument，其次用脚本名（provider key，如 media-netflix）兜底  */
/* -------------------------------------------------------------------------- */

function resolveServiceKey() {
  // 1) Tile 的 argument：{"service":"netflix"}
  try {
    const o = $argument ? JSON.parse($argument) : null
    if (o && o.service) return String(o.service).toLowerCase()
  } catch (e) {
    /* ignore */
  }
  // 2) 脚本名兜底：media-netflix -> netflix
  try {
    const n = String($script && $script.name ? $script.name : '')
    const m = n.match(/media[-_]([a-z0-9]+)/i)
    if (m) return m[1].toLowerCase()
  } catch (e) {
    /* ignore */
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

function runService(meta) {
  return withTimeout(meta.test(), SERVICE_TIMEOUT).then(
    (r) => ({ ok: !!(r && r.ok), region: (r && r.region) || '', note: (r && r.note) || '' }),
    () => ({ error: true })
  )
}

;(async () => {
  const key = resolveServiceKey()

  // ---- 单服务模式：一个 Tile 一个服务 ----
  if (key && SERVICES[key]) {
    const meta = SERVICES[key]
    const res = await runService(meta)
    let content, bg
    if (res.error) {
      content = '检测失败'
      bg = COLOR_ERR
    } else if (res.ok) {
      content = res.region || '已解锁'
      bg = COLOR_OK
    } else {
      content = res.note || '未解锁'
      bg = COLOR_NO
    }
    $done({ title: meta.name, content, icon: meta.icon, backgroundColor: bg })
    return
  }

  // ---- 合并模式（无法确定服务时的回退）----
  const keys = Object.keys(SERVICES)
  const results = await Promise.all(keys.map((k) => runService(SERVICES[k])))
  const lines = keys.map((k, i) => {
    const r = results[i]
    const dot = r.error ? '⚪️' : r.ok ? '🟢' : '🔴'
    let tail = r.ok ? r.region : r.note || ''
    if (r.error) tail = '检测失败'
    return `${dot} ${SERVICES[k].name}${tail ? ' ➟ ' + tail : ''}`
  })
  const okCount = results.filter((r) => r.ok).length
  $done({
    title: `流媒体解锁 ${okCount}/${keys.length}`,
    content: lines.join('\n'),
    icon: 'play.tv.fill',
    backgroundColor:
      okCount === keys.length ? COLOR_OK : okCount === 0 ? COLOR_NO : COLOR_ERR,
  })
})()
