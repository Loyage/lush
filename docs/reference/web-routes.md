# Web 路由

本节管 Web 进程暴露的读取路由与用户动作白名单；监听与安全约束见 [HTTP](http.md)。

Web 进程只暴露读取与用户动作，不提供通用 RPC 代理：

- `GET /`、`/app.js`、`/styles.css`：Web 资源。
- `GET /api/docs`、`GET /api/docs/<id>`：「文档」视图的目录与正文，读的是随这份代码发布的 `docs/` 与 `README.md`（`src/ui/web/docs.js`），与当前项目目录无关。id 由相对路径推出，只按已扫出的表命中，请求里的路径片段不进文件系统；未命中回 `no such document`。
- `POST /api/action`：JSON `{method, params}`，只允许用户输入、任务 message/cancel/retry/merge/cleanup/clear 和 notice answer/dismiss。

上面那份动作白名单就是代码里的 `MUTATIONS`。读取路由：

| 路由 | 底层 |
|---|---|
| `GET /api/snapshot` | status + input.list + notice.list + 分页 task.list |
| `GET /api/task/ID` | `task.inspect` |
| `GET /api/task/ID/history?after=N` | `task.history` |
| `GET /api/task/ID/diff` | `task.diff` |
| `GET /api/task/ID/transcript?after=N` | `task.transcript` |
| `GET /api/task/ID/usage` | `task.usage` |
| `GET /api/docs` | 随代码发布的文档索引（分组与标题） |
| `GET /api/docs/ID` | 一篇文档的 Markdown 正文 |
| `POST /api/action` | 仅限上方 `MUTATIONS` 中的用户动作（含 `task.clear`） |
