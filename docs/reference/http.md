# HTTP

本节管 HTTP 服务的监听范围与安全约束；路由与 `POST /api/action` 白名单见 [Web 路由](web-routes.md)。

无项目的全局启动器与 Electron 临时 host 始终仅监听回环地址；它们可以接收本机绝对目录并启动该项目 daemon，因此不能经反向代理暴露。带 `--project` 的单项目 Web 默认也仅监听回环地址；只有项目存在权限为 `600` 的 `.lush/web.json` 时才监听公网，并通过登录会话保护全部资源与 API。

所有模式都拒绝伪造 Host、跨 Origin、跨站请求和非 JSON 修改请求。公网模式仍是可信用户工具，必须置于 HTTPS 反向代理之后，不能作为不可信多用户服务。
