# Web 路由

本节管 Web 进程暴露的读取路由与用户动作白名单；监听与安全约束见 [HTTP](http.md)。

Web 进程只暴露读取与用户动作，不提供通用 RPC 代理：

- `GET /`、`/app.js`、`/styles.css`：Web 资源。
- `GET /api/docs`、`GET /api/docs/<id>`：「文档」视图的目录与 Markdown 正文，读的是随这份代码发布的 `docs/**/*.md` 与 `README.md`（`src/ui/web/docs.js`），与当前项目目录无关。`GET /api/docs/search-index` 只在用户第一次搜索时返回标题、小节、正文、普通代码与低权重 Mermaid 字段，匹配和排序在浏览器完成。id 由相对路径推出，只按已扫出的表命中，请求里的路径片段不进文件系统；流程图由浏览器按需加载本地 Mermaid 渲染，未命中返回 404。
- `POST /api/action`：JSON `{method, params}`，只允许项目 Agent 配置（`agent.configure`）、用户输入、任务维护、Review Candidate 验收动作、`branch.merge/sync/archive` 和 notice / plan 用户动作。

上面那份动作白名单就是代码里的 `MUTATIONS`。读取路由：

| 路由 | 底层 |
|---|---|
| `GET /api/snapshot` | status + input.list + draft.list + notice.list + spec.list + candidate.list + ladder + timeline + 分页 task.list |
| `GET /api/graph` | 分支节点、fork 连线实时状态与任务关系 |
| `GET /api/agent/models?agent=pi|codex` | 按需读取所选本机 CLI 当前可用模型目录；失败时带预设与 warning 回退 |
| `GET /api/agent/resources` | 不执行资源代码地读取当前用户和项目已安装的 Pi 扩展、Skills 与 package 资源，供 Agent profile 多选 |
| `GET /api/task/ID` | `task.inspect` |
| `GET /api/task/ID/history?after=N` | `task.history` |
| `GET /api/task/ID/diff` | `task.diff` |
| `GET /api/task/ID/transcript?after=N` | `task.transcript` |
| `GET /api/task/ID/usage` | `task.usage` |
| `GET /api/task/ID/report` | verifier 的自包含 HTML 报告（独立文档，独立 CSP） |
| `GET /api/docs` | 随代码发布的 Markdown 文档索引（分组、标题与仓库路径） |
| `GET /api/docs/search-index` | 浏览器按需使用的全文搜索字段（标题 / 小节 / 正文 / 代码 / Mermaid） |
| `GET /api/docs/ID` | 一篇 Markdown 文档的正文 |
| `POST /api/action` | 仅限上方 `MUTATIONS` 中的用户动作（含 `task.delete`、`task.clear`、`candidate.*`） |
