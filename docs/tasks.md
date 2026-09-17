# MVP 开发任务

## TODO

MVP 范围内无未完成项。后续方向（本轮不实现）：PID 0 的孤儿监督策略、Context compression/paging、外部工作工具、调度和权限。

## Doing

无。

## Done

- [x] 理解定位并确认生命周期歧义
- [x] 确认终态父节点的活动直接子节点交 PID 0；保留原父关系和事件
- [x] 确认 Task 显式完成、中断 invocation 不自动重放
- [x] 编写 README、architecture、process-model、rpc 和任务文档
- [x] 用 Bun 取代 Nix / Python：`package.json` + `bunfig.toml`，零第三方依赖，`bun:sqlite` 取代 `sqlite3`
- [x] 最小包骨架、入口（`bin/lush`、`bin/lushd`）、`bun test` 测试环境
- [x] SQLite schema / Repository / 重启恢复
- [x] ProcessManager、生命周期、Template、孤儿收养
- [x] persistence / Process / 收养 / 重开数据库 smoke test
- [x] JSON-RPC server / client；真实 Unix Socket smoke test
- [x] CLI、daemon 锁与启停、交互 attach
- [x] ContextBuilder、Mock / OpenAI-compatible Provider、Agent Runtime
- [x] 内部 Agent Tools 与自主 spawn，不借助 shell
- [x] 35 项测试通过：生命周期、持久化、Context、工具、并发、busy/递归保护、RPC、CLI/attach
- [x] 实际 SIGKILL + 重启验证：调用标记 interrupted，已提交的 spawn 不重放
- [x] 本地 HTTP fixture 验证真实 OpenAI-style 多轮工具请求，不使用真实 API key
- [x] 完整 examples/mvp_demo.js 演示通过，含恢复、孤儿收养和 reclaim 保留历史
- [x] Bun socket 写入是有界的：抽出 `socket_io.js` 处理部分写 + drain，RPC 两端可传 1 MiB 帧
- [x] 用 `AbortController` / `AsyncLocalStorage` 取代 asyncio task / shield / ContextVar
- [x] SIGKILL 遗留锁由 PID 存活检测回收；shutdown 回复先落盘再拆 socket
- [x] 本机 loopback base URL 自动补 `NO_PROXY`，避免代理劫持本地模型
- [x] README、协议、生命周期与已知限制最终核对
- [x] 统一查看入口：`process.view` / `lush inspect PID --with parent,children,prompt`（父节点、子节点、Call Prompt）
- [x] 模板字段改为七项契约：name、type（task/service）、singleton（同一父进程下只允许一个活动实例）、description、spawn_prompt（如何创建、需要哪些参数，注入创建方的 `available_child_templates`）、system_prompt、child_templates；移除 agent_command / initial_context 与 view 的 command section，旧快照只回填 child_templates；示例模板与 39 项测试、demo 全部恢复通过
- [x] 默认 call agent 改为 `pi`：每次 call 起 `pi --print` 子进程 + 每 PID 一个 pi session（`$LUSH_HOME/pi-sessions`），`--system-prompt` 用模板 system_prompt 替换 pi 默认提示词，再追加共享 Lush 说明层与 `LUSH_CONTEXT`；取消/超时/daemon 退出会 SIGKILL 子进程，`LUSH_CALL_TIMEOUT` 默认 900 秒
- [x] 共享 Lush 说明层 `src/agent/guide.js`（tools / cli 两个版本，所有 agent 后端都会带上），内置 provider 保留 `process_*` 工具，pi 改用 `lush` CLI
- [x] spawn args：`process.spawn` / `lush spawn --args` / Justfile 新增 `--args`，原样存入 `state.params`；`args.path` 必须是已存在绝对目录，并作为该进程 agent 的 cwd
- [x] 新模板 `project`（`project-manager` 子模板、非单例、必须提供 `args.path`，spawn_prompt 说明）；CLI 新增 `complete` / `update-state`
- [x] `call --dry-run` / `dry_run: true`：不调用 agent、不写 agent_calls/messages、不标记 busy，只返回本来要执行的调用；pi 后端返回可直接执行的命令行（`executable` / `argv` / `command` / `cwd` / `env` / `path_prefix`），内置运行时返回 `command: null` + messages 条数；49 项测试通过
- [x] `lush session PID [--open]` / RPC `process.session`：只读列出外部 agent 的 session-dir / session-id / 实际文件 / cwd / busy（任何状态可查），`--open` 用带 Lush 身份的交互式 argv 进入 pi TUI；51 项测试通过
- [x] CLI 命令分层重组为 `lush <group> <command>`（`daemon` / `process` / `agent`），并新增逐层 help：顶层、命令组、命令都支持 `help`、`-h`、`--help`，说明本层覆盖范围、子命令与参数；`--json help [command]` 输出结构化命令树（summary/cover/usage/positionals/options/subcommands）；帮助与解析共用同一张 `COMMANDS` 声明，`--json` 可放命令前或末尾；同步 README、rpc/process-model/architecture 文档、Justfile、demo、pi 说明层与模板；52 项测试通过

## 验收命令

```bash
bun test
bun run demo
```

验证环境为 macOS / Bun 1.4.2。OpenAI-compatible Provider 以本地 HTTP fixture 验证请求格式、Authorization、tool calls、tool results 和错误处理；pi 后端以本地假 pi 可执行文件 + 本地 HTTP fixture 验证命令行参数、会话目录、cwd、取消杀进程与错误处理，并用一个模拟 agent 的假 pi 跑通「通过 lush CLI 自建子进程」的端到端流程。未使用真实供应商 API key，也未宣称验证真实模型的推理能力。
