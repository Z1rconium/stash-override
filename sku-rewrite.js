/**
 * sku-rewrite.js —— Shadowrocket 纯手机方案脚本 v2
 *
 * 挂在 http-response，把 Google One 套餐列表 protobuf 里的新 SKU
 * 换成长度更长的老 SKU，并自底向上重算所有 varint 长度前缀。
 *
 * 声明（小火箭 [Script] 段）：
 * GoogleOneSKU = type=http-response,pattern=^https:\/\/subscriptionsmobile(-pa)?\.googleapis\.com\/(.*)(GetDynamicStorefrontInfo|GetStorefrontInfo|GetSubscription),requires-body=1,binary-body-mode=1,max-size=0,script-path=sku-rewrite.js
 *
 * v2 相对 v1：
 *   - 检测 gzip / br / deflate 魔数，避免把压缩包当 protobuf 乱改
 *   - 字符串模式只在 latin1 安全时启用（每字符 <=255），否则跳过
 *   - 命中计数写入 $persistentStore，方便事后自证改到了
 *   - 幂等：重复执行不会二次膨胀
 */

// ============ 配置 ============
var SKU_MAP = {
  "g1.ios.20tb.m.v2": "com.google.one.20tb.m.iog",
  "g1.ios.20tb.y.v2": "com.google.one.20tb.y.iog",
  // 想换目标档位就取消注释：
  // "g1.ios.2tb.m.v2":  "com.google.one.2tb.m.iog",
  // "g1.ios.5tb.m.v2":  "com.google.one.5tb.m.iog",
  // "g1.ios.30tb.m.v2": "com.google.one.30tb.m.iog"
};

// ===== 模式匹配兜底 =====
// AI Ultra / 新档位的 SKU 命名未知。开启后会尝试把任何 g1.ios.<档位>.* 映射到
// com.google.one.<档位>.iog。命中会在日志里标 [pattern]，便于事后核对。
// 默认关闭 —— 先跑 recon 确认实际 SKU 名，再决定是否打开。
var PATTERN_FALLBACK = false;

// 遇到形似 SKU 但不在映射表里时，是否记录到日志。
// 这替代了单独的 recon 脚本 —— 一个文件就能既改写又侦察。
var LOG_UNMAPPED_SKU = true;

function patternMap(s) {
  // g1.ios.20tb.m.v2       -> com.google.one.20tb.m.iog
  // g1.ios.2tb.m.v2        -> com.google.one.2tb.m.iog
  var m = /^g1\.ios\.([a-z0-9]+(?:\.ch)?)\.([a-z0-9]+)\.v\d+$/.exec(s);
  if (!m) return null;
  return "com.google.one." + m[1] + "." + m[2] + ".iog";
}
var DEBUG = true;
var STORE_KEY = "googleone_sku_hits";
// =============================

function log() {
  if (!DEBUG) return;
  var s = "[sku]";
  for (var i = 0; i < arguments.length; i++) s += " " + arguments[i];
  console.log(s);
}

/* ---------------- varint ---------------- */
function readVarint(buf, i) {
  var shift = 0, val = 0, start = i;
  while (true) {
    if (i >= buf.length) throw new Error("varint truncated @" + start);
    var b = buf[i++];
    val += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) return [val, i];
    shift += 7;
    if (shift > 63) throw new Error("varint too long @" + start);
  }
}

function writeVarint(val) {
  var out = [];
  while (true) {
    var b = val % 128;
    val = Math.floor(val / 128);
    if (val > 0) out.push(b | 0x80);
    else { out.push(b); break; }
  }
  return out;
}

/* ---------------- 解析 / 编码 ---------------- */
function parse(buf) {
  var fields = [], i = 0;
  while (i < buf.length) {
    var r = readVarint(buf, i), tag = r[0];
    i = r[1];
    var no = Math.floor(tag / 8), wt = tag & 7;
    if (no === 0) throw new Error("field 0");
    if (wt === 0) {
      var v = readVarint(buf, i);
      fields.push({ no: no, wt: 0, val: v[0] });
      i = v[1];
    } else if (wt === 1) {
      if (i + 8 > buf.length) throw new Error("fixed64 trunc");
      fields.push({ no: no, wt: 1, val: buf.slice(i, i + 8) });
      i += 8;
    } else if (wt === 2) {
      var l = readVarint(buf, i);
      var ln = l[0];
      i = l[1];
      if (i + ln > buf.length) throw new Error("ld trunc");
      fields.push({ no: no, wt: 2, val: buf.slice(i, i + ln) });
      i += ln;
    } else if (wt === 5) {
      if (i + 4 > buf.length) throw new Error("fixed32 trunc");
      fields.push({ no: no, wt: 5, val: buf.slice(i, i + 4) });
      i += 4;
    } else {
      throw new Error("bad wiretype " + wt);
    }
  }
  return fields;
}

function tryParse(buf) {
  if (!buf || buf.length === 0) return null;
  try {
    var f = parse(buf);
    return f.length ? f : null;
  } catch (e) {
    return null;
  }
}

function encode(fields) {
  var out = [];
  for (var k = 0; k < fields.length; k++) {
    var f = fields[k];
    out.push.apply(out, writeVarint(f.no * 8 + f.wt));
    if (f.wt === 0) {
      out.push.apply(out, writeVarint(f.val));
    } else if (f.wt === 2) {
      out.push.apply(out, writeVarint(f.val.length));
      for (var j = 0; j < f.val.length; j++) out.push(f.val[j]);
    } else {
      for (var m = 0; m < f.val.length; m++) out.push(f.val[m]);
    }
  }
  return Uint8Array.from(out);
}

/* ---------------- 字符串工具 ---------------- */
function bytesToStr(b) {
  var s = "", needUtf8 = false;
  for (var k = 0; k < b.length; k++) {
    if (b[k] >= 0x80) { needUtf8 = true; break; }
  }
  if (!needUtf8) {
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch (e) {
    return null;              // 非法 UTF-8，不是我们要的字符串
  }
}

function strToBytes(s) {
  return Uint8Array.from(new TextEncoder().encode(s));
}

function isPrintable(b) {
  if (!b || !b.length) return false;
  var s = bytesToStr(b);
  if (s === null || !s) return false;
  var ok = 0, n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    n++;
    if (c >= 32 && c !== 127) ok++;
  }
  return n > 0 && ok / n > 0.9;
}

/* ---------------- 压缩包检测 ---------------- */
function compressionMagic(b) {
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return "gzip";
  if (b.length >= 2 && b[0] === 0x78 && (b[1] === 0x01 || b[1] === 0x9c || b[1] === 0xda)) return "deflate";
  // brotli 没有固定魔数，只能靠「解析不出 protobuf 且非可打印」推断，不硬判
  return null;
}

/* ---------------- 子串替换（latin1 安全） ---------------- */
function replaceInBytes(buf, map) {
  var s = "", i;
  for (i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  var hits = 0;
  for (var oldK in map) {
    if (!Object.prototype.hasOwnProperty.call(map, oldK)) continue;
    var parts = s.split(oldK);
    if (parts.length > 1) {
      hits += parts.length - 1;
      s = parts.join(map[oldK]);
    }
  }
  if (!hits) return [buf, 0];
  var out = new Uint8Array(s.length);
  for (i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return [out, hits];
}

/* ---------------- 递归改写 ---------------- */
var unmapped = [];   // 收集到的未映射 SKU，供日志输出

function rewrite(buf, depth, hits) {
  if (depth === undefined) depth = 0;
  if (hits === undefined) hits = [];
  if (depth > 12) return [buf, hits];

  var fields = tryParse(buf);
  if (!fields) {
    var rr = replaceInBytes(buf, SKU_MAP);
    if (rr[1]) hits.push("d" + depth + ":raw x" + rr[1]);
    return [rr[0], hits];
  }

  var changed = false, out = [];
  for (var k = 0; k < fields.length; k++) {
    var f = { no: fields[k].no, wt: fields[k].wt, val: fields[k].val };
    if (f.wt === 2) {
      var s = isPrintable(f.val) ? bytesToStr(f.val) : null;

      // 0) 记录「形似 SKU 但没映射」的字符串 —— 用于发现新 SKU 名
      if (LOG_UNMAPPED_SKU && s !== null && s.length > 4 && s.length < 80 &&
          (s.indexOf("g1.") === 0 || s.indexOf("com.google.one") === 0) &&
          SKU_MAP[s] === undefined) {
        if (unmapped.indexOf(s) < 0) {
          unmapped.push(s);
          log("!! 未映射 SKU  d" + depth + ":#" + f.no + "  " + s);
        }
      }

      // 1) 整段就是一个 SKU
      if (s !== null && SKU_MAP[s] !== undefined) {
        hits.push("d" + depth + ":#" + f.no + " " + s + "->" + SKU_MAP[s]);
        f.val = strToBytes(SKU_MAP[s]);
        changed = true;
        out.push(f);
        continue;
      }
      // 显式映射没命中，尝试模式兜底
      if (s !== null && PATTERN_FALLBACK) {
        var pm = patternMap(s);
        if (pm) {
          hits.push("d" + depth + ":#" + f.no + " [pattern] " + s + "->" + pm);
          f.val = strToBytes(pm);
          changed = true;
          out.push(f);
          continue;
        }
      }

      // 2) 先当嵌套 message 递归（长度前缀必须自底向上重算）
      var sub = tryParse(f.val);
      if (sub) {
        var nr = rewrite(f.val, depth + 1, hits);
        if (nr[1].length > hits.length || nr[1].length) {
          f.val = nr[0];
          changed = true;
        }
        out.push(f);
        continue;
      }

      // 3) 退化为子串替换
      if (s !== null) {
        var r2 = replaceInBytes(f.val, SKU_MAP);
        if (r2[1]) {
          hits.push("d" + depth + ":#" + f.no + " substr x" + r2[1]);
          f.val = r2[0];
          changed = true;
        }
      }
    }
    out.push(f);
  }
  return changed ? [encode(out), hits] : [buf, hits];
}

/* ---------------- 持久化命中计数（便于自证） ---------------- */
function bumpStore(n) {
  try {
    if (typeof $persistentStore === "undefined") return;
    var prev = parseInt($persistentStore.read(STORE_KEY) || "0", 10);
    if (isNaN(prev)) prev = 0;
    $persistentStore.write(String(prev + n), STORE_KEY);
    log("累计命中写入 persistentStore =", prev + n);
  } catch (e) {
    log("persistentStore 不可用");
  }
}

/* ---------------- 弹通知（手机-only 时最直观的自证） ---------------- */
function notify(title, body) {
  try {
    if (typeof $notification === "undefined" || !$notification.post) return;
    $notification.post(title, "", body);
    log("已弹通知:", title);
  } catch (e) {
    log("通知不可用");
  }
}

/* ---------------- 入口 ---------------- */
(function main() {
  try {
    if (typeof $response === "undefined" || !$response) {
      log("非 http-response 上下文，跳过");
      $done({});
      return;
    }

    var raw = $response.bodyBytes;
    if (raw === undefined || raw === null) raw = $response.body;
    if (raw === undefined || raw === null) {
      log("无 body，放行");
      $done({});
      return;
    }

    var bytes;
    if (raw instanceof Uint8Array) {
      bytes = raw;
    } else if (raw instanceof ArrayBuffer) {
      bytes = new Uint8Array(raw);
    } else if (typeof raw === "string") {
      // 字符串模式：只有每字符都 <=255 才能无损还原字节
      var safe = true;
      for (var i = 0; i < raw.length; i++) {
        if (raw.charCodeAt(i) > 255) { safe = false; break; }
      }
      if (!safe) {
        log("body 是字符串且含多字节字符，无法无损还原字节");
        log("请确认脚本声明里有 binary-body-mode=1");
        $done({});
        return;
      }
      bytes = new Uint8Array(raw.length);
      for (var j = 0; j < raw.length; j++) bytes[j] = raw.charCodeAt(j) & 0xff;
      log("字符串模式（latin1 无损）");
    } else {
      bytes = Uint8Array.from(raw);
    }

    log("原始长度", bytes.length);

    var magic = compressionMagic(bytes);
    if (magic) {
      log("! body 是 " + magic + " 压缩包，未解压");
      log("! 说明小火箭没自动解压，本次无法改写；换节点或关掉服务端压缩再试");
      $done({});
      return;
    }

    var res = rewrite(bytes, 0, []);
    var patched = res[0], hits = res[1];

    if (!hits.length) {
      log("无 SKU 命中（长度", bytes.length, "），原样放行");
      $done({});
      return;
    }

    for (var h = 0; h < hits.length; h++) log(hits[h]);
    log("改写后长度", patched.length, "（+", patched.length - bytes.length, " 字节）");

    bumpStore(hits.length);
    notify("Google One SKU 已改写", hits[0] + "  [总计已改 " + hits.length + " 处]");

    if ($response.bodyBytes !== undefined) $done({ bodyBytes: patched });
    else $done({ body: patched });
  } catch (e) {
    log("异常:", e && e.message ? e.message : String(e));
    $done({});
  }
})();
