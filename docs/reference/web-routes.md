# Web 路由

本节管 Web 进程暴露的读取路由与用户动作白名单；监听与安全约束见 [HTTP](http.md)。

Web 进程只暴露读取与用户动作，不提供通用 RPC 代理。无 `--project` 的全局模式先通过窄启动器路由选择项目；带 `--project` 的单项目模式固定绑定且拒绝切换：

- `GET /`、`/app.js`、`/styles.css`：Web 资源。
- `GET /api/launcher`：返回 `mode`、当前项目、上次项目与恢复错误；全局模式会在首次读取时恢复缓存并自动启动/连接 daemon。
- `POST /api/launcher/select`：仅全局模式可用，JSON `{project}` 必须是现存目录的绝对路径；切换成功后更新全局 `launcher.json`。
- `GET /api/docs`、`GET /api/docs/<id>`：「文档」视图的目录与 Markdown 正文，读的是随这份代码发布的 `docs/**/*.md` 与 `README.md`（`src/ui/web/docs.js`），与当前项目目录无关。`GET /api/docs/search-index` 只在用户第一次搜索时返回标题、小节、正文、普通代码与低权重 Mermaid 字段，匹配和排序在浏览器完成。id 由相对路径推出，只按已扫出的表命中，请求里的路径片段不进文件系统；流程图由浏览器按需加载本地 Mermaid 渲染，未命中返回 404。
- `POST /api/action`：JSON `{method, params}`，只允许项目 Agent 配置（`agent.configure`）、Agent 环境文件写入（`agent.environment.configure`）、运行设置（`system.configure`）、睡觉模式（`sleep.start/stop/resume`）、选区解释（`explanation.start`）、用户输入、任务维护、Review Candidate 验收动作、`branch.merge/sync/archive` 和 notice / plan 用户动作。

上面那份动作白名单就是代码里的 `MUTATIONS`。读取路由：

| 路由 | 底层 |
|---|---|
| `GET /api/launcher` | 当前/上次项目与启动器模式 |
| `POST /api/launcher/select` | 校验绝对目录、启动/连接项目 daemon、更新最后项目缓存；不进入 `MUTATIONS` 通用 RPC 白名单 |
| `GET /api/notices?status=all&before=ID&limit=30` | `notice.page`：全部类型事项与处理结果的按需分页，不受快照 200 条上限限制；参数和留档语义见[待决问题](rpc/notices.md) |
| `GET /api/sleep` | 用户专属 `sleep.status`，授权、预算与暂停状态；见[睡觉模式](../sleep-mode.md) |
| `GET /api/sleep/choices?before=ID&limit=30` | 用户专属 `sleep.choices`，管家决定的快照、理由、执行结果游标页 |
| `GET /api/snapshot` | status + input.list + draft.list + notice.list + spec.list + candidate.list + ladder + timeline + 分页 task.list |
| `GET /api/usage?start=...&end=...&interval=auto` | 用户专属 `system.usage`，当前项目的 token、预计 USD、时间柱状图与模型分组；详见[统计口径](statistics.md) |
| `GET /api/graph` | 分支节点、fork 连线实时状态与任务关系 |
| `GET /api/agent/models?agent=pi|codex` | 按需读取所选本机 CLI 当前可用模型目录；失败时带预设与 warning 回退 |
| `GET /api/agent/resources` | 不执行资源代码地读取当前用户和项目已安装的 Pi 扩展、Skills 与 package 资源，供 Agent profile 多选 |
| `GET /api/agent/environment?target=common\|ROLE` | 按需读取公共或单角色 env 文件，包含明文值；底层 `agent.environment` 为用户专属，公网模式必须先登录，页面默认遮罩 |
| `GET /api/task/ID` | `task.inspect` |
| `GET /api/task/ID/history?after=N` | `task.history` |
| `GET /api/task/ID/diff` | `task.diff` |
| `GET /api/task/ID/transcript?after=N` | `task.transcript` |
| `GET /api/task/ID/transcript-search` | 用户专属 `task.transcript_search`，当前任务完整记录检索／筛选／分页；参数见[执行记录阅读器](../engineering/transcript-reader.md) |
| `GET /api/task/ID/transcript-page?seq=1&offset=0` | 用户专属 `task.transcript_page`，终端模式的连续完整文字分页；界限与游标见[执行记录阅读器](../engineering/transcript-reader.md) |
| `GET /api/task/ID/transcript-step?seq=N&offset=0` | 用户专属 `task.transcript_step`，分段原文、配对及前后上下文 |
| `GET /api/task/ID/explanations?before=N` | 用户专属 `explanation.list`，源任务的解释历史 |
| `GET /api/explanation/ID` | 用户专属 `explanation.get`，解释状态、结果与来源快照 |
| `GET /api/task/ID/usage` | `task.usage` |
| `GET /api/task/T/notice/N/preview/Q/O` | 按 notice ID 从已存问卷提取（校验所属 task，不受 task.inspect 历史上限影响）第 Q 题第 O 项的 HTML（零基序号），清洗后以独立 sandbox CSP 返回 |
| `GET /api/task/ID/report` | verifier 的自包含 HTML 报告（独立文档，独立 CSP） |
| `GET /api/docs` | 随代码发布的 Markdown 文档索引（分组、标题与仓库路径） |
| `GET /api/docs/search-index` | 浏览器按需使用的全文搜索字段（标题 / 小节 / 正文 / 代码 / Mermaid） |
| `GET /api/docs/ID` | 一篇 Markdown 文档的正文 |
| `POST /api/action` | 仅限上方 `MUTATIONS` 中的用户动作（含 `task.delete`、`task.clear`、`candidate.*`） |
