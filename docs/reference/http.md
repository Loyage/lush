# HTTP

本节管 HTTP 服务的监听范围与安全约束；路由与 `POST /api/action` 白名单见 [Web 路由](web-routes.md)。

全局启动器与带 `--project` 的单项目 Web 默认都只监听回环地址。单项目模式在项目存在权限为 `600` 的 `.lush/web.json` 时监听公网；全局启动器在用户配置目录存在权限为 `600` 的 `web.json` 时监听公网。两者都用登录会话保护全部页面、资源与 API。全局公网配置还必须包含非空 `projects` 绝对路径白名单，启动器只允许打开规范化后命中的目录；未配置认证的本地启动器仍可选择任意现存绝对目录。Electron 的本地临时 Host 始终只监听回环地址且不读取全局公网配置；远程窗口直接加载远端 Host 并使用其认证，见[远程桌面部署](../deployment/remote-desktop.md)。

全局工作台为每个项目分配稳定的 `/p/<project-id>/` 身份路由，项目读写全部在该前缀下按请求所属项目分发；服务端不保存可被别的标签页改变的「当前项目」，无前缀的项目读写、未知或已移除的身份都被拒绝。因此两个标签页分别打开 A、B 时，A 的请求目标、未提交输入与迟到响应都不会被 B 的操作改变。窗口与标签各自独立保持自己的项目，`last_project` 只决定新窗口首次落点。

所有模式都拒绝伪造 Host；显式非 `null` Origin 必须是完整同源值（含协议与端口）或配置的可信 Origin，`Sec-Fetch-Site: same-site/same-origin` 不能覆盖此校验。`cross-site` 子请求继续拒绝，GET 顶层文档导航可进入认证流程。缺失 Origin 与 `Origin:null` 保留旧客户端/webview 兼容，不等于已证明同源。修改 API 仍要求 JSON（登录表单除外）。公网模式仍是可信用户工具，必须置于 HTTPS 反向代理之后，不能作为不可信多用户服务。

`web.json` 的字段、文件权限、密码与登录锁定、反向代理 Origin 配置等部署步骤见[远程 Host Agent 指导](../deployment/remote-host-agent.md)。访问方式与设计原因见[用户说明](../deployment/remote-host.md)。

## RPC 连接预算

daemon 的 Unix socket 与 Web 分隔：帧仍是换行分隔 JSON，单帧上限 1 MiB。每连接另有两个内存预算（不是全局并发限制，也不影响合法大响应一次送达）：解析后待执行的帧最多 32 个，读端达到上限即暂停，回落到 8 个后恢复；对端持续不读导致未写出回包超过 8 MiB 时暂停读取，30 秒仍不收敛则关闭该连接。关闭时尚未解析的帧从未执行，daemon 会为能识别 id 的这类请求回复 `-32022 connection queue full; request was not executed; safe to retry`；已派发但回包丢失的请求语义是**结果未知**，客户端不得自动重试修改类方法。暂停与关闭只作用于该连接，不阻塞其它连接，也不放宽单帧上限或分页字节预算。
