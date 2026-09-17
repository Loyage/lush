# Lush

**Operating System for AI — AI 的操作系统，而不是 AI Operating System。**

Lush 把 AI 工作组织成持久化的逻辑 Process。每个 Process 有自己的 Agent、Context、状态、生命周期和父子关系。PID 0 代表 Lush 自身。它不是 Unix 进程管理器，也不是模型供应商的 CLI 包装器。

## MVP 范围

Bun 1.2+ / JavaScript (ESM) / `bun:sqlite` / Unix Domain Socket / JSON-RPC 2.0；**没有任何第三方依赖**，不用 Nix、不用 Python、不需要 `bun install`。支持 macOS 和 Linux。CLI 和 Agent Tools 调用同一套 Core API。

```bash
# 仓库开发模式，无需安装：CLI 与 daemon 都用 bun 直接运行
export PATH="$PWD/bin:$PATH"
export LUSH_HOME="${TMPDIR:-/tmp}/lush-demo-$USER"
export LUSH_PROVIDER=mock   # 确定性演示；真实 agent 用 pi（默认值）
lush help                   # 每一层都有 help：lush help process / lush process spawn -h
lush daemon start
lush daemon status
lush process tree
lush process spawn 0 generic-service --name project-manager
lush process spawn 1 generic-task --name implement-login --goal '实现登录功能'
lush process call 2 '请介绍一下你当前的身份和任务'
lush process attach 2
# 输入 /exit 或 Ctrl-D 退出；不会停止 Process
lush process call 1 '创建一个子任务，研究 OAuth 登录实现方式'
lush process tree
lush process inspect 2
lush process inspect 2 --with parent,children,prompt  # 一次查看父/子/Call Prompt
lush process complete 2 --result '"done"'   # 只有 Task 能自己完成
lush process update-state 2 --patch '{"progress":"half"}'
lush daemon stop
lush daemon start
lush process tree  # 树、Context、对话和调用历史仍在
lush daemon stop
```

命令分两层组：命令组（`daemon` / `process`）→ 命令 → 参数。`--json` 可写在命令之前或末尾。agent 不是独立的命令层：它属于某个 Process，随进程查询。

也可通过 `bun run bin/lush`（或 `bun run bin/lushd` 前台运行 daemon）调用；`bun link` 之后 `lush` / `lushd` 会进入 PATH。

## 常用命令（Justfile）

```bash
just                 # 列出全部命令
just help            # 列出 lush CLI 的命令树（等价于 lush help）
just doctor          # 工具链 / 数据目录 / daemon 状态
just test            # bun test（just test openai 可按文件名过滤）
just demo            # 完整 CLI / daemon 演示
just verify          # test + demo

just daemon-start    # 起 daemon（幂等）
just bootstrap       # 起 daemon 并创建 project-manager → implement-login
just tree | just ps | just status
just spawn 0 generic-task implement-login '实现登录功能'
just spawn 0 project my-repo '' '{"path":"/abs/repo"}'   # project 必须给绝对路径
just call 2 '请介绍一下你自己'
just call 2 'hi' dry   # 只打印将执行的命令（pi 命令行），不真的调用 agent
just session 2        # 查看该进程的 pi session（dir/id/file）
just session 2 open   # 直接进 pi TUI 接续该会话
just complete 2 '"done"' | just update-state 2 '{"progress":"half"}'
just attach 2
just inspect 2       # 统一查看：just inspect 2 parent,children,prompt
just history 2 0 50
just stop 1 | just kill 2 | just reclaim 2
just daemon-stop     # 或 just daemon-restart（保留进程树与历史）
just prune           # 列出并清理残留 daemon（home 已消失的孤儿）；just prune all 连临时 home 一起清
just log             # tail $LUSH_HOME/daemon.log
just clean           # 停 daemon 并删除仓库内的 .lush
```

`just` 默认把开发数据放在仓库内的 `.lush/`（已 gitignore），不碰你日常的 `~/.local/state/lush`；用 `LUSH_HOME` 可覆盖（此时 `just clean` 只提示、不删除仓库外的目录）。

**改代码或提示词之后，先确认你重启的是哪个 daemon。** daemon 是常驻进程：`src/agent/guide.js`、`src/cli/main.js` 与 `templates/*.json` 都在它启动时读入内存，所以 `just daemon-restart` 只重启 `LUSH_HOME`（默认仓库 `.lush/`）那一份。若你另外在 shell 里直接跑 `lush`（没有 `export LUSH_HOME`，走默认 `~/.local/state/lush`），命令打到的是另一个 daemon，重启那份不会有任何效果。`lush daemon status` / `just doctor` 会列出 daemon 自己的 `home`、`code_dir`、`fingerprint`、`started_at` 与 CLI 侧对应字段（`cli.code_match` 表示两边是否同一份代码）；不一致时，任何 `lush` 命令都会在 stderr 上告警并给出该重启哪一份。

## Agent：默认 pi

`call` 默认交给 **`pi`** 执行（`LUSH_PROVIDER=pi`）：每次 call 起一个 `pi --print` 子进程，**每个 PID 一个 pi session**（`$LUSH_HOME/pi-sessions/`，`--session-id lush-<PID>`），多轮上下文由 pi 自己持久化。Lush 给 pi 的输入是三层提示词：

1. 模板的 `system_prompt`（用 `--system-prompt` **替换** pi 默认的 coding 提示词）；
2. 共享的 Lush 说明层（`src/agent/guide.js`）：介绍 Lush 是什么、如何用 `lush` CLI 操作进程，所有 agent 后端都会带上；
3. 运行时数据 `LUSH_CONTEXT`（自身 metadata、父/子摘要、state、可创建模板及其 `spawn_prompt`）。

pi 用自带的 read / bash / edit / write 工具干活，并**通过 bash 调用 `lush` CLI** 来 spawn / call / complete 其他进程；`LUSH_HOME`、`LUSH_PID` 会传给它，仓库 `bin/` 会被加进 PATH。若进程创建时给了 `args.path`（例如 `project` 模板），pi 的 cwd 就是该目录，否则是 `$LUSH_HOME`。

```bash
export LUSH_PROVIDER=pi            # 默认
# export LUSH_PI_COMMAND=pi        # pi 可执行文件（默认在 PATH 找 pi）
# export LUSH_PI_PROVIDER=openai   # 透传给 pi --provider
# export LUSH_PI_MODEL=gpt-5       # 透传给 pi --model
export LUSH_CALL_TIMEOUT=900       # pi 真实干活很慢，默认 15 分钟
lush process spawn 0 project my-repo --name my-repo --args '{"path":"/abs/repo"}'
lush process call 1 '看看这个仓库，列出待办并开工'
```

取消（`kill` / `stop` / 超时 / daemon 退出）会杀掉对应的 pi 子进程；pi 的 session 文件保留在 `$LUSH_HOME/pi-sessions/` 供审计，Lush 自身只记录 prompt 与最终文本。

### agent 与 session 是两回事

**agent = 此刻在替某个进程干活的工作者**（运行期）；**session = pi 在磁盘上的持久 transcript**（按 PID）。前者会消失，后者会留下。

```bash
lush process tree              # 树里直接标出谁在干活：worker[1] → agent 1.1 running · 1m32s
lush process tree --no-agents  # 只看纯进程结构
lush process agents list       # 运行中的 agent：AGENT/PID/NAME/PROVIDER/STATUS/CALL/OS-PID/ELAPSED/MODE
lush process agents list --all # 附带本次 daemon 内存里保留的已结束条目（有界 32 条，重启即清空）
lush process agents show 1.1   # 运行期事实 + 它在磁盘上的 session + 对应的持久 call 行
lush process agents kill 1.1   # 只杀这个工作者：调用记为 interrupted，进程本身仍 running
```

agent 没有 pid：它在自己的空间里用 `PID.N` 标识（`1.1` = 服务 PID 1 的第 1 个 agent，`N` 在本次 daemon 内单调递增）。它也不落库——重启后 `agents list` 为空，持久记录是 `agent_calls` 的那一行（`agents show` 会把它一并给出）。`MODE` 说明它跑在哪：`pipe`（daemon 起的 pi）、`tty`（`call --interactive` 在你终端里跑的 pi，CLI 起手把 OS pid 报给 daemon，所以 daemon 也能杀它）、`in-process`（`mock` / `openai`）。

```bash
lush process session 2        # 那个 PID 的持久 transcript：session-dir / session-id / file / cwd / browse
lush --json process session 2 # 结构化：argv、command、browse_command、env、path_prefix、busy
lush process session 2 --open # 把这个终端交给该 PID 的 pi session（带 Lush 身份与 LUSH_CONTEXT）
```

session 属于它所在的进程：session-id（`lush-<PID>`）与回话文件（`$LUSH_HOME/pi-sessions/<session 开始时间>_lush-<PID>.jsonl`）都按 PID 算，进程进入终态（completed / cancelled / reclaimed）后依然可查；多轮 call 追加到同一个文件（所以正常恒为 1 个，多于 1 只出现在 pi 自己 `--fork` / `/clone` 时）。这也是为什么命令都挂在 `process` 下：没有独立的 `agent` 命令组，`process agents …` 查运行期，`process session …` 查磁盘。

想「发起一次调用，同时自己也在场」，用 `lush process call PID 'PROMPT' --interactive`（简写 `-i`）：daemon 照常打开这次调用（写 user message、标记 busy、拦递归与并发），但 agent 不跑 `pi --print`，而是在你这个终端里跑同 cwd、同 session、同身份的 pi TUI，PROMPT 作为 TUI 的首条消息；你在里面看它干活、直接插话，退出 TUI 后 CLI 把结果报回 daemon 并结算这次调用（成功/失败、释放 busy）。只适用于外部 agent（`pi`）：内置运行时的 agent 跑在 Lush 进程内，没有可进入的终端，会报错。这次调用只有 prompt 落在 `agent_calls`，回复留在 pi 会话里；期间 `kill` / `stop` 只能把它标记为 interrupted，不会关掉你终端里的 pi。

想先看一次 call 会执行什么，用 `--dry-run`（`dry_run: true`）：不调用 agent、不写历史，只打印那行命令（`cd <cwd> && LUSH_HOME=... LUSH_PID=... pi --print ... '<prompt>'`），可以直接粘到 shell 里重放；`--json` 则给出 `executable` / `argv` / `command` / `cwd` / `env`。内置运行时没有外部命令，返回 `command: null` 与将要发送的消息条数。

## 其他 Agent

`LUSH_PROVIDER=mock`：确定性架构演示，不是真实语言模型，支持身份查询、中文/英文创建子任务请求，以及显式工具指令（`/tool process.spawn {...}`）；`bun test` 与 `bun run demo` 都用它。

`LUSH_PROVIDER=openai`：Lush 内置的 OpenAI-style Chat Completions 运行时（多轮 tool calling，agent 直接用 `process_*` 工具）。

```bash
export LUSH_PROVIDER=openai
export LUSH_API_KEY='...'
export LUSH_BASE_URL='https://api.openai.com/v1'
export LUSH_MODEL='your-model'
lush daemon start
```

环境变量由 **daemon 启动时** 读取，切换需重启。API key 不写入数据库。请求走 Bun 的 `fetch`，自动遵循标准代理环境变量（`http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`）；本机 loopback base URL 会把 loopback 主机名补进 `NO_PROXY`，保证本地模型直连。拒绝 HTTP 重定向以避免转发 API key。调用带 `AbortSignal`，取消后不再执行工具或写入结果；daemon 退出时不会等待网络请求自然结束。不自动重试有副作用的 Agent 调用。内置运行时不支持流式输出。Mock 的自然语言识别只是演示规则。

## CLI 帮助（每一层都有）

命令树按层组织：顶层 → 命令组（`daemon` / `process`）→ 命令 → 参数。任何一层都能问自己这一层是什么、下面有什么、每个子命令干什么：

```bash
lush help                      # 顶层：整体覆盖范围 + 命令组
lush help process              # 命令组：覆盖范围 + 子命令列表
lush process help spawn        # 单个命令：覆盖范围、用法、位置参数、选项、约束
lush process spawn --help      # 等价写法；`-h` 和 `lush process help spawn` 同理
lush --json help process       # 机器可读的命令树（summary/cover/usage/options/subcommands）
```

帮助文本与解析器读同一张命令表（`src/cli/main.js` 的 `COMMANDS`），所以不会和真实参数不一致；`lush` / `lush process` 这类缺参数的调用会把用法打到 stderr 并以退出码 2 结束。

## 文档

- [总体架构](docs/architecture.md)
- [Process 模型及生命周期](docs/process-model.md)
- [RPC / CLI 协议](docs/rpc.md)
- [开发任务](docs/tasks.md)

## 验证

```bash
just verify   # = bun test（51 项）+ bun run demo
bun test      # 只跑测试
bun run demo  # 只跑演示（mock provider）
```

数据默认保存在 `$XDG_STATE_HOME/lush` 或 `~/.local/state/lush`，可用 `LUSH_HOME` 覆盖。包含 SQLite 数据库、socket、daemon 锁、pi session 及日志。目录仅限当前用户访问。模板存放于仓库顶层 `templates/`（内置 `lush-root`、`generic-service`、`generic-task`、`research-task`、`project-manager`、`project`）；`$LUSH_HOME/templates/*.json` 可增加新模板，不覆盖仓库模板；重启后加载。模板字段固定为 name、type（task/service）、singleton（同一父进程下是否只允许一个活动实例）、description、spawn_prompt（创建该模板需要哪些参数、如何创建）、system_prompt（实例 call 时使用的系统提示词）、child_templates（该实例可创建哪些模板），缺一或多一都报错。`project` 是 `project-manager` 的子模板、非单例，创建时必须通过 `--args '{"path":"/abs/dir"}'` 给出已存在的绝对目录，该目录会成为它的 agent cwd。

**生命周期提示：** spawn 自动进入 running；一次 call 返回不等于 Task 完成。完成的 Task 不再接受 call/attach；可通过 inspect 查看历史。stop 仅用于 Service，kill 停止 Service / 取消 Task。父进程结束时，活动直接子节点改挂 PID 0，自己的后代不变。`reclaim` 仅标记结束的 Task 为 reclaimed，历史不删除。PID 0 只能通过停止 daemon 退出。

本地单用户 MVP：没有 ACL、沙箱、自动调度、自动任务恢复、向量数据库或 Web UI。运行 pi 时，pi 自带的 read/bash/edit/write 工具和你的 pi 配置（skills、extensions、AGENTS.md）都会生效，因此 pi 进程能读写磁盘和执行命令；`openai` / `mock` 运行时只有 Lush 自己的 `process_*` 工具，不含 shell、文件编辑或联网能力。不要向不可信用户暴露 socket；Agent 可以调用其他 Process，因此工具调用不是安全隔离边界。
