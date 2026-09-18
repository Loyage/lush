# Lush

**Operating System for AI — AI 的操作系统，而不是 AI Operating System。**

Lush 把 AI 工作组织成**被动的 Service 节点**与**会干活的 Task**：Service 持有身份、变量与持久状态，自己不会运行 agent；用户在某条 service 上 `call` 就在它上面创建一个 **task**，task 才有自己的 agent、会话与 result。task 解决不了的事向自己的**下游子 service** 派子 task，于是形成一棵 task 树——`lush task tree` 能看到一件事是怎样在服务之间协作做完的。SID 0 代表 Lush 自身。它不是 Unix 服务管理器，也不是模型供应商的 CLI 包装器。

## MVP 范围

Bun 1.2+ / JavaScript (ESM) / `bun:sqlite` / Unix Domain Socket / JSON-RPC 2.0；**没有任何第三方依赖**，不用 Nix、不用 Python、不需要 `bun install`。支持 macOS 和 Linux。CLI 和 Agent Tools 调用同一套 Core API。

```bash
# 仓库开发模式，无需安装：CLI 与 daemon 都用 bun 直接运行
export PATH="$PWD/bin:$PATH"
export LUSH_HOME="${TMPDIR:-/tmp}/lush-demo-$USER"
export LUSH_PROVIDER=mock   # 确定性演示；真实 agent 用 pi（默认值）
lush help                   # 每一层都有 help：lush help service / lush service spawn -h
lush daemon start
lush daemon status
lush service tree
lush service spawn 0 project-manager --name project-manager
lush service spawn 1 generic-task --name implement-login --goal '实现登录功能'
lush service tree                  # 被动节点：创建本身不会跑任何 agent
lush call 2 '请介绍一下你当前的身份和任务'   # 在 SID 2 上开一个根 task 并等它结束
lush task list                     # 这件事的 task
lush task tree 1                   # 它派出去的子 task（协作树）
lush task history 1                # 这个 task 自己的对话
lush call 1 '把这活派给下游'          # agent 会在自己的子 service 上开子 task
lush task tree 2
lush task inspect 2
lush task session 2 --open         # 进入该 task 的 pi TUI（等价 `lush task attach 2`）
lush service inspect 2             # 被动节点这一侧：变量、state、挂载的近期 task
lush service update-state 2 --patch '{"progress":"half"}'
lush daemon restart # 等价 stop + start；树、task、Context、对话和调用历史仍在
lush task tree 1
lush daemon stop
```

命令分两层组：命令组（`daemon` / `service` / `task` / `agent`）与顶层入口 `call` → 命令 → 参数。默认输出是给人读的文本（表格、树、分块的 message、一行式状态），`--json` 给出稳定的机器可读 result，可写在命令之前或末尾。运行期 agent 属于 task（`lush task agents …`），不是独立的命令层。

也可通过 `bun run bin/lush`（或 `bun run bin/lushd` 前台运行 daemon）调用；`bun link` 之后 `lush` / `lushd` 会进入 PATH。

## 请求怎么往下走：分派优先

一个 task 的 agent 接到活时，第一件事不是自己动手，而是判断「这活归谁」：对照 task 的 goal、所在 service 的职责与 `children` / `LUSH_CONTEXT.available_child_templates` 里每个子服务、每个可创建模板的 `description` 与 `spawn_prompt`——有谁专职这件事就把 task 派给它（已有的子服务先复用，没有的先按模板 `service_spawn` 建，再 `task_spawn`），没有合适的下游或这本就是自己的职责时才自己动手。派完用 `task_wait`（或等被自动唤醒）拿结果。这条规则写在共享说明层（`src/agent/guide.js` 的「通用规则」），所有后端、所有模板都带；`tools` 与 `cli` 两个后端共用同一份文本。

顶层因此长这样：

```text
用户 → SID 0（入口 / 路由器）上的根 task
        ├── 关于 Lush 自身的问题：SID 0 自己用只读命令回答
        └── 其他一切任务：把 task 派给 project-manager 节点
                ├── 「给 <项目> 加功能 / 修 bug / 重构 / 调研它」→ 该项目的 project 节点上的 task（由它拆 dev-task 子 task）
                ├── 不绑定某个项目的问题（选型 / 通用调研）→ research-task 节点
                ├── 有明确目标的一次性杂活 → generic-task 节点
                └── 长期能力 / 常驻服务 → generic-service 节点
```

SID 0 自己不做项目里的活：不读改仓库文件、不在项目目录里跑实现 / 构建 / 测试命令；`lush-root` 的 `child_templates` 只有 `project-manager`，`project` / `dev-task` 都不在它的权限里，所以它也无法替 `project-manager` 做决定。`project-manager` 收到请求后按上表分派，只有「打开 xx」「关闭 xx」这类项目生命周期管理动作它才亲自做。改这三处提示词（`src/agent/guide.js`、`templates/lush-root.json`、`templates/lush-root/project-manager.json`）后要 `just daemon-restart` 才生效。

## 常用命令（Justfile）

开发与操作入口是 `just`：默认把数据目录设在仓库内的 `.lush/`，所以每个 worktree 天然拥有自己独立的 daemon、数据库与 socket。

```bash
just                 # 列出全部命令        just doctor      # 工具链 / home / daemon 状态
just test            # bun test            just demo        # 完整 CLI / daemon 演示（mock）
just bootstrap       # 起 daemon + project-manager → implement-login
just call 2 'hi'     # 在 SID 2 上开一个根 task 并等它结束（just call 2 'hi' dry 只打印命令）
just tasks | just task-tree 1 | just wait 1 | just inspect 2
just daemon-restart  # 改代码 / 提示词 / 模板之后重启当前 home 的 daemon
just web             # 只启动 Web UI，不操作 daemon；http://127.0.0.1:4318
just web 8080        # 只启动 Web UI，并指定本地端口
just clean           # 停 daemon 并删掉本仓库的 .lush（连历史一起没）
just reset yes       # 只清服务树（daemon、日志、session 都保留），不可逆
```

Web UI 的侧边栏可在「服务」与「任务」两个视图之间切换：服务视图里选中 active Service 并填写 goal，会立即在后台启动一个根 Task；任务视图列出全部 Task（可按根/子与状态筛选），选中后右侧用 `task.tree` 展开它派出去的全部子 Task，并可取消或删除。`just web` 不会启动、停止或重启 daemon：daemon 离线时页面保持运行，后续 daemon 启动或重启后自动恢复。它只监听本机回环地址，不应通过反向代理暴露给不可信用户。CLI、Web UI 以及未来 TUI 的 adapter 统一放在 `src/ui/`，并共享同一个 `UIClient` 应用客户端；细节见 [用户界面](docs/reference/ui.md)。

完整清单、`just clean` 与 `just reset` 的区别、以及每个命令的参数，见 [docs/reference/cli.md](docs/reference/cli.md)。

**改代码或提示词之后，先确认你重启的是哪个 daemon**：daemon 是长驻服务，`start` 不会替换版本，只有 `restart` 会，而且只重启 `LUSH_HOME` 指向的那一份。`lush daemon status`（或 `just doctor`）会列出 daemon 与 CLI 各自的 `home` / `code_dir` / `fingerprint`，不一致时任何 `lush` 命令都会在 stderr 上告警。判据与排障见 [docs/engineering/identity.md](docs/engineering/identity.md)。

## Agent

`call` 默认交给 **`pi`** 执行，且 pi 是「纯净化」的：只带自己的 read / bash / edit / write 工具，不加载你本机的 extensions / skills / prompt templates / themes 与 `AGENTS.md`（要恢复本机加载行为，用 `lush agent add/edit … --plugins`）。agent 是**配置**（`$LUSH_HOME/agents/<name>.json`，`lush agent` 命令组读写，不经过 daemon），运行期的 agent 属于某个 task（`lush task agents …`），两者互不相干。

```bash
lush agent list                 # NAME PROVIDER COMMAND MODEL PLUGINS DEFAULT SOURCE PATH
lush agent inspect default      # 完整配置 + 定义来源 + 真正会跑的 argv 预览
lush agent add analyst --model gpt-5
lush service spawn 1 project x --vars '{"path":"/abs/repo"}'   # 服务也可以用 --agent 指定 profile
```

字段表、选择优先级（服务 > 环境变量 > 内置 default）、`mock` / `openai` 后端与 session 的位置，见 [docs/reference/agents.md](docs/reference/agents.md) 与 [docs/concepts/agents.md](docs/concepts/agents.md)。

## 文档

读哪一份取决于你要回答什么；每份文档都在开头写了自己的定位。

- **概念**：[Service 与 Task 模型](docs/concepts/service-model.md) · [生命周期与孤儿监督](docs/concepts/lifecycle-and-orphans.md) · [Agent 后端与 Context](docs/concepts/agents.md)
- **参考**：[CLI 与 Justfile](docs/reference/cli.md) · [用户界面](docs/reference/ui.md) · [RPC 协议](docs/reference/rpc.md) · [模板](docs/reference/templates.md) · [Agent profile 与 session](docs/reference/agents.md)
- **工程**：[总体架构](docs/engineering/architecture.md) · [daemon 与 CLI 的版本对齐](docs/engineering/identity.md)
- **历史**：[开发日志](docs/log/)
- 索引与阅读约定：[docs/README.md](docs/README.md)

## 验证

```bash
just verify   # = bun test（145 项）+ bun run demo
bun test      # 只跑测试
bun run demo  # 只跑演示（mock provider）
```

数据默认保存在 `$XDG_STATE_HOME/lush` 或 `~/.local/state/lush`，可用 `LUSH_HOME` 覆盖。包含 SQLite 数据库、socket、daemon 锁、pi session 及日志。目录仅限当前用户访问。仓库模板与用户模板的摆放见 [docs/reference/templates.md](docs/reference/templates.md)。

**生命周期提示：** Service 只有 created / active / stopped——它是被动的，`service spawn` 只是建节点，不会跑任何 agent，`service stop` 只让它不再接受 task（先取消它手上的 task）。工作全在 task 上：`call` 建根 task 并等待，task 的状态是 created / running / waiting / completed / failed / cancelled，`task cancel` 取消一棵子树，`task complete` 由它的 agent（或人）在目标达成时调用；终态 task 不会有活动子 task。节点结束时（`stop` / `purge`），活动的直接子节点改挂 SID 0。**删除是唯一的物理删除路径**：`task delete` 只删 task 行（call 行与消息留作 service 的历史），`service delete SID` 只删 stopped 且没有活动 task 的节点（连带它上面的 task），`service purge SID` 先取消 task、停止节点再删（`--recursive` 连整棵子树），且内置运行时的 agent 工具集里没有删除工具；被删节点的父服务会得到一条 `child_deleted` 事件。SID 0 永远拒绝，只能通过停止 daemon 退出。详见 [docs/concepts/lifecycle-and-orphans.md](docs/concepts/lifecycle-and-orphans.md)。

本地单用户 MVP：没有 ACL、沙箱、自动调度、自动任务恢复或向量数据库。Web UI 也只允许监听本机回环地址。运行 pi 时，pi 自带的 read/bash/edit/write 工具和你的 pi 配置（skills、extensions、AGENTS.md）都会生效，因此 pi 服务能读写磁盘和执行命令；`openai` / `mock` 运行时只有 Lush 自己的 `service_*` / `task_*` 工具，不含 shell、文件编辑或联网能力。不要向不可信用户暴露 socket 或 Web UI；Agent 可以调用其他 Service，因此工具调用不是安全隔离边界。
