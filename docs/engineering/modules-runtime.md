# 模块地图：Runtime 与持久化

本章列出 Agent 接缝、任务编排、Git 边界与 SQLite 模块。改签名或搬文件前先回到[模块地图总览](modules.md)确认公共面。

> 模块地图：[总览](modules.md) → **Runtime 与持久化** → [Web 前端](modules-web.md) → [CLI、RPC 与测试](modules-interfaces.md)

## Agent 运行时接缝

| 文件 | 职责 | 导出 |
|---|---|---|
| `agent/prompts.js` | 命名内置 Prompt 片段、按角色组合，并叠加可提交、本机与 `agent.json` 补充 | `AGENT_ROLES`、`PROMPT_PARTS`、`ROLE_PROMPT_PARTS`、`builtInPrompt(role)`、`agentPrompt(config,role,profile)` |
| `agent/environment.js` | 每次 invocation 热加载 `.lush/agent/agent.env` 与角色 env，校验并叠加环境；为 Web/RPC 提供按公共/角色文件读取与 owner-only 原子写入，空表删除文件 | `AGENT_ENV_TARGETS`、`parseAgentEnv(source,file)`、`readAgentEnvironment(config,target)`、`saveAgentEnvironment(config,target,values)`、`agentEnvironment(config,role)` |
| `agent/settings.js` | `.lush/agent.json` 的兼容读取、校验、原子写入、角色继承与 Web 选项（含各角色内置 Prompt）；旧 `prompt` 迁到 `append_prompt`，资源选择存 `extensions` / `skills` | `AGENT_ROLES`、`AGENT_BACKENDS`、`THINKING_LEVELS`、`MODEL_PRESETS`、`normalizeAgentConfig()`、`AgentSettings` |
| `agent/models.js` | 有界、超时地读取 Pi / Codex CLI 模型目录，只投影安全的模型元数据，失败回退内置预设 | `discoverAgentModels(config, agent)` |
| `agent/resources.js` | 不执行资源代码地发现用户/项目 Pi 扩展、Skills 与已安装 package 资源；CLI 列表失败时保留本地目录结果 | `discoverAgentResources(config)` |
| `agent/provider.js` | 动态后端路由、Pi / Codex invocation、Codex thread 恢复；调用 Prompt 与 env 组合器 | `PiProvider`、`CodexProvider`、`AgentProvider`、`MockProvider` |
| `agent/guide.js` | 旧调用方兼容出口；内置 Prompt 的事实来源是 `prompts.js` | `GUIDE` |
| `agent/session.js` | Pi 会话 JSONL 的只读解析与用量投影 | 会话解析函数 |

## 运行设置：`src/core/settings.js`

并发上限是唯一可在运行时改写的软件设置，存储在 `<home>/settings.json`（version 1，权限 `600`）。`src/config.js` 构造时先校验环境变量得到默认值，再用这里的覆盖值算出生效的 `config.concurrency` / `config.controlConcurrency`；`configureRuntime(patch)` 写盘后同步内存并调用宿主的 `onKick` 重新准入。

| 文件 | 职责 | 导出 |
|---|---|---|
| `core/settings.js` | 运行设置的存储与校验：只接受 `concurrency`（1..64）与 `control_concurrency`（1..16），`null` 清除该键；读时校验 uid / symlink / 大小 / 字段，写用临时文件加 rename 原子替换（`0600`）；`get()` 给出生效值 / 环境默认值 / 是否被覆盖与文件路径，`save(patch)` 先校验再落盘 | `RUNTIME_SETTINGS_KEYS`、`RUNTIME_SETTINGS_LIMITS`、`normalizeRuntimeSettings()`、`RuntimeSettings` |

## 任务编排：`src/core/project.js` + `src/core/project/`

入口 `project.js` 只做装配：`export class Project extends ProjectBase {}`，
合并各 mixin 时查重名，并继续 `export const FLOWS`。

| 文件 | 职责 | 导出（作为 `Project.prototype` 的方法） |
|---|---|---|
| `project/base.js` | 构造与实例状态（`config` / `store` / `agentSettings` / `provider` / `workspaces` / `running` / `stopping` / `scheduled` / `ancestry`） | `class ProjectBase` |
| `project/internal.js` | 两个跨模块的私有助手 | `agentView(task, run, latestRun)`、`tokenHash(token)` |
| `project/agents.js` | 项目级 Agent 配置与环境文件读写接缝；配置和 env 都动态生效，按需查询 Pi / Codex 本机模型目录及 Pi 扩展/Skills，写入只允许用户侧 RPC；env 读取因含密钥也只允许用户 | `agentConfig()`、`agentModels(agent)`、`agentResources()`、`agentEnvironment(target)`、`configureAgentEnvironment(target,values)`、`configureAgents(value)` |
| `project/settings.js` | 项目级运行设置接缝：把运行设置的读模型喂给 `system.status`，并把用户侧的 `system.configure` 接到 `Config.configureRuntime` | `runtimeSettings()`、`configureRuntimeSettings(patch)` |
| `project/status.js` | 项目级读模型（任务分布、layers、意图、spec、drafts、agents、待合并、合并冻结、notice 计数），并镜像 daemon 软件配置与当前 `agent_config`；其中并发额度另给 `settings` 镜像（每个键的生效值 / 环境默认值 / 是否被覆盖与文件路径；写走用户专属的 `system.configure`），顶层 `concurrency` / `control_concurrency` 仍是生效值；`provider` 表示当前默认 Agent（mock 模式仍为 mock），旧 pi 环境变量字段继续只读返回用于兼容 | `status()` |
| `project/deps.js` | 依赖边的读模型与结构校验 | `decorate(tasks)`、`blockedBy(taskId)`、`assertDeps(taskId, parent, edges)` |
| `project/inputs.js` | 从用户指定父分支创建可推进输入分支、在其中规划，以及流程判定；`inputs()` 的意图列表由 `inputs JOIN tasks` 内连接派生（任务那一半是输入自己的根 planner），所以根 planner 被 `task.delete` 删掉的输入行仍在库里，但不再出现在这个列表里 | `anchorInput(branch)`、`insertInput(inputId, anchor, content, attach, references)`、`createInput(content, attach, branch, references)`、`submit(content, branch, references)`、`inputs()`、`setInputFlow(taskId, flow)` |
| `project/drafts.js` | 输入缓存（增删改、结构化引用、整体提交到指定父分支） | `draft`、`drafts`、`dropDraft`、`editDraft`、`commitDrafts(ids, branch)` |
| `project/references.js` | Input / Draft 的结构化上下文引用：校验、持久化与 invocation 时实时解析 | `normalizeReferences(references)`、`referencesForInput(inputId)`、`resolveInputReferences(inputId)` |
| `project/specs.js` | 结构化 Plan 与确定性编译入口；新路径不创建 scheduler agent | `compilePlans()`、兼容别名 `ensureScheduler()`、`addSpec(plannerTaskId, spec)`、`dropSpec(specId, note, actor)` |
| `project/plans.js` | 计划审批闸门 | `proposePlan`、`approvePlan`、`rejectPlan`、`planForApproval` |
| `project/tasks.js` | 派生任务与单任务详情 | `spawn(parentId, goal, role, deps, name, specId)`、`inspect(taskId)` |
| `project/progress.js` | task 的 versioned 执行计划投影、整表汇报与按稳定 key 完成；自动记录每步 `started_at` / `completed_at` / `duration_ms`，改计划时同 key 的完成态与计时保留 | `progressView(task)`、`reportProgressPlan(taskId, steps)`、`completeProgressStep(taskId, key)` |
| `project/tree.js` | 任务树读模型（intent 层提上来当根） | `tree(taskId)` |
| `project/timeline.js` | 并发时间轴（run/wait 区间与原因） | `timeline({limit})` |
| `project/messages.js` | 收件箱、notice（question / plan / info 三类）、答复 | `message`、`notice`、`notify`、`answer` |
| `project/merge.js` | 批准合并、按目标分支批量交付、冲突收口、随带提交对账与交付队列 | `approveMerge`、`approveMergeMany`、`reconcileIntegrated`、`openResolution`、`settleResolution`、`mergeConflictContext`、`ladder()`、`containsCommit` |
| `project/graph.js` | 分支图读模型（全部本地分支 + fork 谱系边 + 任务关系）；每条 fork 边带三个可执行动作 `can_merge` / `can_sync` / `can_catchup`；每个 branch 节点带 `origin`（input / task / registered / local / placeholder）与配套 `title` / `summary` / `source_id` / `created_at`，`title` 优先用分支摘要（`branches.summary`），没有摘要才回落输入 / goal 首行截断，以及按自己 + 全部后代分支任务汇总的 `status`（active / failed / merged / ready / empty）与 `tasks` 计数，另带 `worktree` / `worktree_state`（worktree 路径与它现在还在不在磁盘上）与 `deleted`（该分支记录已被回收）；归档分支的 `status` 固定为 `archived` 并带 `archived` / `archived_at`（时间戳复用 `branches.deleted_at`，不新增列），它名下的任务节点标 `archived:true` 且仍留在图上；意图层的 planner（拆解）与 scheduler（编排）也作为 `kind:'task'` 节点进图并像 worker 一样挂在输入锚点分支下：planner 取自己 `input_id` 对应输入的 `inputs.anchor_branch`，scheduler 取本批 spec（`task_specs.batch_id = scheduler.id`）的 `input_id` 对应锚点，批为空 / 没有锚点时回落该批 planner 的输入锚点，仍找不到才 `branch:null` 走兜底分组；verifier 自己虽不拥有分支，单 worker 检验派生为 `verifies_task_id` 的分支，Candidate 检验派生为 `review_candidate_id` 固定的 Intent 集成分支，因此验收任务及工作态、blocker 都挂在服务对象所在分支；它们没有自己的 worktree / 目标分支，`target_branch` / `ahead` / `behind` / `merged` / `branch_state` 一律 null（不画「未合并 / 缺失分支」），但按同一套派生分支计入锚点分支的 `status` 与 `tasks` 汇总（running 的 planner 让分支从 empty 变 active）；每个 `kind:'task'` 节点（含 planner / scheduler）带有界的 `progress` 摘要（完成数 / 总数 / 当前步骤）供分支诊断画执行进度，并另带「待你决断」的 notice：`notice` 是 `status='open'` 且 `kind` 为 `question` / `plan` 的最新一条（按 id 最大，没有则 null），`notice_count` 是这类 open notice 的总数；`kind='info'` 的纯提醒（`status='sent'`）与 answered / dismissed 都不算，任务结算时 lifecycle 会把 open 置为 dismissed，所以终态任务不带——一次 SELECT 取回后按 task_id 在内存里归并，只读、不加列；每条 fork 边实时给出 `fast_forward` / `diverged` / `integrated` / `missing`、ahead/behind 与未收拢的直接子分支 | `graph()` |
| `project/branches.js` | 分支谱系读模型与用户批准的直接父子收敛：`branch merge` 只 fast-forward；落后时 `branch catchup` 让子分支快进跟上父分支；分歧时 `branch sync` 在子侧创建 merger；`branch tree` 不画归档的分支（记录仍在，用 `branch show` 查），隐藏时把它们的后代接到最近的可见祖先上；`branch archive` 归档一整棵子树（先跑安全门：子树根的登记/状态、当前检出不在子树里、全树没有未终态任务，再由 Git 边界把每条的 worktree / ref 删掉，任务行、消息、事件与 pi 会话文件都留着）；`branch tree` 不再画归档的分支，把它们还活着的后代接到最近的可见祖先上（`pruneHidden`）；`setBranchSummary` 只写 / 更新这条分支的一句话摘要（分支图标题），不碰 status / ref / worktree / 任务，并落一条 `branch.summary` 事件 | `BRANCH_NODE_LIMIT`、`branchNodes`、`branchTree`、`branchShow`、`branchImport`、`approveBranchMerge(branch, expectedCommit?)`、`catchupBranch`、`syncBranch`、`archiveBranch`、`setBranchSummary` |
| `project/verify.js` | worker / Candidate 检验与报告位置 | `verify(taskId)`、`verificationContext(task)`、`reportPath(taskId)`、`hasReport(taskId)` |
| `project/candidates.js` | 固定 commit 的 Review Candidate、验收、反馈与最终接受；`prepareCandidate` 只创建 `pending` 候选，不派任务，只有用户专属的 `candidate.verify` 才显式启动 verifier | `prepareCandidate`、`verifyCandidate`、`candidateContext`、`candidates`、`candidate`、`acceptCandidate`、`requestCandidateChanges`、`rejectCandidate` |
| `project/integration.js` | Plan worker 在私有 Intent branch 内自动叶子优先聚合；分歧派 merger，不动 target | `scheduleIntentIntegration`、`integrateIntent` |
| `project/transcript.js` | pi 会话记录的只读投影；每个 step 可带 tokens（assistant 步为 pi 记录的精确用量，工具输出/任务上下文步为相邻两次请求的上下文差值估算） | `transcript(taskId, after, limit)`、`usage(taskId)` |
| `project/scheduling.js` | 调度、invocation 生命周期、凭证 | `kick()`、`pump()`、`actor(token)`、`wake(taskId)`、`invoke(taskId, run)` |
| `project/lifecycle.js` | 结算、取消、重试、清空、定向删除与恢复 | `finish`、`cancel`、`retry`、`clear`、`reclaimThenPurge(tasks, anchors)`、`deleteTask(taskId)`、`subtreeTasks(taskId)`、`forgetTasks(root, subtree, ids)`、`recover`、`shutdown` |

## Git 边界：`src/core/workspaces.js` + `src/core/workspaces/`

| 文件 | 职责 | 导出 |
|---|---|---|
| `workspaces/base.js` | 构造与串行队列状态（`queue` / `busy` / `namespace`） | `class WorkspacesBase` |
| `workspaces/git.js` | Git 原语与串行队列（无 shell 插值） | `exclusive`、`git`、`gitOutput`、`porcelain`、`clean`、`isAncestor`、`merging`、`unmerged`、`workspaceForBranch`、`checkedOut` |
| `workspaces/worktree.js` | worktree / 对照检出 / 可推进输入分支的创建与回收；planner 在输入 worktree 中运行，任务以直接父分支为 target | `anchor(inputId, requestedBranch)`、`dropAnchor(anchor)`、`releaseAnchor(anchor)`、`reclaimAnchors(anchors)`、`inputAnchor(task)`、`ensure(task)`、`finish(task)`、`codeBase(task)`、`removeBaseline(taskId)` |
| `workspaces/diff.js` | 只读审阅视图（不进写队列） | `diff(task)` |
| `workspaces/merge.js` | 父子分支关系判定、两个方向的原子 fast-forward（子→父、父→子）、批量预检与任务兼容入口；绝不在父分支 no-ff；Candidate 可把固定提交传到同一 Git 串行区间内校验并落地 | `branchTaskBlockers(child)`、`branchState(child)`、`mergeBranchUnsafe(child, expectedCommit?)`、`mergeBranch(child, expectedCommit?)`、`catchupBranchUnsafe(child)`、`catchupBranch(child)`、`preflightMerge(tasks)`、`merge(taskId)` |
| `workspaces/cleanup.js` | 分支回收与安全清理（`dropBranch` / `dropAnchor` 走祖先检查；`archiveBranches` 归档一整棵子树，是唯一一条明知未合并也允许的 compare-and-delete，两遍走：先把全树的 tip / worktree 与脏活检查完，再开始删，不留归档了一半的子树） | `dropBranch`、`archiveBranch`、`archiveBranches`、`release`、`cleanup`、`reclaim` |

## 持久化：`src/persistence/store.js` + `src/persistence/store/`

| 文件 | 职责 | 导出 |
|---|---|---|
| `store/base.js` | 打开数据库、事务、id 分配与加列式 schema 演进 | `class StoreBase`（构造、`run`/`get`/`all`/`transaction`/`close`、`taskIdHigh`/`setTaskIdHigh`/`nextTaskId`、`inputIdHigh`/`setInputIdHigh`/`nextInputId`） |
| `store/schema.js` | 全部 DDL 与项目绑定校验 | `SCHEMA`、`bindProject(db, project)` |
| `store/tasks.js` | tasks 表的读写与生命周期字段，以及 `tasks.progress_plan` 附属 JSON 的原子替换 | `task`、`tasks`、`summaries`、`create`、`update`、`setProgressPlan`、`children`、`touch`、`armAgent`、`touchAgent`、`agentByToken`、`activeTasks`、`purge`、`referringTasks`、`deleteTasks` |
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
| `store/candidates.js` | Review Candidate 版本与状态；verifier 结算以当前状态和绑定 task 作条件更新 | `candidate`、`candidates`、`latestCandidate`、`createCandidate`、`updateCandidate`、`settleCandidateVerification` |

---

[← 上一篇：模块地图总览](modules.md) · [下一篇：Web 前端 →](modules-web.md)
