/**
 * sku-recon.js —— 侦察脚本：记录所有 Google 相关请求，定位 AI 套餐页的真实接口
 *
 * 用途：AI Ultra 页面的套餐列表可能不走 subscriptionsmobile，而是别的 endpoint。
 *       这个脚本不做任何改写，只把所有经过的请求 URL、类型、body 长度记下来。
 *
 * 声明（同时挂 request 和 response）：
 * GoogleOneRecon = type=http-request,pattern=^https://.*googleapis\.com/.*,script-path=sku-recon.js
 * GoogleOneRecon2 = type=http-response,pattern=^https://.*googleapis\.com/.*,requires-body=1,binary-body-mode=1,max-size=0,script-path=sku-recon.js
 *
 * 注意：两个声明指向同一个脚本，脚本通过 $response 是否存在来区分阶段。
 */

var MAX_URL_LOG = 200;
var ONLY_INTERESTING = false;   // true = 只记录可能含套餐的请求

function log(s) {
  console.log("[recon] " + s);
}

function urlOf() {
  try {
    if (typeof $request !== "undefined" && $request && $request.url) return $request.url;
  } catch (e) {}
  return "(no url)";
}

function methodOf() {
  try {
    if (typeof $request !== "undefined" && $request && $request.method) return $request.method;
  } catch (e) {}
  return "?";
}

/* 判断这个 URL 是否可能承载套餐数据 */
function interesting(url) {
  var keys = [
    "Storefront", "storefront", "Subscri", "subscri", "Offer", "offer",
    "Plan", "plan", "Purchase", "purchase", "Product", "product",
    "SKU", "sku", "Tier", "tier", "Voucher", "voucher", "Billing", "billing",
    "Play", "play", "Ultra", "ultra", "Gemini", "gemini", "AI", "ai"
  ];
  for (var i = 0; i < keys.length; i++) {
    if (url.indexOf(keys[i]) >= 0) return true;
  }
  return false;
}

function hostOf(url) {
  var m = /^https?:\/\/([^\/]+)/.exec(url);
  return m ? m[1] : "?";
}

/* ---------- 收集 body 里像 SKU 的字符串 ---------- */
function toStr(b) {
  var needUtf8 = false;
  for (var i = 0; i < b.length; i++) {
    if (b[i] >= 0x80) { needUtf8 = true; break; }
  }
  if (!needUtf8) {
    var s = "";
    for (var j = 0; j < b.length; j++) s += String.fromCharCode(b[j]);
    return s;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); }
  catch (e) { return null; }
}

function scanSku(bytes) {
  var found = [];
  var s = toStr(bytes);
  if (!s) {
    // 含非 UTF-8 字节，逐个找 ASCII 片段
    var cur = "";
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i];
      if (c >= 32 && c < 127) cur += String.fromCharCode(c);
      else {
        if (cur.length >= 8 &&
            (cur.indexOf("g1.") === 0 || cur.indexOf("com.google.one") === 0)) {
          found.push(cur);
        }
        cur = "";
      }
    }
    if (cur.length >= 8 &&
        (cur.indexOf("g1.") === 0 || cur.indexOf("com.google.one") === 0)) {
      found.push(cur);
    }
    return found;
  }
  // 直接扫字符串里的 SKU 形态
  var re = /(g1\.[a-z0-9._]+|com\.google\.one\.[a-z0-9._]+)/g;
  var m;
  while ((m = re.exec(s)) !== null) {
    if (found.indexOf(m[1]) < 0) found.push(m[1]);
  }
  return found;
}

/* ---------- 入口 ---------- */
(function main() {
  try {
    var url = urlOf();
    var isResp = (typeof $response !== "undefined" && $response);

    if (!isResp) {
      // 请求阶段：只记录，不改
      if (!ONLY_INTERESTING || interesting(url)) {
        log("REQ  " + methodOf() + " " + url);
      }
      $done({});
      return;
    }

    // 响应阶段
    var raw = $response.bodyBytes;
    if (raw === undefined || raw === null) raw = $response.body;

    var len = 0;
    var bytes = null;
    if (raw instanceof Uint8Array) { bytes = raw; len = raw.length; }
    else if (raw instanceof ArrayBuffer) { bytes = new Uint8Array(raw); len = raw.length; }
    else if (typeof raw === "string") { len = raw.length; }
    else if (raw) { bytes = Uint8Array.from(raw); len = raw.length; }

    var ctype = "";
    try { ctype = ($response.headers && ($response.headers["Content-Type"] || $response.headers["content-type"])) || ""; }
    catch (e) {}

    var st = "";
    try { st = String($response.status || $response.statusCode || ""); } catch (e) {}

    var isPb = ctype.indexOf("protobuf") >= 0 || ctype.indexOf("octet-stream") >= 0 || ctype.indexOf("grpc") >= 0;
    var int_ok = interesting(url);

    if (!ONLY_INTERESTING || int_ok || isPb) {
      log("RESP " + st + " " + len + "B" + (isPb ? " [protobuf]" : "") + " " + url);
    }

    // 扫 SKU
    if (bytes && len > 0 && len < 2000000) {
      // gzip 检测
      if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        if (int_ok) log("     ^ gzip 压缩，无法扫 SKU");
      } else {
        var skus = scanSku(bytes);
        if (skus.length) {
          log("     >>> SKU 命中 " + skus.length + " 个:");
          for (var k = 0; k < skus.length && k < 20; k++) {
            log("         " + skus[k]);
          }
        }
      }
    }

    $done({});   // 不改数据
  } catch (e) {
    log("异常: " + (e && e.message ? e.message : String(e)));
    $done({});
  }
})();
