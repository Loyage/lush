# Lush

**一丁点儿时间不浪费。**
**Not a single moment wasted.**

Lush 是项目级的多 agent 开发应用，不再是电脑级的 AI 管家。一个 daemon 绑定一个项目目录；输入、任务、agent 会话、工作区与待决问题都属于这个项目。

你随时描述想法，Lush 立即保存输入并安排规划任务。规划 agent 拆分工作，多级 agent 在后台并行执行；等待子任务或用户决定时释放 agent 槽，不阻塞下一条输入。代码在独立 Git worktree 中实现，**只有用户明确批准才合并**。

Bun 1.2+ / JavaScript / SQLite / Unix socket，零第三方运行时依赖，支持 macOS 和 Linux。

## 开始使用

在 Lush 源码仓库内操作统一使用 `bun run`。默认项目是当前仓库；操作其他项目时显式指定路径：

```bash
bun run doctor --project /absolute/path/to/my-project
bun run start --project /absolute/path/to/my-project
bun run say '实现登录页面，先研究现有认证流程，再拆分实现和测试' --project /absolute/path/to/my-project
bun run tree --project /absolute/path/to/my-project
bun run web 4318 --project /absolute/path/to/my-project
```

`start` 只启动项目 daemon；`say` **立即返回输入和 task ID，不等待模型或开发完成**；Web 是独立的本地界面进程，不隐式启停 daemon。Web 离线后会自动重连。

Web UI（`http://127.0.0.1:4318`）是两栏视图：左栏是任务树与待决问题，右栏是所选任务的结果、改动概览（已提交与未提交的文件）、子任务、消息、Agent（模型、上下文占用、累计花费与执行过程）与事件时间线，输入框常驻底部。未选任务时右栏显示项目概览（状态分布、运行中与空闲的 agent、待合并分支、运行时信息）。选中任务会写入 `#task-ID` 哈希，可直接用链接打开；刷新不丢已输入的答复。

若 `bin/` 已在 PATH，在目标项目内可以直接使用：

```bash
lush daemon start
lush draft add '给搜索增加键盘导航'
lush draft add '顺便把筛选器抽成组件'
lush draft commit      # 整批交给一个 planner：拆任务、建依赖，然后才建 worktree
lush task tree
lush task inspect 3
lush task message 3 '还要考虑中文输入法'
lush task verify 3      # 派一个只读 verifier：先演示它的 worktree 结果，再对照目标分支
lush notice list
lush notice answer 1 '采用方案 A'
lush task merge 3       # 审阅代码与验证报告后，明确批准这个分支
lush task cleanup 3     # 合并后安全回收 worktree，保留分支作为恢复点
lush daemon stop
```

单条输入也可以用 `lush say '原话'` 立即提交，不等缓存。

### 两类输入：develop 与 explain

每条输入有一个流程判定（`inputs.flow`），由处理它的根 planner 用 `lush input flow develop|explain` 记录：

- `develop`：需要新增功能或改代码。照常拆解，派 coordinator/worker，可派 research。
- `explain`：只是了解、询问、解释相关内容。planner 直接把答案写进自己的 result，必要时派 research 去读代码；**runtime 会硬性拒绝它派发 worker/coordinator**（`input #N is classified as explain (了解)`），因此不会创建 worktree、不会产生待合并改动。

未判定（`flow` 为空）的输入按 `develop` 处理。用户随时可以改判：`lush input flow [TASK_ID] develop|explain`（agent 省略 TASK_ID 时判定自己的输入，Web 任务详情里也有「标记为开发/了解」），`lush input list` 会显示当前判定。改判只影响之后的派工，不会追溯取消已经建立的 worker/coordinator 子任务。

### 检验：用最直观的方式看这次改动跑起来是什么样

任务完成后，点 Web 详情里的「检验」（或 `lush task verify ID`）会派一个**只读 verifier**，它不是复查代码，而是想办法让用户直接看到结果：

- 读被检验任务的 goal 与 diff，自己判断「怎样才能最直观地说明这次改动成立」——跑测试、跑同一个命令对比输出、起服务看界面，方式由它按任务意图决定；可重复的命令与真实输出优先于主观描述。
- 在任务的 worktree 里跑一遍，再在 daemon 临时拉出的**目标分支对照检出**（`git worktree add --detach` 到 `.lush/worktrees/<id>-verify-N-base`）里跑同一场景，把两边并排呈现；基准本来就失败，就说明那是既有问题。
- 最后把结论写成一份自包含 HTML 报告（样式/脚本内联，图片内联为 `data:`）落到 `.lush/verify/<verifier-id>/report.html`，Web 详情里的「打开 HTML 报告」在一个新标签打开它。

verifier 与被检验任务是两个 task（worker 已经终态，不能再挂活动子任务），用 `tasks.verifies_task_id` 关联，界面上挂在被检验任务下面。同一任务同时只允许一次检验；`task.verify` 是用户专属命令，agent 不能用。对照基线是派生状态，检验一结算（成功或失败）就回收，报告保留在磁盘上；`task clear` 不会删它。

### 输入缓存与任务依赖

输入可以先攒着：`lush draft add`（Web 输入框里回车）只写缓存、不规划；`lush draft commit`（Web 的「提交并规划」）把缓存**整体**交给一个 planner，由它拆成多个任务、给互有先后的任务建依赖边，然后才创建 worktree 开工。缓存存库（`drafts` 表），换浏览器或重启 daemon 都不丢；提交后每条草稿留着 `input_id` 作为审计链。

依赖边由 planner 在派工时声明（`task spawn --depends-on ID[:code|order]`），daemon 只做结构校验：

- `code`（默认）：子任务的 worktree 从上游任务的分支拉出，因此看得到上游**未合并**的改动。代价是合并顺序——上游先合，下游才能合，`task merge` 会拒绝越级合并。
- `order`：只等上游结束，代码仍从项目 HEAD 开始。适合等一个调研结论。
- 一个任务最多一条 `code` 依赖；依赖不能指向自己的祖先任务——祖先在等子孙结算，双方会互等而死。
- 依赖未满足的任务保持 `queued`，界面显示「等 #ID」；上游结算时由调度器唤醒，不占 agent 槽。
- 批与批之间不做语义冲突检测（重复劳动、改同一个文件）：那是 planner 读任务树自己判断的事，拿不准就问用户。

默认从 cwd 向上找到 `.lush/project.json` 或 `.git`，以那个目录为项目根。`--project PATH` / `LUSH_PROJECT` 可以显式绑定。目录会 canonicalize，符号链接不会创建第二个 daemon。不同 Git worktree 可作为不同项目独立运行；agent 在任务 worktree 内通过注入的 `LUSH_PROJECT` 始终连接所属项目。

### 运行前提

- 默认 agent 是 `pi`，需要在 PATH 中可用且已完成模型认证。可设置 `LUSH_PI_COMMAND`、`LUSH_PI_PROVIDER`、`LUSH_PI_MODEL`。
- 实现任务需要项目是 **Git worktree 根目录，有初始提交且主工作树干净**。把 `.lush/` 加进项目的 `.gitignore`；Lush 不会替你提交、暂存或藏起已有改动。
- 非 Git 项目也能提交输入和调研，但不能创建实现 worktree。
- `LUSH_PROVIDER=mock bun run start --project ...` 可离线演示调度。Mock 只派调研任务，不调用模型、不修改代码。
- 改环境变量或运行代码后用 `bun run daemon-restart`，不是再次 `start`。

## 新模型

```text
Project / 一个目录 / 一个 daemon
├── Input #1（逐字保存用户原话）
│   └── planner Task
│       └── coordinator Task
│           ├── worker Task → 独立分支 + worktree
│           ├── worker Task → 独立分支 + worktree
│           └── research Task
├── Input #2 → 另一个 planner Task（无需等 #1 完成）
└── Notices（某个 task 等用户做决定）
```

**没有 Service、SID、project-manager、模板构造树或全局项目注册表。** Task 自己持有目标、角色、父任务、状态、结果、消息与工作区。

- `planner`：快速理解原话，参考项目中已有工作，派发任务；不亲自实施开发。
- `coordinator`：拆分多级任务、收集结果、调整计划。
- `worker`：在独立 worktree 中实现、测试、提交。
- `research`：只读研究和审查。

默认最多 **4 个执行 agent + 1 个独立规划 agent**。队列中的任务不占槽；`waiting` / `awaiting` 也不占槽；被依赖挡住的 `queued` 任务同样不占槽。多个输入的规划仍受这个规划槽限制，但不会等待先前的开发树结束；多次提交的解析互不阻塞（每个批次各自一个 planner），越界或非法的依赖在**服务端**被拒绝。

子任务完成、父子消息、用户补充、notice 答复都会进入持久化收件箱，**在 invocation 之间交给 agent**，不硬打断正在执行的模型调用。消息只能沿直接父子边传递；用户可以给任一活动任务追加要求。

## Worktree 与合并

- 每个 worker 的 worktree 位于 `.lush/worktrees/<id>-<name>/`，分支名为 `lush/<项目路径哈希>/<id>-<name>`（`<name>` 是派工时 planner 给的英文短名，如 `fix-login-composer`）。id 保证唯一，短名说清任务做什么；共享 Git 仓库的不同项目不会争用同名 task 分支。省略 `--name` 时 runtime 从 goal 首行的英文词回退，提不出可用名字（例如纯中文 goal）才回到 `task-<id>`；名字只在 spawn 时定一次，之后不变。
- 每个 worker 从创建时项目的 **已提交 HEAD** 开始，除非它对另一个任务声明了 `code` 依赖：那时它的 worktree 从上游任务的**分支**拉出（stacked），于是能拿到上游尚未合并的改动。兄弟任务不会自动看到彼此的修改；无关的编辑应合在一个 worker 中。
- agent 最终输出作为 result。worker 必须提交改动、保持工作区干净；未提交就结束会失败，文件原样保留供检查和重试。
- 完成与合并是两个状态：`completed + pending` 表示已产出提交，**尚未进入主工作树**。
- `task merge ID` 检查任务完成、两边工作树干净、目标分支未切换、待审阅 HEAD 未变化，然后串行执行非快进 merge。冲突会尝试 abort，保留任务分支和错误；不会强制覆盖代码或自动解决冲突。stacked 任务还要求上游已经是目标的祖先（即先合并上游），否则会把它未合并的改动一起带进来。
- merge 中断后标为 `review`，不自动重放。检查 Git 历史、处理遗留冲突并恢复干净工作树后，可重新执行 `task merge ID` 明确批准恢复；若提交已经合入，Git 会确认已包含，不重复改写历史。
- `task cleanup ID` 不使用 `--force`，拒绝未合并成果和脏工作区；取消/失败任务的提交也必须已经进入项目 HEAD 才允许清理。分支始终保留。
- `task clear`（`bun run clear`，Web 项目概览里的「清空任务看板」）一键删掉**全部已结束任务**及其消息、通知、事件与 `inputs` / `drafts` 审计。有 `queued`/`running`/`waiting`/`awaiting` 任务、或还有 invocation 在收尾时**拒绝执行**，不会隐式取消。它只清数据库：`.lush/worktrees/`、任务分支与 `.lush/sessions/` 原样保留（未合并的成果仍在），返回值会列出这些残留路径。因为目录与分支名里带着 task id，清空后 **id 不从 1 重新开始**，新任务不会撞上保留的旧 worktree。

## 常用开发命令

```bash
bun run help
bun run doctor
bun run start
bun run say '你的原话'       # intent 是同义入口，同样不等待
bun run intents
bun run tasks               # 默认前 200 条，可加 --after ID --limit N
bun run tree
bun run inspect 3
bun run transcript 3        # 只看不写：agent 的思考、工具调用与输出
bun run usage 3             # 同一个 agent 的模型、上下文占用与累计花费
bun run message 3 '补充要求'
bun run notices
bun run answer 1 '我的选择'
bun run cancel 3            # 取消这个任务及其活动后代，保留工作区
bun run retry 3             # 检查失败现场之后明确重试
bun run merge 3
bun run cleanup 3
bun run clear               # 一键清空已结束任务（有活动任务时拒绝）
bun run wait 3              # 只有当前客户端等待，不影响调度
bun run web
bun run daemon-restart
bun run stop
```

任一命令都可以加 `--project PATH`。`--json` 输出机器可读结果。底层完整命令见 `bun run help`；不再支持旧 Service API、OpenAI 内置工具后端或 Service agent profiles。

## 状态、恢复与边界

状态目录固定为 `<project>/.lush/`：

```text
project.json       不可跨目录复用的项目绑定
project.db         SQLite：inputs / tasks / messages / notices / events（task.clear 会清空这些表，并把 task id 高水位记在 meta）
sessions/          每个 task 的独立 pi session 与当前输入文件（thinking / 工具调用的原文）
worktrees/         worker 工作区，以及检验期间临时的目标分支对照检出
verify/            每个 verifier 的自包含 HTML 检验报告
daemon.lock        项目 daemon 单实例锁
daemon.log         daemon 日志
```

socket 放在用户私有临时目录，名字由 canonical 项目路径决定，以避免长项目路径超过 Unix socket 限制。它只是通信端点；持久状态仍在项目内。`LUSH_HOME` 不再是独立作用域：若保留该变量，必须恰好等于所选项目的 `.lush`，否则拒绝运行。

任务状态：`queued → running → waiting / awaiting / completed / failed / cancelled`。等待收到新消息后重新排队。终态任务不会保留活动子任务。取消或停止会终止 agent 进程组；重启对未知副作用的运行中任务标记失败，不自动重放；未开始的排队任务、待用户答复和记录保留。重试失败子任务要求父任务仍活动，否则重试父任务或提交新输入。

角色有 planner / coordinator / worker / research / verifier。verifier 是用户点「检验」时才创建的只读任务，它**不是**被检验任务的子任务（终态任务不能再挂活动子任务），而是独立根任务，用 `tasks.verifies_task_id` 指向被检验的 worker；父子不变的不变量不被破坏，界面上依旧挂在被检验任务下面。

**Task 与 agent 是终身一对一的身份。** 任务一创建就拥有一个 agent（`<role>#<task-id>`，例如 `worker#7`），跨唤醒不换身份：pi session、累计唤醒次数和上次动手时间都记在这个 agent 上，`task inspect` 与 Web 详情直接展示。但它的 RPC 凭证是每次唤醒重新签发的：daemon 只存 SHA-256，且只在该次 invocation 运行期间可解析，invocation 结束即作废，重启后一律清空。因此 1:1 指的是身份，不是进程或凭证——等待子任务或用户时 agent 依然存在，但不占执行槽、也没有活着的调用。

**这是本机可信用户工具，不是沙箱。** 目录绑定隔离的是 Lush 的数据库、RPC、调度和工作区管理，不是 OS 文件权限。pi 的 bash 仍拥有当前用户权限，角色约束主要依赖 agent 指令；应审阅改动，不向不可信用户暴露 socket / Web，也不要让其他程序同时修改正在合并的工作树。Agent RPC 用属于活动 invocation 的 token 限制所属任务，不能通过正常 agent 命令批准合并；这不是针对恶意本机进程的安全边界。

pi 默认禁用个人 extensions / skills / prompt templates / themes，保留上下文文件加载以遵循项目开发约定。daemon 意外被 SIGKILL 时可能留下外部进程；恢复不会重放任务，但仍应检查进程和工作区后再重试。

### 配置

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `LUSH_PROJECT` | 从 cwd 发现 | 显式项目目录 |
| `LUSH_PROVIDER` | `pi` | `pi` / `mock` |
| `LUSH_CONCURRENCY` | `4` | 执行 agent 上限，另保留一个规划槽 |
| `LUSH_CALL_TIMEOUT` | `900` | 单次模型调用超时秒数 |
| `LUSH_TASK_CALLS` | `24` | 单 task invocation 总上限 |
| `LUSH_MAX_DEPTH` | `8` | 任务树最大层数 |
| `LUSH_PI_COMMAND` | `pi` | pi 可执行文件 |
| `LUSH_PI_PROVIDER` / `LUSH_PI_MODEL` | pi 默认 | 模型选择 |

`tasks.result` 只保存 invocation 的最后一次输出；完整的执行过程（思考、工具调用、工具输出）留在 `.lush/sessions/*.jsonl`，用 `lush task transcript ID`（Web 详情里的「执行过程」）只读查看，agent 的模型、上下文占用与累计花费用 `lush task usage ID` 从同一批文件里读出（Web 详情里的「Agent」块）。截图、过程与结论分开：审阅合并时看 result 与 `task diff`，需要追究 agent 怎么做的时候看 transcript，需要直接看结果跑起来时点「检验」。

## 验证与文档

```bash
bun run test
```

测试覆盖纯任务树、并发额度、独立规划槽、消息与 notice 唤醒、取消、恢复、任务权限、真实 Git worktree/merge/冲突、检验的对照基线生命周期与报告路由、真实 daemon 的项目隔离、pi 子进程协议与本地 Web 边界。pi 协议测试使用可控的假 pi 可执行文件，不调用付费模型。

[架构](docs/engineering/architecture.md) · [命令与 RPC](docs/reference/api.md) · [重构说明](docs/README.md)

0.2 是不兼容重构，不迁移旧 Service 数据。旧 `.lush/lush.db` 会明确拒绝加载；需要先停止旧 daemon，把旧 `.lush/` 移开保存，再启动新版本。
