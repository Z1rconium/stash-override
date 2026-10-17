# iepl-whitelist 同步服务（服务端）

[Stash 覆写](../README.md)需要的后端：一个很小的 HTTPS 服务（Python 标准库，无第三方依赖）。
它做三件事：

1. 把**请求的来源 IP** 当作你的**直连出口 IP**（所以客户端必须直连它，见 Stash 端说明）；
2. 查询 IEPL 白名单，**这个 IP 不在就添加**，并把结果返回给客户端；
3. 把 **IEPL 的 API Key 留在服务器上**——Stash / 快捷指令只持有访问本服务的 token，设备丢了也不会泄露 IEPL 密钥。

```
Stash / 快捷指令 ──HTTPS + X-Token──▶ Caddy ──▶ server.py ──IEPL 白名单 API──▶ IEPL
   （直连）                       （终结 TLS，                  （API Key 只存在这台服务器）
                                   写入 X-Real-IP）
```

## 需要准备

| 项目 | 说明 |
| --- | --- |
| 一台 Linux 服务器 | 需要 systemd 与 **Python 3.8+**（标准库即可，实测过 3.9 / 3.12）；线路对你的网络可达、稳定即可 |
| 一个域名 | **只配 A 记录**（IPv4）指向这台服务器。不要配 AAAA：白名单通常只接受 IPv4，走 IPv6 的请求会被拒绝 |
| Caddy（或其他反代） | 负责 HTTPS；安装脚本不会改动它，只告诉你要加什么 |
| IEPL 白名单 API 的**完整地址**和 **API Key** | 在服务商后台的“API 调用说明”里；见下文“上游 API 约定” |

## 安装

```bash
git clone https://github.com/Z1rconium/stash-override.git
cd stash-override/iepl-whitelist/server
sudo ./install.sh
```

脚本会询问 API 地址与 API Key（Key 输入不回显），也可以事先用环境变量传入：

```bash
sudo UPSTREAM_URL='<你的 API 完整地址>' UPSTREAM_API_KEY='<你的 API Key>' DOMAIN=your.domain.example ./install.sh
```

它会：

1. 把 `server.py`、`stats.py` 放到 `/opt/iepl-whitelist`；
2. 在 `/etc/iepl-whitelist` 生成 `upstream.env`（API 地址与 Key）和 `token.env`（**随机生成**的访问 token），权限均为 600；
3. 安装并启动 systemd 服务 `iepl-whitelist`，并做一次自检；
4. 结尾打印一次 **token** 和要加到 Caddy 的站点块。**token 只显示这一次**，请保存好。

然后：

1. 把站点块加到 `/etc/caddy/Caddyfile`（也可参照 [`Caddyfile.example`](./Caddyfile.example)），把 `YOUR_DOMAIN` 换成你的域名，`sudo systemctl reload caddy`；
2. 验证——应返回你当前的公网 IP：

   ```bash
   curl https://your.domain.example/ip
   ```

3. 预演一次同步（**只读**，不会真正添加）：

   ```bash
   curl -X POST 'https://your.domain.example/sync?dry=1' -H 'X-Token: <你的 token>'
   ```

4. 在 Stash 覆写里填写 `api = https://your.domain.example` 和 `token`，见 [Stash 端说明](../README.md)。

> 手动安装（不用脚本）：照 [`upstream.env.example`](./upstream.env.example) 创建两个环境文件，
> 把 [`iepl-whitelist.service`](./iepl-whitelist.service) 里的 `@APP_DIR@` / `@ETC_DIR@` 换成实际路径后放进 `/etc/systemd/system/`，
> `systemctl enable --now iepl-whitelist` 即可。

## 接口

除 `/ip` 外都需要请求头 `X-Token: <token>`。GET 和 POST 等价。

| 接口 | 作用 |
| --- | --- |
| `/ip` | 返回调用方的公网 IPv4：`{"ok":true,"ip":"1.2.3.4"}`（无需 token） |
| `/sync` | 检查调用方 IP 是否在白名单，**不在就添加**。这是 Stash 脚本使用的接口 |
| `/sync?dry=1` | 同 `/sync`，但只预演（强制查询上游），**不添加** |
| `/status` | 只返回白名单状态，不做任何修改；`?fresh=1` 强制查询上游 |

`/sync` 成功时：

```json
{
  "ok": true,
  "ip": "1.2.3.4",
  "status": "exists",
  "mode": "ip", "province": null,
  "count": 3, "limit": 10,
  "whitelist": ["…按加入时间从早到晚…"],
  "removed_ip": "仅在满额新增时出现：被自动移除的最早一条"
}
```

| 字段 | 含义 |
| --- | --- |
| `status` | `exists` 已在白名单；`added` 刚新增；`would_add`（仅 `dry=1`）会新增；`/status` 里还有 `missing` |
| `cached` / `age` | 本次结果来自服务端缓存及其年龄（秒），没有这两个字段表示刚查过上游 |
| `would_remove` | 仅 `dry=1`：如果现在新增，白名单已满，将会被移除的那一条 |

失败时：`{"ok":false,"msg":"原因","ip":"…"}`，HTTP 状态码：`401` token 无效、`429` 鉴权失败过多（同一来源 10 分钟内 10 次）、
`400` 来源不是 IPv4、`502` 上游出错或不可达。

## 上游 API 约定

服务端依赖的上游接口形状如下（以服务商后台的“API 调用说明”为准）：

- 请求：`POST <UPSTREAM_URL>`，请求头 `X-API-Key: <API Key>`，表单 `api=1&api_action=<动作>`；
  添加时再带 `ip=<IPv4>`。用到的动作：`get_whitelist`（查询）、`add_whitelist`（添加）。
- 成功：HTTP 200，`{"code":0,"msg":"success","data":{…}}`，其中 `data` 包含
  `mode`、`province`、`iplist`（`["1.2.3.4/32"]`）、`entries`（`[{"cidr":"1.2.3.4/32"}]`，按加入先后）、`count`、`limit`；
  添加还会带 `changed`（是否真的新增）与 `removed_ip`（满额时被顶掉的条目）。
- 失败：非 200 状态码，并带 `{"code":…,"msg":"原因"}`。
- 服务端依赖的语义：同一个 IP 重复添加是**幂等**的（不改变顺序）；白名单**满额时添加会自动移除最早的一条**。

如果你的服务商接口不同，只需要改 `server.py` 里的 `upstream()`（怎么请求）和 `snapshot()`（怎么解析），其余逻辑不用动。

## 配置项

在 `/etc/iepl-whitelist/*.env` 里设置（systemd 的 `EnvironmentFile`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `UPSTREAM_URL` | 必填 | 上游白名单 API 的完整地址 |
| `UPSTREAM_API_KEY` | 必填 | 上游 API Key，只存在服务器上 |
| `CLIENT_TOKEN` | 必填 | 客户端访问本服务的 token（`token.env`） |
| `BIND` | `127.0.0.1` | 监听地址。**保持只监听本机**，由 Caddy 反代；不要改成 `0.0.0.0` |
| `PORT` | `8787` | 监听端口 |
| `CACHE_TTL` | `15` | 白名单快照缓存秒数 |
| `UPSTREAM_TIMEOUT` | `12` | 调用上游的超时秒数 |

## 设计要点

- **来源 IP 的可信度**：服务端只在连接来自本机回环（即 Caddy）时才信任 `X-Real-IP`，而这个头由 Caddy 用真实连接来源**覆盖写入**，
  客户端无法伪造。因此不要在 Caddy 前再套 CDN / 其他反代，否则看到的是它们的 IP。
- **缓存与幂等**：白名单快照缓存 `CACHE_TTL` 秒，新增的结果会直接更新缓存。客户端超时后立刻重试，会等上一次做完，
  然后直接命中缓存返回“已存在”，**不会重复添加**；服务端在客户端断开后仍会把已开始的添加做完。
- **上游长连接**：对上游复用 HTTPS 连接，被对端关掉时自动重连一次。
- **限流**：同一来源 10 分钟内鉴权失败 10 次后返回 429。
- **systemd 加固**：`DynamicUser`、`NoNewPrivileges`、`ProtectSystem=strict` 等，进程以临时非特权用户运行；
  环境文件只有 root 可读，由 systemd 注入。

## 日志与排查

```bash
journalctl -u iepl-whitelist -f
```

每个请求一行：

```
1.2.3.4 "POST /sync" 200 total=6.01s up=[get_whitelist:3.00s+tls,add_whitelist:3.00s] ua=Stash/3.1 CLIENT-GONE
```

- `total`：服务端总耗时；`up=[…]`：各次上游调用耗时，`+tls` 表示新建了连接，`/404` 之类是上游状态码；
- **`CLIENT-GONE`**：客户端在服务端回复前就断开了（客户端超时）。此时 `total` 往往大于客户端的超时时间——
  说明是服务端 / 上游慢，客户端等不及，**不是线路断了**；已开始的添加仍会做完。

汇总分析（按客户端 IP 统计请求数、失败数、断开数、耗时分布、上游耗时、≥4 秒的慢请求）：

```bash
journalctl -u iepl-whitelist --since "24 hours ago" --no-pager | python3 /opt/iepl-whitelist/stats.py
```

| 现象 | 可能原因 |
| --- | --- |
| `401 token 无效` | 客户端 token 与 `token.env` 不一致 |
| `502 … 非 JSON 响应` | 上游接口故障或地址填错（日志里有上游返回的片段） |
| `502 … 上游请求失败` | 服务器连不上上游（网络 / 超时） |
| `400 仅支持 IPv4 访问` | 域名配了 AAAA，或客户端走了 IPv6；删掉 AAAA 记录 |
| 白名单里记录的是代理节点的 IP | 客户端到本服务的请求没有走直连，检查 Stash 覆写里的 `DIRECT` 规则 |
| `CLIENT-GONE` 很多 | 上游慢于客户端超时；换更快的线路对它帮助不大，重点看 `up=[…]` 的耗时 |

## 升级 / 换密钥 / 卸载

- **升级**：`git pull` 后在本目录再运行一次 `sudo ./install.sh`。已有配置和 token 会保留，只更新程序并重启服务。
- **换 token**：编辑 `/etc/iepl-whitelist/token.env`，`sudo systemctl restart iepl-whitelist`，再更新所有客户端（Stash 覆写、快捷指令）。
- **换上游 API Key**：编辑 `/etc/iepl-whitelist/upstream.env` 后重启服务。
- **卸载**：

  ```bash
  sudo systemctl disable --now iepl-whitelist
  sudo rm /etc/systemd/system/iepl-whitelist.service
  sudo rm -r /opt/iepl-whitelist /etc/iepl-whitelist
  sudo systemctl daemon-reload
  ```

## 隐私与安全

- 仓库里**不含**任何 API Key、上游地址、域名或 token；它们只存在于你服务器上的 `/etc/iepl-whitelist/`（权限 600）和你自己的客户端配置里。
  `.gitignore` 已忽略 `*.env`，防止误提交。
- **token 等同于白名单的写入权限**：不要提交、截图或分享；怀疑泄露时按上面的步骤更换。
- 服务只监听 `127.0.0.1`，对外只暴露 Caddy 的 443；请确认防火墙没有放行 8787。
- 公网上的扫描器会请求各种路径，服务端对它们返回 404；`stats.py` 只统计 `/sync` 和 `/status`，不受这些噪音影响。

## Python 版本

`server.py` 只用标准库，已在 **Python 3.9 和 3.12** 上测试。代码没有使用 3.9 以后才有的语法，理论上 3.8 也能运行（安装脚本以 3.8 为下限），但**3.8 没有实测过**。
