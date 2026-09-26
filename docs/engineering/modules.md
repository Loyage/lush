# 模块地图（并行开发的边界）

这份文件是**拆分的契约**：`src/` 与 `test/` 里每个文件的职责与导出签名。目标只有一个——
让两个并行 worker 尽量去改不同的文件。粒度细到这个程度不是审美，是为了让「谁动哪个文件」可预测。

改名、搬家、换签名都先改这里，再改代码。

## 设计方向与执行记录接缝

修改模块前必须阅读[模块设计理念](../design/README.md)中的对应主题；执行记录相关改动先读[Agent 执行过程](../design/agent-process.md)，引用、选区引用与引用卡片定位相关改动先读[上下文引用与定位](../design/references.md)。职责表回答“改哪里”，理念回答“为什么这样改”。

执行记录增量接口（具体约束见[阅读器](transcript-reader.md)）：
- 新增用户只读 `task.transcript_page(id,seq?,offset?)` / `GET /api/task/<id>/transcript-page`，从 `(seq,offset)` 连续读取未裁剪的步骤文字；每页最多 50 段、96,000 字符正文，单段最多 24,000 字符，返回 `next_seq/next_offset/has_more`。终端模式只读回放，不启动 Pi 或 PTY，不执行终端控制序列；旧搜索与步骤 API 兼容保留。
- 原 `task.transcript` 保持兼容，步骤增量保留 `call_id` / `tool_name` / `is_error`；同一会话内按调用 ID 配对。
- 新增用户只读 `task.transcript_latest(id,after?,before?,limit?)` / `GET /api/task/<id>/transcript-latest`：对任务全部会话做一次完整流式扫描，返回满足 `seq > after` 且 `seq < before`（默认 0 / 0 表示不设边界）的最新 `limit`（1..200，默认 100）步，按 `seq` 升序；每步的 4,000 字符裁剪与 `exact` / `batch` token 口径与 `task.transcript` 完全一致。返回 `next` / `oldest` / `has_older` 供 `before` 往回翻页，`truncated` 在单行超 16 MiB 时置真而不冒充空结果。内存只保留窗口与当前 token 批次，不缓存全部正文；不改写会话文件，也不复用 `task.transcript` 的 8 MiB 预算缓存。
- 新增用户只读 `task.transcript_search(id,query?,kind?,tool?,errors?,after?,limit?)` 与 `task.transcript_step(id,seq,offset?)`：前者跨完整任务会话检索、分页摘要，后者按步骤读取分段原文及关联上下文；HTTP 用 `/api/task/<id>/transcript-search`、`transcript-step`。
- 终端跟随不新增 RPC：`lush task transcript ID [--after N] --follow` 先按 `task.transcript` 分页打印已有记录，再用 `task.transcript_latest` 以游标轮询新步骤，直到 Ctrl-C；仅用户可运行，`--json` 不适用，一次读到整页上限会提示可能还有中间记录。
- 新增用户专属 `explanation.start(id,seq,quote)` / `explanation.list(id,before?)` / `explanation.get(id)`：执行步骤介绍仍派只读、无工具的 `explainer` 根 Task，无输入分支、无 worktree、无派工；来源快照保存为既有 Event，结果仍是 Task.result。
- 新增用户专属 `intro.start(quote,location)` / `intro.list(id,before?)` / `intro.get(id)` / `intro.config()` / `intro.configure(config)`：选中任意页面文字后直连设置里的 OpenAI 兼容接口问一次模型，不建 Task / Input / 分支、不读会话文件；结果落 `introductions` 表供「解释历史」回看。`location` 只允许 `view` / `section` / `task_id` / `input_id` / `spec_id` / `notice_id` / `path`（与引用 location 同一套字段与长度约束），带 `task_id` 的记录归到该任务历史。API Key 只写不显，调用失败/超时/进程中断都落成 `failed` 而不是永久 `running`。
- `explanation.requested` 的 version 1 快照是执行步骤来源：`task_id` / `seq` / `goal` / 配对 `related`。旧库遗留的通用选区快照（`kind:"selection"`）仍可按 id 用 `explanation.get` 读取，但不再新增。
- `explainer` 只接受运行时提供的资料；Pi 以无工具、无扩展、无 Skills、无上下文文件模式运行；不能保证同等限制的 backend 明确拒绝，不静默降级权限。

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

## 公共面（拆不动，也不许变）

- RPC 方法名与参数表（`registry.js` 的 `PARAMS`）、`USER_ONLY` / `AGENT_ONLY` 权限集合。兼容读面保留 `system.status` / `task.list` / `task.history`，有界 Web 读面增量增加 `system.summary` / `task.activity` / `task.page` / `task.history_page`。Agent 进度使用 `progress.plan(steps)` / `progress.complete(step)`，只允许当前 invocation 给自己的 task 写入。Agent 配置使用 `agent.config`（只读）、`agent.models(agent)`（按需读取本机 CLI 模型目录）、`agent.resources`（按需发现已安装 Pi 扩展与 Skills）与用户专属的 `agent.configure`（整份写入）。Agent 环境文件通过用户专属的 `agent.environment(target)` / `agent.environment.configure(target,values)` 读写，target 是 `common` 或九类角色；由于返回值可能含密钥，连读取也拒绝 agent token。运行设置读写使用用户专属的 `system.configure`（参数 `settings`，部分更新，`null` 清除该键回退环境默认）。
- CLI 命令与 `lush help` 的语义。新增 `lush config [show]` 打印运行设置的生效值 / 环境默认值 / 是否被覆盖、快速路由前缀与设置文件路径，`lush config set concurrency|control-concurrency|call-timeout|task-call-limit|max-depth N` 写回，`lush config reset [concurrency|control-concurrency|call-timeout|task-call-limit|max-depth|all]` 清除覆盖，`lush config route list|add|remove|reset` 管理快速路由前缀表（`add PREFIX [--target worker|research]` 默认 worker，读当前生效表后整表写回，重复前缀报错；`remove PREFIX` 不存在报错；`reset` 写 `null` 回退默认；校验复用 `core/input-routes.js`，报错与核心一致）；`--json` 输出与 `system.status.settings` 同一份结构化读模型。两端都是用户专属，agent 调用被拒。命令面用连字符（`control-concurrency`），设置文件与 RPC 里是下划线（`control_concurrency` / `input_routes`）。
- SQLite schema、表名、列名与 `meta.task_id_high` / `meta.input_id_high` / `meta.overview_revision` 的行为。`overview_revision` 由读模型相关表的触发器单调推进，技术聚合表 `overview_task_counts` 由 task 触发器维护精确 layer/status 计数，首页用两者做 O(1) 失效与统计（它不是业务实体）；新核心表为 `agent_runs` / `artifacts` / `review_candidates` / `introductions`（快速介绍，`task_id` 可空且不加外键，删任务不连带删阅读记录）；`tasks.review_candidate_id` 与附属元数据列 `tasks.progress_plan` / `tasks.retry_profile` 通过 `store/base.js` 的 `ADDED_COLUMNS` 渐进补齐；`retry_profile` 保存一次显式重试冻结的完整 Agent profile，只在该轮到下次终态之间生效。同理，分支附属元数据列 `branches.showcase_reservation`（效果展示预约，versioned JSON，可空）也只加不改、不重写已有行。`branches.merge_run`（一键合并运行，versioned JSON，可空）是同一类分支附属运行态元数据：终态即清空，不新增表、不新增业务实体。`progress_plan` 保存 versioned JSON，不引入新的业务实体；读模型统一投影为 `progress`（有 `agent_runs` 时按调用区间重算工作用时，并把非 running 的等待投影成一条 `kind:'wait'` 条目；不改写存储的 `progress_plan`）。`artifacts.payload` 继续使用同一 JSON 文本列：新 `run.result` 是 version 2 envelope，分开记录 invocation 完成与 `pass` / `fail` / `partial` / `unverified` 验收结论；`pass` 必须没有 `failures` / `unverified`，但可以保留 `baseline_failures` / `residual_risks`；旧 payload 不重写，读取时缺失或自相矛盾的证据明确投影为 `unknown`。其它兼容列仍只加不改，不重写已有行。
- `src/index.js` 的导出、`bin/*` 的行为。
- Web 路由与 asset 路径：`server.js` 只按 basename 服务 `assets/` 下的 `.js` / `.css`，
  所以**新增前端模块不需要改 server.js**。带 `--project` 的单项目 Web 继续用无前缀的 `/api/**`；无 `--project` 的全局工作台改为**每项目一条稳定身份路由**：`/p/<project-id>/**` 下的页面、GET、report、preview 与 `POST /api/action` 都按请求自带的项目身份解析（ID 由 canonical 路径派生，只在已登记集合里反查，不把 URL 片段当路径），`GET /api/snapshot`、report、preview 与 action 因此不再有可被别的标签页切换的「当前项目」。宿主级路由留在无前缀：`GET /api/launcher`（模式、已登记列表、上次打开）、`GET /api/launcher/projects`（列表 + 仅对已连接项目的一次 `system.summary` 有界摘要）、`POST /api/launcher/select`（登记并连接，返回路由 ID，不设全局当前项目）、`POST /api/launcher/remove`（只删入口并断开 Web 连接）。全局模式下无前缀的项目读写一律拒绝并提示刷新；未知／已移除的项目身份返回错误或回项目列表，绝不回退到其它项目。其余显式例外是 `/api/graph`、检验报告
  `/api/task/<id>/report`，以及「文档」视图的 `/api/docs`、`/api/docs/search-index` 与 `/api/docs/<id>`——数据源是
  `src/ui/web/docs.js`，只读随代码发布的 `docs/**/*.md` 与 `README.md`，与当前项目目录无关，
  只按扫出来的 id 查表命中；另保留兼容 `/api/snapshot`，首页轮询走带 revision 的 `/api/overview`，历史任务与事件分别走 `/api/tasks`、`/api/task/<id>/history-page`，完整 Agent 配置只由设置页请求 `/api/agent/config`；搜索索引按需返回、在浏览器匹配，Mermaid 流程图由浏览器按需加载本地固定版本渲染。认证边界也在 `server.js`：项目绑定模式读取 `.lush/web.json`，全局启动器读取用户配置目录的 `web.json`；无对应配置时只监听本机，有配置时监听公网，并用 `/login`、`/logout` 与 HttpOnly 会话 Cookie 保护全部页面、资源和 API。全局公网配置必须额外提供 `projects` 绝对路径白名单，且项目注册表不允许把白名单外的路径解析成可访问身份；本地无认证启动器仍可输入任意现存绝对目录。
- 前端项目身份在 `src/ui/web/assets/route.js`：从 `location.pathname` 读 `/p/<id>/`（读不到就是单项目模式或全局根），`api.js` 用它给项目 API 加前缀，启动器与文档等宿主级资源不加；折叠 / 筛选 / 排序与分支图折叠按项目隔离在 `prefs.js` / `state.js`，主题等外观偏好共享。项目列表与切换在 `project-picker.js`：已在一个项目页时用新标签打开别的项目，切换项目不会清空当前标签的输入。
- Web 按钮帮助走 `data-help`：含义不直观的按钮都带提示，会调用 Agent 的按钮另带 `agent-call` 类与 `agentHelp()` 生成的文案，禁用按钮由外层 `.help-host` 承载；前端实现与三种输入方式见[按钮帮助与 Agent 触发标识](../design/ui-guidance.md)。
- 全局项目启动状态在 `src/ui/launcher.js`：用户配置目录中的 `launcher.json` 是 v2，存 `last_project` 与已登记的 `projects` 路径列表（读 v1 时把 `last_project` 提升为登记项），只把上次打开当作**新窗口首次落点**，不再决定任何页面的请求目标；同目录的可选 `web.json` 独立保存全局启动器认证、可信 Origin 与项目白名单；两者都不是业务事实也不是 `LUSH_HOME`。`projectRouteId(path)` 由 canonical 路径派生 16 位十六进制 ID，同一路径稳定、不同路径不可混同；服务端只用它在已登记集合里反查路径。macOS / Linux / Windows 分别遵循各自用户配置目录。Electron 桌面壳使用独立随机端口复用同一 Web server 与 assets，始终只监听回环且不读取全局公网认证；关闭时只停自己的临时 Web host，不停项目 daemon，因此可与后台 Web 同时打开。
- Web 进程的生命周期在 `src/ui/web/control.js`：`webListenerPids(port)` 认出端口上的监听者，
  `webOwners(config, port)` 把端口与 `.lush/web.state.json`（后台 Web 自己写的 pid / 端口 / 代码指纹）
  合起来给出「谁在听、命令行是不是 Lush Web」，`stopStaleWeb(port)` 只停命令行确实是 Lush Web 的进程
  （`bin/lush-web` / `ops.js web` / `ui/web/server.js`，先 SIGTERM、超时才 SIGKILL），`busyPortHint(port)`
  在端口被别人占着时把命令行原样报出来。`bun run web` 就是「后台 spawn `bin/lush-web` + 等它占住端口」
  （`waitForWebState`），`web-restart` 就是「停下旧的 + 后台起一个新的」；Web 进程不会跟着代码换版本，
  这是换版的正路。`doctor` / `web-status` 只读这些状态，把当前磁盘、daemon、Web 的代码目录 / 版本 / 指纹
  分开报告；不一致只产生带项目与端口的更新提示，不触发重启。
- 环境变量与 agent capability 语义（`LUSH_PROJECT` / `LUSH_HOME` / `LUSH_TASK_ID` / `LUSH_AGENT_TOKEN`）。`LUSH_TASK_ID` 是与当前 agent 直接绑定的 task，不是任务树上的 `tasks.parent_id`；进度 RPC 仍以一次性 token 解析出的 actor 为准，不信任环境变量中的 ID。项目级 Agent 配置固定写在 `<project>/.lush/agent.json`：默认配置 + planner / coordinator / worker / research / verifier / merger / showcase / explainer / butler 九类角色覆盖；写入原子替换，运行中的 invocation 不打断，下一次调用动态读取并生效。失败 / 取消任务的显式重试可另外提交完整 `profile`，它只冻结到该任务本轮重试、不会改写 `agent.json`，任务再次进入任一终态时清除。每份 profile 分 `default_prompt` 与 `append_prompt`：前者非空时替换该角色的内置组合（UI 明确警告能力、权限与交付协议可能失效），后者追加在共享/本机文件补充之后；旧 `prompt` 字段按 `append_prompt` 兼容读取。内置规则由 `PROMPT_PARTS` 按角色组合；再叠加可提交的 `.lush-agent/{common,ROLE}.md` 与本机 `.lush/agent/{common,ROLE}.md`。Agent 子进程环境在 daemon 环境之上热加载 `.lush/agent/agent.env` 和角色 env，`LUSH_*` 不可覆盖；Web 键值编辑器把文件规范化为 owner-only 的 `NAME="value"`，空表删除对应文件。profile 另存 `extensions` / `skills` 路径列表，只给普通 Pi invocation 以显式参数加载，Codex 与无工具 explainer/butler 保留配置但不使用。
- 项目级「快速介绍」模型配置固定写在 `<home>/quick-intro.json`（version 1，权限 `600`），唯一读写入口是 `src/core/quick-intro.js` 的 `QuickIntroSettings`；只存 `base_url` / `model` / `api_key`，没有环境默认值，未配置时调用方明确拒绝并提示去设置里填。读模型只返回 `has_key` / `key_hint`，不下发密钥。
- 项目级运行设置固定写在 `<home>/settings.json`（version 1，权限 `600`），唯一读写入口是 `src/core/settings.js` 的 `RuntimeSettings`；目前有数字键 `concurrency`（1..64）、`control_concurrency`（1..16）、`call_timeout`（1..86400）、`task_call_limit`（1..1000）、`max_depth`（1..64）与结构化 `input_routes`，`null` / 缺键表示回退默认。`LUSH_CONCURRENCY` / `LUSH_CONTROL_CONCURRENCY` / `LUSH_CALL_TIMEOUT` / `LUSH_TASK_CALLS` / `LUSH_MAX_DEPTH` 只提供各自的默认值；daemon 启动时读出生效值，运行时写盘后同步内存并重新准入（含 `input_routes`），不需要重启。`input_routes` 是快速路由前缀表，默认 `开发` → worker、`解释` → research；每项恰为 `{prefix,target}`，prefix 非空、≤32 字符且不含空白，target 只能是 worker / research，prefix 大小写不敏感去重，最多 32 项。提交输入（`input.submit`）时先用 `src/core/input-routes.js` 的纯函数做一次确定性匹配：按 prefix 长度降序做大小写不敏感最左匹配，前缀后必须是输入结束或非字母非数字字符（避免「开发文档」误命中），命中即不调用规划模型，按 target 创建 worker 或 research 根任务并短路 planner。
- `src/core/genealogy.js`（分支谱系的纯逻辑：`buildForest` / `pruneHidden` / `parentOf` / `childrenOf` / `ancestorsOf` /
  `descendantsOf` / `rootOf` / `chainOf`）与 `types.js` / `naming.js` 一样是共享纯模块：不碰 git、不写盘、
  不渲染，只被 `project/branches.js` 与 `test/branch-tree.test.js` 使用。`naming.js` 导出 `slugify` /
  `taskSlug` / `taskLabel` 与 `inputLabel(id)`（输入聚合分支的 `input-<id>` 名）。

## Task 图与固定输入规则

`task.graph` / `/api/task-graph` 是以 Task 父子关系为边的有界读面；Web 的 `#task-graph` 为主视角，原 `#graph` 分支图保持独立入口与原操作。Task 卡片按真实状态配色，并把「有子 say 分支就可在 Task 上发起合并编排」搬到主视角：读面多投影 `branch_info.subtree_say` / `branch_info.merge_run`，执行仍复用 `branch.orchestrate_plan` / `branch.orchestrate`，不新增 RPC、表或实体。新 say 从已提交 fork 读取 `.lush-task/input.mjs` 并冻结在项目 `.lush/task-rules/`；用户后续消息由固定规则返回 `message` 或安全点软抢占的 `interrupt`，失败回退并留事件。子 Task 继承直接父的规则快照。实现范围、可信代码风险与未完成的旧数据只读迁移见 [Task 图与固定输入规则](task-graph.md)。

## 页面导航与全类型任务列表

- Web 采用平级页面，分组只组织导航：工作（项目概览、待我处理、需求记录、执行计划、任务列表）、交付与用量（分支与合并、用量统计）、其他（设置、帮助文档）。任务详情归属任务列表，文档正文归属帮助文档。
- `sidebar-ui.js` 统一页面切换、路由地址、唯一选中项、视图栏、移动端收起与加载占位；`ui.view` 为当前页面身份，异步读面用身份检查阻止迟到响应覆盖新页面。概览导航先画缓存，不依赖 revision 变化或轮询空闲。
- `task.activity(limit?,scope?)` / `task.page(before?,limit?,scope?)` 增加 `scope='work'|'all'`，省略保留旧 work 口径；Web overview 与历史分页显式请求 all，覆盖 intent/work 两层，继续有界读取，不改任务实体或存储层级。`GET /api/tasks` 透传 scope；类型筛选固定提供全部现行角色，兼容历史 scheduler 与未知角色，筛选范围明确为已加载任务。

## 分支诊断增量读面

- `graph.get` 的 branch 节点增量提供 `diagnostics`：`changes` 以登记的 `created_from_commit` → 当前固定 tip 统计已提交净改动（文件总数、文本增删行、二进制文件数及有界文件列表），`latest_commit` 给出 tip 的提交时间与摘要，`working_tree` 单独统计实际检出该分支的工作区未提交文件数（暂存 / 未暂存 / 未跟踪 / 冲突，分类可能重叠）。无起点、无 ref、未检出与读取失败不能冒充零。
- Git 边界 `workspaces/diff.js` 新增 `branchDiagnostics(branches)` 批量读面：只读 Git、禁用外部 diff/textconv，固定提交结果有界缓存；文件列表每分支最多 50 项且 JSON 不超过 2 KiB，截断不影响汇总。无新表、无新 RPC 方法；Web 用既有图轮询，并保留文件列表展开状态。

## 一键合并与分支写冻结

- 用户确认后的一次编排在 `project/merge-all.js`：`branch.merge_plan` 只读列出目标分支整棵后代子树（叶子在前：谱系深度降序，其次创建时间、名字），每条给状态、动作（`merge` / `sync` / `skip`）、`ready` 与 blockers；`order` 包含有工作要交付的全部后代（含此刻被未收拢子分支阻塞、叶子先合后会自动就绪的父级）。`branch.merge_all` 落一条目标分支附属的 `branches.merge_run`（versioned JSON：status/order/index/done/skipped/waiting_task_id），异步逐条复用 ff-only 门槛；分歧时建子侧 merger、置为 `paused` 等待，merger 结算时由 `lifecycle.finish` 调 `resumeMergeRun` 自动继续。`branch.merge_cancel` 清运行、取消等待中的 merger 并释放冻结。不新增表 / 实体；终态清空。
- `src/core/branch-freeze.js` 从三处已有事实现算分支写冻结：目标分支上 active 的 `merge_run` 冻结目标 + 全部后代；任何未结束的 merger 任务冻结其 `target_branch` + 全部后代 + 其直接父分支；已发出但尚未集成的 say 合并请求（`reservation` 里 `kind=merge`、`status=requested`）冻结其 `target_branch` **本身**（不冻结请求者与兄弟 say 自己的分支）——请求已经把父分支基线固定成那个 commit，父分支再前进就只能作废重做。交付锁同时保证同一个父分支一次只接受一个未集成请求：`settleReservedMerge` 见到别人的交付锁就保持 pending 并记 `parent_locked`，`integrateChild` / `approveReservedMerge` 只允许锁持有者自己落地。冻结拦截新建 intent（`input.submit` / `draft.commit`）、`branch.merge` / `branch.sync` / `branch.catchup` / `branch.archive`、`task.retry` / `task.cleanup` / `task.delete` 与 `task.clear`；`task.cancel` 保持可用（释放路径）；另外源分支带着未集成请求时 `branch.archive` 也拒绝（删了它父分支的交付锁就永远没有落地对象）。一键合并运行与冻结经 `status.branch_freeze` / `status.merge_runs` 与 `graph.get` 的 branch 节点 `freeze` / `merge_run` 下发，Web 据此给「一键合并全部子分支」/「取消一键合并」入口并在冻结时禁用写按钮。
- 新交付模型另有合并编排（`project/orchestrate.js`，`branch.orchestrate_plan` / `orchestrate` / `orchestrate_cancel`）：只读计划枚举目标分支后代里每个 say 子分支的固定 `commit`、父 `baseline`、实时状态与动作（`merge` / `resolve` / `skip`）；用户确认一次后在目标分支的 main/owner Task 下创建 `task_kind='merge'` 的 runtime 驱动编排 Task，复用同一份 `branches.merge_run`（`mode:'orchestrate'` + `task_id`）与同一套冻结，按叶子→根内部落地固定提交（ff-only，不经旧 `branch.merge` / `branch.sync`；没有合并预约但已静息、有已提交改动且无未收拢子分支的 say 由 runtime 代发固定提交请求，仍在跑 / 等待用户答复 / 无提交 / 已合入的跳过并给原因），分歧时在源侧派独立解分歧子 Task（`resolves_task_id` + `orchestrated:true` 事件）并由 runtime 收尾。编排 Task 不参与 agent 调度（`scheduling` 与 `main` / `owner` 一样跳过 `task_kind='merge'`）；`recover` 按 active run 重新驱动；`cancelOrchestrate` 清运行释放冻结并取消等待中的子任务。旧 `branch.merge_all` 对含新 say 子树的派生仍拒绝，`merge_cancel` 拒绝编排运行。
- planner / scheduler 不受影响；`task.cancel` 不受冻结限制，所以用户总能把卡住的子任务停掉再取消整场合并。

## 效果展示增量接口

- 新增专用 `showcase` agent（第七类可配置角色），只由用户 `showcase.start(branch,baseline?)` 创建独立根 Task，不参与代码交付或 Candidate 状态机。`tasks.showcase` 为不可变 version 1 JSON 元数据（分支、固定 commit、对比基线），只加可空列，不重写历史。
- 仅已登记、未归档/删除、有明确父分支与创建基线的非主干分支可展示。相关规划/开发/合并任务必须完成、子分支已收拢，工作区干净且无 Git 操作中间态，相对基线有实际文件树变化；未知/读取失败不开放。主干包括 main / master、远端默认分支及无父分支的根。`baseline` 参数保留兼容，但不能绕过准入。
- 同分支有活动展示时禁止重复启动；历史成功展示按文件树去重（不只比较 commit，基线变化不构成重新展示理由），失败/取消可重试。重试仍冻结原提交，但必须重新通过准入且当前文件树未变。新元数据在 version 1 中增量保存 `tree`，旧记录只读解析 commit 的 tree，不重写。
- `Project.showcaseEligibility(branch,baseline?,excludeTaskId?)` 是 graph 与创建/重试共用的准入读面；Git 校验与树解析由 Workspaces 提供。`graph.get` 的 branch 节点增量带 `showcase:{allowed,reason,latest_task_id,reserved,reserved_at,reserve_allowed,reserve_reason}`，前端按 `reserve_allowed` / `reserved` 在分支详情给「预约效果展示」/「取消预约」入口（入口不要求当前已满足完整准入，`allowed` 只影响确认文案与是否立即开始）；首页、Intent 列表和任务详情不提供启动入口。已有展示仍可查看。在独立 detached worktree 执行，不切换/提交用户分支。
- RPC `showcase.list(branch?)` 读最近 50 条；`showcase.start` / `showcase.reserve` / `showcase.unreserve` / `showcase.stop(id)` 为用户专属；`showcase.preview(command,path?)` 为当前 showcase invocation 专属，以 argv 数组启动预览。CLI `showcase start BRANCH [--baseline BRANCH]` / `list [--branch BRANCH]` / `stop ID` / `preview --file JSON`。
- 展示 HTML 写在 `<home>/showcase/<task>/report.html`，复用认证后的 `/api/task/<id>/report`，使用 sandbox CSP。`task.inspect.showcase` 给出冻结上下文、报告与托管预览状态。完成不等于检验通过、不批准合并；现有 verifier / Candidate API 与历史报告兼容保留，Web 的手动验收创建入口改为展示。
- 预约是分支附属元数据（`branches.showcase_reservation`，versioned JSON，可空），不是新业务实体：只对已登记、有明确父分支与创建基线的非主干本地分支开放静态预约（`showcaseReservable` 只看 store，不跑 Git），重复预约幂等。写入后若当前已通过完整准入就立即启动，否则由 `scheduleShowcaseSweep` 在结算 / 恢复 / 预约 / 归档 / 合并 / 跟上等触发点重扫；sweep 单飞，逐条重跑 `showcaseEligibility`，满足才清预约并启动，其余保持 pending。预约不绕过任何准入：真实条件（ref、脏工作区、代码树去重等）在启动前由同一个 `showcaseEligibility` 复核。启动（手动或预约触发）都会清除该分支 pending 预约；预约触发的另落 `showcase.reservation_started`，与 `showcase.reserved` 串成事件链。`unreserve`、归档与删除分支会清除预约并落 `showcase.unreserved`。`graph.get` 的 branch 节点 `showcase` 增量带 `reserved` / `reserved_at` / `reserve_allowed` / `reserve_reason`，原有 `allowed` / `reason` / `latest_task_id` 不变。
- 预览由 daemon 托管：运行于展示 worktree，动态分配本机端口，argv 中 `{port}` 替换，环境 `HOST=127.0.0.1` / `PORT`，不传 agent token；agent 须显式配置应用监听本机。完成后保留，失败/取消/用户停止/daemon 退出时停止进程组。守护子进程观察父进程 stdin 关闭以处理 daemon 崩溃；重启不自动重放。运行预览期间禁止普通任务回收 worktree；归档来源分支会先停关联预览，再删除该分支历史展示的两个 detached worktree，但保留展示任务、报告与执行记录。入口仅面向同机浏览器，不反向代理不可信应用。

## 统计面板接缝

- 新增用户只读 RPC `system.usage(start?,end?,interval?)` 与 `GET /api/usage`；时间为带时区 ISO，范围 `[start,end)`，省略边界分别表示历史起点 / 本次查询时间。interval 为 `auto|hour|day|month`，柱按 UTC 日历分段，显式粒度最多 1500 段，超限要求放宽粒度。
- `core/usage-statistics.js` 的 `readUsageStatistics(config,options,metadata?)` 异步流式读取项目 sessions 的全部 Lush JSONL，独立于任务详情的 8 MiB 窗口；只缓存精简用量，不改写历史文件或 SQLite。返回总量、时间段、provider/model 分组与缺失数据说明；缺价与真实零价分开，全部金额为会话记录的预计 USD。
- `project/transcript.js` 暴露 `usageStatistics(options)`；`agent/provider.js` 为后续 Codex `turn.completed` 追加 Pi 兼容的 token 用量记录（费用未知），旧 Codex thread 文件只用于提示历史覆盖缺失。
- Web `render-statistics.js` 提供 `openStatistics()` / `renderStatistics(data)`，`#statistics` 与左栏入口共享；面板按日间／日内双视图选择日期或小时范围，`statistics-range.js` 统一将 UTC 日历选择转换为 API 半开时间段；快捷按钮立即查询，两种视图独立保留条件，不进入首页轮询。

## 「托管模式」接缝

- 用户专属 `sleep.start(options,confirmed)` / `sleep.stop()` / `sleep.resume()` / `sleep.status()` / `sleep.choices(before?,limit?)`；Web 设置开启，左栏常驻关闭；CLI `auto-manage on/off/status/resume/choices`（旧别名 `sleep`）。options 显式包含 `mode=recommended|preferences`、可空正整数 `budget_tokens`、`include_existing`、`allow_merge`。confirmed 必须为 true，UI/CLI 先显示风险。
- `project/sleep.js` 用既有 meta 保存项目授权/预算/暂停状态，既有 Event（task_id=null）保存不可变决策快照、执行意图及结果；不引入业务表，不改写旧 Notice。Event 新增 type/id 与两类管家 JSON 引用的部分索引；`Store.event()` 增量返回 event ID。关闭不删除选择记录。重启保留授权与预算，已开始的选择绝不自动重放。`sleepStatus()` 额外按当前 `session` 汇总既有 `sleep.choice.started`/`sleep.choice.finished`，返回本会话进度 `handled`（已给出结果的 Notice 条数，含纯信息已阅）与 `decisions`（其中 `approve`/`reject`/`answer`/`dismiss`/`merge` 的条数）；查询借 `events_type_id` 与 `sleep.started` 的事件 ID 限定扫描范围，不新增表。
- `butler` 专用 Task 无 Input/worktree，无工具、扩展、Skills、上下文文件和 RPC capability，仅 Pi（mock 用于测试）；每次处理一条 Notice，独立单并发槽。规则模式优先批准 Plan、选择唯一推荐项；其余与偏好模式交由 Agent。偏好上下文区分人类答案与管家答案。
- 预算累计开启后全项目会话新增 input/output/cache token，每秒及调度/决策前检查；缺失用量/读取故障保守暂停。到限停止管家及新调度，中止活动 invocation 为失败、保留现场且不自动重放；在途请求可能超额。关闭不解除预算暂停，`sleep.resume` 单独恢复排队任务，中止任务仍需显式 retry。
- 自动合并仅在显式授权后响应已登记任务的交付 Notice，通过既有安全合并 API，不把自然语言答案当作 Git 指令；禁止绕过依赖、干净工作区与最终 Candidate 验收门。关闭后迟到 Agent 结果不执行；已经开始的 Git 操作可能完成，记录保留。
- 「待我处理 → 管家选择」按 Event 游标分页，展示模式/问题快照/答案/理由/执行结果与失败、中断，不混同用户亲自确认。

## Notice 提醒与历史接缝

- 保留 `notice.list` 兼容读面，新增 `notice.page(status?,before?,limit?)` 与 `GET /api/notices`：按 ID 降序分页，status 为 `all|open|answered|dismissed|sent`，返回 `{notices,cursor,has_more,limit}`。不删除或重写既有 Notice。
- 「待我决定」按需查询全部类型的 Notice，未处理项可直接答复／审批，历史只读；首页仍用有界快照。通知仅针对新增的 open 决策事项，首次加载不补发历史。
- `notice-notifications.js` 负责浏览器 Notification 与桌面 IPC 适配，默认关闭；授权只由用户开启时触发，失败不影响轮询和留档。开关属于当前客户端，桌面保存在 Electron userData（不受随机端口影响）。窗口关闭后不提醒，不引入 daemon 后台推送。

## Token 效率接缝

实现约束、配置示例与历史归因口径见 [Token 效率与用量归因](token-efficiency.md)。

- `input.submit` 提交时先按运行设置的快速路由前缀做确定性匹配：命中就不调用规划模型，按前缀 target 创建 worker 或 research（只读、不建 worktree / 分支）根任务，并在同一事务把 planner 标 completed、写 `input.route` 事件；未命中才走规划模型。命中前缀仍保留 Input、输入分支与 completed/零 invocation 的 planner 占位；`draft.commit` 逐条提交，每条正文各自匹配一次前缀，未命中的仍走规划；不绕过 worker 决策提问与人工最终合并。
- `project/context.js` 的 `invocationContext(task,run)` 只投影直接父子、依赖、用户引用与专用角色上下文；不注入全局最近任务。关联摘要有界且明确截断，完整内容通过既有 `task inspect` 读取。`provider.js` 启动 JSON 使用多行格式，剔除凭证 hash 与重复 prompt 配置。
- 安全抢占（`scheduling.requestPreempt`）：**只由用户追加输入触发**（`task.message` 且 `sender===null`），且只在有可验证安全边界的后端生效（目前只有 Pi）。它杀进程，而是在 `<home>/preempt/` 写一次性 request；`agent/pi-runtime.js` 在 `turn_end`——本轮工具都结束、不会再有并行 `tool_call` 正在跑的边界——写 stop 标记并让本轮收尾（不用 `tool_call`：同一条 assistant message 的工具调用可能并行）。`provider.js` 关进程后读一次双向标记（无论采纳与否都立即清掉）并抛 `AgentPreempted`；`invoke` 据此把这次 run 记成 `preempted`（与 completed/failed/cancelled 并列，见 `store/runs.js`）并把 Task 放回 `queued`/`waiting`，写 `invocation.preempted` 事件，**不**调 `cancel()`：不算失败、不重建工作区、下一轮先读那条输入。超时与 `task.cancel` 仍走硬杀路径并如实标成失败/取消，两类不混用。Codex 与未声明边界的后端保持轮末投递，只记 `preempt.requested` 而不假装能抢占；安全边界只覆盖 Agent 的工具循环，后台孙进程照旧在 invocation 结束时回收。
- coordinator 的普通子任务成功结算只在全部子任务终态后唤醒；失败、取消、显式消息仍及时处理。延迟消息保留未读，所有收尾/恢复路径共用 `hasActionableMessages(taskId)`，避免空转和 lost-wakeup。
- Agent profile 增加可选 `soft_budget:{responses?,tokens?}`：正整数，空对象/缺省关闭。仅普通 Pi 支持；Codex 和 explainer 明确拒绝启用。内置 `agent/pi-runtime.js` 扩展记录 invocation 身份，按本次响应累计用量，在达到阈值后下一次自然模型调用前仅提醒一次收尾；不强制停止、不额外启动模型轮次、不把历史用量算进新 invocation。
- `system.usage` 增量返回 `roles` / `tasks` / `invocations` 归因表（按费用排序，任务与 invocation 各最多 100 条，明确总组数与截断），历史不能可靠归因的记录进入 unknown。新 Pi custom entry 与 Codex usage 行固化 task/run/role，旧记录仅在唯一 Run 时间区间匹配时归因；不改写历史。
- CLI `task list --brief` 返回短目标与分页提示；`progress` 默认只回简短确认，`--json` 保留完整读模型；`doctor` 默认省略完整 daemon 配置，`--verbose` 恢复详细输出。原 RPC 读面保持兼容。

## 分区总览

| 分区 | 入口 | 细粒度模块 | 独立可并行 |
|---|---|---|---|
| 任务编排 | `src/core/project.js` | `src/core/project/`（含 Plan 编译、Integration、Candidate） | ✅ |
| Git 边界 | `src/core/workspaces.js` | `src/core/workspaces/`（5 个） | ✅ |
| 持久化 | `src/persistence/store.js` | `src/persistence/store/`（含分支、run、candidate 与引用元数据） | ✅ |
| 前端 | `src/ui/web/assets/app.js` | `src/ui/web/assets/`（见下表） | ✅ |
| CLI | `src/cli/main.js` | `src/cli/`（含 Agent 配置命令） | ✅ |
| RPC | `src/rpc/protocol.js` | `src/rpc/`（7 个） | ✅ |
| 测试 | `test/*.test.js` | `test/<分区>/*.test.js` | 依赖上面六个落定后 |

前六个分区 **互不共享文件**，可以同时开工。测试分区要等它们落地，否则测的是半成品。

新 Task 的预约是 `tasks.reservation` 可空 versioned JSON 附属状态：仅 say Task 可设置 `showcase` 或 `merge` 的一个 pending 意图，同类重复幂等、异类拒绝并要求显式撤销；User-only `task.reserve` / `task.unreserve` 与 Event 同事务。`merge` 预约只在 say 静息、工作区可检验且子任务已结算时冻结提交与直接父基线，在结算事务内写一次父 Task 信号并结束源 Task；用户另用固定 commit + baseline 批准 main/owner 的快进，Git 串行区内复核双方 ref。`showcase` 在静息且安全准入后按固定源/对照提交启动专用展示子 Task，原 say 用预约阶段 `started` 表示开发已完成但未终结；展示子 Task 结算后原 Task 才结算，失败仍留现场与原因；未批准的合并请求绝不移动父分支。展示交付把原 say 结算为 `completed` 后，`task.reserve merge` 不再新建 pending 意图（终态 Task 等不到 pending 阶段），而是直接固定当前源 tip 与父基线、补写一次 `requested` 请求并给父 Task 发一次信号；撤销请求后再请求同样走这条补口，其余安全门与普通请求同源；展示交付后的终态 say 若此时与直接父分支分歧，`task.reserve merge` 不抛错而是留下 pending/diverged 预约，用户经 `task.resolve_divergence` 派不挂在终态 say 子树下、用 `resolves_task_id` 关联的独立解分歧子 Task，结算后 runtime 把产物快进推进回 say 分支、按最新父 tip 重新发 requested（仍须用户批准）。同类重复 `task.reserve` 不重建预约，而是显式重查 pending 状态：执行屏障、未读消息和子任务等待原因也记在 `blocked_reason`，成功后由结算事务清掉；Web 的「复查预约」与 CLI 原命令共享此路径，不自动轮询外部 Git 变化。User-only `task.resolve` 另给无代码改动的 say 一个与取消区分的收尾：工作区干净、分支无新提交、没有活动 Agent/请求/展示预约时以 `completed` + `integration='none'` 结算并保留 `result`，清掉 pending 预约（仅 merge），不移动任何 ref；有提交仍须走 `task.reserve` 或 `task.cancel`。

daemon 启动在 project identity/Store 建立后、RPC 开放前幂等执行 `Project.bootstrapMain()`：只有本地 main ref 存在才确立唯一静息 main Task；无 main 时保持 daemon 可用、首次新 say 给明确错误，不自动造 ref，也不触发 provider。恢复仍保留未知副作用不重放。

显式分支绑定：用户选定本地 `BRANCH` 与当时的 `HEAD COMMIT` 后，`branch.bind` 为非 main 且尚无新 Task 所有者的分支创建独立、永不执行不受限 provider 的静息 `task_kind='owner'` 根 Task。旧分支记录和旧 Task 不回写；`branch.tree/show` 派生的新 owner 投影覆盖旧 task_id 的当前所有者显示，历史仍可按旧 task id 查看。无绑定的新 say 继续拒绝，不猜祖先。

main/owner 的**受限按需分析**：用户 `task.analyze {id,question}`（用户专属，`lush task analyze ID '问题'`）在分支所有者下建一个 `task_kind='analysis'` 子 Task，答案成为它的 `result`，结算时另落一条 `kind='info'` 提醒（带截断结论与详情指引）。它**不建分支**：工作区是该分支提交的分离检出（`baseline_workspace`，与 verifier 对照检出同一套路，invocation 结束即回收，下次调用按当时分支顶端重建），Task 的 `branch` 为 null、不记 `head_commit`/integration，所以既推不了任何 ref 也交付不了代码；`target_branch` / `base_commit` 只记录“分析哪条分支的哪个提交”。提示词按 `task_kind='analysis'` 换成只读组合（不切分支、不写 ref、不派工、不合并、不说已交付，结论需带证据并自陈未知），工具不限（可在隔离检出里跑命令取证）；`task.spawn` 明确拒绝分析 Task，`task.cleanup` / `task.delete` 对它不等“未合并”门槛，也不需要归档分支。

新 say 入口增量：`say.submit(content?,draft_id?,branch?,references?)` 与旧 `input.submit` 分开，后者仍供历史调用方安全收尾；新 Input 直连 `role='agent'`、`task_kind='say'` 的 Task，main 是 `task_kind='main'` 的静息根 Task。`tasks.task_kind` 只加列不重写历史；新提交必须先校验父分支有明确的 Task 所有者。实现职责放 `src/core/project/say.js`、现有 Git 边界与 Store，不新增全局调度器。

新 Task 子代码只允许执行中的直接父 Agent 经 `task.integrate {id,commit}` 确认固定 child HEAD 并在 Git 串行锁下 ff-only 快进至父分支；旧 `task.merge` / `branch.merge` 拒绝新 Task 分支。新 say 的 pending merge 请求若与直接父分支分歧，用户可 `task.resolve_divergence {id}` 创建一个独立 child（基线固定为源 tip，目标固定为源 say 分支，任务目标要求合入当时固定的父 tip 并测试）；活动 say 的 child 挂在其子树下，由 `task.integrate` 确认，只派生不推进父分支/源分支。已经终结的 say（展示交付后）没有可唤醒的 Agent：`task.resolve_divergence` 派生 `resolves_task_id` 关联、parent 为空的独立 child，完成后 runtime 校验它含两端固定提交、用 `fastForwardBranchUnsafe` 快进推进回 say 分支并重新发出 requested 请求。父 say Agent 收到子任务完成信号后用 `task.integrate` 确认固定 child commit；该确认额外校验 child commit 同时含最初源/父 tip，之后用户复查预约或自然轮末重新按最新父 tip 准入。重复请求返回未集成的同一活动 child；已完成但不合格或已失败/取消的 child 需用户检查并显式归档其仍活动的旧分支（保留 Task/事件/会话，未提交文件必须另行确认丢弃）后才可重新派独立 child；没有创建分支的失败任务可直接新派。解分歧 child 不走旧 `task.retry`，不暗中豁免子分支阻塞或重写已完成 Task。兄弟子任务先落地或父分支自己提交后，已完普通子任务的固定提交同样不再能快进：执行中的直接父 Agent 用 `task.resolve_child_divergence {id}` 从该固定提交拉起同构的解分歧子 Task（记录 `task.divergence_resolution_requested`，固定当时的父分支顶端），解分歧子 Task 合入父分支新提交并测试后，仍由 `task.integrate` 确认（同时校验它含固定子提交与固定父顶端，成功后一并结算被修复的子任务并记 `child.integrated_via_resolution`）；父分支有未集成 say 请求时先拒。`task.integrate` 不能推进 main；父分支不干净、HEAD 漂移、子任务未结算或有未集成后代时保留现场并拒绝。实现放 `src/core/project/say.js`，Git 写入复用 `workspaces.mergeBranchUnsafe`。

Task 中心输入的持久信号增量：`messages` 增加可空 `signal_type` / `signal_key`（旧自由文本消息不变），`(task_id,sender_id,signal_key)` 部分唯一索引保证子→父同一次信号只写一条；`Store.signal()` 与 `Project.sendTaskSignal()` 只供 runtime 内部使用，事务同写 Event/Message，先落库后唤醒。当前 say 路径已支持持久信号、静息唤醒及 Pi `turn_end` 安全抢占；边界见[Task 中心输入](task-centered-input-design.md)和[一次 invocation](invocation.md)。

问卷决策沿用 Notice，不新增表或实体：`src/core/questionnaire.js` 负责严格校验与答案规范化，`Project.notice` 保存 `kind='questionnaire'`，调度器通过 `questionPending` / `parkForQuestion` 暂停并恢复 invocation；Web 端由 `render-questionnaire.js` 渲染，预览路由使用 `notice-preview.js` 的独立 CSP 清洗 HTML。

## 分章地图

模块清单仍以本页为唯一入口，细表拆成三篇短章：

1. [Runtime 与持久化](modules-runtime.md)：Agent provider、Project、Workspaces 与 Store。
2. [Web 前端](modules-web.md)：浏览器模块、渲染职责与导出。
3. [CLI、RPC 与测试](modules-interfaces.md)：命令、协议与测试分区。

跨分区改动先从这里确认边界，再进入对应细表；新增或移动文件时必须同步更新所属章节。

---

[下一篇：Runtime 与持久化 →](modules-runtime.md)
