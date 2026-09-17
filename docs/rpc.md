# RPC 与 CLI

## 传输

Unix Domain Socket：`$LUSH_HOME/lush.sock`。每行一个 UTF-8 JSON-RPC 2.0 对象，以 LF 分隔。最大帧 1 MiB；不支持 batch；支持无 id 的 notification（执行但不回复），CLI 始终使用 request。同一连接逐条处理，不同连接并发。响应 id 与请求一致。拒绝 NaN / Infinity。

```json
{"jsonrpc":"2.0","id":1,"method":"process.call","params":{"pid":2,"prompt":"当前目标是什么？"}}
{"jsonrpc":"2.0","id":1,"result":{"pid":2,"call_id":1,"output":"..."}}
```

错误：`{"jsonrpc":"2.0","id":1,"error":{"code":-32004,"message":"process not found: 99"}}`。

| code | 含义 |
|---|---|
| -32700 | JSON parse error |
| -32600 | invalid request / batch / frame |
| -32601 | method not found |
| -32602 | invalid params |
| -32603 | unexpected internal error（详情只写 daemon log） |
| -32004 | process/template not found |
| -32009 | lifecycle conflict / busy / call cycle |
| -32010 | template policy denied |
| -32020 | provider / invocation error |
| -32021 | invocation interrupted |

## 方法

所有 params 为具名 object，无未知字段。PID 为非负 integer（不接受 boolean）。

| RPC | params | result |
|---|---|---|
| system.status | {} | daemon_pid, root_pid, provider, process_count, active_calls, home, socket, code_dir, version, fingerprint, started_at, uptime_seconds |
| system.shutdown | {} | stopping |
| process.list | {} | metadata 数组 |
| process.tree | agents? | metadata 数组（客户端格式化树）；agents 默认 true，为每行附上运行期活跃度：provider、running（个数）、agents[]（id / call_id / interactive / os_pid / started_at / elapsed_ms）；agents=false 时与 process.list 同形 |
| process.agents_list | pid?, all? | 运行期 agent 数组（id、pid、name、provider、status、call_id、os_pid、interactive、cancellable、started_at、ended_at、elapsed_ms、error）；all=true 附上本次 daemon 内存里已结束的条目（上限 32） |
| process.agents_show | id | 单个 agent + 它服务的进程的 session + 对应的持久 call 行 |
| process.agents_kill | id | 结束该 agent 的这次调用（interrupted），返回该 agent 的视图与 killed 标记；逻辑进程状态不变 |
| process.call_os_pid | pid, call_id, os_pid | 终端上报 `call --interactive` 起在自己终端里的 pi 进程：recorded=true 表示已挂到该 agent 上 |
| process.inspect | pid | metadata、Context metadata、Agent 状态、近期调用 |
| process.parent | pid | parent metadata 或 null |
| process.children | pid | children metadata 数组 |
| process.view | pid, sections? | 只含被请求 section 的视图：parent、children、call_prompt |
| process.spawn | parent_pid, template, name?, goal?, args? | 新 Process metadata；args 存入 state.params，`args.path` 必须是已存在的绝对目录 |
| process.call | pid, prompt, dry_run? | pid, call_id, output；dry_run=true 时不调用 agent，返回将执行的命令预览 |
| process.call_begin | pid, prompt | 打开一次由调用方终端自己跑的调用：pid, call_id, agent, prompt, argv/command, cwd, env, path_prefix；写 user message 并标记 busy |
| process.call_end | pid, call_id, status, output?, error? | 结算 call_begin 打开的调用：pid, call_id, settled, status；status 只接受 succeeded / failed |
| process.session | pid | 该进程 agent 的 session：session_dir、session_id、files、file、argv/command（--open 用）、browse_command、cwd、env、busy；内置运行时全为 null。列表形式见 process.tree 的 agents |
| process.start/stop/kill/reclaim | pid | 更新后的 metadata |
| process.update_state | pid, patch | 更新后 state（顶层 merge） |
| process.complete | pid, result? | 更新后的 metadata |
| process.history | pid, after=0, limit=100 | 按 id 升序 messages、next_after |

inspect 的 Context 包含 system_prompt、state、artifacts、references、message_count；调用和事件各取最近 20 条，避免无界响应。完整消息使用 history 分页读取。元数据含 template 的完整创建时快照。

### 身份：daemon 跑的是哪份代码

`system.status` 里的 `home` / `socket` 描述状态在哪（`LUSH_HOME`），`code_dir` / `version` / `fingerprint` / `started_at` 描述**回答你的是哪份代码**：daemon 启动时把 `src/agent/guide.js`、`src/cli/main.js` 与 `templates/*.json` 读入内存（`src/identity.js` 的指纹覆盖这三处），之后不再重读。`code_dir` 不同 = 另一个 checkout；`fingerprint` 不同 = 同一 checkout 的旧进程。CLI 每次命令都会先读一次 status 并在不一致时于 stderr 告警（`cli.code_match` 是同一判断的布尔形式）。

process.view 是「查看」的统一读模型，把父子关系和 Call Prompt 合并到一次读取：

| section | 内容 |
|---|---|
| parent | 当前父节点完整 metadata；无父节点时为 null（例如 PID 0） |
| children | 直接子节点完整 metadata 数组 |
| prompt | call_prompt：该 Process 模板 system_prompt 的快照 |

sections 省略时返回全部三项；必须是非空、无重复、只含上述名称的字符串数组（否则 -32602）。返回字段顺序固定为 pid、parent、children、call_prompt，只包含被请求的 section。未知 PID 与其他方法一样返回 -32004。view 是只读操作，不改变状态、不创建调用记录。Agent 侧的等价能力仍是个体工具 process_self / process_parent / process_children。

旧版本写入、快照里没有 `child_templates` 的 Process，会在 daemon 启动时从同名已加载模板回填一次（见 process-model）。

## Agent Tools

Provider tool 名称采用 OpenAI-compatible 安全字符：`process_self`、`process_spawn` 等；Runtime 映射成以下 Core 操作。Mock `/tool process.spawn {...}` 也接受逻辑点号名称。这些工具只属于 Lush 内置运行时（`mock` / `openai`）；`LUSH_PROVIDER=pi` 时 pi 没有它们，改用 bash 运行 `lush` CLI（上方同名命令）。`dry_run` 只在 RPC / CLI 上暴露，Agent 工具暂未开放；`process.call_begin` / `process.call_end`（`call --interactive`）也一样：进入 TUI 是给人用的，Agent 自己发调用一律用普通 `call`。

| Tool | 参数 | 语义 |
|---|---|---|
| process.self | {} | inspect 当前 Process |
| process.parent | {} | 当前父节点 |
| process.children | {} | 当前直接子节点 |
| process.inspect | pid | inspect 指定节点 |
| process.spawn | template, name?, goal?, args? | 当前节点创建 child；singleton 模板在已有活动实例时拒绝，参数见 available_child_templates[].spawn_prompt |
| process.call | pid, prompt | 调用另一节点；禁止递归和 busy |
| process.update_state | patch | 修改自身持久 state |
| process.complete | result? | 完成自身 Task |

工具错误作为带 code/message 的 tool result 回给 Agent；Provider 可以修正。未知工具拒绝。内置运行时不允许 Agent 伪造当前 PID（工具参数里没有 pid）；pi 后端的安全边界更弱：它能读写磁盘、执行命令，并通过 bash 调用 `lush` CLI，因此 `LUSH_PID` 只是便利信息，不是权限凭据。complete 后本轮可返回最终文本，但后续副作用工具被拒绝。

## CLI

命令分三层：顶层 → 命令组 → 命令 → 参数。每一层都提供 help（`help` 子命令、`-h`、`--help`），帮助文本与下面的命令表来自同一张声明（`src/cli/main.js` 的 `COMMANDS`），不会与解析器脱节；`--json help [command]` 返回结构化的命令树。

```text
lush help [command [subcommand]]        # 顶层与任意一层的覆盖范围、子命令、参数

lush daemon start|stop|status
lush process list|tree|inspect|spawn|call|attach|history|start|stop|kill|reclaim|complete|update-state|session|agents

lush process inspect PID [--with parent,children,prompt]
lush process spawn PARENT TEMPLATE [--name NAME] [--goal GOAL] [--args JSON]
lush process call PID PROMPT [--dry-run]
lush process call PID PROMPT --interactive   # 在本终端用 pi TUI 跑这次调用（简写 -i）
lush process attach PID
lush process history PID [--after ID] [--limit N]
lush process start|stop|kill|reclaim PID
lush process complete PID [--result JSON]
lush process update-state PID --patch JSON
lush process tree [--no-agents]
lush process agents list [--pid PID] [--all]
lush process agents show AGENT_ID
lush process agents kill AGENT_ID
lush process session PID [--open]
```

`--args` / `--patch` / `--result` 接收 JSON 字面量，JSON 非法时报 usage 错误（退出码 2）。`complete` 只能用于 Task；`update-state` 顶层 shallow-merge 到该 Process 的 state（CLI 命令名带连字符，RPC 方法仍是 `process.update_state`）。

`call --dry-run`（RPC `dry_run: true`，必须是 boolean）不调用 agent：不写 agent_calls / messages，不标记 busy，只把本来要执行的调用描述出来。外部后端（pi）返回 `executable` / `argv` / `command`（可直接粘贴的 shell 行）/ `cwd` / `env` / `path_prefix`；内置运行时没有外部命令，返回 `command: null` 和 `messages`（本来会发给模型的条数）。文本输出就是那行可执行命令（含 `cd <cwd>` 与 `LUSH_HOME` / `LUSH_PID` / `PATH`）；`--json` 返回结构化字段。进程仍需是 running。

`call --interactive`（CLI 简写 `-i`；不能和 `--dry-run`、`--json` 同时用）把这次调用交给调用方的终端，由两个 RPC 组成：`process.call_begin` 走与 `call` 相同的校验（running、非 busy、非递归），写 user message、标记 busy，并返回**不带 `--print`** 的交互式 argv——同一个 pi session、同一个 cwd、同一套身份提示词，PROMPT 作为 TUI 的首条消息；CLI 用 `stdio: inherit` 前台运行它（spawn 而非 spawnSync，好让运行期就知道 OS pid），起手用 `process.call_os_pid` 把该 pi 的 OS pid 报给 daemon（于是 `process agents show/kill` 能指到它），退出后调 `process.call_end` 报回 succeeded / failed 并释放 busy。回包的 `settled: false` 表示 daemon 已经先结算了（timeout、kill / stop、daemon 退出），此时终端里的 pi 与调用记录无关。只有外部 agent（pi）能这样交接：内置运行时的 agent 在 Lush 进程内，没有可进入的终端，`--interactive` 报错。`process agents kill` 能杀掉这个 pi（daemon 按上报的 OS pid SIGKILL）；`process kill` / `process stop` 只把这次调用标成 interrupted，真正关掉 pi 的是你的终端或上面的 agents kill；调用方被 SIGKILL 时，daemon 在 `LUSH_CALL_TIMEOUT` 后记为 failed 并释放 busy。文本层面这次调用只留下 user message（回复在 pi 会话里），因此 `--interactive` 后紧接着的 `call` 会接着同一个 pi session 继续。

`process session`（RPC `process.session`；命令从 `lush agent session` 移到这里，因为 agent 属于它所在的进程）是只读查询，任何状态都可查（含终态 Task 与 reclaimed）：给出该进程外部 agent 的 session-dir、session-id、磁盘上的 session 文件（`<timestamp>_lush-<PID>.jsonl`，没有则为 null）、cwd 与 busy。`argv` / `command` 是带着 Lush 身份（模板 system_prompt + 说明层 + `LUSH_CONTEXT`）的交互式命令（无 `--print`），`--open` 就是直接用它把终端交给 pi；`browse_command` 是不带身份的短命令（只有 `--session-dir` / `--session-id`，用 pi 默认提示词浏览）。内置运行时 `session_dir` 等字段为 null，文本输出提示 `runs in-process`；`--open` 会报错，且 `--open` 不能与 `--json` 同时用（CLI 报 usage 错误）。

agent 有两个互不相同的视图，都不落库也不共用 pid 空间：

- **运行期 agent**（`process.agents_list` / `_show` / `_kill`，CLI `lush process agents …`）：id 形如 `PID.N`（N 在本次 daemon 内按进程单调递增），字段有 `pid`、`name`、`provider`、`status`（只有 `running` 是活的）、`call_id`、`os_pid`（daemon 起的 pi 由 `invocation.on_spawn` 报回，`--interactive` 的由终端调 `process.call_os_pid` 上报）、`interactive`、`cancellable`（interactive 且尚未上报 os_pid 时为 false）、`started_at`/`ended_at`/`elapsed_ms`、`error`。`agents_list` 默认只返回活着的；`all: true` 再附上本次 daemon 内存里保留的已结束条目（上限 32，daemon 退出即清空）。`agents_kill` 只结束这一次调用（记为 interrupted），改变逻辑进程状态仍然是 `process.kill`。
- **`process.tree` 的 `agent` 字段**（默认带；`agents: false` 去掉，CLI `--no-agents`）：只回答「此刻谁在干活」——`provider`、`running`（个数）、`agents[]`（每个的 id / call_id / interactive / os_pid / started_at / elapsed_ms）。由 `AgentRuntime.agentSummary` 生成，不建 Context、不拼 argv、不读磁盘与历史，因此 N 个进程只付 N 次内存查询；没有 agent 在跑的进程返回 `running: 0`。
- **磁盘上的 transcript** 仍然是 `process.session`（session_dir / session_id / files / file / argv / browse_command / cwd / busy）：按 PID 命名，多轮 call 追加同一个文件，进程归档后照样可查。

`process.call_os_pid` 是 `call --interactive` 专用的补充：终端在 spawn 出 pi 之后立刻上报 `{ pid, call_id, os_pid }`，daemon 才知道那个跑在别人终端里的进程叫什么、怎么杀；调用已经结算时返回 `recorded: false` 而不是报错。`process agents_*` 与 `call_os_pid` 都只在 RPC / CLI 上暴露，Agent 工具里没有（agent 不该杀自己）。

`--json` 为全局标志，可放在命令之前或命令末尾（`lush --json process list` / `lush process list --json`），输出机器可读 result。其他情况下 list/tree 显示表/树，call 显示文本，inspect/history 显示 JSON。spawn 打印 PID。错误写 stderr 并返回非零；缺参数或未知命令/选项报 usage 错误（退出码 2）并提示 `lush help`。

`inspect` 不带 `--with` 时保持完整 inspect 输出；带 `--with` 时改调 process.view，只返回所选 section（逗号分隔，可多次使用，重复的 section 在客户端去重；RPC 层仍拒绝重复）。未知 section 在 CLI 报 usage 错误（退出码 2），在 RPC 报 -32602。

attach 是持续 RPC 对话，不是独占接管锁，也不是历史终态的只读模型对话。进入前验证 running；`/exit`、`/quit`、EOF 退出。不改变 Process 状态。Ctrl-C 退出客户端，不保证取消 daemon 中的调用；需要 `lush process stop|kill` 明确中断。

daemon start 后台用 `process.execPath` 启动 `src/daemon/main.js`（detached，日志 `$LUSH_HOME/daemon.log`）并等待 RPC ready。已启动时幂等。daemon stop 发 system.shutdown 并等待锁释放。根进程不能用 `lush process stop 0` 停止。启动参数来自环境：LUSH_HOME、LUSH_PROVIDER=pi|mock|openai（默认 pi）、LUSH_PI_COMMAND、LUSH_PI_PROVIDER、LUSH_PI_MODEL、LUSH_API_KEY、LUSH_BASE_URL、LUSH_MODEL、LUSH_CALL_TIMEOUT（默认 900 秒）、LUSH_MAX_ROUNDS（默认 12，仅内置运行时）。客户端超时为调用超时 + 10 秒，可用 LUSH_RPC_TIMEOUT 覆盖。

实现细节：Bun socket 单次 `write()` 只能接受有限字节，RPC 两端都用 `socket_io.js` 的写队列处理部分写与 drain；`system.shutdown` 的回复在拆连接之前写出，然后才唤醒 daemon 拆除流程。
