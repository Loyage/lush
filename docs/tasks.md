# MVP 开发任务

## TODO

MVP 范围内无未完成项。后续方向（本轮不实现）：Context compression/paging、外部工作工具、调度和权限。

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
- [x] `lush process call PID PROMPT --interactive`（简写 `-i`）/ RPC `process.call_begin` + `process.call_end`：daemon 照常打开调用（user message + busy + running/非 busy/非递归校验），把不带 `--print` 的交互式 argv 交给调用方终端跑同 session、同 cwd、同身份的 pi TUI，退出后报回 succeeded / failed 并释放 busy；调用方消失时由 `LUSH_CALL_TIMEOUT` 结算为 failed；`kill` / `stop` 只能标记 interrupted（daemon 无法向终端发信号），已结算的调用重报返回 `settled: false`；仅外部 agent 支持，内置运行时报错；`--interactive` 与 `--dry-run` / `--json` 互斥；同步 README、rpc 文档、Justfile（`just enter`）、pi 说明层；57 项测试通过
- [x] agent 归位到它所属的进程：删掉 `lush agent` 命令组，`agent session` 移到 `lush process session PID [--open]`（agent 由 PID 决定、随进程一起归档，不该单开一层）；`lush process tree --agents` 在每个进程下多打一行 agent 摘要（provider、busy/idle、session-id、回话文件数），RPC `process.tree { agents: true }` 在每行附上同构的 agent 字段（runtime `agentSummary` 不建 Context、不拼 argv，且 `process list` 不受影响）；新增 65 项测试通过
- [x] 运行期 agent 空间（不落库、不占 pid 空间）：`AgentRuntime` 用 `PID.N` 给每个工作者发号（N 按进程、按 daemon 运行单调递增），普通 call 的 pi 由 `invocation.on_spawn` 回传 OS pid、`call --interactive` 的由终端调新 RPC `process.call_os_pid` 上报（spawnSync 改 spawn，运行期就有 pid）；新增 `process.agents_list`（默认只看 running，`--all` 附本次 daemon 内存里保留的已结束条目，上限 32）、`process.agents_show`（运行期事实 + 磁盘 session + 持久 call 行）、`process.agents_kill`（只结束那次调用，记为 interrupted，逻辑进程保持 running，对 daemon 起的 pi 与终端里的 pi 都能 SIGKILL）；`process.tree` 的 `agent` 字段改为活跃度（provider / running 个数 / agents[]：id、call_id、interactive、os_pid、started_at、elapsed_ms），默认带上、`--no-agents`（含 `--json`）关掉，空闲进程不占行；session 与 agent 的语义彻底分开（磁盘 transcript 按 PID，运行期工作者按 `PID.N`）；同步 README、rpc/architecture 文档、Justfile（`just agents`、tree 默认带活跃度）、pi 说明层；69 项测试通过

- [x] 进程变量（variables）：模板新增第八个字段 `variables`，分 `immutable` / `mutable` 两个区间，每项只有 `description`（必填）与可选 `required` / `default`（required+default、跨区同名、mutable 区声明 `path`、未知分区/字段都报错）；创建时用 `process.spawn` 的 `variables` 参数 / `lush process spawn --vars`（`--args` 作为等价旧写法保留）提供，只接受模板声明的名字，缺失必填即创建失败（`template project requires variables.path`）；值按区间存进持久 state（immutable → `state.params`，mutable → `state.vars`），`inspect` / `tree` 以 `variables`（immutable / mutable 当前值 + `declarations` 声明）暴露，tree 文本把可变变量前缀标 `~`；新增 `process.update_vars`（CLI `lush process update-vars`、内置运行时工具 `process_update_vars`）只改 mutable 区，`update_state` 不能再写 `state.params` / `state.vars`；声明取自创建时快照，旧快照缺 `variables` 时随 `child_templates` 一起回填；`project` 用它声明必填 immutable `path`（spawn_prompt / system_prompt 写明「必须提供 path」「path 不可改、branch 可改」）与 mutable `branch`（默认 main）；同步 README、process-model / architecture / rpc 文档、Justfile（`--vars`、`just update-vars`）、demo 与共享说明层（guide）；72 项测试通过

- [x] 硬删除（delete / purge）：新增 RPC `process.delete` / `process.purge` 与 CLI `lush process delete|purge PID [--recursive]`，Justfile 同步 `just delete` / `just purge`；`delete` 只接受已结束（非 created/running）的进程，`purge` 先按 kill 规则停止/取消（中断进行中的调用）再删；两者都拒绝 PID 0（-32010），有子进程时默认拒绝、`--recursive` 在**同一个事务**里从叶子往上删整棵子树（`purge --recursive` 以 `adopt: false` 终止子树里每个活动节点，不写马上又要删掉的收养行）；Repository 新增唯一的行删除路径 `remove`（`messages` → `agent_calls` / `process_events` / `contexts` → `processes` 顺序，`_transition` 新增 `adopt` 覆盖），同一事务内删除并把 `child_deleted` 事件留在父进程，`original_parent_pid` 指向被删 pid 的幸存节点改挂 PID 0 并记 `parent_deleted`（NOT NULL 外键不允许行活过它指向的 pid）；内置运行时工具集刻意不含删除（新增断言），runtime 的已结束 agent 条目容忍进程已消失（`name: null`）；同步 README、process-model（新增「删除（delete / purge）」一节）/ architecture / rpc 文档、pi 说明层（CLI_HOWTO）与 CLI 三层 help；79 项测试通过（core 新增 4、rpc/CLI/runtime 各新增 1）

- [x] 新模板 `dev-task`（`project` 的子模板、task、非单例、`child_templates: []`）：开发某项功能的实现任务，刻意不声明任何变量（`variables: {}`，传了会被拒），spawn_prompt / system_prompt 说明工作信息向父进程取（从 LUSH_CONTEXT 的 parent.pid 出发，`lush process inspect <parent_pid>` 读 project 的 path / branch）并提醒默认 cwd 是 `$LUSH_HOME`、要先 `cd` 到仓库；一个任务自己实现、自测、干到底，不创建子进程；`project` 的 `child_templates` / system_prompt 纳入 dev-task（创建时在 goal 里说清要改什么）；同步 README 与 process-model（内置模板列表 + 「模板不声明变量」样板说明）；80 项测试通过

- [x] PID 0 的孤儿监督（orphan supervision）：新增 `src/core/orphans.js`（`ORPHAN_ADOPT_MODES` / `ORPHAN_TRIGGERS` / `DEFAULT_ORPHAN_POLICY`、`normalizeOrphanPolicy` 校验非法值报 -32602、`OrphanSupervisor`：只读的孤儿池读模型 `pool()` + 一轮监督 `supervise()`，自带重入保护与可被测试覆盖的 `clock`），孤儿 = `parent_pid = 0 AND pid > 0 AND original_parent_pid NOT IN (NULL, 0)`（PID 0 自己 spawn 的孩子不算）；四个环境变量在 daemon 启动时由 `Config.fromEnv()` 读入（非法值点名变量并拒绝启动，改配置需重启 daemon）：`LUSH_ORPHAN_ADOPT`（adopt | none | terminate，默认 adopt）、`LUSH_ORPHAN_LIMIT`（整数，默认 0 = 不限）、`LUSH_ORPHAN_TTL`（秒，默认 0 = 不启用，可小数）、`LUSH_ORPHAN_SWEEP`（整数秒，默认 30；=0 不起定时器），daemon 只在 `(limit > 0 || ttl > 0) && sweep > 0` 时起定时器（unref，关闭时先 clearInterval 再关数据库）；`repository.transition` 的 `adopt` / `terminate` 在同一事务里处理活动直接子节点（`terminate` 的子节点 `cause = parent_terminated`，`effects` 出参供事务外取消被终止子节点的 running 调用），新增 `repository.orphans()` 一条 SQL 只读返回孤儿行（含 `last_message_at` / `last_call_at` 子查询）；`ProcessManager` 新增 `orphanPolicy` / `orphanPolicyReport()` / `orphans()` / `superviseOrphans(trigger)` / `orphanEvict(pid, reason)`（冻结：Service → stopped、Task → cancelled），收养发生且 `limit > 0` 时事务后立即以 `trigger = adoption` 跑一轮（重入保护，一轮只跑一个）；监督顺序先 TTL（`idle_seconds >= ttl` 且非 busy）后上限（活动孤儿数 > limit 时从最旧开始），每冻结一个重查一次孤儿池（冻结父节点会把它的活动子节点收养成新孤儿，同一轮继续处理），排序为 `last_activity_at` 升序、其次 pid 升序；busy（该 PID 有 agent 调用在跑）永不冻结，只记入报告的 `deferred`；过渡事件 data 仍是 `{ from, to }`，只在有 cause 时多一个字段（`orphan_ttl` / `orphan_limit`）；RPC 新增 `process.orphans`（读模型：policy / active_count / busy_count / over_limit / orphans[]）与 `process.orphan_sweep`（报告：trigger / skipped / checked / active_before / active_after / evicted / deferred / limit / ttl_seconds），未知参数报 -32602，`system.status` 新增 `orphan_policy`（嵌套，文本不显示）与 `orphans_active`（标量，daemon status 文本可见）；CLI 新增 `lush process orphans [--sweep]`（文本分读模型表与 sweep 报告两形态，`--json` 原样输出）、Justfile 同步 `just orphans` / `just orphans sweep`；默认值下行为与历史完全一致（adopt + 不限 + 不超时，默认下 `--sweep` 什么都不冻结），PID 0 自己的 transition 永不收养/终止子节点（daemon 关闭路径），`purge --recursive` 仍 `adopt: false`（不收养不级联）；删父节点后幸存节点的 `original_parent_pid` 改挂 0，因此不再算孤儿且不被监督；同步 process-model.md（新增「PID 0 的孤儿监督」一节并改写「MVP 不实现…」那句话）/ architecture / rpc / README（四个环境变量 + 常用命令 + 「孤儿监督」小节）文档、guide.js（COMMON 与 CLI_HOWTO）、lush-root 的 system_prompt；100 项测试通过（core.test.js 新增 10 条监督用例、新增 test/config.test.js，rpc / CLI 补孤儿接口与 help 断言）

- [x] `dev-task` 的三个正式字段：简述标题 `name`、显示标题 `title`、任务详情 `detail`。三个字段都是 `dev-task` 自己声明的 immutable 变量（`state.params`），因此受 Core 校验、随 inspect / history / `--json` 输出、也能被渲染：`name` 是保留变量名（`process_spawn` 的 name / CLI `--name` 与它**是同一个值**，两边不一致直接拒绝），声明里带 `pattern ^[A-Za-z][A-Za-z0-9_-]*$` + `max_length 64`，用于命名相关 worktree / 分支；`title` 必填、单行、≤200，`list` 末尾的 TITLE 列与 `inspect` 的 title 行显示的就是它；`detail` 可选、可多行、≤20000，`inspect` 独立分节渲染（文本截断，`--json` 完整）。变量声明新增可选的格式约束 `pattern` / `max_length` / `single_line`（`src/template_loader.js` 的 `VARIABLE_FIELDS` + `checkVariables` 与 `src/core/variables.js` 的 `checkVariableDeclaration` / `checkVariableValue`）：声明在加载时校验（正则要能编译、`default` 必须满足自己的约束、`name` 只能在 immutable 区），值在创建与 `update_vars` 时校验，报错引述违反的约束与变量自己的 `description`；CLI 新增 `--title` / `--detail` 简写（与 `--vars` 同名冲突时报 usage 错误），Core 的 -32602 在 CLI 上统一为退出码 2（与 `guide.js` 早已写明的「退出码 2 表示用法错误」一致）；保留变量名（`path` / `name` / `title` / `detail`）写进 process-model.md 与 README；新增 6 项测试（core 3 + cli 3，含旧数据无 title/detail 不崩），共 106 项通过。

## 验收命令

```bash
bun test
bun run demo
```

验证环境为 macOS / Bun 1.4.2。OpenAI-compatible Provider 以本地 HTTP fixture 验证请求格式、Authorization、tool calls、tool results 和错误处理；pi 后端以本地假 pi 可执行文件 + 本地 HTTP fixture 验证命令行参数、会话目录、cwd、取消杀进程与错误处理，并用一个模拟 agent 的假 pi 跑通「通过 lush CLI 自建子进程」的端到端流程。未使用真实供应商 API key，也未宣称验证真实模型的推理能力。