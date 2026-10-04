# 工作台接入契约

本章为[工作台设计](../design/workbench.md)的施工接缝；实现与验证结果在交付时核实，不能仅凭本章宣称所有平台已完成。

## 不变边界

每项目一个 lushd、项目 `.lush/` 事实和 Worker 调度不变。每项目独立窗口/浏览器标签；关闭视图、断开 SSH 不停止开发。公网认证、Origin 校验、项目白名单不得放宽。首次安装需确认，重连不重放写操作。

## 分工

- `src/ui/web/assets/app.js` / `project-picker.js`：先启动主体；`#projects` 项目管理、`#environments` 环境管理，不再用选择项目作为启动闸门。
- `src/ui/web/assets/environments.js`：环境页面，桌面窄 IPC 与 Web 服务端能力适配。浏览器必须显示 SSH 执行机器/用户。
- `src/ui/web/assets/route.js` / `api.js` / `prefs.js`：当前环境前缀与项目身份，远端路径为 `/e/<environment-id>/p/<project-id>/`，本地现有路径不变。
- `src/host/environments.js`：服务用户的 SSH manager、只读配置枚举、会话绑定一次性确认、连接元数据，不持有 Worker 事实。
- `src/ui/web/server.js`：认证后的环境端点、受限远端数据代理；远端不提供本地可信页面脚本。
- `src/host/project-host.js`：项目列表及显式后台启停，停止复用 idle 准入；读取不启动，明确停止后不因轮询自动重启。
- `src/ui/desktop/`：启动直接进入工作台；不支持本地 runtime 的平台仍有可用的可信主体。远端页面不能获得 SSH 或任意本机命令能力。

## Web 环境接口

全部环境管理端点位于根 `/api/environments`，不跟随当前项目/远端前缀，复用 Host 登录与 Origin/JSON 校验。

- `GET /api/environments` → `{execution:{hostname,username,scope:'host'},ssh:{supported,reason?,hosts:[{alias}],warnings:[],connections:[{id,alias,connected}]}}`。
- `POST /api/environments/ssh/inspect {alias,id?}` → `{profile,ready,requiresInstall,plan,warnings,confirmation}`。
- `POST /api/environments/ssh/connect {confirmation,install:boolean}` → `{id,href:'/e/<id>/'}`；授权来自同会话上次预检，不接收渲染器安装计划。
- `POST /api/environments/ssh/disconnect {id}` → 仅断开自有隧道。
- `POST /api/environments/ssh/cancel {}` → 作废同会话的计划并取消在途操作。

服务端使用独立用户配置目录保存 SSH 元数据。公网 SSH 必须通过部署环境 `LUSH_SSH_HOSTS`（JSON 字符串数组）明确白名单；缺省拒绝公网 SSH 管理，不把项目白名单当作 SSH 授权。回环桌面/本机 Web 可使用服务用户配置，主机身份校验不变。

`/e/<id>/` 和 `/e/<id>/p/<project-id>/` 使用入口 Host 自己的 UI 资源；仅代理已连接、已验证回环隧道的已知 Host/项目 API。代理不得接受 URL/自由路径，不转发入口 Cookie/Authorization，不跟随重定向，不代理远端脚本、登录页面或环境管理 API。文档来自入口发布资源。未知/断开环境显式离线，不回落本地项目。

## 项目后台控制

`POST /api/host/projects/start {id}`、`POST /api/host/projects/stop {id}` 只接受已登记身份；stop 复用 `system.stop_if_idle` 并等待退出。忙碌拒绝，失败不改写 Worker 事实。项目 API 附着始终只读（包括另一个 Host、重启后的 Host 和旧标签页），不由轮询启动 daemon；用户明确 select/启动可恢复。直接书签打开尚未运行项目时，先显示离线并提供主体内启动入口。能力字段通过 `/api/host` 发布。旧的 `remove` 只移除记录，含义不变。

## 验证入口

- `bun run check:workbench`：真实 Chromium/CDP，独立临时 Host/profile 和内存项目替身；验证空主体、全局导航、独立项目页与原输入保留、SSH 执行身份、双主题/三种宽度及离线环境。浏览器路径可由 `LUSH_TEST_CHROME` 指定；失败保留诊断，不连接真实 SSH。
- `test/web/environment-gateway.test.js` / `environment-authorization.test.js`：代理范围、认证/会话、一次性确认、过期、并发与取消竞态。
- `test/web/project-control.test.js` / `test/integration/project-control.test.js`：显式启停互斥、空闲停止以及另一个 Host 轮询不偷启 daemon；集成测试只用临时项目与 mock Agent。
- `test/desktop/runtime.test.js`：模拟 Electron 的主体启动、窗口/网关身份、降权及通知隔离，不代表真实跨平台桌面或 SSH 发布验收。

## 逐步交付边界

可信桌面工作台与远端页面彻底解耦、HTTPS 多环境代理认证及跨版本协议协商属于后续完整接入层工作；施工中必须逐项报告已实现与未实现，不将现有远端窗口误称为已完成本地渲染。现有 HTTPS 独立窗口可兼容保留，不通过任意反向代理绕过认证。
