# Lush

**一丁点儿时间不浪费。**
**Not a single moment wasted.**

Lush 是项目级的多 agent 开发应用。一个 daemon 绑定一个项目目录；输入、任务、agent 会话、工作区与待决问题都属于这个项目。

你随时描述想法，Lush 立即保存输入并安排规划任务；提交的那一刻先把**当前代码**锚成一条分支与一份检出（`.lush/worktrees/input-<id>-anchor`），所以规划花多久都不会改变这次输入看到的是哪份代码。规划 agent 拆分工作，多级 agent 在后台并行执行；等待子任务或用户决定时释放 agent 槽，不阻塞下一条输入。代码在独立 Git worktree 中实现，**只有用户明确批准才合并**。

Bun 1.2+ / JavaScript / SQLite / Unix socket，零第三方运行时依赖，支持 macOS 和 Linux。

第一次接触任务状态、`code` / `order` 依赖、交付队列或 resolver 时，先读[从输入到交付：行动任务处理流程](docs/task-flow.md)。它按使用顺序解释“任务完成”和“改动已进入目标分支”的区别，以及普通交付、变更栈、冲突与回收应该怎样处理。

## 开始使用

在 Lush 源码仓库内操作统一使用 `bun run`。默认项目是当前仓库；操作其他项目时显式指定路径：

```bash
bun run doctor --project /absolute/path/to/my-project
bun run start --project /absolute/path/to/my-project
bun run say '实现登录页面，先研究现有认证流程，再拆分实现和测试' --project /absolute/path/to/my-project
bun run tree --project /absolute/path/to/my-project
bun run web 4318 --project /absolute/path/to/my-project
```

`start` 只启动项目 daemon；`say` **立即返回输入和 task ID，不等待模型或开发完成**（提交时先做一次 Git 锚点：在当前分支顶端建 `input-<id>-anchor` 分支与检出，所以它短暂排在 Git 串行队列里）；Web 是独立的界面进程，不隐式启停 daemon。Web 离线后会自动重连。默认只监听 `127.0.0.1`；如需从公网访问，在项目的 `.lush/web.json` 写入登录凭证：

```json
{
  "version": 1,
  "username": "your-name",
  "password": "a-strong-password-at-least-12-characters"
}
```

文件权限必须是 `600`。`bun run web` 会监听 `0.0.0.0`，首次启动时自动把明文 `password` 原地替换为 scrypt `password_hash`；之后浏览器通过登录页取得 12 小时的 HttpOnly / SameSite 会话 Cookie。密码首尾的空白一律忽略（从终端复制常会带上换行），但大小写与中间字符仍须完全一致：建议选一个**好辨认**的密码，避开 `0/O`、`1/I/l` 这类易混字符；连续输错 5 次会锁 60 秒。登录被拒与被挡的跨站请求都会写进 web 进程自己的日志，是排查的第一站。

**通过反向代理或域名访问时**，代理默认会把 `Host` 改写成 `127.0.0.1:4318`，而浏览器发出的 `Origin` 是对外地址；两者不一致的提交会被当作跨站拒绝（登录时报 `Cross-site access denied`）。二选一：

- 让代理保留原始 Host（推荐，nginx 写 `proxy_set_header Host $host;`）；
- 或在 `.lush/web.json` 里登记对外地址：`"origin": "https://lush.example.com"`（多个用 `"origins": [...]`）。

公网部署仍应在前面配置 HTTPS 反向代理，否则登录密码会在网络中明文传输。跨站请求判定以浏览器自己填的 `Sec-Fetch-Site` 为准（网页无法伪造它），`Origin` 只在旧浏览器没有这个头时作为回退；内嵌 webview、沙箱页面与部分隐私扩展会报 `Origin: null` 却依然是同源，这类客户端能正常登录。删除 `.lush/web.json` 即恢复仅本机、无需登录的模式。

Web UI（默认 `http://127.0.0.1:4318`）是项目工作台：左栏索引待决事项、行动任务、规划与历史输入；概览优先展示运行 / 待决 / 待交付 / 已完成指标，再展示需要你决定的问题与按目标分支分组的交付队列。任务详情以目标为标题，结果与执行过程优先，模型和用量、运行时配置与维护操作可展开查看。输入框常驻内容区底部；窄屏用「浏览任务」展开索引。右上角可切换**深色 / 浅色主题**，偏好保存在当前浏览器，首次访问跟随系统；过渡动画尊重系统「减少动态效果」。左栏顶部的三个工作区入口——项目概览、分支图与**文档**——共用右侧内容区；文档读的是随这份代码发布的 `docs/` 与 `README.md`（不随被开发的项目变），目录与正文都在右栏，文档之间的相对链接可以直接点开。选中任务会写入 `#task-ID` 哈希，文档是 `#docs` / `#doc-<id>`，都可以直接用链接打开；刷新不丢已输入的答复。

若 `bin/` 已在 PATH，在目标项目内可以直接使用：

```bash
lush daemon start
lush draft add '给搜索增加键盘导航'
lush draft add '顺便把筛选器抽成组件'
lush draft edit 2 '把筛选器抽成独立组件'   # 改一条缓存输入
lush draft commit 1 2   # 只提交选中的几条（无参即全部）交给一个 planner：拆解、建依赖，然后才创建任务 worktree
lush task tree
lush task inspect 3
lush task message 3 '还要考虑中文输入法'
lush task verify 3      # 派一个只读 verifier：先演示它的 worktree 结果，再对照目标分支
lush notice list
lush notice answer 1 '采用方案 A'
lush task merge 3       # 审阅代码与验证报告后，明确批准这个分支
lush task merge 3       # 如果冲突：主树回到合并前，并开一个解冲突任务 + 一条待决问题等你决定
lush task cleanup 3     # 合并后安全回收 worktree 与任务分支（--keep-branch 留分支作恢复点）
lush branch tree        # 分支谱系：谁从谁创建出来（不是 commit graph，也不是任务树）
lush branch show lush/…/7-auth-ui   # 一条分支的 parent / fork commit / task / worktree 与祖先链
lush daemon stop
```

单条输入也可以用 `lush say '原话'` 立即提交，不等缓存。

### 两类输入：develop 与 explain

每条输入有一个流程判定（`inputs.flow`），由处理它的根 planner 用 `lush input flow develop|explain` 记录：

- `develop`：需要新增功能或改代码。照常拆解，派 coordinator/worker，可派 research。
- `explain`：只是了解、询问、解释相关内容。planner 直接把答案写进自己的 result，必要时派 research 去读代码；**runtime 会硬性拒绝它派发 worker/coordinator**（`input #N is classified as explain (了解)`），因此不会产生**任务** worktree、不会产生待合并改动（提交时那份只读的输入锚点仍在，见下）。

未判定（`flow` 为空）的输入按 `develop` 处理。用户随时可以改判：`lush input flow [TASK_ID] develop|explain`（agent 省略 TASK_ID 时判定自己的输入，Web 任务详情里也有「标记为开发/了解」），`lush input list` 会显示当前判定。改判只影响之后的派工，不会追溯取消已经建立的 worker/coordinator 子任务。

### 检验：用最直观的方式看这次改动跑起来是什么样

任务完成后，点 Web 详情里的「检验」（或 `lush task verify ID`）会派一个**只读 verifier**，它不是复查代码，而是想办法让用户直接看到结果：

- 读被检验任务的 goal 与 diff，自己判断「怎样才能最直观地说明这次改动成立」——跑测试、跑同一个命令对比输出、起服务看界面，方式由它按任务意图决定；可重复的命令与真实输出优先于主观描述。
- 在任务的 worktree 里跑一遍，再在 daemon 临时拉出的**目标分支对照检出**（`git worktree add --detach` 到 `.lush/worktrees/<id>-verify-N-base`）里跑同一场景，把两边并排呈现；基准本来就失败，就说明那是既有问题。
- 最后把结论写成一份自包含 HTML 报告（样式/脚本内联，图片内联为 `data:`）落到 `.lush/verify/<verifier-id>/report.html`，Web 详情里的「打开 HTML 报告」在一个新标签打开它。

verifier 与被检验任务是两个 task（worker 已经终态，不能再挂活动子任务），用 `tasks.verifies_task_id` 关联，界面上挂在被检验任务下面。同一任务同时只允许一次检验；`task.verify` 是用户专属命令，agent 不能用。对照基线是派生状态，检验一结算（成功或失败）就回收，报告保留在磁盘上；`task clear` 不会删它。

### 输入锚点：这次输入看到的是哪份代码

提交输入时会先从当前检出分支的顶端拉出一条 `lush/<项目哈希>/input-<id>-anchor` 分支，并在 `.lush/worktrees/input-<id>-anchor` 做一份检出。规划要花时间，这期间你可能继续在主树上提交；锚点把这些提交拦在外面：没有 `code` 依赖、也不是解冲突任务的 worker 都以锚点的 commit 为 `base_commit`、以锚点当时的检出分支为 `target_branch`，分支谱系的 `parent` 写锚点分支。它属于**输入**而不是任务（没有 agent 在里面跑，进不了任务树、`task diff` 或分支图），所以 `task clear` 会连同它一起回收；锚点检出干净、分支顶端仍是锚定 commit 才删，被动过就整份留下并在返回值里说明。

### 输入缓存与任务依赖

输入可以先攒着：`lush draft add`（Web 输入框里回车）只写缓存、不规划；`lush draft edit ID '内容'`（Web 里点草稿正文就地编辑）改动某一条；`lush draft commit [ID...]`（Web 的「提交并规划」）把选中的草稿交给一个 planner——省略 ID 即提交整个缓存，给了 ID 就只提交这几条、其余继续留在缓存，由 planner 拆成多个任务、给互有先后的任务建依赖边，然后才创建任务 worktree 开工。缓存存库（`drafts` 表），换浏览器或重启 daemon 都不丢；提交后每条草稿留着 `input_id` 作为审计链（已提交的草稿不可改也不可再提交）。

依赖边由 planner 在派工时声明（`task spawn --depends-on ID[:code|order]`），daemon 只做结构校验：

- `code`（默认）：子任务的 worktree 从上游任务的分支拉出，因此看得到上游**未合并**的改动。代价是合并顺序——上游先合，下游才能合，`task merge` 会拒绝越级合并。
- `order`：只等上游结束，代码仍从这条输入的锚点（提交那一刻冻结的 commit）开始。适合等一个调研结论。
- 一个任务最多一条 `code` 依赖；依赖不能指向自己的祖先任务——祖先在等子孙结算，双方会互等而死。
- 依赖未满足的任务保持 `queued`，界面显示「等 #ID」；上游结算时由调度器唤醒，不占 agent 槽。
- 批与批之间不做语义冲突检测（重复劳动、改同一个文件）：那是 planner 读任务树自己判断的事，拿不准就问用户。

默认从 cwd 向上找到 `.lush/project.json` 或 `.git`，以那个目录为项目根。`--project PATH` / `LUSH_PROJECT` 可以显式绑定。目录会 canonicalize，符号链接不会创建第二个 daemon。不同 Git worktree 可作为不同项目独立运行；agent 在任务 worktree 内通过注入的 `LUSH_PROJECT` 始终连接所属项目。

### 运行前提

- 默认 agent 是 `pi`，需要在 PATH 中可用且已完成模型认证。可设置 `LUSH_PI_COMMAND`、`LUSH_PI_PROVIDER`、`LUSH_PI_MODEL`。
- 提交输入需要项目是 **Git worktree 根目录且有初始提交（且不能是 detached HEAD）**：拿不到「当前分支 + 已提交 HEAD」就无从锚定，`say` / `draft commit` 会直接报错且不落库。主工作树可以有未提交改动：worker 基于这条输入在**提交时**冻结的锚点开工（或 `code` 依赖的上游分支），看不到你未提交的编辑。这份分歧记进 `input.anchor` 事件的 `dirty_source`（开工时主树的状态记在 `workspace.created`），`task diff` 的 `base_behind` 给出基线落后目标分支多少提交。把 `.lush/` 加进项目的 `.gitignore`；Lush 不会替你提交、暂存或藏起已有改动，**合并时主工作树必须干净**。
- 非 Git 项目不能提交输入（也建不了实现 worktree）：提交前先 `git init` 并至少提交一次。
- `LUSH_PROVIDER=mock bun run start --project ...` 可离线演示调度。Mock 只派调研任务，不调用模型、不修改代码。
- 改环境变量或运行代码后用 `bun run daemon-restart`，不是再次 `start`。Web 是另一个进程：改完 `src/ui/web/` 用 `bun run web-restart`（它会先停掉端口上那个旧 Web）；`daemon-restart` 不会动它，而直接再跑 `bun run web` 只会撞端口。

## 新模型

概念分三层：**意图（intent）→ 拆解（spec）→ 任务（task）**。意图是用户原话加它的 planner 分析，planner 与 scheduler 都属于意图层、**不进任务树**（`task list` / `tree` / `timeline` 只画开发工作）；它们只在 `lush intent list` 与 Web 的「意图 · 待提交缓存」里出现。

```text
Project / 一个目录 / 一个 daemon
├── Intent #1（逐字保存用户原话）           ← 意图层（不进任务树）
│   ├── planner Task   拆解分析 → spec 队列
│   └── scheduler Task 把这一轮 spec 编排成任务
├── Intent #2 → 另一个 planner（无需等 #1 完成）
└── 任务树（只有开发工作）
    ├── coordinator Task
    │   ├── worker Task → 独立分支 + worktree
    │   ├── worker Task → 独立分支 + worktree
    │   └── research Task
    └── Notices（某个 task 等你做决定）
```

planner 不直接派活：它把每条可独立完成的工作写成拆解队列条目（`lush spec add`）。一个 planner 的**一轮拆解**（它这次 invocation 里写下的全部 spec）在它停下后作为**同一批**交给同一个 scheduler：批内没有依赖边的 spec 同时开工，批次之间串行。planner 觉得这次改动影响面大、与现状冲突、或没把握读准意图时，可以 `lush plan propose` 请用户先拍板——**批准**（`lush plan approve ID` / Web 卡片上的「批准并开发」）才交给 scheduler；**驳回**（`lush plan reject ID '理由'`）会让这一轮 spec 作废、理由送回 planner 并唤醒它重拆。默认不问，直接进入编排。

**Task 自己持有目标、角色、父任务、状态、结果、消息与工作区。**

- `planner`：快速理解意图，参考项目中已有工作，写拆解队列；不实施开发、不直接建任务。
- `scheduler`：把一批 spec 编排成真实任务（建依赖、建 worktree 基线），自己也不写代码。
- `coordinator`：拆分多级任务、收集结果、调整计划。
- `worker`：在独立 worktree 中实现、测试、提交。
- `research`：只读研究和审查。

默认并发上限就是一个池：`LUSH_CONCURRENCY`（默认 4）个 agent，planner / scheduler / worker 一视同仁。队列中的任务不占槽；`waiting` / `awaiting` 也不占槽；被依赖挡住的 `queued` 任务同样不占槽。多个输入的规划互不阻塞（各自一个 planner），越界或非法的依赖在**服务端**被拒绝。

子任务完成、父子消息、用户补充、notice 答复都会进入持久化收件箱，**在 invocation 之间交给 agent**，不硬打断正在执行的模型调用。消息只能沿直接父子边传递；用户可以给任一活动任务追加要求。

## Worktree 与合并

- 每个 worker 的 worktree 位于 `.lush/worktrees/<id>-<name>/`，分支名为 `lush/<项目路径哈希>/<id>-<name>`（`<name>` 是派工时 planner 给的英文短名，如 `fix-login-composer`）。id 保证唯一，短名说清任务做什么；共享 Git 仓库的不同项目不会争用同名 task 分支。省略 `--name` 时 runtime 从 goal 首行的英文词回退，提不出可用名字（例如纯中文 goal）才回到 `task-<id>`；名字只在 spawn 时定一次，之后不变。
- 每个 worker 从**提交这条输入时**冻结的锚点 commit 开始（见上面的「输入锚点」），除非它对另一个任务声明了 `code` 依赖：那时它的 worktree 从上游任务的**分支**拉出（stacked），于是能拿到上游尚未合并的改动。兄弟任务不会自动看到彼此的修改；无关的编辑应合在一个 worker 中。
- **分支谱系**（`lush branch tree`）回答的只有一件事：这条 branch 是从哪条 branch 创建出来的。runtime 在 `git worktree add -b` 的那一刻把它写进 `branches` 表：输入锚点写**提交输入时检出的分支**，`code` 依赖写**上游任务的分支**，解冲突任务写**目标分支**，其余任务写**这条输入的锚点分支**，并记下 fork commit（parent 之后往前走也查得到当时的起点）。**不用 merge-base 事后推断，也不用 commit graph 代替它**；合并永远不改写谱系，分支被删除只把记录标成 `[deleted]`，子分支的 parent 指针照旧有效。引入这个功能前就存在的分支默认显示为 `[?]`，`lush branch import` 只登记它们存在与当前 worktree，**不猜** parent。
- agent 最终输出作为 result。worker 必须提交改动、保持工作区干净；未提交就结束会失败，文件原样保留供检查和重试。
- 完成与合并是两个状态：`completed + pending` 表示已产出提交，**尚未进入主工作树**。
- 项目概览的**交付队列**与任务树分开：任务树回答谁在做什么；交付队列按 `target_branch` 分组，`code` 依赖显示成必须先落地的变更栈，`order` 只影响执行、不改变合并顺序。队列以原 worker 为稳定条目，解冲突 task 只是它的当前落地来源，不会出现原任务与 resolver 两个并列候选。每项明确显示阶段、是否就绪和阻塞原因；批量操作只允许一个目标分支，并在写主树前检查条目资格与集合外的 code 上游。
- `task merge ID` 检查任务完成、两边工作树干净（脏时错误列出具体文件）、目标分支未切换、待审阅 HEAD 未变化，然后串行执行 merge。**内容冲突不再是一句报错**：主树会 abort 回合并前，任务进入 `integration=conflict`，runtime 立刻开一个专用解冲突任务（`role=merger`）并提一条待决问题。答复即批准它开工（它在自己的 worktree 里以**目标分支顶端**为基线把那次审阅过的提交并进来、解冲突、提交、跑测试），忽略即撤销。原任务有活动 resolver 时不能从旁重试；结果完成后交付队列只允许审阅并落地 resolver。落地只用 `--ff-only`，因此目标树就是它测过的树。冲突未解决期间，同一目标分支上的其它合并被冻结。任何一次成功落地后，runtime 还会把已经随它进入目标分支的其它待交付提交自动对账成 `merged`，不留下“幽灵待合并”条目。
- merge 中断后标为 `review`，不自动重放。检查 Git 历史、处理遗留冲突并恢复干净工作树后，可重新执行 `task merge ID` 明确批准恢复；若提交已经合入，Git 会确认已包含，不重复改写历史。
- `task cleanup ID [--keep-branch]` 不使用 `--force`：worktree 拒绝未合并成果和脏工作区，取消/失败任务的提交也必须已经进入项目 HEAD 才允许清理。分支额外要求**顶端就是审阅过的那次提交**且它已经是 `target_branch` 的祖先，然后用 `git update-ref -d <ref> <tip>` 做 compare-and-delete——检查之后分支被谁动过就拒绝，`head_commit` 之外的提交一条也不会丢；不满足就把分支留下，并在返回的 `cleanup.reason` 里说明原因。`--keep-branch` 只回收 worktree，把分支单独留成恢复点。
- `task clear`（`bun run clear`，Web 项目概览里的「清空任务看板」）一键删掉**全部已结束任务**及其消息、通知、事件与 `inputs` / `drafts` 审计，并先按与 `task cleanup` 相同的安全门回收磁盘状态：能回收的连 `.lush/worktrees/<id>-<name>/`、检验对照检出、任务分支与每条输入的 `input-<id>-anchor` 一起删，返回值 `reclaimed` 给出 `{worktrees, branches, anchors}`。有 `queued`/`running`/`waiting`/`awaiting` 任务、或还有 invocation 在收尾时**拒绝执行**，不会隐式取消。回收不掉的任务（未合并成果、审阅后被改过的分支、脏工作区）连同目录与分支一起保留在磁盘上，`retained.tasks` 列出 `{id, branch, workspace, baseline_workspace, reason}`，被动过的锚点在 `retained.anchors` 里说明原因；`.lush/sessions/` 与检验报告不受影响。因为目录与分支名里带着 task id / input id，清空后 **id 不从 1 重新开始**，新任务与新输入不会撞上保留的旧目录。

## 常用开发命令

```bash
bun run help
bun run doctor
bun run start
bun run say '你的原话'       # lush intent '…' 是同义入口，同样不等待
bun run intents             # 意图列表：每条输入的 planner 拆解 / scheduler 编排进度
bun run propose '标题' --body '我打算这样拆'   # planner 专用：这轮拆解请你先拍板
bun run approve 40          # 批准（ID 可以是 planner task id 或那条 notice id）
bun run reject 40 '别动架构'  # 驳回：本轮 spec 作废，理由送回 planner 重拆
bun run specs               # 拆解队列：等 scheduler 编排 / 已编排 / 已丢弃
bun run tasks               # 默认前 200 条，只含开发任务（意图层见 intents）
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
bun run cleanup 3           # 回收 worktree 与分支（--keep-branch 只回收 worktree）
bun run clear               # 一键清空已结束任务并回收可安全回收的 worktree/分支
bun run branch tree         # 分支谱系（--verbose 带 task / worktree / fork / parent；见 docs/engineering/branch-genealogy.md）
bun run branch show 3       # 按 branch 名或 task id 查一条分支的 parent 与祖先链
bun run branch import       # 把旧项目里已有的本地分支登记成记录（只记存在，不推断 parent）
bun run wait 3              # 只有当前客户端等待，不影响调度
bun run web
bun run web-restart         # 改完 src/ui/web/ 换掉端口上那个旧 Web 进程（它不会跟着代码换版本）
bun run daemon-restart
bun run stop
```

任一命令都可以加 `--project PATH`。`--json` 输出机器可读结果。底层完整命令见 `bun run help`；内置 agent 后端只有 pi 与 mock。

## 状态、恢复与边界

状态目录固定为 `<project>/.lush/`：

```text
project.json       不可跨目录复用的项目绑定
project.db         SQLite：inputs / tasks / messages / notices / events / branches（task.clear 会清空任务相关的表，并把 task id / input id 高水位记在 meta；branches 是历史事实，不被清空）
sessions/          每个 task 的独立 pi session 与当前输入文件（thinking / 工具调用的原文）
worktrees/         worker 工作区、每条输入的锚点检出（input-<id>-anchor），以及检验期间临时的目标分支对照检出
verify/            每个 verifier 的自包含 HTML 检验报告
daemon.lock        项目 daemon 单实例锁
daemon.log         daemon 日志
```

socket 放在用户私有临时目录，名字由 canonical 项目路径决定，以避免长项目路径超过 Unix socket 限制。它只是通信端点；持久状态仍在项目内。`LUSH_HOME` 不是独立作用域：若保留该变量，必须恰好等于所选项目的 `.lush`，否则拒绝运行。

任务状态：`queued → running → waiting / awaiting / completed / failed / cancelled`。等待收到新消息后重新排队。终态任务不会保留活动子任务。取消或停止会终止 agent 进程组；重启对未知副作用的运行中任务标记失败，不自动重放；未开始的排队任务、待用户答复和记录保留。重试失败子任务要求父任务仍活动，否则重试父任务或提交新输入。

角色有 planner / coordinator / worker / research / verifier。verifier 是用户点「检验」时才创建的只读任务，它**不是**被检验任务的子任务（终态任务不能再挂活动子任务），而是独立根任务，用 `tasks.verifies_task_id` 指向被检验的 worker；父子不变的不变量不被破坏，界面上依旧挂在被检验任务下面。

**Task 与 agent 是终身一对一的身份。** 任务一创建就拥有一个 agent（`<role>#<task-id>`，例如 `worker#7`），跨唤醒不换身份：pi session、累计唤醒次数和上次动手时间都记在这个 agent 上，`task inspect` 与 Web 详情直接展示。但它的 RPC 凭证是每次唤醒重新签发的：daemon 只存 SHA-256，且只在该次 invocation 运行期间可解析，invocation 结束即作废，重启后一律清空。因此 1:1 指的是身份，不是进程或凭证——等待子任务或用户时 agent 依然存在，但不占执行槽、也没有活着的调用。

**这是可信用户工具，不是沙箱。** 目录绑定隔离的是 Lush 的数据库、RPC、调度和工作区管理，不是 OS 文件权限。pi 的 bash 仍拥有当前用户权限，角色约束主要依赖 agent 指令；应审阅改动，不向不可信用户暴露 socket，也不要让其他程序同时修改正在合并的工作树。公网 Web 必须启用 `.lush/web.json` 登录认证并使用 HTTPS，但这仍不把 agent 或宿主机变成面向恶意用户的安全沙箱。Agent RPC 用属于活动 invocation 的 token 限制所属任务，不能通过正常 agent 命令批准合并；这不是针对恶意本机进程的安全边界。

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

[架构](docs/engineering/architecture.md) · [命令与 RPC](docs/reference/api.md) · [文档](docs/README.md)
