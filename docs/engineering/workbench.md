# 工作台接入契约

本章为[工作台设计](../design/workbench.md)的工程接缝。

## 不变边界

每项目一个 lushd，项目 `.lush/` 保存事实。每个项目独立浏览器标签，关闭视图不停止开发。认证、Origin 校验和项目白名单保持；HTTP 可用但需明确警告明文风险。远程服务器运行 Host 与网络连通均由用户自行配置，Lush 不管理 SSH、安装包、隧道或跨 Host 环境代理。

## 分工

- `src/ui/web/assets/app.js` / `project-picker.js`：先启动主体；项目管理、界面设置与帮助不依赖已选项目。
- `route.js` / `api.js` / `prefs.js`：项目身份固定为 `/p/<project-id>/`，项目请求与具体工作状态隔离；主题等设备偏好共享。
- `src/ui/web/server.js`：Host 的 UI、认证、项目 API 转发适配器，不提供受管远端环境端点。
- `src/host/project-host.js`：已登记项目列表及显式后台启停；读取不启动，停止后不因轮询重启。

## 项目后台控制

`POST /api/host/projects/start {id}`、`POST /api/host/projects/stop {id}` 只接受已登记身份。stop 复用 `system.stop_if_idle` 并等待退出；忙碌拒绝，不改写 Worker 事实。项目 API 附着始终只读；用户明确选择/启动可恢复。直接书签打开未运行项目时显示离线并提供启动入口。能力通过 `/api/host` 发布；remove 只移除记录。

## 项目外观（W160）

项目页标题为「项目名 · Lush」，由 Host 登记元数据先建立，daemon 离线仍可识别；根工作台标题为「Lush」。项目外观保存到 `<project>/.lush/appearance.json`，不是浏览器偏好或设备运行设置，不依赖 daemon。Host 首次显式打开初始化，优先分配已登记项目未使用的预设颜色（green/blue/teal/amber/rose/slate），耗尽后选使用最少者，重开不改色；列表读取不分配。

#411 保留 W160 的辨识配色，取消项目主题权威。`GET /api/host/projects/<id>/appearance` 只读返回 `{id,name,project,appearance}`，尚未配置时 appearance 为 null；`POST` 同路径接受 `{initialize:true}` 或 `{color,expected_revision}`。文件仍为 `{version:1,theme,color,revision}`，旧 theme 留存但不参与显示；兼容客户端可回传相同 theme，试图修改则拒绝并引导设备偏好。初始化的 system 也是非活跃兼容值，不自动导入设备主题。身份须已登记／在白名单内，不接受任意路径；认证、Origin、JSON/no-store、token／未知字段拒绝、私有读取、原子写入、跨进程锁和 revision 校验保持，损坏文件不自动覆盖。

用户工作台「项目」列表的「配色」入口提供六种具名辨识色，项目 shell 不再编辑主题或配色。主题统一经设备 prefs.js 管理，恢复设备默认不清项目辨识色或历史 theme。项目色失败保留已知值、提供重读入口，不阻断设备主题。项目页每 15 秒可见时只读同步配色；保存带 revision，迟到响应不能污染新项目。仅改变侧栏、品牌、选中项及强调色，不替换业务状态／Agent 紫色。

## 验证入口

- `bun run check:workbench`：真实 Firefox/WebDriver（需系统 Firefox 与 geckodriver），独立临时 Host/profile 和可控项目替身；验证空主体、全局导航、独立项目页、输入保留、双主题/响应式布局与离线状态。另用两个独立 Firefox profile 验证项目标题、持久外观与跨浏览器同步，六种配色 × 深浅主题 × 1440/900/390px 的布局、对比度与业务状态／Agent 色不变，首次分配与重开保留。使用系统浏览器，不依赖已删除的 Electron Chromium；不连接用户项目。
- `test/project-appearance.test.js`、`test/web/project-appearance-api.test.js`：临时目录的私有存储／权限／别名／TOCTOU／损坏文件／锁／并发配色分配与 revision 冲突，真实 Host HTTP 与前端控制器联调、认证／Origin／白名单保护及离线不启动 daemon。`project-appearance-client.test.js` 与 `dom-project-appearance*.test.js` 覆盖读取／保存／迟到响应／设置／项目切换／标签页身份／默认恢复不清项目外观／禁用帮助宿主。`project-colors-contrast.test.js` 按实际 CSS 调色与混合比例验证六种配色在染色侧栏／选中项上的 WCAG 文本对比度；浏览器测量在侧栏过渡动画真正结束后进行。
- `test/web/project-control.test.js` / `test/integration/project-control.test.js`：显式启停、空闲停止及旧标签不偷启 daemon；只使用临时项目与 mock Agent。

[返回工程索引](README.md) · [Web 路由](../reference/web-routes.md)
