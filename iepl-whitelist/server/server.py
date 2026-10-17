#!/usr/bin/env python3
"""iepl-whitelist: 直连 IP 查询 + IEPL 白名单自动同步服务（仅标准库）。

监听 127.0.0.1:8787，由 Caddy 反代并终结 TLS。
  GET  /ip                 返回调用方的公网 IPv4（无需鉴权）
  GET  /status             返回白名单状态，不做任何修改（需 token）；?fresh=1 强制查上游
  POST /sync               检查调用方 IP 是否在白名单，不在则添加（需 token）
  POST /sync?dry=1         只预演，不真正添加（需 token）

上游 API Key 只存在服务器环境变量里，不会下发给客户端。

v2 相对 v1：
  - 对上游复用 HTTPS 长连接（省去每次握手），连接失效时自动重连一次
  - 白名单快照缓存 CACHE_TTL 秒：客户端超时后立刻重试 / 查 /status 时无需再次访问上游，
    且上一次 add 的结果会直接更新缓存，重试一定看到“已存在”，不会重复添加
  - 每个请求记录总耗时、各次上游调用耗时、客户端是否在回复前断开（用于定位超时）
"""
import hmac
import http.client
import ipaddress
import json
import os
import socket
import ssl
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM_URL = os.environ["UPSTREAM_URL"]
UPSTREAM_API_KEY = os.environ["UPSTREAM_API_KEY"]
CLIENT_TOKEN = os.environ["CLIENT_TOKEN"]
BIND = os.environ.get("BIND", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))
CACHE_TTL = float(os.environ.get("CACHE_TTL", "15"))
UPSTREAM_TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", "12"))

_u = urllib.parse.urlparse(UPSTREAM_URL)
UP_SCHEME = _u.scheme
UP_HOST = _u.netloc
UP_PATH = _u.path + ("?" + _u.query if _u.query else "")

LOCK = threading.Lock()      # 串行化“查询 + 添加”，避免并发重复添加
UP_LOCK = threading.Lock()   # 同一时刻只用一条上游连接
CACHE = {"ts": 0.0, "snap": None}
FAILS = {}                   # 客户端地址 -> (连续鉴权失败次数, 首次失败时间)
_conn = None
_tl = threading.local()      # 每个请求自己的上游耗时记录


def _close_conn():
    global _conn
    try:
        if _conn is not None:
            _conn.close()
    except Exception:
        pass
    _conn = None


def upstream(action, **extra):
    """调用上游 API（复用长连接）。返回 data；失败抛 RuntimeError。"""
    global _conn
    data = urllib.parse.urlencode({"api": 1, "api_action": action, **extra})
    headers = {
        "X-API-Key": UPSTREAM_API_KEY,
        "User-Agent": "iepl-whitelist/2.0",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    t0 = time.time()
    reused = False
    status, raw = 0, ""
    with UP_LOCK:
        for attempt in (1, 2):
            fresh = _conn is None
            try:
                if _conn is None:
                    if UP_SCHEME == "https":
                        _conn = http.client.HTTPSConnection(
                            UP_HOST, timeout=UPSTREAM_TIMEOUT, context=ssl.create_default_context())
                    else:
                        _conn = http.client.HTTPConnection(UP_HOST, timeout=UPSTREAM_TIMEOUT)
                reused = not fresh
                _conn.request("POST", UP_PATH, body=data, headers=headers)
                r = _conn.getresponse()
                raw = r.read().decode("utf-8", "replace")
                status = r.status
                if (r.getheader("Connection") or "").lower() == "close":
                    _close_conn()
                break
            except (OSError, http.client.HTTPException) as e:
                _close_conn()
                # 新建连接就失败、或已经等满超时：不再重试，避免把客户端拖得更久。
                # 只有“复用的旧连接被对端关了”才值得换新连接重试一次（添加操作是幂等的）。
                if fresh or isinstance(e, (TimeoutError, socket.timeout)) or attempt == 2:
                    _record(action, t0, reused, "ERR")
                    raise RuntimeError("上游请求失败: %s" % e)
    _record(action, t0, reused, status)
    try:
        body = json.loads(raw)
    except Exception:
        print("upstream %s -> HTTP %d non-JSON: %s" % (action, status, raw[:160].replace("\n", " ")), flush=True)
        raise RuntimeError("上游 %s 失败（HTTP %d，非 JSON 响应），疑似上游接口故障" % (action, status))
    if status != 200 or body.get("code") != 0:
        raise RuntimeError(body.get("msg") or "上游返回 HTTP %d" % status)
    return body.get("data") or {}


def _record(action, t0, reused, status):
    log = getattr(_tl, "up", None)
    if log is not None:
        log.append("%s:%.2fs%s%s" % (action, time.time() - t0, "" if reused else "+tls", "" if status in (200,) else "/" + str(status)))


def norm(cidr):
    return str(cidr).split("/")[0]


def snapshot(data):
    entries = data.get("entries") or []
    ips = [norm(e.get("cidr", "")) for e in entries] or [norm(x) for x in data.get("iplist") or []]
    return {
        "mode": data.get("mode"),
        "province": data.get("province"),
        "count": data.get("count", len(ips)),
        "limit": data.get("limit", 10),
        "whitelist": ips,  # 按加入时间从早到晚
    }


def get_snapshot(force=False):
    """返回 (快照, 是否来自缓存, 缓存年龄秒)。"""
    now = time.time()
    if not force and CACHE["snap"] is not None and now - CACHE["ts"] < CACHE_TTL:
        return CACHE["snap"], True, now - CACHE["ts"]
    snap = snapshot(upstream("get_whitelist"))
    CACHE["snap"], CACHE["ts"] = snap, time.time()
    return snap, False, 0.0


def client_ip(handler):
    # Caddy 会用 header_up 覆盖 X-Real-IP；只信任来自本机回环的请求
    peer = handler.client_address[0]
    raw = handler.headers.get("X-Real-IP") if peer in ("127.0.0.1", "::1") else peer
    raw = (raw or peer).strip()
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        return None
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return str(ip) if ip.version == 4 else None


def sync(ip, dry):
    with LOCK:
        snap, cached, age = get_snapshot(force=dry)
        out = {"ip": ip, **snap}
        if cached:
            out["cached"] = True
            out["age"] = round(age, 1)
        if ip in snap["whitelist"]:
            out["status"] = "exists"
            return out
        # 满额时上游会自动移除最早的一条（含管理员添加的网段），提前告知
        evict = snap["whitelist"][0] if snap["count"] >= snap["limit"] and snap["whitelist"] else None
        if dry:
            out["status"] = "would_add"
            out["would_remove"] = evict
            return out
        res = upstream("add_whitelist", ip=ip)
        if res.get("entries") or res.get("iplist"):
            after = snapshot(res)
        else:
            after = snapshot(upstream("get_whitelist"))
        CACHE["snap"], CACHE["ts"] = after, time.time()   # 重试 / 查 /status 直接命中，不再访问上游
        out.update(after)
        out.pop("cached", None)
        out.pop("age", None)
        out["status"] = "added" if res.get("changed", True) else "exists"
        out["removed_ip"] = norm(res["removed_ip"]) if res.get("removed_ip") else (evict if out["status"] == "added" else None)
        return out


class H(BaseHTTPRequestHandler):
    server_version = "iepl-whitelist"

    def log_message(self, fmt, *a):  # 访问日志由 handle_any 统一输出
        pass

    def reply(self, code, obj):
        self._code = code
        body = json.dumps(obj, ensure_ascii=False).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self._gone = True   # 客户端（或 Caddy 上游的客户端）在我们回复前已经断开

    def authed(self, ip_key):
        now = time.time()
        n, t0 = FAILS.get(ip_key, (0, now))
        if now - t0 > 600:
            n, t0 = 0, now
        if n >= 10:
            self.reply(429, {"ok": False, "msg": "鉴权失败过多，请稍后再试"})
            return False
        tok = self.headers.get("X-Token", "")
        if hmac.compare_digest(tok.encode(), CLIENT_TOKEN.encode()):
            FAILS.pop(ip_key, None)
            return True
        FAILS[ip_key] = (n + 1, t0)
        self.reply(401, {"ok": False, "msg": "token 无效"})
        return False

    def route(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        ip = client_ip(self)
        if url.path == "/ip":
            if not ip:
                return self.reply(400, {"ok": False, "msg": "仅支持 IPv4 访问"})
            return self.reply(200, {"ok": True, "ip": ip})
        if url.path not in ("/status", "/sync"):
            return self.reply(404, {"ok": False, "msg": "not found"})
        if not self.authed(self.headers.get("X-Real-IP", self.client_address[0])):
            return
        if not ip:
            return self.reply(400, {"ok": False, "msg": "仅支持 IPv4 访问（白名单只允许 IPv4）"})
        try:
            if url.path == "/status":
                snap, cached, age = get_snapshot(force=q.get("fresh", ["0"])[0] == "1")
                extra = {"cached": True, "age": round(age, 1)} if cached else {}
                return self.reply(200, {"ok": True, "ip": ip,
                                        "status": "exists" if ip in snap["whitelist"] else "missing",
                                        **snap, **extra})
            return self.reply(200, {"ok": True, **sync(ip, q.get("dry", ["0"])[0] == "1")})
        except RuntimeError as e:
            return self.reply(502, {"ok": False, "ip": ip, "msg": str(e)})

    def handle_any(self):
        t0 = time.time()
        _tl.up = []
        self._code, self._gone = 0, False
        try:
            self.route()
        finally:
            path = urllib.parse.urlparse(self.path).path
            print("%s \"%s %s\" %d total=%.2fs up=[%s] ua=%s%s" % (
                self.headers.get("X-Real-IP", self.client_address[0]), self.command, path, self._code,
                time.time() - t0, ",".join(_tl.up),
                (self.headers.get("User-Agent") or "-")[:40].replace(" ", "_"),
                " CLIENT-GONE" if self._gone else ""), flush=True)

    do_GET = handle_any
    do_POST = handle_any


class Server(ThreadingHTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    Server((BIND, PORT), H).serve_forever()
