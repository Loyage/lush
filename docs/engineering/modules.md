# 模块地图（并行开发的边界）

这份文件是**拆分的契约**：`src/` 与 `test/` 里每个文件的职责与导出签名。目标只有一个——
让两个并行 worker 尽量去改不同的文件。粒度细到这个程度不是审美，是为了让「谁动哪个文件」可预测。

改名、搬家、换签名都先改这里，再改代码。

## 设计方向与执行记录接缝

修改模块前必须阅读[模块设计理念](../design/README.md)中的对应主题；执行记录相关改动先读[Agent 执行过程](../design/agent-process.md)，引用、选区引用与引用卡片定位相关改动先读[上下文引用与定位](../design/references.md)。

公开面以[核心 API 收敛](core-api.md)与 `src/rpc/registry.js` 为唯一白名单。本节下面提到的 `explanation.*` / `intro.*` 历史实现已经没有公开入口（注册表里不存在），保留在源码中只为读懂旧记录与后续清理；当前可用的执行记录接口只有 `task.transcript*`。

执行记录增量接口（具体约束见[阅读器](transcript-reader.md)）：
- 用户只读 `task.transcript_page(id,seq?,offset?)` / `GET /api/task/<id>/transcript-page`，从 `(seq,offset)` 连续读取未裁剪的步骤文字；每页最多 50 段、96,000 字符正文，单段最多 24,000 字符，返回 `next_seq/next_offset/has_more`。终端模式只读回放，不启动 Pi 或 PTY，不执行终端控制序列。
- `task.transcript` 是主读面：步骤增量保留 `call_id` / `tool_name` / `is_error`；同一会话内按调用 ID 配对。
- 用户只读 `task.transcript_latest(id,after?,before?,limit?)` / `GET /api/task/<id>/transcript-latest`：对 Task 全部会话做一次完整流式扫描，返回满足 `seq > after` 且 `seq < before`（默认 0 / 0 表示不设边界）的最新 `limit`（1..200，默认 100）步，按 `seq` 升序；每步的 4,000 字符裁剪与 `exact` / `batch` token 口径与 `task.transcript` 完全一致。返回 `next` / `oldest` / `has_older` 供 `before` 往回翻页，`truncated` 在单行超 16 MiB 时置真而不冒充空结果。
- 用户只读 `task.transcript_search(id,query?,kind?,tool?,errors?,after?,limit?)` 与 `task.transcript_step(id,seq,offset?)`：前者跨完整 Task 会话检索、分页摘要，后者按步骤读取分段原文及关联上下文；HTTP 用 `/api/task/<id>/transcript-search`、`transcript-step`。
- 终端跟随不新增 RPC：`lush task transcript ID [--after N] --follow` 先按 `task.transcript` 分页打印已有记录，再用 `task.transcript_latest` 以游标轮询新步骤，直到 Ctrl-C；仅用户可运行，`--json` 不适用。

## 三条规矩

1. **入口路径不变。** `src/core/project.js`、`src/core/workspaces.js`、`src/persistence/store.js`、
   `src/rpc/protocol.js`、`src/ui/web/assets/app.js`、`src/cli/main.js` 仍是各自的入口，必须继续
   导出与今天完全相同的名字（`Project` / `Workspaces` / `Store` / `Dispatcher` / `main` / `HELP`…），
   所以 `src/index.js`、`bin/`、`test/helpers.js` 与现有测试都不必跟着改。实现细节住进同名目录。
2. **组装方式是 mixin，不是继承链。** 每个职责模块导出**一个方法对象**，方法体里照旧用 `this`；
   入口文件把它们的原型属性合并进来，并在合并时查重名（重名＝拆分出错，立刻抛错，不静默覆盖）。
   这样搬家只是剪切粘贴，方法体一行都不用改，`this.store` / `this.running` 照旧。
3. **一个分区只改自己分区里的文件。** 分区见下；跨分区要改的东西，先在 `docs/engineering/modules.md`
   里加一条接口，而不是直接伸手。

## 当前公开面

精简后的 RPC / CLI / Web 白名单以[核心 API 收敛](core-api.md)和 `src/rpc/registry.js` 为准：`system.*`、`agent.*`、`say.submit`、`task.*`（含 `spawn` / `integrate` / `reserve` / `resolve*` / `unreserve` / `approve_merge` / `message` / `cancel` / `retry` / `cleanup` 与只读读面）、`progress.*`、`notice.*`、`branch.tree/show/bind/archive`、`graph.get`。CLI 只注册 `daemon` / `status` / `doctor` / `log` / `web*` / `say` / `task` / `progress` / `notice` / `branch` / `agent` / `config`；其余命令模块（draft / intent / spec / plan / candidate / showcase / sleep）不再挂载，handlers 中未列入白名单的方法一律返回 `unknown method`。

以下仍是可调用的公共面：

- CLI 命令与 `lush help` 的语义。`lush config [show]` 打印运行设置的生效值 / 环境默认值 / 是否被覆盖与设置文件路径，`lush config set concurrency|control-concurrency|call-timeout|task-call-limit|max-depth N` 写回，`lush config reset [concurrency|control-concurrency|call-timeout|task-call-limit|max-depth|all]` 清除覆盖；`--json` 输出与 `system.status.settings` 同一份结构化读模型。两端都是用户专属，agent 调用被拒。命令面用连字符（`control-concurrency`），设置文件与 RPC 里是下划线（`control_concurrency`）。
- SQLite schema、表名、列名与 `meta.task_id_high` / `meta.input_id_high` / `meta.overview_revision` 的行为。`overview_revision` 由读模型相关表的触发器单调推进，技术聚合表 `overview_task_counts` 由 Task 触发器维护精确 layer/status 计数，首页用两者做 O(1) 失效与统计（它不是业务实体）。`tasks.progress_plan` 附属 JSON 保存 versioned 计划，读模型统一投影为 `progress`（有 `agent_runs` 时按调用区间重算工作用时，并把非 running 的等待投影成一条 `kind:'wait'` 条目；不改写存储的 `progress_plan`）。`agents` 之外的新核心表（`agent_runs` / `artifacts`）承载每次调用与结果；`artifacts.payload` 使用同一 JSON 文本列，`run.result` 是 version 2 envelope，分开记录 invocation 完成与 `pass` / `fail` / `partial` / `unverified` 验收结论；`pass` 必须没有 `failures` / `unverified`，但可以保留 `baseline_failures` / `residual_risks`；旧 payload 不重写，读取时缺失或自相矛盾的证据明确投影为 `unknown`。历史表（`inputs` / `drafts` / `task_specs` / `review_candidates` / `introductions`）与列（`branches.showcase_reservation` / `branches.merge_run` / `tasks.review_candidate_id` / `tasks.retry_profile`）只加不改、不重写已有行，且不再有新的公开写入口。
- `src/index.js` 的导出、`bin/*` 的行为。
- Web 路由与 asset 路径：`server.js` 只按 basename 服务 `assets/` 下的 `.js` / `.css`，
  所以**新增前端模块不需要改 server.js**。带 `--project` 的单项目 Web 继续用无前缀的 `/api/**`；无 `--project` 的全局工作台改为**每项目一条稳定身份路由**：`/p/<project-id>/**` 下的页面、GET 与 `POST /api/action` 都按请求自带的项目身份解析（ID 由 canonical 路径派生，只在已登记集合里反查，不把 URL 片段当路径），`GET /api/snapshot` 因此不再有可被别的标签页切换的「当前项目」。宿主级路由留在无前缀：`GET /api/host`（模式、已登记列表、上次打开）、`GET /api/host/projects`（仅探测已登记目录的 lushd，返回 `running` 与有界摘要；不启动项目）、`POST /api/host/select`（登记并连接，返回路由 ID，不设全局当前项目）、`POST /api/host/remove`（只删入口并断开 Web 连接），以及「文档」视图的 `/api/docs`、`/api/docs/search-index` 与 `/api/docs/<id>`——数据源是 `src/ui/web/docs.js`，只读随代码发布的 `docs/**/*.md` 与 `README.md`，与当前项目目录无关，只按扫出来的 id 查表命中。项目读取与写动作的完整白名单见[Web 路由](../reference/web-routes.md)（`CORE_READS` / `CORE_TASK_READ` / `CORE_DOC_READ` / `MUTATIONS`）。认证边界也在 `server.js`：项目绑定模式读取 `.lush/web.json`，全局启动器读取用户配置目录的 `web.json`；无对应配置时只监听本机，有配置时监听公网，并用 `/login`、`/logout` 与 HttpOnly 会话 Cookie 保护全部页面、资源和 API。全局公网配置必须额外提供 `projects` 绝对路径白名单，且项目注册表不允许把白名单外的路径解析成可访问身份；本地无认证启动器仍可输入任意现存绝对目录。
- 前端项目身份在 `src/ui/web/assets/route.js`：从 `location.pathname` 读 `/p/<id>/`（读不到就是单项目模式或全局根），`api.js` 用它给项目 API 加前缀，启动器与文档等宿主级资源不加；折叠 / 筛选 / 排序与分支图折叠按项目隔离在 `prefs.js` / `state.js`，主题等外观偏好共享。项目列表与切换在 `project-picker.js`：已在一个项目页时用新标签打开别的项目，切换项目不会清空当前标签的输入。
- Web 按钮帮助走 `data-help`：含义不直观的按钮都带提示，会调用 Agent 的按钮另带 `agent-call` 类与 `agentHelp()` 生成的文案，禁用按钮由外层 `.help-host` 承载；前端实现与三种输入方式见[按钮帮助与 Agent 触发标识](../design/ui-guidance.md)。
- Host 的项目连接与按需启动在 `src/host/project-host.js`；全局项目登记状态在 `src/host/registry.js`：用户配置目录中的 `launcher.json` 是 v2，存 `last_project` 与已登记的 `projects` 路径列表（读 v1 时把 `last_project` 提升为登记项），只把上次打开当作**新窗口首次落点**，不再决定任何页面的请求目标；同目录的可选 `web.json` 独立保存全局启动器认证、可信 Origin 与项目白名单；两者都不是业务事实也不是 `LUSH_HOME`。`projectRouteId(path)` 由 canonical 路径派生 16 位十六进制 ID，同一路径稳定、不同路径不可混同；服务端只用它在已登记集合里反查路径。macOS / Linux / Windows 分别遵循各自用户配置目录。Electron 桌面壳使用独立随机端口复用同一 Web server 与 assets，始终只监听回环且不读取全局公网认证；关闭时只停自己的临时 Web host，不停项目 daemon，因此可与后台 Web 同时打开。
- Web 进程的生命周期在 `src/host/control.js`：`webListenerPids(port)` 认出端口上的监听者，
  `webOwners(config, port)` 把端口与 `.lush/host.state.json`（后台 Web 自己写的 pid / 端口 / 代码指纹）
  合起来给出「谁在听、命令行是不是 Lush Web」，`stopStaleWeb(port)` 只停命令行确实是 Lush Web 的进程
  （`bin/lush-host` / `ops.js host`，先 SIGTERM、超时才 SIGKILL），`busyPortHint(port)`
  在端口被别人占着时把命令行原样报出来。`bun run host` 就是「后台 spawn `bin/lush-host` + 等它占住端口」
  （`waitForWebState`），`host-restart` 就是「停下旧的 + 后台起一个新的」；Web 进程不会跟着代码换版本，
  这是换版的正路。`doctor` / `host-status` 只读这些状态，把当前磁盘、daemon、Web 的代码目录 / 版本 / 指纹
  分开报告；不一致只产生带项目与端口的更新提示，不触发重启。
- 环境变量与 agent capability 语义（`LUSH_PROJECT` / `LUSH_HOME` / `LUSH_TASK_ID` / `LUSH_AGENT_TOKEN`）。`LUSH_TASK_ID` 是与当前 agent 直接绑定的 Task，不是 Task 树上的 `tasks.parent_id`；进度 RPC 仍以一次性 token 解析出的 actor 为准，不信任环境变量中的 ID。项目级 Agent 配置固定写在 `<project>/.lush/agent.json`：默认配置 + planner / coordinator / worker / research / verifier / merger / showcase / explainer / butler 九类角色覆盖（专用角色不再有公开创建入口，但配置读取与历史调用仍可用）；写入原子替换，运行中的 invocation 不打断，下一次调用动态读取并生效。每份 profile 分 `default_prompt` 与 `append_prompt`：前者非空时替换该角色的内置组合（UI 明确警告能力、权限与交付协议可能失效），后者追加在共享/本机文件补充之后；旧 `prompt` 字段按 `append_prompt` 兼容读取。内置规则由 `PROMPT_PARTS` 按角色组合；再叠加可提交的 `.lush-agent/{common,ROLE}.md` 与本机 `.lush/agent/{common,ROLE}.md`。Agent 子进程环境在 daemon 环境之上热加载 `.lush/agent/agent.env` 和角色 env，`LUSH_*` 不可覆盖；Web 键值编辑器把文件规范化为 owner-only 的 `NAME="value"`，空表删除对应文件。profile 另存 `extensions` / `skills` 路径列表，只给普通 Pi invocation 以显式参数加载，Codex 与无工具 explainer / butler 保留配置但不使用。
- 项目级运行设置固定写在 `<home>/settings.json`（version 1，权限 `600`），唯一读写入口是 `src/core/settings.js` 的 `RuntimeSettings`；目前有数字键 `concurrency`（1..64）、`control_concurrency`（1..16）、`call_timeout`（1..86400）、`task_call_limit`（1..1000）、`max_depth`（1..64），`null` / 缺键表示回退默认。`LUSH_CONCURRENCY` / `LUSH_CONTROL_CONCURRENCY` / `LUSH_CALL_TIMEOUT` / `LUSH_TASK_CALLS` / `LUSH_MAX_DEPTH` 只提供各自的默认值；daemon 启动时读出生效值，运行时写盘后同步内存并重新准入，不需要重启。历史设置键 `input_routes` 与旧提交路径一起保留在文件中，但不再有公开写入口，也不影响新 say。
- `src/core/genealogy.js`（分支谱系的纯逻辑：`buildForest` / `pruneHidden` / `parentOf` / `childrenOf` / `ancestorsOf` /
  `descendantsOf` / `rootOf` / `chainOf`）与 `types.js` / `naming.js` 一样是共享纯模块：不碰 git、不写盘、
  不渲染，只被 `project/branches.js` 与 `test/branch-tree.test.js` 使用。`naming.js` 导出 `slugify` /
  `taskSlug` / `taskLabel` 与 `inputLabel(id)`（历史输入聚合分支的 `input-<id>` 名）。

当前接缝（尚未完成全类型统一）：新式 say/child 的 Git 基线在创建时固定，say 以输入时选定的父 ref 建 worktree，child 派生时在 Git 串行队列里立即从父分支 tip 建 worktree；analysis 创建时固定只读 detached worktree。showcase / 其它专用 Task、旧 Task 与额外绑定的 owner 根 Task 尚未迁入统一 fork 创建路径。`commit_contexts` 是项目本地的提交→Pi session/entry 附属索引；Agent 的 `git commit` 成功后记录当时可复用的上下文指针，外部提交没有指针时子 Pi 从空会话起步。子 Pi 首次运行用固定 entry 截出的 checkpoint 调 `--fork`，后续 invocation 继续自己的会话。旧 task/commit 不回填。

## Task 图与固定输入规则

`task.graph` / `/api/task-graph` 是以 Task 父子关系为边的有界读面；Web 的 `#task-graph` 为主视角，原 `#graph` 分支图保持独立入口与原操作。Task 卡片按真实状态配色，读面投影 `branch_info.subtree_say` / `branch_info.merge_run` 作为交付诊断；旧 `branch.orchestrate_plan` / `branch.orchestrate` 一键编排入口已下线。新 say 从已提交 fork 读取 `.lush-task/input.mjs` 并冻结在项目 `.lush/task-rules/`；用户后续消息由固定规则返回 `message` 或安全点软抢占的 `interrupt`，失败回退并留事件。子 Task 继承直接父的规则快照。可信代码风险与读面边界见 [Task 图与固定输入规则](task-graph.md)。

## 页面导航与全类型 Task 列表

- Web 采用平级页面，分组只组织导航：工作（Task 图、项目概览、待我处理、Task 列表）、交付与用量（分支与合并）、其他（设置、帮助文档）。Task 详情归属 Task 列表，文档正文归属帮助文档。
- `sidebar-ui.js` 统一页面切换、路由地址、唯一选中项、视图栏、移动端收起与加载占位；`ui.view` 为当前页面身份，异步读面用身份检查阻止迟到响应覆盖新页面。概览导航先画缓存，不依赖 revision 变化或轮询空闲。
- `task.activity(limit?,scope?)` / `task.page(before?,limit?,scope?)` 增加 `scope='work'|'all'`，省略保留旧 work 口径；Web overview 与历史分页显式请求 all，覆盖 intent/work 两层，继续有界读取，不改 Task 实体或存储层级。`GET /api/tasks` 透传 scope；类型筛选固定提供全部现行角色，兼容历史 scheduler 与未知角色，筛选范围明确为已加载 Task。

## 分支诊断增量读面

- `graph.get` 的 branch 节点增量提供 `diagnostics`：`changes` 以登记的 `created_from_commit` → 当前固定 tip 统计已提交净改动（文件总数、文本增删行、二进制文件数及有界文件列表），`latest_commit` 给出 tip 的提交时间与摘要，`working_tree` 单独统计实际检出该分支的工作区未提交文件数（暂存 / 未暂存 / 未跟踪 / 冲突，分类可能重叠）。无起点、无 ref、未检出与读取失败不能冒充零。
- Git 边界 `workspaces/diff.js` 新增 `branchDiagnostics(branches)` 批量读面：只读 Git、禁用外部 diff/textconv，固定提交结果有界缓存；文件列表每分支最多 50 项且 JSON 不超过 2 KiB，截断不影响汇总。无新表、无新 RPC 方法；Web 用既有图轮询，并保留文件列表展开状态。

## 新式 Task 的自动合并（version 2）

新式 say / child 的 `task.reserve {kind:'merge'}` 创建 version 2 预约：运行中只保存意图，轮末安全点、子任务结算、工作区干净且有提交时发幂等 `merge.requested` 信号；请求后原 Task 静息冻结。父 Task 创建/复用 `task_kind='merge'` 子 Task，先留带原父 ID 的审计事件，再把请求 Task 的 `parent_id` 改成 merge Task；Git 的 `target_branch` 仍是创建时的直接父分支，不改写分支谱系。merge Task 是 runtime 驱动的串行队列，不启动不受限 Provider；队列空闲时结算身份，后续请求可重开。源/目标可快进时将源树 Squash 为父分支上的**一条提交**（不是把源的 Git 提交逐个快进）；分歧时重新唤醒原 Task，在自己的分支吸收固定父提交，完成后重新排队。main / owner 也由该队列自动推进，不需旧 `task.approve_merge`。Git 和 DB 分阶段，恢复时只对比精确原父、树与提交标题，绝不重放未知副作用。合并后验证源树等于已落地树、ref 未漂移且工作区干净，删 worktree 与源 ref，保留 Task / 事件 / 原哈希；检查失败保留磁盘现场和错误，允许安全重试归档。历史 version 1 请求继续走原来的用户/父 Agent 手动路径，不迁移旧记录。

## 交付锁与合并编排（历史 version 1）

- 新的 Task 中心交付只走固定提交：合并预约（`tasks.reservation`，`kind='merge'`）在静息、后代结算、工作区干净且可快进时冻结源 `commit` 与父 `baseline`，向父 Task 发去重请求；父为 say 时由运行中的直接父 Agent `task.integrate` 确认，父为 main/owner 时由用户 `task.approve_merge` 批准。请求未解决时父分支受交付锁保护。
- `src/core/branch-freeze.js` 从已有事实现算分支写冻结：任何未结束的解分歧 Task 冻结其目标分支 + 全部后代 + 其直接父分支；已发出但尚未集成的 say 合并请求（`reservation` 里 `kind=merge`、`status=requested`）冻结其 `target_branch` **本身**（不冻结请求者与兄弟 say 自己的分支）——请求已经把父分支基线固定成那个 commit，父分支再前进就只能作废重做。交付锁同时保证同一个父分支一次只接受一个未集成请求：`settleReservedMerge` 见到别人的交付锁就保持 pending 并记 `parent_locked`，`integrateChild` / `approveReservedMerge` 只允许锁持有者自己落地。冻结拦截新建 say、`task.retry` / `task.cleanup` / `branch.archive`；`task.cancel` 保持可用（释放路径）；源分支带着未集成请求时 `branch.archive` 也拒绝（删了它父分支的交付锁就永远没有落地对象）。冻结经 `status.branch_freeze` / `status.merge_runs` 与 `graph.get` 的 branch 节点 `freeze` / `merge_run` 下发。
- 旧的一键合并（`branch.merge_all`）与合并编排（`branch.orchestrate*`）不再有公开入口；`project/merge-all.js` 与 `project/orchestrate.js` 的内部实现及 `branches.merge_run` 列保留，只为读懂历史行与后续清理。

## Notice 提醒与历史接缝

- 保留 `notice.list` 兼容读面，新增 `notice.page(status?,before?,limit?)` 与 `GET /api/notices`：按 ID 降序分页，status 为 `all|open|answered|dismissed|sent`，返回 `{notices,cursor,has_more,limit}`。不删除或重写既有 Notice。
- 「待我处理」按需查询全部类型的 Notice，未处理项可直接答复／审批，历史只读；首页仍用有界快照。通知仅针对新增的 open 决策事项，首次加载不补发历史。
- `notice-notifications.js` 负责浏览器 Notification 与桌面 IPC 适配，默认关闭；授权只由用户开启时触发，失败不影响轮询和留档。开关属于当前客户端，桌面保存在 Electron userData（不受随机端口影响）。窗口关闭后不提醒，不引入 daemon 后台推送。

## Token 效率接缝

实现约束与历史归因口径见 [Token 效率与用量归因](token-efficiency.md)。

- `project/context.js` 的 `invocationContext(task,run)` 只投影直接父子、依赖、用户引用与专用角色上下文；不注入全局最近 Task。关联摘要有界且明确截断，完整内容通过既有 `lush task inspect` 读取。`provider.js` 启动 JSON 使用多行格式，剔除凭证 hash 与重复 prompt 配置。
- 安全抢占（`scheduling.requestPreempt`）：**只由用户追加输入触发**（`task.message` 且 `sender===null`），且只在有可验证安全边界的后端生效（目前只有 Pi）。它在 `<home>/preempt/` 写一次性 request；`agent/pi-runtime.js` 在 `turn_end` 写 stop 标记并让本轮收尾。`provider.js` 关进程后读一次双向标记并抛 `AgentPreempted`；`invoke` 据此把这次 run 记成 `preempted` 并把 Task 放回 `queued`/`waiting`，写 `invocation.preempted` 事件，**不**调 `cancel()`。超时与 `task.cancel` 仍走硬杀路径并如实标成失败/取消。
- 普通子 Task 成功结算只在全部子 Task 终态后唤醒；失败、取消、显式消息仍及时处理。延迟消息保留未读，所有收尾/恢复路径共用 `hasActionableMessages(taskId)`，避免空转和 lost-wakeup。
- Agent profile 增加可选 `soft_budget:{responses?,tokens?}`：正整数，空对象/缺省关闭。仅普通 Pi 支持；Codex 和 explainer 明确拒绝启用。内置 `agent/pi-runtime.js` 扩展记录 invocation 身份，按本次响应累计用量，在达到阈值后下一次自然模型调用前仅提醒一次收尾；不强制停止、不额外启动模型轮次。
- CLI `task list --brief` 返回短目标与分页提示；`progress` 默认只回简短确认，`--json` 保留完整读模型；`doctor` 默认省略完整 daemon 配置，`--verbose` 恢复详细输出。

## 分区总览

| 分区 | 入口 | 细粒度模块 | 独立可并行 |
|---|---|---|---|
| Task 编排 | `src/core/project.js` | `src/core/project/`（含 say、预约、集成、生命周期） | ✅ |
| Git 边界 | `src/core/workspaces.js` | `src/core/workspaces/`（5 个） | ✅ |
| 持久化 | `src/persistence/store.js` | `src/persistence/store/`（含分支、run 与引用元数据） | ✅ |
| 前端 | `src/ui/web/assets/app.js` | `src/ui/web/assets/`（见下表） | ✅ |
| CLI | `src/cli/main.js` | `src/cli/`（含 Agent 配置命令） | ✅ |
| RPC | `src/rpc/protocol.js` | `src/rpc/`（7 个） | ✅ |
| 测试 | `test/*.test.js` | `test/<分区>/*.test.js` | 依赖上面六个落定后 |

前六个分区 **互不共享文件**，可以同时开工。测试分区要等它们落地，否则测的是半成品。

新 Task 的预约是 `tasks.reservation` 可空 versioned JSON 附属状态：仅 say Task 可设置 `merge` 的一个 pending 意图，同类重复幂等；User-only `task.reserve` / `task.unreserve` 与 Event 同事务。`merge` 预约只在 say 静息、工作区可检验且子 Task 已结算时冻结提交与直接父基线，在结算事务内写一次父 Task 信号并结束源 Task；用户另用固定 commit + baseline 批准 main/owner 的快进，Git 串行区内复核双方 ref。同类重复 `task.reserve` 不重建预约，而是显式重查 pending 状态：执行屏障、未读消息和子 Task 等待原因也记在 `blocked_reason`，成功后由结算事务清掉；Web 的「复查预约」与 CLI 原命令共享此路径，不自动轮询外部 Git 变化。User-only `task.resolve` 另给无代码改动的 say 一个与取消区分的收尾：工作区干净、分支无新提交、没有活动 Agent/请求时以 `completed` + `integration='none'` 结算并保留 `result`，不移动任何 ref；有提交仍须走 `task.reserve` 或 `task.cancel`。

daemon 启动在 project identity/Store 建立后、RPC 开放前幂等执行 `Project.bootstrapMain()`：只有本地 main ref 存在才确立唯一静息 main Task；无 main 时保持 daemon 可用、首次新 say 给明确错误，不自动造 ref，也不触发 provider。恢复仍保留未知副作用不重放。

显式分支绑定：用户选定本地 `BRANCH` 与当时的 `HEAD COMMIT` 后，`branch.bind` 为非 main 且尚无新 Task 所有者的分支创建独立、永不执行不受限 provider 的静息 `task_kind='owner'` 根 Task。旧分支记录和旧 Task 不回写；`branch.tree/show` 派生的新 owner 投影覆盖旧 task_id 的当前所有者显示，历史仍可按旧 Task id 查看。无绑定的新 say 继续拒绝，不猜祖先。

新 say 入口增量：`say.submit(content?,branch?,references?)` 与旧 `input.submit` 分开，后者不再有公开入口；新 Input 直连 `role='agent'`、`task_kind='say'` 的 Task，main 是 `task_kind='main'` 的静息根 Task。`tasks.task_kind` 只加列不重写历史；新提交必须先校验父分支有明确的 Task 所有者。实现职责放 `src/core/project/say.js`、现有 Git 边界与 Store，不新增全局调度器。

新 Task 子代码只允许执行中的直接父 Agent 经 `task.integrate {id,commit}` 确认固定 child HEAD 并在 Git 串行锁下 ff-only 快进至父分支。新 say 的 pending merge 请求若与直接父分支分歧，用户可 `task.resolve_divergence {id}` 创建一个独立 child（基线固定为源 tip，目标固定为源 say 分支，Task 目标要求合入当时固定的父 tip 并测试）；活动 say 的 child 挂在其子树下，由 `task.integrate` 确认。父 say Agent 收到子 Task 完成信号后用 `task.integrate` 确认固定 child commit；该确认额外校验 child commit 同时含最初源/父 tip，之后用户复查预约或自然轮末重新按最新父 tip 准入。兄弟子 Task 先落地或父分支自己提交后，已完普通子 Task 的固定提交同样不再能快进：执行中的直接父 Agent 用 `task.resolve_child_divergence {id}` 从该固定提交拉起同构的解分歧子 Task，解分歧后仍由 `task.integrate` 确认。`task.integrate` 不能推进 main；父分支不干净、HEAD 漂移、子 Task 未结算或有未集成后代时保留现场并拒绝。实现放 `src/core/project/say.js`，Git 写入复用 `workspaces.mergeBranchUnsafe`。

Task 中心输入的持久信号增量：`messages` 增加可空 `signal_type` / `signal_key`（旧自由文本消息不变），`(task_id,sender_id,signal_key)` 部分唯一索引保证子→父同一次信号只写一条；`Store.signal()` 与 `Project.sendTaskSignal()` 只供 runtime 内部使用，事务同写 Event/Message，先落库后唤醒。边界见[Task 中心输入](task-centered-input-design.md)和[一次 invocation](invocation.md)。

问卷决策沿用 Notice，不新增表或实体：`src/core/questionnaire.js` 负责严格校验与答案规范化，`Project.notice` 保存 `kind='questionnaire'`，调度器通过 `questionPending` / `parkForQuestion` 暂停并恢复 invocation；Web 端由 `render-questionnaire.js` 渲染，预览路由使用 `notice-preview.js` 的独立 CSP 清洗 HTML。

## 分章地图

模块清单仍以本页为唯一入口，细表拆成三篇短章：

1. [Runtime 与持久化](modules-runtime.md)：Agent provider、Project、Workspaces 与 Store。
2. [Web 前端](modules-web.md)：浏览器模块、渲染职责与导出。
3. [CLI、RPC 与测试](modules-interfaces.md)：命令、协议与测试分区。

跨分区改动先从这里确认边界，再进入对应细表；新增或移动文件时必须同步更新所属章节。

---

[下一篇：Runtime 与持久化 →](modules-runtime.md)
