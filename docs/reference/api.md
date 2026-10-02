# CLI 与 RPC

完整 CLI 帮助：`bun run help`。全局参数 `--project PATH`、`--json` 可放在命令前后。

`daemon start/restart` 是客户端工作流，不是 RPC。`doctor` 默认提供简短身份摘要，`--verbose` 才附带完整 daemon 状态（含 Agent 配置）。它检查本地项目配置，并把当前磁盘代码、该项目 daemon、以及该项目状态目录记录的后台 Web 三份身份分别列在 `identities.current/daemon/host`；保留旧的顶层 `fingerprint` / `code_match` 字段供脚本兼容。发现代码不一致时只返回 `update_hints` 并在 stderr 给出带正确 `--project` 的命令，绝不自动重启。项目 `doctor` 不猜测无项目启动器的 Web；诊断全局启动器请运行无 `--project` 的 `host-status`。

无 `--project` 的 `host [port]` 后台启动全局项目选择器：首次要求绝对目录，之后从用户配置目录恢复上次项目，并自动启动或连接所选项目 daemon；带 `--project` / `LUSH_PROJECT` 时保持单项目绑定模式（日志 `.lush/host.log`，不替用户启动 daemon）。命令等 Web 真的占住端口就返回；同一端口已经有 Lush Web 时幂等报告「已在运行」，不换进程。两种模式默认都只监听本机；单项目存在 `.lush/web.json` 时改为公网监听并启用登录认证，全局模式则读取用户配置目录的 `web.json`，且要求其中的 `projects` 非空绝对路径白名单。Electron 临时 host 不使用全局公网配置。`host-restart [port]` 先停掉端口上那个后台 Web 再按当前代码起一个新的：Web 不跟着代码换版本，改完 `src/ui/web/` 之后用它。`host-stop [port]` 停掉后台 Web，`host-status [port]` 通过 `current_code` / `host_code`（以及同义的 `identities.current/host`）分别报告磁盘与进程的目录、版本和指纹；不一致时 `update_hint.command` 精确包含端口及项目作用域，但命令本身不会执行。停只能停命令行确实是 Lush Web 的进程，别的程序占着端口时报出它的命令行交还给你。`host --foreground`（即 `bin/lush-host`）占住终端，只在调试时用。

本页是索引：CLI 与 RPC 表格、返回值和错误信息都在下面各章里。若要先理解从输入到交付的实际操作顺序，请读[当前 say 流程](../task-flow.md)。

公开实体入口统一为 `lush worker` / RPC `worker.*`，旧 Task 命令与方法不保留别名；`notice --worker` / `config worker-call-limit` 与保留的内部字段之间的映射见[更名边界](../engineering/core-api.md#worker-更名与兼容边界)。

## 速查表

| 命令 | 章节 |
|---|---|
| `lush say` | [一条 say 输入如何交付](../task-flow.md) |
| `lush worker list` / `tree` / `inspect` / `spawn` / `message` / `cancel` / `retry` / `integrate` / `reserve` / `unreserve` / `resolve` / `resolve-divergence` / `resolve-child-divergence` / `approve-merge` / `cleanup` | [Worker、Run 与 Artifact](rpc/tasks.md) |
| `lush worker inspect` / `history` / `transcript` / `wait`（`worker.diff` / `worker.usage` 仅 RPC） | [审阅与过程读模型](rpc/inspect.md) |
| `lush worker cleanup [--keep-branch]` | [磁盘回收](rpc/maintenance.md) |
| `lush branch tree` / `show` / `bind` / `archive` | [分支谱系](rpc/branches.md) |
| `lush notice list` / `post` / `answer` / `dismiss` | [待决问题](rpc/notices.md) |
| `lush status` / `lush config show` / `lush config set|reset` / `lush agent show|prompt|env|init|set|reset` / `lush daemon stop` | [Agent 环境与权限](agent-environment.md) |
| Web 读取路由与 `POST /api/action` | [Web 路由](web-routes.md) |
| HTTP 监听与安全约束 | [HTTP](http.md) |

已下线的方法与命令不再有公开入口：Intent / Plan / Candidate、草稿、快速路由、效果展示、介绍、托管模式、`task.analyze`、`task.verify`、`task.delete` / `task.clear`、`task.merge` / `task.merge_many` / `task.ladder`、`branch.import` / `branch.merge` / `branch.sync` / `branch.catchup` / `branch.summary` 与合并编排。旧记录、会话与工作区不迁移、不删除；完整边界见[核心 API 收敛](../engineering/core-api.md)。
