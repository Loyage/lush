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
lush process spawn 0 project-manager --name project-manager
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

命令分两层组：命令组（`daemon` / `process`）→ 命令 → 参数。默认输出是给人读的文本（表格、树、分块的 message、一行式状态），`--json` 给出稳定的机器可读 result，可写在命令之前或末尾。agent 不是独立的命令层：它属于某个 Process，随进程查询。

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
just agent list      # agent profile（不需要 daemon）：just agent inspect default / add / edit / delete / default / path
just spawn 1 generic-task implement-login '实现登录功能'
just spawn 1 generic-task x '' '' demo-agent   # 第 6 个参数是该进程使用的 agent profile
just spawn 1 project my-repo '' '{"path":"/abs/repo"}'   # project 必须给变量 path（绝对路径，同时是 cwd）
just spawn 1 dev-task fix-login '修好登录' '' '' '修复登录流程' '任务详情正文'   # dev-task：name（就是 --name）+ title + detail（第 6、7 个参数）
just call 2 '请介绍一下你自己'
just call 2 'hi' dry   # 只打印将执行的命令（pi 命令行），不真的调用 agent
just session 2        # 查看该进程的 pi session（dir/id/file）
just session 2 open   # 直接进 pi TUI 接续该会话
just complete 2 '"done"' | just update-state 2 '{"progress":"half"}' | just update-vars 2 '{"branch":"dev"}'
just attach 2
just inspect 2       # 统一查看：just inspect 2 parent,children,prompt
just history 2 0 50
just stop 1 | just kill 2 | just reclaim 2 | just delete 2 | just purge 2
just orphans         # PID 0 的孤儿池：策略 + 每个孤儿的 busy / 闲置秒数
just orphans sweep   # 立刻按 TTL / 上限回收一次（冻结，不删除）
just daemon-stop     # 或 just daemon-restart（保留进程树与历史）
just prune           # 列出并清理残留 daemon（home 已消失的孤儿）；just prune all 连临时 home 一起清
just log             # tail $LUSH_HOME/daemon.log
just clean           # 停 daemon 并删除仓库内的 .lush
```

`just` 默认把开发数据放在仓库内的 `.lush/`（已 gitignore），不碰你日常的 `~/.local/state/lush`；用 `LUSH_HOME` 可覆盖（此时 `just clean` 只提示、不删除仓库外的目录）。

**改代码或提示词之后，先确认你重启的是哪个 daemon。** daemon 是常驻进程：`src/agent/guide.js`、`src/cli/tree/`（CLI 声明树）与 `templates/**/*.json`（模板按 spawn 树分层嵌套，递归加载）都在它启动时读入内存，所以 `just daemon-restart` 只重启 `LUSH_HOME`（默认仓库 `.lush/`）那一份。若你另外在 shell 里直接跑 `lush`（没有 `export LUSH_HOME`，走默认 `~/.local/state/lush`），命令打到的是另一个 daemon，重启那份不会有任何效果。`lush daemon status` / `just doctor` 会列出 daemon 自己的 `home`、`code_dir`、`fingerprint`、`started_at` 与 CLI 侧对应字段（`cli.code_match` 表示两边是否同一份代码）；不一致时，任何 `lush` 命令都会在 stderr 上告警并给出该重启哪一份。

## Agent：默认「纯净 pi」

`call` 默认交给 **`pi`** 执行（`LUSH_PROVIDER=pi`）。**行为变更**：Lush 现在给 pi 加上一组纯净化开关，pi 只带自己的 read / bash / edit / write 工具，**不再加载你本机的 pi extensions / skills / prompt templates / themes 与 `AGENTS.md` context 文件**（等价于 `--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files`）。要让某个 agent（或全局默认）恢复 pi 原本的加载行为，用 `lush agent add/edit … --plugins`，见下面的「agent profile」。

每次 call 起一个 `pi --print` 子进程，**每个 PID 一个 pi session**（`$LUSH_HOME/pi-sessions/`，`--session-id lush-<PID>`），多轮上下文由 pi 自己持久化。Lush 给 pi 的输入是三层提示词：

1. 模板的 `system_prompt`（用 `--system-prompt` **替换** pi 默认的 coding 提示词）；
2. 共享的 Lush 说明层（`src/agent/guide.js`）：介绍 Lush 是什么、如何用 `lush` CLI 操作进程，所有 agent 后端都会带上；
3. 运行时数据 `LUSH_CONTEXT`（自身 metadata、父/子摘要、state、可创建模板及其 `spawn_prompt`）。

pi 用自带的 read / bash / edit / write 工具干活，并**通过 bash 调用 `lush` CLI** 来 spawn / call / complete 其他进程；`LUSH_HOME`、`LUSH_PID` 会传给它，仓库 `bin/` 会被加进 PATH。若进程创建时给了 `path` 变量（例如 `project` 模板），pi 的 cwd 就是该目录，否则是 `$LUSH_HOME`。

```bash
export LUSH_PROVIDER=pi            # 默认
# export LUSH_PI_COMMAND=pi        # pi 可执行文件（默认在 PATH 找 pi）
# export LUSH_PI_PROVIDER=openai   # 透传给 pi --provider
# export LUSH_PI_MODEL=gpt-5       # 透传给 pi --model
export LUSH_CALL_TIMEOUT=900       # pi 真实干活很慢，默认 15 分钟
lush process spawn 0 project-manager --name project-manager
lush process spawn 1 project my-repo --name my-repo --vars '{"path":"/abs/repo"}'
lush process call 2 '看看这个仓库，列出待办并开工'
```

取消（`kill` / `stop` / 超时 / daemon 退出）会杀掉对应的 pi 子进程；pi 的 session 文件保留在 `$LUSH_HOME/pi-sessions/` 供审计，Lush 自身只记录 prompt 与最终文本。

### agent profile：一个进程用哪个 agent、这个 agent 长什么样

**agent profile** 把「用哪个 agent」变成可配置的一等概念。每个 profile 是一个文件 `$LUSH_HOME/agents/<name>.json`（**文件名就是 agent 名**，没有 `name` 字段，可手写），由 `lush agent` 命令组读写：

```bash
lush agent list                 # NAME PROVIDER COMMAND MODEL PLUGINS DEFAULT SOURCE PATH
lush agent inspect default      # 完整配置 + 定义来源 + 校验 + 真正会跑的 argv 预览
lush agent add analyst --model gpt-5 --flag --verbose   # 新 profile，默认就是纯净 pi
lush agent add legacy --plugins # 这个 profile 保留 pi 自己的插件默认行为
lush agent edit analyst --no-plugins                    # 增量修改：未给出的字段不变
lush agent delete analyst       # default 拒绝删除
lush agent default analyst      # 把 analyst 的字段复制到 default 的 override
lush agent path                 # profile 目录（$LUSH_HOME/agents）
```

**`lush agent` 不经过 daemon**：它只读写 `$LUSH_HOME/agents/*.json`，daemon 没运行时也能用（这是它和 `lush process ...` 的区别）。daemon 在**每次 call 时按名字读盘**，所以改完 profile 不用 `daemon-restart`（`daemon-restart` 仍然要用于改代码 / 提示词 / 模板）。

**选择优先级**（进程 > 环境变量 > 内置 default）：

1. 进程显式选择：`lush process spawn … --agent <name>`，或模板里的可选字段 `agent`（`--agent` 覆盖模板）。选中的名字写进进程 state（`lush process inspect PID` 的 `agent.profile` 与 `context.state.agent` 都能看到），之后这个进程的每次 call、`process session`、`process call --dry-run` 都用它。
2. 环境变量：`LUSH_PROVIDER` / `LUSH_PI_COMMAND` / `LUSH_PI_PROVIDER` / `LUSH_PI_MODEL`（语义与以前完全一致，`LUSH_PROVIDER=mock` 仍然照常工作）。
3. 内置 `default`：provider `pi` + 纯净化参数。它永远可用、不可删除，但可以写 `$LUSH_HOME/agents/default.json` 逐字段覆盖（`lush agent edit default …` / `lush agent default <name>`）。

解析是**逐字段叠加**：profile 里声明了的字段优先，没声明的字段回落到环境变量，再回落到内置 fallback。所以一个 profile 只写它要改的字段即可，而 `LUSH_PI_COMMAND` 之类的环境变量对所有 pi profile 仍然生效（例如把 pi 指向 stub 做测试）。

profile 字段（都可省略，未知字段会被拒绝）：

| 字段 | 含义 |
| --- | --- |
| `provider` | `pi`（默认，外部子进程）/ `openai` / `mock`（Lush 内置运行时） |
| `command` | pi 可执行文件；省略时用 `LUSH_PI_COMMAND`，最后回落到 `pi` |
| `model` / `pi_provider` | 透传 pi `--model` / `--provider` |
| `plugins` | `false`（默认）= 纯净化：追加五个 `--no-*`；`true` = 不追加任何插件开关 |
| `flags` | 额外 pi 参数（字符串数组），追加在插件开关之后 |
| `description` | 备注，只用于 `list` / `inspect` |

pi 的 argv 顺序固定：`pi [--print] <插件开关> <flags> --session-dir … --session-id … --name … --system-prompt … --append-system-prompt … [--provider] [--model] <prompt>`；`lush agent inspect <name>` 会用一个占位 invocation 把它整条打印出来，`lush process call PID 'hi' --dry-run` 打的是真实进程的那条。

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

session 属于它所在的进程：session-id（`lush-<PID>`）与回话文件（`$LUSH_HOME/pi-sessions/<session 开始时间>_lush-<PID>.jsonl`）都按 PID 算，进程进入终态（completed / cancelled / reclaimed）后依然可查；多轮 call 追加到同一个文件（所以正常恒为 1 个，多于 1 只出现在 pi 自己 `--fork` / `/clone` 时）。所以运行期与磁盘都挂在 `process` 下：`process agents …` 查运行期，`process session …` 查磁盘；名字容易混的是 `agent` 命令组——那是**配置**（profile，见上一节），与某个进程此刻的 agent 无关。

### 删除：把记录真正拿掉

`reclaim` 只是归档，`delete` / `purge` 才是物理删除——同一个事务里删掉该 PID 的 `processes` / `contexts` / `messages` / `agent_calls` / `process_events` 行，之后 `list` / `tree` / `inspect` / `history` 都不再有它。

```bash
lush process delete 2              # 只删已结束的进程；running 被拒绝并提示改用 purge
lush process purge 2               # 先停止/取消（中断进行中的调用）再删
lush process delete 1 --recursive  # 连整棵子树一起删（叶子先走，同一个事务）
lush process purge 1 --recursive   # 子树里每个活动节点都会被终止，且不收养给 PID 0
```

有子进程时默认拒绝（删掉父行会让子进程指向不存在的行），`--recursive` 才级联。删完只留一处痕迹：被删进程的父进程记一条 `child_deleted` 事件（`lush process inspect 1` 里能看到是什么时候没的、叫什么名字）；`original_parent_pid` 指向被删进程的幸存节点会改挂 PID 0 并记 `parent_deleted`。内置运行时的 agent 工具里没有删除工具——删除是人的决定。PID 0 永远不能删。

### 孤儿监督

父节点进入终态时，它的活动直接子节点改挂 PID 0（收养），之后归 PID 0 监督。**默认不回收**（`adopt` + 不限 + 不超时，与历史行为一致），只有配了上限或闲置超时才动手；这四个变量在 daemon 启动时读取，**改配置必须重启 daemon**：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `LUSH_ORPHAN_ADOPT` | `adopt` | 父节点结束时活动直接子节点怎么办：`adopt` 收养 / `none` 不收养也不终止 / `terminate` 连同子节点一起冻结 |
| `LUSH_ORPHAN_LIMIT` | `0`（不限） | PID 0 下活动孤儿的上限，超出时从最旧开始冻结 |
| `LUSH_ORPHAN_TTL` | `0`（不启用） | 闲置超过这么多秒的孤儿被冻结（可小数） |
| `LUSH_ORPHAN_SWEEP` | `30` | daemon 每这么多秒扫一次；`0` = 不起定时器（仍可手动 `--sweep`） |

```bash
LUSH_ORPHAN_LIMIT=5 LUSH_ORPHAN_TTL=3600 just daemon-restart   # 默认的 adopt 收养下，上限 5、闲置一小时就回收
lush process orphans          # 读模型：当前策略 + 每个孤儿的 busy / 闲置秒数
lush process orphans --sweep  # 立刻按 TTL + 上限回收一次，返回本轮报告（evicted / deferred）
```

**回收是冻结，不是删除**：Service → `stopped`、Task → `cancelled`，metadata、Context、消息、调用与事件全部保留（真删除只有 `delete` / `purge`）。有 agent 调用在跑的孤儿（busy）永不被冻结，只出现在报告的 `deferred` 里。被监督冻结的进程，其 transition 事件带 `cause`（`orphan_ttl` / `orphan_limit`），用 `lush process inspect PID` 可查；`lush daemon status` 里的 `orphans_active` 是当前活动孤儿数。细节见 [Process 模型](docs/process-model.md#pid-0-的孤儿监督)。

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

`mock` / `openai` 也可以写进 agent profile（`lush agent add x --provider mock`）：被进程显式选中的 profile 优先于 `LUSH_PROVIDER`，所以同一个 daemon 里可以同时有跑 pi 的进程和跑内置运行时的进程（各自带上匹配的 Lush 说明层：`cli` 或 `tools`）。openai 的 URL / key / model 仍然只来自环境变量。

## CLI 帮助（每一层都有）

命令树按层组织：顶层 → 命令组（`daemon` / `process` / `agent`）→ 命令 → 参数。任何一层都能问自己这一层是什么、下面有什么、每个子命令干什么：

```bash
lush help                      # 顶层：整体覆盖范围 + 命令组
lush help process              # 命令组：覆盖范围 + 子命令列表
lush process help spawn        # 单个命令：覆盖范围、用法、位置参数、选项、约束
lush process spawn --help      # 等价写法；`-h` 和 `lush process help spawn` 同理
lush --json help process       # 机器可读的命令树（summary/cover/usage/options/subcommands）
```

帮助文本与解析器读同一张命令表（`src/cli/tree/` 的命令声明），所以不会和真实参数不一致；`lush` / `lush process` 这类缺参数的调用会把用法打到 stderr 并以退出码 2 结束。

## 文档

- [总体架构](docs/architecture.md)
- [Process 模型及生命周期](docs/process-model.md)
- [RPC / CLI 协议](docs/rpc.md)
- [开发任务](docs/tasks.md)

## 验证

```bash
just verify   # = bun test（136 项）+ bun run demo
bun test      # 只跑测试
bun run demo  # 只跑演示（mock provider）
```

数据默认保存在 `$XDG_STATE_HOME/lush` 或 `~/.local/state/lush`，可用 `LUSH_HOME` 覆盖。包含 SQLite 数据库、socket、daemon 锁、pi session 及日志。目录仅限当前用户访问。模板存放于仓库顶层 `templates/`：每个模板 `<name>.json` 旁边有一个同名文件夹 `<name>/`，里面放它能直接创建的模板（被多个模板创建的共享模板跟最浅的那个父模板放一起），于是目录本身就是 spawn 树——`lush-root.json` + `lush-root/project-manager.json` + `lush-root/project-manager/{project.json,generic-task.json,generic-service.json,research-task.json}`，`project` 的子模板在 `lush-root/project-manager/project/dev-task.json`；模板的 `child_templates` 写相对自己文件的路径（如 `lush-root/project-manager.json`、`project/dev-task.json`、同目录的 `generic-task.json`），loader 递归读取并把它解析成模板名，白名单、快照与权限比对里仍然只有名字；也接受直接写模板名（程序化 `register` 没有文件可相对，旧用户模板也继续可用）。`$LUSH_HOME/templates/**/*.json` 可增加新模板（同样递归读取，路径相对自己的文件），不覆盖仓库模板；重启后加载。模板按层级顺序加载与展示（`lush-root` → `project-manager` → `project` → 它能创建的任务）：能创建某个模板的模板排在它前面，`*` 与自引用不算层级关系，同级按名称排序，所以 `available_child_templates` 的顺序与文件名无关。**PID 0 只能创建 `project-manager`**：`lush-root` 的 `child_templates` 只有这一项，用户模板同样不在其列（列表是显式的，没有 `*`）。模板字段固定为 name、type（task/service）、singleton（同一父进程下是否只允许一个活动实例）、description、spawn_prompt（创建该模板需要哪些变量、如何创建）、system_prompt（实例 call 时使用的系统提示词）、child_templates（该实例可创建哪些模板）、variables（实例变量声明：immutable / mutable 两个区间，每项有 description 与可选的 required、default，以及可选的格式约束 pattern / max_length / single_line），缺一或多一都报错。变量在创建时用 `--vars '<json>'` 提供：必填变量缺失、写了没声明的名字、值不符合声明里的格式都会直接失败（CLI 退出码 2，RPC 错误码 -32602，报错会引述该变量的声明）；immutable 变量（如 `path`）创建后不可改，mutable 变量用 `lush process update-vars PID --vars '<json>'` 修改（同样要满足声明的格式），`process inspect` / `process tree` 都能看到变量的当前值与声明。四个变量名是保留的，它们的含义不限于声明它们的模板：`path` 是 agent 工作目录（必须是已存在的绝对目录，只能 immutable）；`name` 是进程名——声明它的模板（`dev-task`）用 `--name` 或 `variables.name` 给同一个值，格式按该声明校验；`title` / `detail` 是任务的一行摘要与详情正文，`process list` / `tree` / `inspect` 会渲染。`project` 是 `project-manager` 的子模板、非单例，必须提供 immutable 变量 `path`（已存在的绝对目录，会成为它的 agent cwd），另有 mutable 变量 `branch`（默认 main）。它的 `system_prompt`（每次 call 的系统提示词）带一条「先拆分、再创建」的协议：拿到一批指令时先判断是不是明显多条，是就按目标模板自己的 `spawn_prompt` / `variables` 声明配置字段、用 `process_spawn` 逐个创建 task 进程（一次 call 可以建多个），只有一条目标时不硬拆；默认只创建、不逐个 call。它只创建 task 类子模板（`child_templates` 是 `dev-task` / `research-task` / `generic-task` / `generic-service`，不含 `project`）：开 / 关项目是 `project-manager` 的职责（PID 0 → `project-manager` → `project`），嵌套 project 在创建时被白名单拒绝（-32010，`cannot create template project`），`available_child_templates` 里也不会出现 `project`。`dev-task` 是 `project` 的子模板，用三个正式字段描述一项开发任务：`name`（不可留空的英文标识符 `^[A-Za-z][A-Za-z0-9_-]*$`、≤64，同时就是进程名，用来命名相关的 worktree / 分支）、`title`（不可留空的一行摘要、≤200，`process list` 与 `inspect` 显示的就是它）、`detail`（任务详情正文，可多行、可以为空，≤20000）。创建时 `lush process spawn 1 dev-task --name fix-login --title '修复登录流程' --detail '正文'`（`--title` / `--detail` 是这两个变量的简写，等价于写进 `--vars`）；工作目录与分支仍由任务自己向父进程取。

**生命周期提示：** spawn 自动进入 running；一次 call 返回不等于 Task 完成。完成的 Task 不再接受 call/attach；可通过 inspect 查看历史。stop 仅用于 Service，kill 停止 Service / 取消 Task。父进程结束时，活动直接子节点改挂 PID 0，自己的后代不变。`reclaim` 仅标记结束的 Task 为 reclaimed，历史不删除。**删除是唯一的物理删除路径**：`process delete PID` 只删已结束的进程，`process purge PID` 先停止/取消再删（`--recursive` 连整棵子树），同一个事务里删掉该 PID 的 Context、消息、调用与事件，且内置运行时的 agent 工具集里没有删除工具；被删进程的父进程会得到一条 `child_deleted` 事件，被删进程自己不留痕。PID 0 永远拒绝，只能通过停止 daemon 退出。

本地单用户 MVP：没有 ACL、沙箱、自动调度、自动任务恢复、向量数据库或 Web UI。运行 pi 时，pi 自带的 read/bash/edit/write 工具和你的 pi 配置（skills、extensions、AGENTS.md）都会生效，因此 pi 进程能读写磁盘和执行命令；`openai` / `mock` 运行时只有 Lush 自己的 `process_*` 工具，不含 shell、文件编辑或联网能力。不要向不可信用户暴露 socket；Agent 可以调用其他 Process，因此工具调用不是安全隔离边界。
