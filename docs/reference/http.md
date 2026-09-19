# HTTP

本节管 HTTP 服务的监听范围与安全约束；路由与 `POST /api/action` 白名单见 [Web 路由](web-routes.md)。

仅回环监听；拒绝非本地 Host、跨 Origin、跨站请求和非 JSON 修改请求。不能将它作为公网多用户服务暴露。
