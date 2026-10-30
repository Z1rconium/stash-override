# 在 Loon 中自动同步 IEPL 白名单

安装 [`iepl-whitelist.plugin`](./iepl-whitelist.plugin)，在插件参数界面填写服务地址和 token，即可自动把手机的直连出口 IP 加入白名单。服务端沿用 [`server/`](./server/README.md)，与 Stash 版共用 [`iepl-whitelist.js`](./iepl-whitelist.js)。

## 安装与首次同步

需要 **Loon 3.5.1 (983) 或更新版本**，并先部署好同步服务。

1. 在 Loon 插件页面添加本插件：

   ```text
   https://raw.githubusercontent.com/Z1rconium/stash-override/main/iepl-whitelist/iepl-whitelist.plugin
   ```

2. 打开插件的参数设置，填写：
   - **同步服务地址**：例如 `https://sync.example.com`，使用 HTTPS，不带末尾 `/`。
   - **访问令牌**：服务端配置的 `X-Token`，不是 IEPL 上游 API Key。
3. 启用插件，确保脚本资源已下载。在 Loon 的脚本列表中手动运行 `iepl-whitelist-manual`。
4. 执行结果会写入脚本日志，并通过通知显示直连 IP、白名单占用数量和检查时间。新增 IP 时使用新增通知，包含可能被移除的旧 IP。请开启 Loon 的系统通知权限。

尚未发布时，可先将 `.plugin` 和 `.js` 导入 Loon 本地，将插件三处 `script(...)` 中的远程 URL 改成已导入的本地脚本路径；本地文件路径按 Loon 中实际保存的位置填写。

参数为空或仍为 `YOUR_…` 时不会联网。手动执行会提示配置，后台任务静默退出。token 保存在自己的 Loon 配置中；不要分享填写后的配置、备份或参数截图。

## Stash TestFlight 的 Loon 插件兼容模式

插件入口与实际 HTTP 运行时分别识别：原生 Loon 使用毫秒制超时与 `node: "DIRECT"`；
Stash 使用秒制超时与 `X-Stash-Selected-Proxy: DIRECT`。插件固定 tag 负责识别定时、网络变化和手动入口，原生 Stash 覆写继续使用 `mode` 参数。

Stash TestFlight 的插件参数绑定仍需实机确认。更新插件及脚本资源到 `1.2.1` 后，保存参数、重载配置，再从插件手动入口运行。
日志会输出一行不含地址和 token 值的诊断，例如：

```text
[IEPL 1.2.1] runtime=Stash；entry=manual；argument=object；api=已收到；token=已收到
```

- 两个字段均“已收到”：脚本已经拿到参数，随后才进行联网探测。
- “未传入”：解析后的参数对象缺少该字段；结合 `argument` 类型区分未绑定和未解析。请提供 Stash 版本与 Build，以及这行诊断，不要粘贴原始参数。
- “为空”或“仍为占位符”：保存插件参数并重载配置。
- “不是有效 HTTPS 地址”：检查协议和格式；复制粘贴带来的首尾空白会自动去除。
- `entry=native`：未识别出插件固定 tag，需核对 Stash 转换后的脚本名称和入口；原生 `.stoverride` 显示 native 属正常行为。

按 [Loon 官方说明](https://nsloon.app/docs/Script/script_v2/)，插件参数在配置加载时绑定，修改参数后需重载配置；普通远程脚本不自带插件参数作用域。

## 同步时机

- **定时**：每分钟唤醒脚本，通常每 5 分钟探测并同步一次。首次 cron 或距上次 cron 超过 150 秒时补检查一次；启动后的实际执行时间取决于 Loon 调度。
- **网络变化**：收到 Loon 的 `network-changed` 事件时立即探测并同步，不等待 5 分钟周期。
- **手动**：运行 `iepl-whitelist-manual`，立即探测并同步，显示结果。
- **断网或探测未通过**：跳过同步，保留上次成功结果，不累计同步失败；每分钟重新探测。手动执行会显示暂停状态。
- **联网但同步服务连接失败**：单次最多尝试 3 次，每次 8 秒；下一分钟重试。连续 3 次同步网络失败才提醒，服务端明确报错连续 2 次才提醒，后续每 12 次提醒，恢复时通知。

联网探测使用 Apple 的 HTTPS 测试页，超时 3 秒，并校验预期响应。测试站点受限也会暂停同步；不以代理节点是否健康作为条件。三个入口的 `tag` 用来识别运行方式，请保留原值。

## 与 Stash 的区别

Loon 使用通用脚本作为手动入口，状态通过日志与通知展示，没有沿用 Stash 的彩色 Tile。定时和网络变化入口成功时记录日志；新增 IP、连续失败和恢复仍会通知。

探测与同步都在请求中设置 `node: "DIRECT"`，不经代理节点；这不保证绕过 Loon 调用 iOS 原生网络栈。无需添加域名规则，也不需要 MitM 证书。Loon 的 HTTP 请求超时单位是毫秒，脚本已适配；请求显式设置 `insecure: false` 校验证书，并关闭自动重定向，避免 token 被转发到其他地址。

## 验证

仓库根目录运行：

```sh
node --test iepl-whitelist/tests/sync.test.cjs
```

自动测试模拟 Stash / Loon 接口，覆盖入口调度、离线恢复、强制直连、超时单位、证书校验和通知，不访问真实白名单服务。

iOS 验收：导入插件后先手动同步，确认返回的是手机的直连出口 IP；再切换 Wi-Fi / 蜂窝网络检查网络变化触发，断网检查暂停状态。当前未进行 Loon 实机导入和后台调度验证。

## 接口依据

- [插件与参数声明](https://nsloon.app/docs/Plugin/)
- [脚本触发方式与新版语法](https://nsloon.app/docs/Script/script_v2/)
- [HTTP 请求、存储和通知 API](https://nsloon.app/docs/Script/script_api/)
