# 界面与传输

本文件管 CLI 分页、Web 轮询与 CSP、RPC 信任边界与 `system.status` 字段。

CLI 的 task list / history 支持 cursor 分页；task inspect 返回完整任务结果和有界的相关记录。Web 复用 UIClient，轮询快照，采用 textContent 呈现模型输出，不插入 HTML；输入表单和 notice 答复在轮询时保留。

左栏 workspace-nav 的「文档」在右栏打开随这份代码发布的文档（架构、使用流程、接口参考），与所开发的项目无关。它与「项目概览」「分支图」共用同一个右栏和同一套排他规则：路由是 `#graph` / `#docs` / `#doc-<id>`，视图自己把 `#detail[data-view]` 写对（左栏高亮与进场动画都跟着它走），轮询只画当前开着的那个（`ui.graphOpen` / `ui.docsOpen`）。正文由 `/api/docs` 取回后用同一套 Markdown 渲染器画成 DOM，文档之间的相对链接解析成站内 hash 后走同一个路由。「分支图」（`#graph`）调 `/api/graph`，覆盖所有本地分支：`branches` 表记录 ∪ `refs/heads` 现状，只被父指针提到的名字补占位节点；分支按 fork 谱系嵌套，任务挂在自己的分支下。打开期间不每个 1.5s 轮询都打 git：快照指纹变了至少隔 3 秒才重拉，指纹不覆盖 UI 外新建的分支，因此另有约 10s 的最长陈旧时间兜底，新分支不手点刷新也会出现。

Web 只监听 127.0.0.1，校验 Host / Origin / Sec-Fetch-Site，修改操作要求 JSON；HTTP 只能访问显式允许的方法，不能代理任意 RPC。Web 与 daemon 是两个独立进程，谁都不跟着对方换版本：`bun run daemon-restart` 只管 daemon，`bun run web-restart` 管 Web（停掉端口上那个后台 Web 再按当前代码起一个新的，只认命令行确实是 Lush Web 的进程）。`bun run web` 后台起进程并要求它真的占住端口才返回；Web 的日志与自我描述（pid / 端口 / 代码指纹）在 `.lush/web.log` 与 `.lush/web.state.json`，`web-status` 据此报告跑的是不是这份代码。重启 Web 会清空内存里的登录会话，浏览器需要重新登录。检验报告在 `/api/task/<id>/report` 以独立文档返回，只允许内联样式/脚本与 `data:` 图片（`default-src 'none'`），因此报告里的脚本不能回调本地 API；非 verifier 任务或不存在的报告不会被当文件读出去。RPC 以本机用户为可信边界；agent token 只约束正常的 agent 调用，不是本机攻击者隔离。`system.status` 报告运行中的 agent 列表与 `agents_total` / `agents_idle`（每个活动 task 一个 agent，含已 park 的），`task.inspect` 报告该 agent 的 id、唤醒次数与上次动手时间。

相关：[数据流](data-flow.md)。
