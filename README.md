# Lush

**一丁点儿时间不浪费。**
**Not a single moment wasted.**

Lush 是项目级的多 agent 开发应用。一个 daemon 绑定一个项目目录；输入、任务、agent 会话、工作区与待决问题都属于这个项目。

你随时描述想法，并可指定任一本地父分支。Lush 立即创建 `input-<id>` 分支与 worktree，planner 在这份不可漂移的代码上解析；多项任务再从输入分支创建子分支并行工作。结果从叶子向输入分支逐层收敛，最后输入分支合回用户选择的父分支，**每一步都由用户明确批准且只做 fast-forward**。

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

`start` 只启动项目 daemon；`say` **立即返回输入和 task ID，不等待模型或开发完成**（提交时从 `--branch` 指定的本地分支、或当前分支创建 `input-<id>` 分支与检出，所以它短暂排在 Git 串行队列里）；Web 是独立的界面进程，不隐式启停 daemon，`bun run web` **后台起进程后立刻返回**（日志在 `.lush/web.log`）。Web 离线后会自动重连。默认只监听 `127.0.0.1`；如需从公网访问，在项目的 `.lush/web.json` 写入登录凭证：

```json
{
  "version": 1,
  "username": "your-name",
  "password": "a-strong-password-at-least-12-characters"
}
```

文件权限必须是 `600`。`bun run web` 会监听 `0.0.0.0`，首次启动时自动把明文 `password` 原地替换为 scrypt `password_hash`；之后浏览器通过登录页取得 12 小时的 HttpOnly / SameSite 会话 Cookie。密码首尾的空白一律忽略（从终端复制常会带上换行），但大小写与中间字符仍须完全一致：建议选一个**好辨认**的密码，避开 `0/O`、`1/I/l` 这类易混字符；连续输错 5 次会锁 60 秒。登录被拒与被挡的跨站请求都会写进后台 Web 自己的日志 `.lush/web.log`，是排查的第一站（`bun run web-status` 会告诉你它在哪、跑的是不是这份代码）。

**通过反向代理或域名访问时**，代理默认会把 `Host` 改写成 `127.0.0.1:4318`，而浏览器发出的 `Origin` 是对外地址；两者不一致的提交会被当作跨站拒绝（登录时报 `Cross-site access denied`）。二选一：

- 让代理保留原始 Host（推荐，nginx 写 `proxy_set_header Host $host;`）；
- 或在 `.lush/web.json` 里登记对外地址：`"origin": "https://lush.example.com"`（多个用 `"origins": [...]`）。

公网部署仍应在前面配置 HTTPS 反向代理，否则登录密码会在网络中明文传输。跨站请求判定以浏览器自己填的 `Sec-Fetch-Site` 为准（网页无法伪造它），`Origin` 只在旧浏览器没有这个头时作为回退；内嵌 webview、沙箱页面与部分隐私扩展会报 `Origin: null` 却依然是同源，这类客户端能正常登录。删除 `.lush/web.json` 即恢复仅本机、无需登录的模式。

Web UI（默认 `http://127.0.0.1:4318`）是 **Intent 优先**的项目工作台：左栏是导航，首屏是 **Intent 工作台**（目标、Plan 状态、待验收候选版本与结果入口、真正需要你决定的事）；分支图、待你决定、行动任务、Intent 记录、结构化 Plan 与文档分别在右侧独立成页。右侧顶部始终保留返回上一页的入口，页面地址使用 `#graph`、`#notices`、`#tasks`、`#intents`、`#specs`、`#task-ID`、`#docs` / `#doc-<id>`，浏览器前进 / 后退可以在各视图与任务详情之间往返。首页顶部指标按 Intent 计（Intent / 并行执行 / 等待验收 / 需要你决定），并用同一份 `graph.get` 读模型把 Git 交付诊断折叠在成果主线之后；候选行上的「打开结果」直接开 verifier 的 HTML 报告，验收动作用 `candidate.accept` / `candidate.changes`。任务详情以目标为标题，结果与执行过程优先。输入框常驻内容区底部；窄屏用「导航菜单」展开页面入口。右上角可切换**深色 / 浅色主题**，偏好保存在当前浏览器，首次访问跟随系统；过渡动画尊重系统「减少动态效果」。文档读的是随这份代码发布的 `docs/` 与 `README.md`（不随被开发的项目变），Markdown 相对链接可以直接点开，核心架构是一篇 standalone HTML（sandbox iframe）；刷新不丢已输入的答复。

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
lush branch archive lush/…/7-auth-ui  # 不要这条分支了：删 worktree 与本地 ref，任务、事件与会话留在库里
lush daemon stop
```

单条输入也可以用 `lush say '原话'` 立即提交，不等缓存。

### 两类输入：develop 与 explain

每条输入有一个流程判定（`inputs.flow`），由处理它的根 planner 用 `lush input flow develop|explain` 记录：

- `develop`：需要新增功能或改代码。照常拆解，派 coordinator/worker，可派 research。
- `explain`：只是了解、询问、解释相关内容。planner 直接把答案写进 result，必要时派 research；runtime 会拒绝 worker/coordinator，因此不会产生任务分支（提交时创建的输入分支仍提供稳定读取上下文）。

未判定（`flow` 为空）的输入按 `develop` 处理。用户随时可以改判：`lush input flow [TASK_ID] develop|explain`（agent 省略 TASK_ID 时判定自己的输入，Web 任务详情里也有「标记为开发/了解」），`lush input list` 会显示当前判定。改判只影响之后的派工，不会追溯取消已经建立的 worker/coordinator 子任务。

### 验收候选：Review Candidate

由 Plan 编译出的工作完成后，Integration Service 自动在私有 Intent 集成分支内叶子优先聚合（分歧时自动建 child-side merger），**不动用户目标分支**。收敛后 runtime 只冻结 integration commit 与 target baseline commit，创建一版 `pending` Review Candidate；不会自动派验收任务。只有用户显式执行 `candidate verify`（或在 Web 点击“开始验收”）才会派只读 verifier，在两边跑同一场景并生成自包含 HTML 报告。

```bash
lush candidate list --input 1
lush candidate prepare 1 --summary '一句话说明这版做了什么'
lush candidate verify 2                    # 用户显式启动验收
lush candidate inspect 2
lush candidate accept 2                    # 只落地你看过的那个 commit
lush candidate changes 2 '按钮再明显一点'   # 同一 Intent 下启动增量规划，产出 v2
lush candidate reject 2 --reason '方向不对'
```

接受前 runtime 会重新校验集成分支 tip 仍等于被审阅 commit，不再相等就拒绝并要求生成新版本；不会被 branch 漂移夹带未审阅内容。`candidate.*` 全部是用户专属命令。

### 检验：用最直观的方式看这次改动跑起来是什么样

单 worker 也可以单独检验（`lush task verify ID`，兼容入口）：派一个**只读 verifier**，它不是复查代码，而是想办法让用户直接看到结果：

- 读被检验任务的 goal 与 diff，自己判断「怎样才能最直观地说明这次改动成立」——跑测试、跑同一个命令对比输出、起服务看界面，方式由它按任务意图决定；可重复的命令与真实输出优先于主观描述。
- 在任务的 worktree 里跑一遍，再在 daemon 临时拉出的**目标分支对照检出**（`git worktree add --detach` 到 `.lush/worktrees/<id>-verify-N-base`）里跑同一场景，把两边并排呈现；基准本来就失败，就说明那是既有问题。
- 最后把结论写成一份自包含 HTML 报告（样式/脚本内联，图片内联为 `data:`）落到 `.lush/verify/<verifier-id>/report.html`，Web 详情里的「打开 HTML 报告」在一个新标签打开它。

verifier 与被检验任务是两个 task（worker 已经终态，不能再挂活动子任务），用 `tasks.verifies_task_id` 关联，界面上挂在被检验任务下面。同一任务同时只允许一次检验；`task.verify` 是用户专属命令，agent 不能用。对照基线是派生状态，检验一结算（成功或失败）就回收，报告保留在磁盘上；`task clear` 不会删它。

### Intent 分支：稳定上下文与聚合点

提交输入时可用 `--branch NAME` 选择父分支（省略时用当前分支）。runtime 创建 `lush/<项目哈希>/input-<id>` 与 `.lush/worktrees/input-<id>`；planner 就在这里解析。Plan 编译出的普通 worker 以它为直接父分支，完成后由 Integration Service 自动逐层聚合；全部收拢后才是 Review Candidate 可以出现的时刻。字段名为兼容旧库仍叫 `anchor_*`，但分支已经是可推进的聚合分支。

### 输入缓存与任务依赖

输入可以先攒着：`lush draft add`（Web 输入框里回车）只写缓存、不规划；`lush draft edit ID '内容'`（Web 里点草稿正文就地编辑）改动某一条；`lush draft commit [ID...]`（Web 的「提交并规划」）把选中的草稿交给一个 planner——省略 ID 即提交整个缓存，给了 ID 就只提交这几条、其余继续留在缓存，由 planner 拆成多个任务、给互有先后的任务建依赖边，然后才创建任务 worktree 开工。缓存存库（`drafts` 表），换浏览器或重启 daemon 都不丢；提交后每条草稿留着 `input_id` 作为审计链（已提交的草稿不可改也不可再提交）。

依赖边在 Plan 编译时由 runtime 从 planner 的 spec 依赖建立（`task spawn --depends-on ID[:code|order]` 仍是兼容入口），daemon 只做结构校验：

- `code`（默认）：子任务从上游任务分支拉出，并只合回这个直接父分支；从最深下游开始逐层向输入分支收敛。
- `order`：只等上游结束，代码仍从这条输入的锚点（提交那一刻冻结的 commit）开始。适合等一个调研结论。
- 一个任务最多一条 `code` 依赖；依赖不能指向自己的祖先任务——祖先在等子孙结算，双方会互等而死。
- 依赖未满足的任务保持 `queued`，界面显示「等 #ID」；上游结算时由调度器唤醒，不占 agent 槽。
- 一批 Plan 内没有依赖边的 spec 会同时开工；不同 Intent 的 Plan 也互不等待。
- 语义冲突（重复劳动、改同一个文件）不做自动检测：那是 planner 读任务树自己判断的事，拿不准就问用户。

默认从 cwd 向上找到 `.lush/project.json` 或 `.git`，以那个目录为项目根。`--project PATH` / `LUSH_PROJECT` 可以显式绑定。目录会 canonicalize，符号链接不会创建第二个 daemon。不同 Git worktree 可作为不同项目独立运行；agent 在任务 worktree 内通过注入的 `LUSH_PROJECT` 始终连接所属项目。

### 运行前提

- 默认 agent 是 `pi`，需要在 PATH 中可用且已完成模型认证。可设置 `LUSH_PI_COMMAND`、`LUSH_PI_PROVIDER`、`LUSH_PI_MODEL`。
- 提交输入需要项目是 **Git worktree 根目录且父分支有初始提交**。可用 `--branch NAME` 指定任一本地分支；未指定时 detached HEAD 会被拒绝。未提交改动不进入输入分支，并记录在 `input.anchor.dirty_source`；Lush 不替你提交、暂存或 stash。分支落地时，涉及的 child / parent worktree 都必须干净。
- 非 Git 项目不能提交输入（也建不了实现 worktree）：提交前先 `git init` 并至少提交一次。
- `LUSH_PROVIDER=mock bun run start --project ...` 可离线演示调度。Mock 只派调研任务，不调用模型、不修改代码。
- 改环境变量或运行代码后用 `bun run daemon-restart`，不是再次 `start`。Web 是另一个进程：改完 `src/ui/web/` 用 `bun run web-restart`（它先停掉端口上那个后台 Web，再按当前代码起一个新的）；`daemon-restart` 不会动它，而再跑一次 `bun run web` 只会如实报告「已在运行」。

## 新模型：Intent-first + Candidate-first，Branch-backed

产品主线是 **Intent → Plan → Work DAG → Run → Artifact → Review Candidate**。用户围绕目标和可验收结果行动；Branch / worktree 继续承担代码隔离、集成与恢复，但退回 Git 基础设施层。完整流程图、实体边界和设计原则见[核心架构 HTML](docs/core-architecture.html)。

```text
Intent（逐字保存用户目标）
  └─ planner Run → 结构化 Plan/spec
       └─ deterministic Plan Compiler（代码，不调用模型）
            ├─ WorkItem / worker Run → commit artifact
            ├─ WorkItem / research Run → finding artifact
            └─ WorkItem / verifier Run → evidence artifact
                 └─ Intent integration branch
                      └─ Review Candidate @ exact commit
                           └─ 用户接受 / 要求修改 / 放弃
```

planner 一轮写完 spec 后，runtime 在事务中直接编译根 WorkItem 与依赖边：不再创建 scheduler agent，没有全项目串行 batch，也不为机械 ID 翻译消耗模型调用。高风险计划仍可用 `plan propose` 建审批闸门；批准后由 runtime 编译，驳回则让 planner 带反馈重拆。

每次 provider invocation 都落成独立 `agent_runs` 行；结果同时形成结构化 Artifact。Task 暂时作为兼容的 WorkItem 投影，重试与唤醒不会覆盖 Run 历史。

- `LUSH_CONTROL_CONCURRENCY`（默认 2）：planner 等控制面调用；长 worker 不会饿死新输入规划。
- `LUSH_CONCURRENCY`（默认 4）：worker / research / verifier 等执行面调用。
- 等依赖、等子任务、等用户时不占槽。

开发工作完成后，Integration Service 自动把 Plan 编译出的 worker 分支从叶子向 Intent 私有集成分支聚合；父子分歧时自动创建子侧 merger。目标分支不会自动变化。聚合完成后系统冻结 integration commit 与 baseline commit，创建 Review Candidate 并生成前后对照 HTML 报告。用户最终接受的是这个精确 commit；若 branch 已移动，旧 Candidate 不能复用。

## Worktree 与合并

- 每个 worker 的 worktree 位于 `.lush/worktrees/<id>-<name>/`，分支名为 `lush/<项目路径哈希>/<id>-<name>`（`<name>` 是派工时 planner 给的英文短名，如 `fix-login-composer`）。id 保证唯一，短名说清任务做什么；共享 Git 仓库的不同项目不会争用同名 task 分支。省略 `--name` 时 runtime 从 goal 首行的英文词回退，提不出可用名字（例如纯中文 goal）才回到 `task-<id>`；名字只在 spawn 时定一次，之后不变。
- 普通 worker 从输入提交时冻结的 commit 创建，直接父分支是输入分支；`code` 下游从上游任务分支创建，并只合回这个直接父分支。兄弟任务互不偷看。
- **分支谱系**在 `git worktree add -b` 时显式记录。输入分支 parent 是用户指定分支，普通任务 parent 是输入分支，`code` 下游 parent 是上游任务分支，sync merger parent 是待同步 child。merge 永不改写谱系；已有但未登记的分支只显示 `[?]`，不能据此执行合并。
- agent 最终输出作为 result。worker 必须提交改动、保持工作区干净；未提交就结束会失败，文件原样保留供检查和重试。
- 完成与合并是两个状态：`completed + pending` 表示已产出提交，**尚未进入主工作树**。
- **Intent 工作台与 Review Candidate 是主要交付界面**；分支图保留为 Git 诊断界面。每条 fork 连线仍显示 ahead/behind、分歧、缺失与恢复动作。
- `branch merge CHILD`（图上的「合入父分支」）只把 child fast-forward 到 recorded direct parent；父分支未检出时用 compare-and-swap 更新 ref，已检出时要求 worktree 干净并同步 index/工作目录。
- 父子已分歧时用 `branch sync CHILD`。runtime 从 child tip 创建 merger 子分支，让 agent 合入冻结的 parent commit、在子侧解决冲突并测试；之后先 FF 回 child，再 FF 到 parent。父分支上永不直接 `--no-ff`，最终落地树就是测试过的树。
- 不再要某条分支的代码时用 `branch archive BRANCH [--discard]`（图上的「归档」）。它删掉该分支的 worktree 与本地 ref，但保留分支记录（`branches.status` 标 `archived`）、任务行、消息、事件，以及不随 worktree 消失的 pi 会话文件（`.lush/sessions/`）。归档明知可能未合并也允许删，因此是用户专属的显式动作；默认要求 worktree 干净，只有 `--discard` 才会连着未提交改动一起丢。与「证明已进入目标分支才删」的 `task cleanup` 不是一回事。
- `task merge` / 批量交付保留为兼容入口，最终遵循同一条 direct-parent / ff-only 规则；批量在首个分歧处停止。
- `task cleanup ID [--keep-branch]` 不使用 `--force`：branch tip 必须仍包含任务审阅提交，并且整个 tip 已进入直接父分支，才用 compare-and-delete 回收。聚合过子分支的任务分支也能安全清理，不会把额外提交当成漂移丢掉。
- `task clear`（`bun run clear`，Web 项目概览里的「清空任务看板」）一键删掉**全部已结束任务**及其消息、通知、事件与 `inputs` / `drafts` 审计，并先按与 `task cleanup` 相同的安全门回收磁盘状态：能回收的连 `.lush/worktrees/<id>-<name>/`、检验对照检出、任务分支与每条输入的 `input-<id>` 一起删，返回值 `reclaimed` 给出 `{worktrees, branches, anchors}`。有 `queued`/`running`/`waiting`/`awaiting` 任务、或还有 invocation 在收尾时**拒绝执行**，不会隐式取消。回收不掉的任务（未合并成果、审阅后被改过的分支、脏工作区）连同目录与分支一起保留在磁盘上，`retained.tasks` 列出 `{id, branch, workspace, baseline_workspace, reason}`，被动过的锚点在 `retained.anchors` 里说明原因；`.lush/sessions/` 与检验报告不受影响。因为目录与分支名里带着 task id / input id，清空后 **id 不从 1 重新开始**，新任务与新输入不会撞上保留的旧目录。

## 常用开发命令

```bash
bun run help
bun run doctor
bun run start
bun run say '你的原话' --branch main  # 从指定父分支创建输入分支；省略 --branch 使用当前分支
bun run intents             # Intent、Plan 编译与候选验收进度
bun run propose '标题' --body '我打算这样拆'   # planner 专用：这轮拆解请你先拍板
bun run approve 40          # 批准（ID 可以是 planner task id 或那条 notice id）
bun run reject 40 '别动架构'  # 驳回：本轮 spec 作废，理由送回 planner 重拆
bun run specs               # 结构化 Plan：待编译 / 已编译 / 已丢弃
bun run tasks               # 默认前 200 条，只含开发任务（意图层见 intents）
bun run tree
bun run inspect 3
bun run transcript 3        # 只看不写：agent 的思考、工具调用与输出
bun run usage 3             # 同一个 agent 的模型、上下文占用与累计花费
bun run lush candidate list # 查看固定 commit 的验收候选
bun run lush candidate prepare 1   # 为 Intent #1 生成候选与前后对照报告
bun run lush candidate accept 2    # 接受 Candidate #2 并合入目标分支
bun run lush candidate changes 2 '按钮再明显一点'  # 反馈进入同一 Intent 的增量规划
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
bun run branch import       # 把旧项目已有本地分支登记成记录（不推断 parent）
bun run branch merge lush/…/7-auth-ui  # ff-only 合回直接父分支
bun run branch sync lush/…/7-auth-ui   # 分歧时在子侧创建 merger
bun run branch archive lush/…/7-auth-ui  # 归档：删 worktree 与 ref，保留任务、事件与会话（--discard 才丢未提交改动）
bun run wait 3              # 只有当前客户端等待，不影响调度
bun run web                 # 后台起 Web（默认 4318），命令立刻返回
bun run web-status          # 在不在跑、跑的是不是这份代码、日志在哪
bun run web-restart         # 改完 src/ui/web/ 换掉那个后台 Web 进程（它不会跟着代码换版本）
bun run web-stop            # 停掉后台 Web；只停命令行确实是 Lush Web 的进程，别人的只报告
bun run daemon-restart
bun run stop
```

任一命令都可以加 `--project PATH`。`--json` 输出机器可读结果。底层完整命令见 `bun run help`；内置 agent 后端只有 pi 与 mock。

## 状态、恢复与边界

状态目录固定为 `<project>/.lush/`：

```text
project.json       不可跨目录复用的项目绑定
project.db         SQLite：inputs / drafts / tasks / task_specs / task_deps / agent_runs / artifacts / review_candidates / messages / notices / events / branches（task.clear 会清空任务相关的表，并把 task id / input id 高水位记在 meta；branches 是历史事实，不被清空）
sessions/          每个 task 的独立 pi session 与当前输入文件（thinking / 工具调用的原文）
worktrees/         worker 工作区、每条输入的聚合分支检出（input-<id>），以及检验期间临时对照检出
verify/            每个 verifier 的自包含 HTML 检验报告
daemon.lock        项目 daemon 单实例锁
daemon.log         daemon 日志
```

socket 放在用户私有临时目录，名字由 canonical 项目路径决定，以避免长项目路径超过 Unix socket 限制。它只是通信端点；持久状态仍在项目内。`LUSH_HOME` 不是独立作用域：若保留该变量，必须恰好等于所选项目的 `.lush`，否则拒绝运行。

任务状态：`queued → running → waiting / awaiting / completed / failed / cancelled`。等待收到新消息后重新排队。终态任务不会保留活动子任务。取消或停止会终止 agent 进程组；重启对未知副作用的运行中任务标记失败，不自动重放；未开始的排队任务、待用户答复和记录保留。重试失败子任务要求父任务仍活动，否则重试父任务或提交新输入。

角色有 planner / coordinator / worker / research / verifier / merger。planner 属于 control lane，只写结构化 Plan；没有 scheduler 角色（旧数据里的 `scheduler` 行仍可读）。verifier 有两条来源：用户点「检验」时的单 worker 对照（用 `tasks.verifies_task_id` 指向被检验的 worker），以及自动验收流程为 Review Candidate 创建的对照（用 `tasks.review_candidate_id`）。两者都是独立根任务，不是被检验任务的子任务（终态任务不能再挂活动子任务），父子不变的不变量不被破坏，界面上依旧挂在被检验对象下面。

**Task 与 agent 是终身一对一的身份。** 任务一创建就拥有一个 agent（`<role>#<task-id>`，例如 `worker#7`），跨唤醒不换身份：pi session、累计唤醒次数和上次动手时间都记在这个 agent 上，`task inspect` 与 Web 详情直接展示。但它的 RPC 凭证是每次唤醒重新签发的：daemon 只存 SHA-256，且只在该次 invocation 运行期间可解析，invocation 结束即作废，重启后一律清空。因此 1:1 指的是身份，不是进程或凭证——等待子任务或用户时 agent 依然存在，但不占执行槽、也没有活着的调用。

**这是可信用户工具，不是沙箱。** 目录绑定隔离的是 Lush 的数据库、RPC、调度和工作区管理，不是 OS 文件权限。pi 的 bash 仍拥有当前用户权限，角色约束主要依赖 agent 指令；应审阅改动，不向不可信用户暴露 socket，也不要让其他程序同时修改正在合并的工作树。公网 Web 必须启用 `.lush/web.json` 登录认证并使用 HTTPS，但这仍不把 agent 或宿主机变成面向恶意用户的安全沙箱。Agent RPC 用属于活动 invocation 的 token 限制所属任务，不能通过正常 agent 命令批准合并；这不是针对恶意本机进程的安全边界。

pi 默认禁用个人 extensions / skills / prompt templates / themes，保留上下文文件加载以遵循项目开发约定。daemon 意外被 SIGKILL 时可能留下外部进程；恢复不会重放任务，但仍应检查进程和工作区后再重试。

### 配置

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `LUSH_PROJECT` | 从 cwd 发现 | 显式项目目录 |
| `LUSH_PROVIDER` | `pi` | `pi` / `mock` |
| `LUSH_CONCURRENCY` | `4` | worker / research / verifier 执行槽 |
| `LUSH_CONTROL_CONCURRENCY` | `2` | planner 等控制面槽，不被执行面占用 |
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

[核心架构与完整流程图](docs/core-architecture.html) · [工程架构](docs/engineering/architecture.md) · [命令与 RPC](docs/reference/api.md) · [文档](docs/README.md)
