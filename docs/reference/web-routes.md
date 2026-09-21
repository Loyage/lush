# Web 路由

本节管 Web 进程暴露的读取路由与用户动作白名单；监听与安全约束见 [HTTP](http.md)。

Web 进程只暴露读取与用户动作，不提供通用 RPC 代理：

- `GET /`、`/app.js`、`/styles.css`：Web 资源。
- `GET /api/docs`、`GET /api/docs/<id>`、`GET /api/docs/<id>/html`：「文档」视图的目录、Markdown 正文与受控 standalone HTML，读的是随这份代码发布的 `docs/` 与 `README.md`（`src/ui/web/docs.js`），与当前项目目录无关。id 由相对路径推出，只按已扫出的表命中，请求里的路径片段不进文件系统；`/html` 只对索引里 `format === 'html'` 的条目生效（核心架构文档），响应带 `default-src 'none'` 的收紧 CSP，未命中回 404。
- `POST /api/action`：JSON `{method, params}`，只允许用户输入、任务维护、Review Candidate 验收动作、`branch.merge/sync/archive` 和 notice / plan 用户动作。

上面那份动作白名单就是代码里的 `MUTATIONS`。读取路由：

| 路由 | 底层 |
|---|---|
| `GET /api/snapshot` | status + input.list + draft.list + notice.list + spec.list + candidate.list + ladder + timeline + 分页 task.list |
| `GET /api/graph` | 分支节点、fork 连线实时状态与任务关系 |
| `GET /api/task/ID` | `task.inspect` |
| `GET /api/task/ID/history?after=N` | `task.history` |
| `GET /api/task/ID/diff` | `task.diff` |
| `GET /api/task/ID/transcript?after=N` | `task.transcript` |
| `GET /api/task/ID/usage` | `task.usage` |
| `GET /api/task/ID/report` | verifier 的自包含 HTML 报告（独立文档，独立 CSP） |
| `GET /api/docs` | 随代码发布的文档索引（分组、标题与 `format`） |
| `GET /api/docs/ID` | 一篇 Markdown 文档的正文 |
| `GET /api/docs/ID/html` | 一篇 standalone HTML 文档的原始正文（sandbox iframe 用） |
| `POST /api/action` | 仅限上方 `MUTATIONS` 中的用户动作（含 `task.clear`、`candidate.*`） |
