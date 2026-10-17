#!/usr/bin/env python3
"""汇总 iepl-whitelist 服务日志，用来判断超时是线路问题还是服务/上游问题。

用法（在服务器上）:
  journalctl -u iepl-whitelist --since "24 hours ago" --no-pager | python3 /opt/iepl-whitelist/stats.py

按客户端 IP 输出：请求数、成功/失败数、客户端在回复前断开的次数（CLIENT-GONE）、耗时分布，
以及上游（IEPL 白名单 API）调用耗时。解读：
  - CLIENT-GONE 多且 total 很大（> 客户端超时）：服务端/上游慢，客户端等不及 —— 不是线路断了
  - 请求根本没出现在日志里（对比客户端的重试次数）：请求没到服务器 —— 才是线路/DNS/DIRECT 问题
"""
import re
import sys
from collections import defaultdict

LINE = re.compile(r'(?P<ip>\d+\.\d+\.\d+\.\d+) "(?P<m>GET|POST) (?P<path>/\S*)" (?P<code>\d+) '
                  r'total=(?P<total>[\d.]+)s up=\[(?P<up>[^\]]*)\] ua=(?P<ua>\S+)(?P<gone> CLIENT-GONE)?')
UP = re.compile(r'(?P<act>\w+):(?P<t>[\d.]+)s')


def pct(a, p):
    a = sorted(a)
    return a[min(len(a) - 1, int(len(a) * p))] if a else 0.0


rows = defaultdict(list)
up_times = defaultdict(list)
for line in sys.stdin:
    m = LINE.search(line)
    if not m or m["path"] not in ("/sync", "/status"):
        continue
    rows[m["ip"]].append(m)
    for u in UP.finditer(m["up"]):
        up_times[u["act"]].append(float(u["t"]))

if not rows:
    print("没有匹配到 /sync 或 /status 的访问记录（服务是否已升级到 v2？旧版本不记录耗时）")
    sys.exit(0)

print("%-17s %5s %5s %5s %6s  %-26s %s" % ("客户端 IP", "请求", "成功", "失败", "断开", "耗时 中位/P90/最大(s)", "UA"))
for ip, ms in sorted(rows.items(), key=lambda kv: -len(kv[1])):
    t = [float(m["total"]) for m in ms]
    ok = sum(1 for m in ms if m["code"] == "200")
    gone = sum(1 for m in ms if m["gone"])
    print("%-17s %5d %5d %5d %6d  %5.2f / %5.2f / %5.2f      %s" % (
        ip, len(ms), ok, len(ms) - ok, gone, pct(t, .5), pct(t, .9), max(t), ms[0]["ua"][:18]))

print("\n上游调用耗时，中位/P90/最大(s):")
for act, v in sorted(up_times.items()):
    print("  %-14s n=%-4d %5.2f / %5.2f / %5.2f" % (act, len(v), pct(v, .5), pct(v, .9), max(v)))

slow = [m for ms in rows.values() for m in ms if float(m["total"]) >= 4.0]
print("\n耗时 ≥ 4 秒的请求: %d 个（Stash 脚本请求的超时约 5 秒，这类请求最容易被客户端放弃）" % len(slow))
for m in slow[:8]:
    print("  %s %s %s total=%ss up=[%s]%s" % (m["ip"], m["m"], m["path"], m["total"], m["up"], " CLIENT-GONE" if m["gone"] else ""))
