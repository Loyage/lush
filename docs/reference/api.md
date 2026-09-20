# CLI 与 RPC

完整 CLI 帮助：`bun run help`。全局参数 `--project PATH`、`--json` 可放在命令前后。

`daemon start/restart` 是客户端工作流，不是 RPC。`doctor` 检查本地项目配置与 daemon 身份。`web [port]` 启动独立 Web 进程；默认只监听本机，存在 `.lush/web.json` 时改为公网监听并启用登录认证。`web-restart [port]` 先停掉端口上那个旧 Web 进程再起一个新的：Web 不跟着代码换版本，改完 `src/ui/web/` 之后用它，而不是再跑一次 `web`（那只会撞端口）。只停命令行确实是 Lush Web 的进程，别的程序占着端口时报出它的命令行交还给你。

本页是索引：CLI 与 RPC 表格、返回值和错误信息都在下面各章里。若要先理解从输入到交付的实际操作顺序，请读[行动任务处理流程](../task-flow.md)。

## 速查表

| 命令 | 章节 |
|---|---|
| `lush say` / `lush intent` / `lush intent list` / `lush plan *` / `lush draft *` / `lush input *` | [输入、规划与缓存](rpc/inputs.md) |
| `lush task list` / `tree` / `spawn` / `message` / `cancel` / `retry` | [任务与拆解](rpc/tasks.md) |
| `lush task merge ID [ID...]` | [合并](rpc/merge.md) |
| `lush task inspect` / `history` / `diff` / `transcript` / `usage` / `wait` | [审阅与过程读模型](rpc/inspect.md) |
| `lush task cleanup` / `clear` | [磁盘回收与清空](rpc/maintenance.md) |
| `lush notice list` / `post` / `answer` / `dismiss` | [待决问题](rpc/notices.md) |
| `lush status` / `lush daemon stop` | [Agent 环境与权限](agent-environment.md) |
| Web 读取路由与 `POST /api/action` | [Web 路由](web-routes.md) |
| HTTP 监听与安全约束 | [HTTP](http.md) |
