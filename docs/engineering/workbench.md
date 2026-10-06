# 工作台接入契约

本章为[工作台设计](../design/workbench.md)的工程接缝。

## 不变边界

每项目一个 lushd，项目 `.lush/` 保存事实。每个项目独立浏览器标签，关闭视图不停止开发。认证、Origin 校验和项目白名单保持；HTTP 可用但需明确警告明文风险。远程服务器运行 Host 与网络连通均由用户自行配置，Lush 不管理 SSH、安装包、隧道或跨 Host 环境代理。

## 分工

- `src/ui/web/assets/app.js` / `project-picker.js`：先启动主体；项目管理、界面设置与帮助不依赖已选项目。
- `route.js` / `api.js` / `prefs.js`：项目身份固定为 `/p/<project-id>/`，请求与项目偏好隔离。
- `src/ui/web/server.js`：Host 的 UI、认证、项目 API 转发适配器，不提供受管远端环境端点。
- `src/host/project-host.js`：已登记项目列表及显式后台启停；读取不启动，停止后不因轮询重启。

## 项目后台控制

`POST /api/host/projects/start {id}`、`POST /api/host/projects/stop {id}` 只接受已登记身份。stop 复用 `system.stop_if_idle` 并等待退出；忙碌拒绝，不改写 Worker 事实。项目 API 附着始终只读；用户明确选择/启动可恢复。直接书签打开未运行项目时显示离线并提供启动入口。能力通过 `/api/host` 发布；remove 只移除记录。

## 验证入口

- `bun run check:workbench`：真实 Firefox/WebDriver（需系统 Firefox 与 geckodriver），独立临时 Host/profile 和可控项目替身；验证空主体、全局导航、独立项目页、输入保留、双主题/响应式布局与离线状态。使用系统浏览器，不依赖已删除的 Electron Chromium；不连接用户项目。
- `test/web/project-control.test.js` / `test/integration/project-control.test.js`：显式启停、空闲停止及旧标签不偷启 daemon；只使用临时项目与 mock Agent。

[返回工程索引](README.md) · [Web 路由](../reference/web-routes.md)
