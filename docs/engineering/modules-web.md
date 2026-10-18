# 模块地图：Web 前端

本章定位浏览器与 Host 的职责接缝，不维护另一份 asset 导出清单。源码为原生 ES module；当前能力与权限见[核心 API](core-api.md)，路由见[Web 参考](../reference/web-routes.md)。修改相关范围前先读[执行过程](../design/agent-process.md)、[引用](../design/references.md)、[按钮帮助](../design/ui-guidance.md)或[通知理念](../design/notices.md)。

> 模块地图：[总览](modules.md) → [Runtime 与持久化](modules-runtime.md) → **Web 前端** → [CLI、RPC 与测试](modules-interfaces.md)

## Agent 能力开关（W217／D509）

全局系统设置复用设备 partial patch，不加载 Agent 注册表或调用模型。保存不能重画其他字段的未保存草稿；启停语义以[能力契约](agent-capabilities.md)为准。

## 浏览器装配与共享接缝

- `assets/app.js` 是装配入口，保留 `boot()`；重复 boot 必须清理旧轮询、监听器与只读请求，不能绑定旧 DOM 或重放通知。DOM 测试共享模块注册表，因此每例必须重新装配自己的 stub。
- 页面间只依赖接缝：跳转走 `navigate.js`，共享状态走 `state.js`，偏好走 `prefs.js`。页面／项目／请求代次阻止迟到响应覆盖新页面，写 ACK 与后续读取失败分开，不自动重试 mutation。
- 确认、输入和表单走 `dialog.js` 应用内弹窗，不用原生 confirm／prompt／alert；取消、失败、在途编辑须保留现场与焦点。
- `route.js` 固定项目身份，`api.js` 给项目 API 加前缀；Host／文档是根资源，不能按浏览器“当前项目”改投。
- `index.html` 是模板，构建与版本资源由 Host 装配发布；鉴权、缓存、启动预算与动态拆包见[Web 性能](web-performance.md)。

## 页面职责

| 范围 | 定位入口（`src/ui/web/assets/`） | 当前契约 |
|---|---|---|
| 根 shell 与项目登记 | `workspace-shell.js`、`project-picker.js` | [工作台](workbench.md)、[用户工作台](user-workspace.md) |
| 总览与诊断 | `dashboard-panel.js`、`dashboard-diagnostics.js` | [总览面板](dashboard-panel.md) |
| 输入与历史 | `composer.js`、`render-inputs.js` | [输入接口](input-history.md)、[条件发射](conditional-emission.md) |
| 工作列表／管家列表／工作树／通用详情 | `render-tree.js`、`render-task-graph.js`、`detail.js` | [Worker 图](task-graph.md)、[Worker RPC](../reference/rpc/tasks.md) |
| 时间线与执行详情 | `render-conversation.js`、`transcript-view.js` | [阅读器](transcript-reader.md) |
| 代码与差异 | `code-view.js`、`render-diff.js` | [代码阅读器](code-reader.md) |
| Worker CLI 交互 | `worker-cli-route.js`、`worker-cli-page.js`、`worker-cli.js`、`worker-cli-detail.js` | 详情新标签链接进入独立页面；组件仅依赖注入的 preview/execute，Ctrl+Enter 与按钮共用提交流程，结果紧接输入；适配器固定项目／Worker 身份、页内刷新复用与离页释放；实际执行权限和界限见 [Worker CLI 契约](../reference/rpc/tasks.md#worker-cli-交互) |
| CLI 学习与项目管家权限 | `render-valet-settings.js`（保留历史文件名）、`cli-catalog.js` | `#cli-interfaces` 静态目录版本缓存、读／写分类与本地搜索、目录／单条详情；项目权限按需读取，跨详情保留草稿，完整映射与 revision、迟到／离页保护；保存对当前项目新旧管家统一生效，权限与未开始操作重检边界来自[Valet 契约](hook-signals-management.md) |
| 自动化目录／功能与 Worker 实例挂载 | `render-project-automation.js`、`automation-features.js`、`render-hooks.js` | [Hooks](hooks.md)、[命令授权](shortcut-commands.md)、[历史](shortcut-command-runs.md) |
| 交付／验收／删除与管家停止 | `render-delivery.js`、`render-iteration.js`、`worker-delete.js`、`valet-actions.js` | [合并](merge.md)、[验收](worker-acceptance.md)、[删除](../reference/rpc/maintenance.md) |
| Agent 配置与来源 | `render-agent-status.js`、`render-model-sources.js` | [Web 配置](web-agent-configuration.md)、[账号连接](agent-connections.md) |
| 设置与设备策略 | `render-settings.js`、`settings-api.js`、`workspace-automation.js` | [设备契约](user-workspace.md) |
| Notice 与全局收件箱 | `render-notices.js`、`global-inbox.js` | [Notice](../reference/rpc/notices.md)、[全局来源](user-workspace.md#全局收件箱分区) |
| 维护与重启 | `project-maintenance.js`、`service-restart.js` | [维护](project-maintenance.md)、[中断完成](interrupt-completion.md)、[重启](../reference/web-routes.md#服务重启) |
| Worker 详情版本图与旧入口兼容 | `render-versions.js`、`retired-pages.js` | [版本迭代](version-history.md) |
| 文档与全文检索 | `docs.js`、`render-docs.js`、`docs-search.js` | [文档维护与格式](../contributing/documentation.md) |

W263／D611：「工作列表」仅展示开发 Worker，「管家列表」仅展示持久 Valet，复用 `render-tree.js` 的同源列表与既有详情；「工作树」独立表达开发委派层级。两列表共享 overview 和 `scope=all` 的有界历史分页，状态筛选即时生效、文本搜索显式提交，检索仅覆盖已读取范围；不把 `/api/hooks` 的绑定快照当完整管家历史，也不从局部卡片估算全量。Valet 使用真实 V 编号，旧未编号记录回退 `#内部ID`；详情共享 Agent 与执行记录，展示安全绑定／操作收据；`render-detail.js` 经 `valet-actions.js` 提供停用授权与停止管家，删除共用 `worker-delete.js` 的预检、revision 及精确确认协议。停止已提交不等于实际退出，调用与在途操作收口后须重新预检；失败或未知不自动重发。正常结束并安全收口后，详情可通过标准表单向同一 Valet 追加输入，授权新一轮；具体准入与拒绝保留原文的边界见[管家追加契约](hook-signals-management.md#数据与时间)。仍不提供开发暂存／条件发射、合并交付、验收或 Git 动作。

旧独立 Valet 时间信号／绑定设置与指令／Hook 工具页面及其 Web 配置入口已删除（「CLI 接口」位于全局工作台，配置设备共享管家权限，内建默认与审核边界见[权限契约](hook-signals-management.md#设备全局管家权限)），不迁往其他页面；`render-management.js`、`openHookTools` 只保留退休导航兼容。项目自动化及 Worker 实例挂载管理保留，推送功能引用指令只读；后端 API、CLI、持久配置、授权与历史不删除或迁移。旧 `#versions` 从有界 overview 读取持久 main 身份后跳真实 Worker 详情，无 main 明示不可用，不再挂独立版本页；`render-versions.js` 已由 `render-detail.js` 接入版本模块，滚入时直接读取有界分支提交历程／main 图页，完整节点与交付映射收据按需展开。路由兼容见[Web 路由](../reference/web-routes.md#worker-页面与命名)，权限见[Valet 契约](hook-signals-management.md)。

设置页的 `render-settings.js` 只编排导航，`settings-interface.js`／`settings-system.js` 分别拥有偏好和系统页的请求代次；Agent 编辑从 `settings-agent.js` 进入，profile、包管理和环境编辑器各自维护草稿与缓存。模型来源的 `render-agent-connections.js` 负责选择、批量操作与页面生命周期，`connection-*` 模块分别拥有编辑／登录、历史／采样、提醒和只读展示；迟到响应仍由对应请求所有者作废，秘密不进入公开草稿。浏览器模块保持 assets 平级，构建与兼容资源路由自动发现，不另维护资源登记表。

CLI 目录的代码来源是 `src/cli/catalog.js`，同时生成 CLI help 和顶层分发注册；`src/rpc/cli-catalog.js` 只投影公开命令路径、父子关系、格式、示例、风险及实际一对多 RPC 关联，参数和权限从 registry／management-policy 读取。新用户专属 `cli.catalog {}` / 项目 GET `/api/cli/catalog` 不扩展 Agent 权限；根 GET `/api/host/cli/catalog` 仅返回随代码的说明，无需项目／daemon，不读取项目设置。新页面由 HTML 提供内容版本目录资源，`static-assets.js`／`build-assets.js` 用安全投影生成独立不可变 JSON，不把服务端 registry 打入浏览器；`assets/cli-catalog.js` 校验并复用当前 document 的读取，持久复用交给浏览器 HTTP 缓存，不使用 localStorage 存项目事实。无项目／后台停止仍可浏览；权限按需读取，不可编辑未知或版本不匹配的权限，详见[缓存边界](../hooks.md#cli-目录缓存与权限)。旧 `#valet-settings` 跳新页，不恢复信号／绑定设置。

## 共用阅读与交互

`dom.js`／`dom-base.js` 提供基础节点，`list-surface.js` 与 `search-field.js` 统一显式搜索和列表；`shared-module.js`／`module-reading.js` 保留正文节点、引用显露与阅读锚点。它们不改变记录来源、权限或加载范围。

`format.js`／`worker-label.js` 只用服务端明确编号；`worker-links.js` 经 lookup 导航，不从 W／V 编号猜整数。编号与标题规则见[编号参考](../reference/api.md#用户编号与-cli-身份)、[标题契约](core-api.md#worker-自定义标题)。历史引用快照不回写。

`markdown.js` 的默认 Agent 渲染不执行 Mermaid；文档调用可接管相对链接、GFM 表格并显式开启 diagrams。`mermaid-docs.js` 只在含图的文档按需加载固定本地资源，用 strict 渲染及隔离 blob SVG，失败回退源码、离页回收；不放宽主 CSP。`code-highlight.js` 通过安全 token DOM 按需着色，未知语言／超限／失败保留纯文本。

## Web 宿主

`src/ui/web/server.js` 是 Host 的 HTTP 装配入口，不是 Worker 权威库或跨项目调度器。请求先经 `server-auth.js` 的每监听器独立认证，再经根 Host 路由、固定项目路由，项目内拆出 Worker 读面与文档／资源适配；路由模块不拥有调度或凭证事实。认证、Origin、JSON、参数／路由白名单与 no-store 边界见[HTTP](../reference/http.md)及[Web 路由](../reference/web-routes.md)。

| 入口 | 职责 |
|---|---|
| `src/host/project-host.js`、`registry.js` | 登记目录、稳定身份解析与项目连接；只读 API 不启动离线后台 |
| `src/host/user-services.js`、`device-settings.js` | 用户设备服务、严格白名单与关闭期收口，不构造伪项目 |
| `src/host/global-inbox.js` | 已授权来源的私有派生缓存，动作在线重核并转发来源事务 |
| `src/host/project-appearance.js` | 项目身份配色，不读取 Worker 或覆盖设备主题 |
| `src/host/control.js`、`service-control.js`、`supervisor.js` | 真实进程所有权、显式安全停止／重启；Host 与 lushd 独立 |
| `src/ui/web/static-assets.js`、`build-assets.js` | 鉴权后版本资源、压缩／缓存与静态闭包发布 |
| `src/ui/web/docs.js` | 只读随代码发布的 Markdown 与搜索索引，按已知 ID 命中，不读取目标项目文档 |

服务器部署、SSH、证书及网络由用户配置，见[远程 Host](../deployment/remote-host.md)。Host 不管理隧道。测试与真实浏览器的责任区分见[贡献指南](../contributing/README.md#分层测试与交付)，不把 DOM stub 当真实布局／触摸验收。

---

[← 上一篇：Runtime 与持久化](modules-runtime.md) · [下一篇：CLI、RPC 与测试 →](modules-interfaces.md)
