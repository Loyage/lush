# CLI 与 RPC

完整 CLI 帮助：`bun run help`。全局参数 `--project PATH`、`--json` 可放在命令前后。

`daemon start/restart` 是客户端工作流，不是 RPC。`doctor` 默认提供简短身份摘要，`--verbose` 才附带完整 daemon 状态（含 Agent 配置）。它检查本地项目配置，并把当前磁盘代码、该项目 daemon、以及该项目状态目录记录的后台 Web 三份身份分别列在 `identities.current/daemon/host`；保留旧的顶层 `fingerprint` / `code_match` 字段供脚本兼容。发现代码不一致时只返回 `update_hints` 并在 stderr 给出带正确 `--project` 的命令，绝不自动重启。项目 `doctor` 不猜测无项目启动器的 Web；诊断全局启动器请运行 `bun run lush host status`。

`bun run lush host start [PORT]` 后台启动 Host：无 `--project` 时进入全局项目工作台；带 `--project` / `LUSH_PROJECT` 时保持单项目绑定模式（日志 `.lush/host.log`，不替用户启动 daemon）。首次全局启动可要求绝对目录，之后使用已登记项目；命令等 Web 真的占住端口就返回，同端口已运行时幂等报告，不换进程。两种模式默认都只监听本机；单项目存在 `.lush/web.json` 时改为公网监听并启用登录认证，全局模式读取用户配置目录的 `web.json`，且要求其中的 `projects` 非空绝对路径白名单。`bun run lush host restart [PORT]` 先停旧 Host 再按当前代码启动；改完 `src/ui/web/` 后使用。`bun run lush host stop [PORT]` 停止后台 Host，`bun run lush host status [PORT]` 通过 `current_code` / `host_code`（以及同义的 `identities.current/host`）分别报告磁盘与进程的目录、版本和指纹；不一致时 `update_hint.command` 精确包含端口及项目作用域。停止操作只会停止确认属于 Lush 的 Web 进程；端口由其他程序占用时会报告命令行，不会触碰它。调试前台运行使用 `bun run lush host start --foreground`。

本页是索引：CLI 与 RPC 表格、返回值和错误信息都在下面各章里。若要先理解从输入到交付的实际操作顺序，请读[当前指令流程](../task-flow.md)。

公开实体入口统一为 `lush worker` / RPC `worker.*`，旧 Task 命令与方法不保留别名；`notice --worker` / `config worker-call-limit` 与保留的内部字段之间的映射见[更名边界](../engineering/core-api.md#worker-更名与兼容边界)。

## 用户编号与 CLI 身份

新原始输入沿用项目次序显示为 `O5`，其直接指令 Worker 为 `W5`；Agent 派生的后代按父级次序显示为 `W5-1`、`W5-1-1`。新指令即使提交到已有 Worker 分支，仍用自身输入编号。失败或删除可能留下空号，编号不复用。历史 Worker 不改编号；未编号的历史父 Worker 新派生后代继续使用旧整数编号。

CLI 的 Worker 身份参数支持原整数或严格的新编号：

```bash
bun run lush worker inspect W5-1
bun run lush worker message W5-1 '补充说明'
bun run lush worker spawn '目标' --parent W5 --name child
bun run lush notice post '问题' --worker W5-1 --body '背景'
```

CLI 通过只读 `worker.lookup {number}` 找到真实整数 ID 后，再调用原 Worker 操作；`W5` 不意味着内部 `id=5`。RPC/HTTP 的既有 `id`、引用目标、链接、环境变量和磁盘路径仍使用整数。`--json` 保留整数 `id` 和可空 `worker_number`；分页游标与 Notice ID 仍为整数，不接受 W 编号。

## 速查表

| 命令 | 章节 |
|---|---|
| `lush order`（指令；旧 say 无别名） | [一条指令输入如何交付](../task-flow.md) |
| `lush worker list` / `tree` / `inspect` / `spawn` / `message` / `cancel` / `retry` / `integrate` / `reserve` / `unreserve` / `resolve` / `resolve-divergence` / `resolve-child-divergence` / `approve-merge` / `cleanup` | [Worker、Run 与 Artifact](rpc/tasks.md) |
| `lush worker inspect` / `history` / `transcript` / `wait`（`worker.diff` / `worker.usage` 仅 RPC） | [审阅与过程读模型](rpc/inspect.md) |
| `lush worker cleanup [--keep-branch]` / `worker delete ID [--confirm --revision REV]` | [磁盘回收与彻底删除](rpc/maintenance.md) |
| `lush branch tree` / `show` / `bind` / `archive` | [分支谱系](rpc/branches.md) |
| `lush notice list` / `post` / `answer` / `dismiss` | [待决问题](rpc/notices.md) |
| `lush status` / `lush config show` / `lush config set|reset` / `lush agent show|prompt|env|init|set|reset` / `lush daemon stop` | [Agent 环境与权限](agent-environment.md) |
| `lush agent network show` / `set --file PATH` / `reset` | [项目出站网络代理](../engineering/outbound-network.md) |
| Web 读取路由与 `POST /api/action` | [Web 路由](web-routes.md) |
| HTTP 监听与安全约束 | [HTTP](http.md) |

已下线的方法与命令不再有公开入口：Intent / Plan / Candidate、草稿、快速路由、效果展示、介绍、托管模式、`task.analyze`、`task.verify`、`task.delete` / `task.clear`、`task.merge` / `task.merge_many` / `task.ladder`、`branch.import` / `branch.merge` / `branch.sync` / `branch.catchup` / `branch.summary` 与合并编排。旧记录、会话与工作区不迁移、不自动删除；仅用户明确确认 `worker.delete` 时清除所选子树的专属资源与历史。完整边界见[核心 API 收敛](../engineering/core-api.md)。
