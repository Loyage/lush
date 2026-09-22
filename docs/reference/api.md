# CLI 与 RPC

完整 CLI 帮助：`bun run help`。全局参数 `--project PATH`、`--json` 可放在命令前后。

`daemon start/restart` 是客户端工作流，不是 RPC。`doctor` 检查本地项目配置，并把当前磁盘代码、该项目 daemon、以及该项目状态目录记录的后台 Web 三份身份分别列在 `identities.current/daemon/web`；保留旧的顶层 `fingerprint` / `code_match` 字段供脚本兼容。发现代码不一致时只返回 `update_hints` 并在 stderr 给出带正确 `--project` 的命令，绝不自动重启。项目 `doctor` 不猜测无项目启动器的 Web；诊断全局启动器请运行无 `--project` 的 `web-status`。

无 `--project` 的 `web [port]` 后台启动全局项目选择器：首次要求绝对目录，之后从用户配置目录恢复上次项目，并自动启动或连接所选项目 daemon；带 `--project` / `LUSH_PROJECT` 时保持单项目绑定模式（日志 `.lush/web.log`，不替用户启动 daemon）。命令等 Web 真的占住端口就返回；同一端口已经有 Lush Web 时幂等报告「已在运行」，不换进程。两种模式默认都只监听本机；单项目存在 `.lush/web.json` 时改为公网监听并启用登录认证，全局模式则读取用户配置目录的 `web.json`，且要求其中的 `projects` 非空绝对路径白名单。Electron 临时 host 不使用全局公网配置。`web-restart [port]` 先停掉端口上那个后台 Web 再按当前代码起一个新的：Web 不跟着代码换版本，改完 `src/ui/web/` 之后用它。`web-stop [port]` 停掉后台 Web，`web-status [port]` 通过 `current_code` / `web_code`（以及同义的 `identities.current/web`）分别报告磁盘与进程的目录、版本和指纹；不一致时 `update_hint.command` 精确包含端口及项目作用域，但命令本身不会执行。停只能停命令行确实是 Lush Web 的进程，别的程序占着端口时报出它的命令行交还给你。`web --foreground`（即 `bin/lush-web`）占住终端，只在调试时用。

本页是索引：CLI 与 RPC 表格、返回值和错误信息都在下面各章里。若要先理解从输入到交付的实际操作顺序，请读[行动任务处理流程](../task-flow.md)。

## 速查表

| 命令 | 章节 |
|---|---|
| `lush say` / `lush intent` / `lush intent list` / `lush plan *` / `lush draft *` / `lush input *` | [输入、规划与缓存](rpc/inputs.md) |
| `lush task list` / `tree` / `spawn` / `message` / `cancel` / `retry` | [任务、Run 与 Artifact](rpc/tasks.md) |
| `lush candidate list` / `prepare` / `inspect` / `verify` / `accept` / `changes` / `reject` | [Review Candidate](rpc/candidates.md) |
| `lush task merge ID [ID...]` | [合并](rpc/merge.md) |
| `lush task inspect` / `history` / `diff` / `transcript` / `usage` / `wait` | [审阅与过程读模型](rpc/inspect.md) |
| `lush task cleanup` / `delete` / `clear` | [磁盘回收与清空](rpc/maintenance.md) |
| `lush branch tree` / `show` / `import` / `archive` | [分支谱系](rpc/branches.md) |
| `lush notice list` / `post` / `answer` / `dismiss` | [待决问题](rpc/notices.md) |
| `lush status` / `lush config show` / `lush config set|reset` / `lush agent show|prompt|env|init|set|reset` / `lush daemon stop` | [Agent 环境与权限](agent-environment.md) |
| Web 读取路由与 `POST /api/action` | [Web 路由](web-routes.md) |
| HTTP 监听与安全约束 | [HTTP](http.md) |
