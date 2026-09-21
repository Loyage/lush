# 模块地图（并行开发的边界）

这份文件是**拆分的契约**：`src/` 与 `test/` 里每个文件的职责与导出签名。目标只有一个——
让两个并行 worker 尽量去改不同的文件。粒度细到这个程度不是审美，是为了让「谁动哪个文件」可预测。

改名、搬家、换签名都先改这里，再改代码。

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

- RPC 方法名与参数表（`registry.js` 的 `PARAMS`）、`USER_ONLY` / `AGENT_ONLY` 权限集合。Agent 配置使用 `agent.config`（只读）、`agent.models(agent)`（按需读取本机 CLI 模型目录）、`agent.resources`（按需发现已安装 Pi 扩展与 Skills）与用户专属的 `agent.configure`（整份写入）。
- CLI 命令与 `lush help` 的语义。
- SQLite schema、表名、列名与 `meta.task_id_high` / `meta.input_id_high` 的行为。新核心表为 `agent_runs` / `artifacts` / `review_candidates`；`tasks.review_candidate_id` 通过 `store/base.js` 的 `ADDED_COLUMNS` 渐进补齐。其它兼容列仍只加不改，不重写已有行。
- `src/index.js` 的导出、`bin/*` 的行为。
- Web 路由与 asset 路径：`server.js` 只按 basename 服务 `assets/` 下的 `.js` / `.css`，
  所以**新增前端模块不需要改 server.js**。读取路由里只有几个显式登记的例外：`/api/graph`、检验报告
  `/api/task/<id>/report`，以及「文档」视图的 `/api/docs` 与 `/api/docs/<id>`——数据源是
  `src/ui/web/docs.js`，读的是随代码发布的 `docs/` 与 `README.md`，与当前项目目录无关，
  只按扫出来的 id 查表命中。认证边界也在 `server.js`：无 `.lush/web.json` 时只监听本机；
  有配置时监听公网，并用 `/login`、`/logout` 与 HttpOnly 会话 Cookie 保护全部页面、资源和 API。
- Web 进程的生命周期在 `src/ui/web/control.js`：`webListenerPids(port)` 认出端口上的监听者，
  `webOwners(config, port)` 把端口与 `.lush/web.state.json`（后台 Web 自己写的 pid / 端口 / 代码指纹）
  合起来给出「谁在听、命令行是不是 Lush Web」，`stopStaleWeb(port)` 只停命令行确实是 Lush Web 的进程
  （`bin/lush-web` / `ops.js web` / `ui/web/server.js`，先 SIGTERM、超时才 SIGKILL），`busyPortHint(port)`
  在端口被别人占着时把命令行原样报出来。`bun run web` 就是「后台 spawn `bin/lush-web` + 等它占住端口」
  （`waitForWebState`），`web-restart` 就是「停下旧的 + 后台起一个新的」；Web 进程不会跟着代码换版本，
  这是换版的正路。
- 环境变量与 agent capability 语义（`LUSH_PROJECT` / `LUSH_HOME` / `LUSH_TASK_ID` / `LUSH_AGENT_TOKEN`）。项目级 Agent 配置固定写在 `<project>/.lush/agent.json`：默认配置 + planner / coordinator / worker / research / verifier / merger 六类角色覆盖；写入原子替换，运行中的 invocation 不打断，下一次调用动态读取并生效。每份 profile 分 `default_prompt` 与 `append_prompt`：前者非空时替换 Lush 内置规则（UI 正常显示内置全文、可恢复默认，并明确警告能力、权限与交付协议可能失效），后者始终追加；旧 `prompt` 字段按 `append_prompt` 兼容读取。profile 另存 `extensions` / `skills` 路径列表，只给 Pi invocation 以显式参数加载，Codex 保留配置但不使用。
- `src/core/genealogy.js`（分支谱系的纯逻辑：`buildForest` / `pruneHidden` / `parentOf` / `childrenOf` / `ancestorsOf` /
  `descendantsOf` / `rootOf` / `chainOf`）与 `types.js` / `naming.js` 一样是共享纯模块：不碰 git、不写盘、
  不渲染，只被 `project/branches.js` 与 `test/branch-tree.test.js` 使用。`naming.js` 导出 `slugify` /
  `taskSlug` / `taskLabel` 与 `inputLabel(id)`（输入聚合分支的 `input-<id>` 名）。

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

### Agent 运行时接缝

| 文件 | 职责 | 导出 |
|---|---|---|
| `agent/settings.js` | `.lush/agent.json` 的兼容读取、校验、原子写入、角色继承与 Web 选项（含内置 Prompt）；旧 `prompt` 迁到 `append_prompt`，资源选择存 `extensions` / `skills` | `AGENT_ROLES`、`AGENT_BACKENDS`、`THINKING_LEVELS`、`MODEL_PRESETS`、`normalizeAgentConfig()`、`AgentSettings` |
| `agent/models.js` | 有界、超时地读取 Pi / Codex CLI 模型目录，只投影安全的模型元数据，失败回退内置预设 | `discoverAgentModels(config, agent)` |
| `agent/resources.js` | 不执行资源代码地发现用户/项目 Pi 扩展、Skills 与已安装 package 资源；CLI 列表失败时保留本地目录结果 | `discoverAgentResources(config)` |
| `agent/provider.js` | 动态后端路由、Pi / Codex invocation、Codex thread 恢复；组合默认 Prompt 与追加 Prompt | `PiProvider`、`CodexProvider`、`AgentProvider`、`MockProvider` |
| `agent/guide.js` | Lush 内置任务、权限与交付协议；profile 未替换默认 Prompt 时使用 | `GUIDE` |
| `agent/session.js` | Pi 会话 JSONL 的只读解析与用量投影 | 会话解析函数 |

---

## 1. 任务编排：`src/core/project.js` + `src/core/project/`

入口 `project.js` 只做装配：`export class Project extends ProjectBase {}`，
合并各 mixin 时查重名，并继续 `export const FLOWS`。

| 文件 | 职责 | 导出（作为 `Project.prototype` 的方法） |
|---|---|---|
| `project/base.js` | 构造与实例状态（`config` / `store` / `agentSettings` / `provider` / `workspaces` / `running` / `stopping` / `scheduled` / `ancestry`） | `class ProjectBase` |
| `project/internal.js` | 两个跨模块的私有助手 | `agentView(task, run, latestRun)`、`tokenHash(token)` |
| `project/agents.js` | 项目级 Agent 配置读写接缝；读取动态生效，按需查询 Pi / Codex 本机模型目录及 Pi 扩展/Skills，写入只允许用户侧 RPC | `agentConfig()`、`agentModels(agent)`、`agentResources()`、`configureAgents(value)` |
| `project/status.js` | 项目级读模型（任务分布、layers、意图、spec、drafts、agents、待合并、合并冻结、notice 计数），并镜像 daemon 软件配置与当前 `agent_config`；`provider` 表示当前默认 Agent（mock 模式仍为 mock），旧 pi 环境变量字段继续只读返回用于兼容 | `status()` |
| `project/deps.js` | 依赖边的读模型与结构校验 | `decorate(tasks)`、`blockedBy(taskId)`、`assertDeps(taskId, parent, edges)` |
| `project/inputs.js` | 从用户指定父分支创建可推进输入分支、在其中规划，以及流程判定 | `anchorInput(branch)`、`insertInput(inputId, anchor, content, attach, references)`、`createInput(content, attach, branch, references)`、`submit(content, branch, references)`、`inputs()`、`setInputFlow(taskId, flow)` |
| `project/drafts.js` | 输入缓存（增删改、结构化引用、整体提交到指定父分支） | `draft`、`drafts`、`dropDraft`、`editDraft`、`commitDrafts(ids, branch)` |
| `project/references.js` | Input / Draft 的结构化上下文引用：校验、持久化与 invocation 时实时解析 | `normalizeReferences(references)`、`referencesForInput(inputId)`、`resolveInputReferences(inputId)` |
| `project/specs.js` | 结构化 Plan 与确定性编译入口；新路径不创建 scheduler agent | `compilePlans()`、兼容别名 `ensureScheduler()`、`addSpec(plannerTaskId, spec)`、`dropSpec(specId, note, actor)` |
| `project/plans.js` | 计划审批闸门 | `proposePlan`、`approvePlan`、`rejectPlan`、`planForApproval` |
| `project/tasks.js` | 派生任务与单任务详情 | `spawn(parentId, goal, role, deps, name, specId)`、`inspect(taskId)` |
| `project/tree.js` | 任务树读模型（intent 层提上来当根） | `tree(taskId)` |
| `project/timeline.js` | 并发时间轴（run/wait 区间与原因） | `timeline({limit})` |
| `project/messages.js` | 收件箱、notice（question / plan / info 三类）、答复 | `message`、`notice`、`notify`、`answer` |
| `project/merge.js` | 批准合并、按目标分支批量交付、冲突收口、随带提交对账与交付队列 | `approveMerge`、`approveMergeMany`、`reconcileIntegrated`、`openResolution`、`settleResolution`、`mergeConflictContext`、`ladder()`、`containsCommit` |
| `project/graph.js` | 分支图读模型（全部本地分支 + fork 谱系边 + 任务关系）；每条 fork 边带三个可执行动作 `can_merge` / `can_sync` / `can_catchup`；每个 branch 节点带 `origin`（input / task / registered / local / placeholder）与配套 `title` / `summary` / `source_id` / `created_at`，`title` 优先用分支摘要（`branches.summary`），没有摘要才回落输入 / goal 首行截断，以及按自己 + 全部后代分支任务汇总的 `status`（active / failed / merged / ready / empty）与 `tasks` 计数，另带 `worktree` / `worktree_state`（worktree 路径与它现在还在不在磁盘上）与 `deleted`（该分支记录已被回收）；归档分支的 `status` 固定为 `archived` 并带 `archived` / `archived_at`（时间戳复用 `branches.deleted_at`，不新增列），它名下的任务节点标 `archived:true` 且仍留在图上；意图层的 planner（拆解）与 scheduler（编排）也作为 `kind:'task'` 节点进图并像 worker 一样挂在输入锚点分支下：planner 取自己 `input_id` 对应输入的 `inputs.anchor_branch`，scheduler 取本批 spec（`task_specs.batch_id = scheduler.id`）的 `input_id` 对应锚点，批为空 / 没有锚点时回落该批 planner 的输入锚点，仍找不到才 `branch:null` 走兜底分组；verifier 自己虽不拥有分支，单 worker 检验派生为 `verifies_task_id` 的分支，Candidate 检验派生为 `review_candidate_id` 固定的 Intent 集成分支，因此验收任务及工作态、blocker 都挂在服务对象所在分支；它们没有自己的 worktree / 目标分支，`target_branch` / `ahead` / `behind` / `merged` / `branch_state` 一律 null（不画「未合并 / 缺失分支」），但按同一套派生分支计入锚点分支的 `status` 与 `tasks` 汇总（running 的 planner 让分支从 empty 变 active）；每个 `kind:'task'` 节点（含 planner / scheduler）另带「待你决断」的 notice：`notice` 是 `status='open'` 且 `kind` 为 `question` / `plan` 的最新一条（按 id 最大，没有则 null），`notice_count` 是这类 open notice 的总数；`kind='info'` 的纯提醒（`status='sent'`）与 answered / dismissed 都不算，任务结算时 lifecycle 会把 open 置为 dismissed，所以终态任务不带——一次 SELECT 取回后按 task_id 在内存里归并，只读、不加列；每条 fork 边实时给出 `fast_forward` / `diverged` / `integrated` / `missing`、ahead/behind 与未收拢的直接子分支 | `graph()` |
| `project/branches.js` | 分支谱系读模型与用户批准的直接父子收敛：`branch merge` 只 fast-forward；落后时 `branch catchup` 让子分支快进跟上父分支；分歧时 `branch sync` 在子侧创建 merger；`branch tree` 不画归档的分支（记录仍在，用 `branch show` 查），隐藏时把它们的后代接到最近的可见祖先上；`branch archive` 归档一整棵子树（先跑安全门：子树根的登记/状态、当前检出不在子树里、全树没有未终态任务，再由 Git 边界把每条的 worktree / ref 删掉，任务行、消息、事件与 pi 会话文件都留着）；`branch tree` 不再画归档的分支，把它们还活着的后代接到最近的可见祖先上（`pruneHidden`）；`setBranchSummary` 只写 / 更新这条分支的一句话摘要（分支图标题），不碰 status / ref / worktree / 任务，并落一条 `branch.summary` 事件 | `BRANCH_NODE_LIMIT`、`branchNodes`、`branchTree`、`branchShow`、`branchImport`、`approveBranchMerge`、`catchupBranch`、`syncBranch`、`archiveBranch`、`setBranchSummary` |
| `project/verify.js` | worker / Candidate 检验与报告位置 | `verify(taskId)`、`verificationContext(task)`、`reportPath(taskId)`、`hasReport(taskId)` |
| `project/candidates.js` | 固定 commit 的 Review Candidate、验收、反馈与最终接受；`prepareCandidate` 只创建 `pending` 候选，不派任务，只有用户专属的 `candidate.verify` 才显式启动 verifier | `prepareCandidate`、`verifyCandidate`、`candidateContext`、`candidates`、`candidate`、`acceptCandidate`、`requestCandidateChanges`、`rejectCandidate` |
| `project/integration.js` | Plan worker 在私有 Intent branch 内自动叶子优先聚合；分歧派 merger，不动 target | `scheduleIntentIntegration`、`integrateIntent` |
| `project/transcript.js` | pi 会话记录的只读投影；每个 step 可带 tokens（assistant 步为 pi 记录的精确用量，工具输出/任务上下文步为相邻两次请求的上下文差值估算） | `transcript(taskId, after, limit)`、`usage(taskId)` |
| `project/scheduling.js` | 调度、invocation 生命周期、凭证 | `kick()`、`pump()`、`actor(token)`、`wake(taskId)`、`invoke(taskId, run)` |
| `project/lifecycle.js` | 结算、取消、重试、清空与恢复 | `finish`、`cancel`、`retry`、`clear`、`reclaimThenPurge(tasks, anchors)`、`recover`、`shutdown` |

## 2. Git 边界：`src/core/workspaces.js` + `src/core/workspaces/`

| 文件 | 职责 | 导出 |
|---|---|---|
| `workspaces/base.js` | 构造与串行队列状态（`queue` / `busy` / `namespace`） | `class WorkspacesBase` |
| `workspaces/git.js` | Git 原语与串行队列（无 shell 插值） | `exclusive`、`git`、`gitOutput`、`porcelain`、`clean`、`isAncestor`、`merging`、`unmerged`、`workspaceForBranch`、`checkedOut` |
| `workspaces/worktree.js` | worktree / 对照检出 / 可推进输入分支的创建与回收；planner 在输入 worktree 中运行，任务以直接父分支为 target | `anchor(inputId, requestedBranch)`、`dropAnchor(anchor)`、`releaseAnchor(anchor)`、`reclaimAnchors(anchors)`、`inputAnchor(task)`、`ensure(task)`、`finish(task)`、`codeBase(task)`、`removeBaseline(taskId)` |
| `workspaces/diff.js` | 只读审阅视图（不进写队列） | `diff(task)` |
| `workspaces/merge.js` | 父子分支关系判定、两个方向的原子 fast-forward（子→父、父→子）、批量预检与任务兼容入口；绝不在父分支 no-ff | `branchTaskBlockers(child)`、`branchState(child)`、`mergeBranchUnsafe(child)`、`mergeBranch(child)`、`catchupBranchUnsafe(child)`、`catchupBranch(child)`、`preflightMerge(tasks)`、`merge(taskId)` |
| `workspaces/cleanup.js` | 分支回收与安全清理（`dropBranch` / `dropAnchor` 走祖先检查；`archiveBranches` 归档一整棵子树，是唯一一条明知未合并也允许的 compare-and-delete，两遍走：先把全树的 tip / worktree 与脏活检查完，再开始删，不留归档了一半的子树） | `dropBranch`、`archiveBranch`、`archiveBranches`、`release`、`cleanup`、`reclaim` |

## 3. 持久化：`src/persistence/store.js` + `src/persistence/store/`

| 文件 | 职责 | 导出 |
|---|---|---|
| `store/base.js` | 打开数据库、事务、id 分配与加列式 schema 演进 | `class StoreBase`（构造、`run`/`get`/`all`/`transaction`/`close`、`taskIdHigh`/`setTaskIdHigh`/`nextTaskId`、`inputIdHigh`/`setInputIdHigh`/`nextInputId`） |
| `store/schema.js` | 全部 DDL 与项目绑定校验 | `SCHEMA`、`bindProject(db, project)` |
| `store/tasks.js` | tasks 表的读写与生命周期字段 | `task`、`tasks`、`summaries`、`create`、`update`、`children`、`touch`、`armAgent`、`touchAgent`、`agentByToken`、`activeTasks`、`purge` |
| `store/specs.js` | 拆解队列 | `specDeps`、`addSpec`、`spec`、`specs`、`specStats`、`pendingSpecs`、`specsForBatch`、`specsByPlanner`、`nextSpecPlanner`、`assignSpecs`、`takeSpecs`、`plannedSpec`、`dropSpec`、`releaseBatch`、`discardBatch` |
| `store/deps.js` | 依赖边 | `addDep`、`deps`、`dependents`、`depsDetail`、`dependentsDetail`、`depMap`、`reaches`、`edgesOf` |
| `store/messages.js` | 收件箱 | `message`、`unread` |
| `store/events.js` | 审计事件 | `event`、`history` |
| `store/verification.js` | 检验与解冲突的关联读模型 | `verifications`、`activeVerification`、`resolutions`、`activeResolver`、`unlandedResolver`、`conflictsOn` |
| `store/drafts.js` | 输入缓存 | `addDraft`、`draft`、`updateDraft`、`openDrafts`、`draftCount` |
| `store/references.js` | Input / Draft 的引用元数据（不是新的业务实体） | `setDraftReferences`、`draftReferences`、`setInputReferences`、`inputReferences`、`referencesForDrafts` |
| `store/timeline.js` | 时间轴原料 | `timelineTasks`、`lifecycleEvents`、`childSpans` |
| `store/branches.js` | 分支谱系记录（写入即不可变，删除与归档都只标 `status`、不删行，另存一句人写的 `summary` 作分支标题） | `PARENT_RELATIONS`、`branch`、`branches`、`recordBranch`、`markBranchDeleted`、`markBranchArchived`、`setBranchSummary` |
| `store/runs.js` | 每次 invocation 的 Run 与结构化 Artifact；Run 固化这一次实际使用的 provider / model / thinking（后续改项目配置不改历史） | `startRun`、`finishRun`、`runsForTask`、`addArtifact`、`artifact`、`artifactsForTask`、`artifactsForInput` |
| `store/candidates.js` | Review Candidate 版本与状态 | `candidate`、`candidates`、`latestCandidate`、`createCandidate`、`updateCandidate` |

## 4. 前端：`src/ui/web/assets/`

浏览器端 ES module，无打包器：`index.html` 先以 module 加载 `/appearance.js`（head 中定主题）再加载 `/app.js`，其余模块走 import 图，
由 `server.js` 的扩展名白名单按 basename 服务。

**三个必须遵守的接缝：**

- **`app.js` 导出 `boot()`**，并在被当作模块加载时执行一次 `await boot()`。
  `boot()` 先清掉上一次的定时器/监听器，再按当前全局 DOM 重新装配。理由：`bun test`
  在多个测试文件之间**共享模块注册表**，DOM 测试要给每个文件装自己的 stub，只能靠重复调用 `boot()`。
- **面板之间不互相 import 实现，只 import 接缝。** 跳转走 `navigate.js`，共享可变状态走 `state.js`，
  本地偏好（键名 / 默认值 / 读写）走 `prefs.js`，这既断掉循环依赖，也让面板文件之间没有编辑冲突面。
- **确认与输入一律走 `dialog.js` 的应用内弹窗，不用原生 `confirm` / `prompt` / `alert`。**
  原生弹窗不属于页面，浏览器可以静默吃掉它（勾过「阻止此页面创建更多对话框」、沙箱 iframe、
  内嵌 webview 等），那时 `confirm()` 不显示任何东西直接返回 false：调用方以为用户点了取消，
  用户看到的是「点了没反应」（分支图的「归档」就这样变成过死按钮）。`test/dom-stub.js` 把三个原生
  函数换成抛错，UI 一旦退回去测试就失败。

| 文件 | 职责 | 导出 |
|---|---|---|
| `app.js` | 唯一入口：装配左栏顶部身份区按钮（品牌回概览 / 移动端导航 / 右侧返回）、`#graph` / `#settings` / 四个信息页 / 任务 / 文档的 hash 路由与两个定时器；定时器按「轮询频率」偏好重建 | `boot()` |
| `appearance.js` | head 中初始化深浅主题，装配左栏顶部的主题切换按钮；偏好经 prefs.js 读写（`lush.theme`），`system` 跟随系统、显式值覆盖系统，存储不可用时保留会话内选择 | `systemThemeMedia()`、`resolveTheme()`、`effectiveTheme()`、`applyTheme()`、`createAppearance()`、`initAppearance()`、`refreshTheme()` |
| `prefs.js` | 本地偏好中心：键名 / 默认值 / 解析与序列化、读写与变更通知都在这一份（`markdown` / `theme` / `sidebarSort` / `collapsed` / `filters` / `reduceMotion` / `polling` / `toastDuration`）；坏数据回落默认值，存储不可用不抛异常；老键（`lush.treeSort`、`lush.theme`、`lush.markdown`）继续生效；`resetPrefs()` 删除全部受管键（含历史键）并逐项通知回默认值 | `PREF_DEFS`、`PREF_NAMES`、`MARKDOWN_KEY`、`THEME_KEY`、`SIDEBAR_SORT_KEY`、`LEGACY_TREE_SORT_KEY`、`REDUCED_MOTION_KEY`、`POLLING_KEY`、`TOAST_DURATION_KEY`、`THEME_VALUES`、`SORT_IDS`、`POLLING_MODES`、`TOAST_MODES`、`pollingIntervals()`、`toastDurations()`、`readPref`、`writePref`、`setPref`、`onPrefChange`、`resetPrefs`、`prefsSnapshot`、`storageAvailable` |
| `render-settings.js` | 设置视图，分 Agent / 界面 / 系统三个页签：Agent 页编辑项目默认与六类角色覆盖（agent / model / thinking / 默认 prompt / 追加 prompt / Pi 扩展与 Skills），可按需读 `/api/agent/models` 展示本机 CLI 当前模型目录、读 `/api/agent/resources` 多选已安装资源，经 `agent.configure` 写入项目；默认 prompt 正常显示内置全文并可一键恢复，替换内置 prompt 前显示风险警告并二次确认；界面页管理浏览器本地偏好与恢复默认；系统页只读展示 daemon 配置。打开期间轮询不用概览覆盖 | `openSettings()`、`renderSettings()` |
| `styles.css` | 双主题设计 token、应用布局（无应用顶栏：品牌 / 项目名 / 并发槽 / 连接状态 / 主题切换 / 退出登录在左栏顶部的身份区，内容区占满高度）、组件、响应式与 reduced-motion 动效（含设置页与强制减少动效 `[data-reduced-motion="true"]`） | CSS |
| `state.js` | 共享可变状态（一个对象，新字段不必改别的文件就能加）；`ui.indexOpen` 记录右侧信息页，`ui.lastGraph` 保存最近一次 `graph.get` 读模型，`ui.settingsOpen` 标记设置视图；折叠 / 筛选 / 排序偏好经 prefs.js 读写 | `ui`、`transcriptOpen`、`transcriptCache`、`mergeSelection`、`resetUiState()`、`readSidebarSortPref`、`readCollapsedPref`、`readFiltersPref`、`saveCollapsedPref`、`saveFiltersPref`、`SIDEBAR_SORT_KEY`、`LEGACY_TREE_SORT_KEY`、`SORT_IDS` |
| `navigate.js` | 导航间接层（断循环依赖） | `registerNavigation({refresh, detail, overview, graph})`、`refresh()`、`detail(taskId)`、`overview()`、`graph()` |
| `api.js` | fetch 与用户动作 | `api(url, options)`、`action(method, params)`、`loadHistory(taskId)` |
| `format.js` | 标签映射与格式化（纯函数） | `STATUS`、`INTEGRATION`、`ROLE`、`EVENTS`、`HOT`、`TERMINAL_STATUS`、`WAIT_REASON`、`PLAN_GATE`、`SPEC_STATUS`、`MERGE_STATUS`、`CHANGE`、`DEP_HELP`、`STEP`、`MD_STEP`、`GOAL_TITLE_LIMIT`、`statusOf`、`relative`、`duration`、`absolute`、`clock`、`tokens`、`money`、`depsOf`、`waitingDeps`、`resolverOf`、`specStatus`、`specTitle`、`summarizeGoal`、`taskTitle`、`edgeLabel`、`lastView`、`short` |
| `dom.js` | DOM 原语 | `el`、`button`、`syncChildren`、`block`、`kv`、`badge`、`statusBadge` |
| `dialog.js` | 应用内确认 / 输入弹窗（替代原生 `confirm` / `prompt`）：画进独立于 `#detail` 的 `#modal`，同刻只留一个弹窗，Esc / 点背景 / 取消＝取消，Enter / 输入框回车＝确认，关闭后焦点还给打开者 | `confirmDialog(opts)`、`promptDialog(opts)`、`closeDialog()` |
| `text.js` | agent 输出的 Markdown 偏好（只在设置页管理，偏好键 `lush.markdown`）；偏好变化时重画当前详情 | `markdownEnabled()`、`agentText(value, opts)` |
| `gauge.js` | 左栏身份区并发槽表 | `slotGauge(data)` |
| `filters-ui.js` | 筛选控件与选项工具 | `filterSelect`、`filterToggle`、`filterInput`、`syncSelectOptions`、`withCurrent`、`uniqueValues`、`roleOption`、`statusOption`、`specStatusOption`、`plannerOption`、`filterUi` |
| `sidebar-ui.js` | 左栏纯导航与右侧视图切换：信息页 / 通用内容画布互斥、统一视图栏、计数与兼容折叠状态 | `setViewChrome`、`activateDetailView`、`openResource`、`paintCollapsed`、`setNavCount`、`selectNav`、`navTo` |
| `sidebar-init.js` | 装配左侧页面导航，以及移到右侧信息页内的筛选 / 排序控件 | `initSidebar()` |
| `composer.js` | 输入缓存与提交表单；默认折叠只留一行输入 + 一行操作（父分支字段与快捷键说明点开「展开」才出现，折叠态在控件上标出非空父分支；展开状态只在会话内）；提示统一交给 `messages.js`，不再自己写输入栏底部的 `#error` | `buffer()`、`selectedDraftIds()`、`syncComposer()`、`paintDraftPanel()`、`toggleDraftPanel()`、`paintComposerDetails()`、`toggleComposerDetails()`、`initComposer()` |
| `context-references.js` | 页面选区 / 语义元素的右键引用、输入框引用卡片与可引用节点注册 | `referenceable(node, descriptor)`、`initContextReferences()`、`renderComposerReferences()`、`setComposerReferences()` |
| `messages.js` | 顶部消息提示（toast）：`#error` 从 `.composer` 底部搬进固定浮层，脱离 `.app` 的 grid；停留时长是本地偏好（`lush.toastDuration`，标准档＝信息 4s / 错误 8s），失败 / 错误类带手动关闭按钮，鼠标悬停暂停倒计时，同一段文本反复写入不重置计时（离线错误不闪烁），空文本立即隐藏。错误 `role=alert` / `aria-live=assertive`，信息 `role=status` / `aria-live=polite`；计时器可注入（DOM 测试用假时钟） | `show(value, kind)`、`clear()`、`setTimers(next)` |
| `render-drafts.js` | 待提交缓存与引用摘要 | `renderDrafts(data)` |
| `render-intents.js` | Intent 列表：原始目标、planner 闸门、Plan 计数、最新 Review Candidate 版本与「开始/重新验收 / 打开结果 / 接受并合入 / 要求修改」动作 | `renderIntents(data)` |
| `render-specs.js` | 拆解队列（只读） | `renderSpecs(data)`、`specItem(spec)`、`specDeps(value)` |
| `render-tree.js` | 任务树、兄弟链、依赖标签、为什么没在跑 | `renderTree(data)` |
| `render-notices.js` | 待决问题索引与右侧展开；resolver 首次请示使用明确的开始/暂不处理动作 | `renderNotices(data)`、`openNotice(noticeId)`、`noticePanel(notice, task?)` |
| `render-ladder.js` | 按目标分支分组的交付队列、变更栈与批量落地 | `renderLadder(data)`、`mergeBatch(ids, candidates)`、`renderMergeResult(entry)` |
| `render-timeline.js` | 并行时间轴 | `renderTimeline(timeline)` |
| `render-history.js` | 事件时间线 | `renderHistory(history, opts)` |
| `render-diff.js` | 改动概览 | `renderDiff(diff)` |
| `render-agent.js` | Agent 区块：执行过程优先，模型与用量折叠展示；增量更新最近一步 | `renderAgent(task, usage)`、`paintUsageLast(taskId, usage)` |
| `render-transcript.js` | 执行过程（分页、折叠、增量续读） | `transcriptContent(taskId)`、`paintTranscript(taskId)`、`appendTranscriptSteps(taskId, steps)`、`loadTranscript(taskId)` |
| `render-verify.js` | 检验区块 | `renderVerifications(task)` |
| `render-resolutions.js` | 合并冲突处理记录 | `renderResolutions(task)` |
| `render-detail.js` | 任务详情整页：一句话短标题（`taskTitle`）、完整 goal 以 Markdown 正文排在结果之前、状态、结果优先的阅读顺序与任务操作 | `renderDetail(task, history, diff, usage)`、`renderDetailError(taskId, message)` |
| `render-overview.js` | Intent 工作台：指标按 Intent / 并行执行 / 等待验收 / 需要你决定计，`pending` 候选提供用户显式“开始验收”动作，Intent 成果主线（含候选报告入口）先于折叠的 Git 交付诊断，任务只作明细；`kind='info'` 提醒、运行中 agent 与时间轴、维护信息照旧（`render-ladder.js` / `merge-select.js` 仍可用，但没有常驻视图） | `renderOverview(data)` |
| `graph-layout.js` | 分支图纯逻辑：fork 边拼出分支森林（任务挂到自己的分支下并把父分支作为嵌套；planner / scheduler 由 `graph.get` 派生出输入锚点分支后与 worker 任务同样挂载，无需新逻辑）；归档的分支不占分支树——跳过 `archived` 的 branch 节点与它们名下的任务，把它们还在的后代接到最近的可见祖先上（没有就升为根），这种后代的关系标 `parent_archived`（「父分支已归档」，中性色），`missing`（红色「分支缺失」）只留给谁都没归档、ref 真不见了的情况、每棵子树的 `subtreeBranches` / `subtreeTasks` 计数（收起时告诉用户藏了什么）、组内 code 层级（同层新的在前：任务按 id 降序，兄弟分支按 created_at 降序、未知时间排最后）、标签与廉价结构指纹，以及折叠偏好的 localStorage 形态——指纹把「待你决断」的 notice 也算进来（`graphFingerprint(snapshot)` 取 snapshot 里 open 且 question / plan 的 notice 按 id 排序，`graphRenderKey(graph)` 取任务节点的 `notice` id / kind 与 `notice_count`），所以新 notice 出现、被答复 / 忽略或换成另一条都会让分支图在既有 3s / 10s 陈旧规则内重拉重画（`kind='info'` 与 answered / dismissed 不算）；给每个分支算出 `archived` / `archived_at` 与 `archivable`（可归档判断：已登记、未归档也未删除、非当前检出、自己与后代都没有活动任务，且 ref 或 worktree 至少还有一个）；工作态显示口径由 `workingState(entry)` 单独回答（本分支 running / 本分支在等 / 只有子树在跑 / 停下来了）；每个分支另带 `relation`（`edgeRelation` 的结果，可能是 null）：归档把 ref 删掉之后 git 里算不出父子关系（daemon 报 `missing`），但那是用户自己按的归档，不是故障——已归档的分支 `relation` 为 null，父分支已归档的报 `parent_archived`，两者都不算 `unmerged` | `graphLayout(graph)`、`graphFingerprint(snapshot)`、`graphRenderKey(graph)`、`parseGraphCollapsed(raw)`、`serializeGraphCollapsed(set)`、`aheadBehindText(node)`、`nodeMarks(node)`、`workingState(entry)` |
| `render-graph.js` | 核心交互式分支流程图：顶部先汇总分支 / 任务 / 当前检出与关系图例；面板与连接线按父子关系着色（领先绿 / 一致灰 / 落后蓝 / 分歧琥珀 / 缺失红 / 父分支已归档灰），表头给出该关系的动作（合入父分支 / 让子分支跟上父分支 / 在子分支解决分歧），做不了的也画出来但禁用并写明原因；父子关系靠 CSS 画的竖线与拐角表达，整棵子树可收起（状态存 localStorage，重画不丢）；可归档的分支提供「归档」按钮（确认框写明会连它下面 N 条后代分支一起删，确认后调 `branch.archive`，带 `discard:true`；归档的分支随后不再画在图上）；分支表头按 `workingState` 渲染工作态标识（在跑 / 在等 chip、子树工作中），在跑的任务行带脉冲点，停下来的分支加 `.graph-idle` 整体降噪但保留未合并与关系色；真的有任务在本分支上跑（`workingState(...).key === 'running'`，不含仅子树在跑）的分支行另加 `.graph-running`：整行外环呼吸动效（只动外环的扩散与不透明度、周期 2.4s，不位移不缩放；在等 / 子树 / 停下来的分支都没有这个 class，保持静止；`prefers-reduced-motion` 下随全局规则关闭）；带待决 notice 的任务行（`graph.get` 的 `notice` / `notice_count`）另加 `.graph-emphasis-awaiting` 琥珀强调（可与工作态强调并存）并就地渲染决策区：徽标（`question` →「◔ 等你决定」/ `plan` →「计划待批」）、标题、正文与「另有 N-1 条待决」，`question` 给 textarea +「回复并继续任务」（`notice.answer`）与「忽略」（`notice.dismiss`，⌘/Ctrl+回车与任务详情一致），`plan` 给「批准并开发」（`plan.approve`）与「驳回」（`plan.reject`，沿用 `promptDialog`、空理由不发）；动作与任务详情 / 意图面板同源，成功后 `loadGraph()` 重拉、失败写顶部提示（`messages.js`）；有内容或正聚焦的决策输入会让这次 `renderGraph` 跳过重画（`hasPendingDecision`），避免 1.5s 轮询把用户打了一半的字与焦点冲掉。`fetchGraph()` 只拉数与更新 `ui.lastGraph` / `ui.graphFetchedAt` / `ui.graphFingerprint`（单飞），供概览复用，`loadGraph()` 再渲染分支图 | `openGraph()`、`fetchGraph()`、`loadGraph()`、`renderGraph(graph, opts)` |
| `detail.js` | 拉取并渲染任务详情；窄屏新导航收起索引并定位内容，轮询保留滚动 | `loadDetail(taskId)` |
| `docs.js` | 「文档」视图：路由（`#docs` / `#doc-<id>`）、取数与站内相对链接解析 | `docsTarget(hash)`、`resolveDocPath(from, raw)`、`docLinkResolver(current, docs)`、`openDocs(id)`、`loadDocs(id)`、`DOCS_HASH` |
| `render-docs.js` | 「文档」视图的目录、正文与兜底 | `renderDocsIndex(docs, onOpen)`、`renderDoc(doc, resolveLink, onOpen)`、`renderDocError(id, message, onOpen)` |
| `refresh.js` | 轮询快照、概览、热任务增量刷新、筛选重画；右侧信息页 / 文档 / 设置打开时不让概览覆盖；「项目概览」与「分支图」共用同一份 `graph.get`（`ui.lastGraph`）与同一条陈旧规则（指纹变且距上次 ≥3s，或 ≥10s），概览先用快照画、后台取图后就地重画 | `refresh()`、`overview()`、`liveRefresh()`、`applyFilters()` |

其它纯逻辑模块：`markdown.js`、`tree-order.js`、`live.js`、`sidebar.js`；`merge-select.js` 是交付队列的候选、冻结与 code-only 顺序预览接缝，由 `render-ladder.js` 使用。`live.js` 的实时刷新间隔不再是写死常量：`liveInterval()` 读「轮询频率」偏好，标准档等于改造前的 3000ms。

`markdown.js` 除默认渲染外还有两件「文档」视图需要的能力：`renderMarkdown(text, doc, options)` 里的
`options.link(raw, label)` 由调用方接管链接解析（返回 `{ href, external }`，返回空或抛错都回落到默认规则：
只有 http/https 成链接），以及 GFM 表格（架构文档大量使用）。两者都不改变不传 options 时的行为。

## 5. CLI：`src/cli/main.js` + `src/cli/`

命令处理器的统一签名：`export async function run(command, args, ctx)`，
其中 `ctx = { client, json }`；返回 `undefined` 表示「已经自己打印过，主流程不要再 print」。
`option` / `exact` / `print` 从 `args.js` 直接 import。

| 文件 | 命令 | 导出 |
|---|---|---|
| `cli/help.js` | 帮助文本 | `HELP` |
| `cli/args.js` | 参数解析与两种输出 | `option`、`exact`、`print` |
| `cli/print.js` | 树 / 阶梯 / 时间轴 / 合并 / 会话 / 用量 / 分支谱系的渲染 | `printTree`、`printLadder`、`printTimeline`、`printMergeMany`、`printTranscript`、`printUsage`、`printBranchTree`、`printBranchShow`、`printBranchImport`、`printBranchArchive` |
| `cli/commands/intent.js` | `say` / `intent` / `input` | `run` |
| `cli/commands/draft.js` | `draft` | `run` |
| `cli/commands/task.js` | `task` | `run` |
| `cli/commands/spec.js` | `spec` | `run` |
| `cli/commands/plan.js` | `plan` | `run` |
| `cli/commands/notice.js` | `notice` | `run` |
| `cli/commands/branch.js` | `branch`（tree / show / import / merge / sync / catchup / archive / summary） | `run` |
| `cli/commands/system.js` | `daemon` / `status` / `doctor` / `log` / `web` / `web-restart` / `web-stop` / `web-status` | `run` |
| `cli/commands/candidate.js` | `candidate list/inspect/prepare/verify/accept/changes/reject` | `run` |
| `cli/commands/agent.js` | `agent show/models/set/reset`；`--prompt` 只作旧版 `--append-prompt` 别名 | `run` |
| `cli/main.js` | 全局参数、命令分发表、fingerprint 提醒 | `main(argv)`（并 re-export `HELP`） |

## 6. RPC：`src/rpc/protocol.js` + `src/rpc/`

处理器的统一签名：`(project, params, actor) => result | Promise<result>`。

| 文件 | 职责 | 导出 |
|---|---|---|
| `rpc/protocol.js` | framing（编码、解析、帧上限）；并 re-export `Dispatcher` 保持旧 import 可用 | `MAX_FRAME`、`encode`、`errorResponse`、`parseRequest`、`Dispatcher` |
| `rpc/registry.js` | 方法白名单、参数白名单、权限集合与统一校验 | `PARAMS`、`USER_ONLY`、`AGENT_ONLY`、`assertAllowed(method, params, actor)` |
| `rpc/handlers/system.js` | `system.*`、`graph.get`、`agent.config`、`agent.models`、`agent.resources`、`agent.configure` | `handlers` |
| `rpc/handlers/input.js` | `input.*`、`draft.*` | `handlers` |
| `rpc/handlers/task.js` | `task.*` | `handlers` |
| `rpc/handlers/spec.js` | `spec.*`、`plan.*` | `handlers` |
| `rpc/handlers/notice.js` | `notice.*` | `handlers` |
| `rpc/handlers/branch.js` | `branch.tree/show/import/merge/sync/archive/summary`（`branch.archive` 参数 `branch` / `discard`，在 `USER_ONLY`；`branch.summary` 参数 `branch` / `summary`，agent 可写、省略 branch 时写自己的分支，用户必须显式点名） | `handlers` |
| `rpc/handlers/candidate.js` | `candidate.list/inspect/prepare/verify/accept/changes/reject`；所有变更操作 USER_ONLY | `handlers` |
| `rpc/dispatcher.js` | 合并 handler 表（查重名、查漏），校验后分派 | `class Dispatcher` |

## 7. 测试：`test/`

拆分只搬文件、不改断言。测试文件之间共享模块注册表，所以**每个测试文件必须自给自足**
（自己的 fixture / world / DOM stub），不要靠别的文件先跑过。

| 现在 | 拆成 |
|---|---|
| `project.test.js` | `test/project/{intent-layer,plan-gate,specs-queue,agents,lifecycle,recovery,limits,permissions}.test.js` |
| `drafts-deps.test.js` | `test/drafts/{drafts,deps}.test.js` |
| `workspaces.test.js` | `test/workspaces/{naming,merge,cleanup,genealogy,anchor}.test.js` |
| `web-rpc.test.js` | `test/web/{security,assets,read-models,drafts,transcript,specs-intents,maintenance}.test.js` |
| `web-live-dom.test.js` | `test/web/dom-{merge,detail,drafts,specs-intents,sidebar}.test.js`（各自 `boot()`，见前端接缝） |
| 工作台与主题 | `test/web/appearance.test.js`（主题解析、跟随系统、显式覆盖、存储失败）、`test/web/settings.test.js`（设置入口 / `#settings` / 轮询不覆盖、偏好默认值与老键、每项即时生效、恢复默认、系统信息组只读渲染与无快照占位）、`test/project/status.test.js`（`system.status` 的只读软件配置镜像与默认值）、`test/web/dom-studio.test.js`（信息优先级、折叠保留、移动端索引） |
| `integration.test.js` | `test/integration/{daemon,pi,verify,shutdown,merge}.test.js` |

`test/helpers.js`、`test/dom-stub.js` 是被多个文件共用的**公共面**：只增不改，改签名会同时影响所有分区。
