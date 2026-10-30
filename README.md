# Stash 流媒体解锁 Tile

在 Stash 首页「第三方服务」面板中，为每个流媒体服务显示一块折叠 Tile：

- 🟩 **解锁** → 整块绿色背景，`content` 显示解锁地区
- 🟥 **未解锁 / 被封** → 整块红色背景，`content` 显示原因（如“仅香港”“IP 被封”）
- ⬜️ **超时 / 异常** → 灰色背景

支持服务：**Netflix、Disney+、YouTube Premium、YouTube 主站、Spotify、ChatGPT、Claude、TikTok**。

检测逻辑移植自 [MediaUnlockTest](https://github.com/HsukqiLee/MediaUnlockTest) 的 Go 实现
（`pkg/providers/*.go`），并改写为 Stash 的 JavaScript 脚本。

## 安装

1. 在 Stash → **覆写** 中添加下面的覆写 URL 并启用：

   ```
   https://raw.githubusercontent.com/Z1rconium/stash-override/main/media-unlock/media-unlock.stoverride
   ```

2. Stash → **策略组页左上角 ☁️ → 远程资源 → 更新**（首次需下载脚本资源），
   或断开 Stash 再重新连接一次。
3. 打开首页 **「第三方服务」** 面板即可看到各服务 Tile。

> 脚本与覆写均通过本仓库的 GitHub raw 链接分发，不依赖任何自建服务器。

## 工作原理

一个覆写里声明 8 块 `collapsed: true` 的 Tile（`media-netflix`、`media-disney`、…），
全部指向同一个脚本 `media-unlock.js`，脚本通过两种方式确定当前要测哪个服务：

1. Tile 的 `argument`：`{"service":"netflix"}`
2. 脚本名兜底：`media-netflix` → `netflix`、`media-youtube-main` → `youtube-main`

确定服务后只测该服务，并把结果写入 Tile：解锁 → `#34C759`，未解锁 → `#FF3B30`，
异常 → `#8E8E93`。若两者都取不到服务名，则退化为“一个合并 Tile + 🟢/🔴 圆点”的模式。

## 移植要点 / 已知差异

| MediaUnlockTest (Go) | Stash (JS Tile) |
| --- | --- |
| `core.GET / PostJson / PostForm` | `$httpClient.get / post(...)` |
| `resp.StatusCode` | `response.status` |
| `resp.Header.Get(...)` | `response.headers[...]` |
| 读取 body | 回调第三个参数 `data` |
| `SetFollowRedirect` | 请求对象 `'auto-redirect': true/false` |
| 并发 goroutine | `Promise.all` |

需注意的差异：

1. **TLS 指纹**：Go 版用 `tls-client` 伪装 Chrome 指纹以绕过 WAF；Stash 用 Apple 系统网络栈。
   对多数服务无影响，强 WAF 服务（如 Prime Video）行为可能不同，需单独验证。
2. **超时**：Stash `$httpClient` 默认 5s，脚本内放宽到 8s，并有 12s 的服务级超时兜底。
3. **重定向**：默认不跟随（与 Go 一致）。TikTok 必须**不跟随**跳转，否则地区页里会出现误导性的
   `"region"` 字段。
4. **仅 IPv4**：Stash `$httpClient` **无法按请求强制 IPv4/IPv6**。走代理时由 Fake-IP 把域名转给
   节点，最终协议族由**节点**决定。如需「仅 IPv4」结果，请配合 IPv4-only 出口的节点使用。
5. **内存**：iOS Network Extension 有 15/50MB 上限，不要一次性移植全部 provider。
6. **YouTube 主站**：`YoutubeRegion`（Premium 解锁）之外，另有一块 **YouTube 主站** Tile 检测主站可达性与
   出口地区 —— 直接请求 `https://www.youtube.com/` 首页，解析 ytcfg 内嵌的
   `"INNERTUBE_CONTEXT_GL":"XX"`（或 `"GL":"XX"`），该值来自请求出口 IP 的地理位置。
   连接被重置 / DNS 污染 / 超时记为「无法连接」，403 记为「IP 被封」，返回 `www.google.cn` 记为「仅中国」。

## 文件

```
media-unlock/media-unlock.stoverride   # 覆写声明：8 块折叠 Tile + 8 个 script-providers
media-unlock/media-unlock.js           # 检测脚本（所有服务 + 主流程）
```

## 刷新说明

- 本覆写的 collapsed Tile **不设 `interval`**（与 Stash 官方示例及社区覆写一致），
  由「第三方服务」面板的打开/刷新驱动：进入或刷新该面板即重新测试。
- 反之，若给 collapsed Tile 设了 `interval`，它会被锁定到该定时周期，点右上角刷新
  不会立即重跑 —— 这正是之前「点刷新没反应」的原因。
- 想测试**某个具体节点**的解锁情况：长按该节点 →「代理信息」→「第三方服务」，
  此时 `$httpClient` 的请求会经由该节点转发。
- **脚本资源是独立缓存**：`script-providers` 的 JS 按 `interval`（6 小时）缓存，
  与覆写（tiles）分开刷新。若只更新了覆写、没更新到脚本，会出现「新 Tile 用旧脚本」的错位 ——
  新加的 Tile 因服务名不在旧脚本里而退化成「合并 Tile」（灰色，标题形如 `流媒体解锁 5/7`）。
  为此每次改脚本都会给 `script-providers` 的 URL 追加版本查询串（如 `?v=0.6.1`），
  URL 变化会强制 Stash 重新下载脚本；更新后请按上面第 2 步刷新一次远程资源。

## 其他覆写

| 目录 | 说明 |
| --- | --- |
| [`iepl-whitelist/`](./iepl-whitelist/) | IEPL 白名单自动同步：定时检测直连出口 IP，不在白名单就自动添加，Tile 显示状态、点击手动同步。含 Stash 覆写、[Loon 插件](./iepl-whitelist/LOON.md)与[服务端实现（一键安装）](./iepl-whitelist/server/README.md)，也可以[把提示词交给 AI Agent 一键完成安装配置](./iepl-whitelist/AGENT-PROMPT.md)。**使用前必须填写自己的域名、token 与 API 信息** |

## 致谢

测试逻辑基于 [HsukqiLee/MediaUnlockTest](https://github.com/HsukqiLee/MediaUnlockTest)（MIT），
其上游为 [nkeonkeo/MediaUnlockTest](https://github.com/nkeonkeo/MediaUnlockTest) 与
[lmc999/RegionRestrictionCheck](https://github.com/lmc999/RegionRestrictionCheck)。

## License

MIT，详见 [LICENSE](./LICENSE)。
