# 模块地图：Runtime 与持久化

本章列出 Agent 接缝、任务编排、Git 边界与 SQLite 模块。改签名或搬文件前先回到[模块地图总览](modules.md)确认公共面。

> 模块地图：[总览](modules.md) → **Runtime 与持久化** → [Web 前端](modules-web.md) → [CLI、RPC 与测试](modules-interfaces.md)

## Agent 运行时接缝

| 文件 | 职责 | 导出 |
|---|---|---|
| `agent/prompts.js` | 命名内置 Prompt 片段、按角色组合，并叠加可提交、本机与 `agent.json` 补充 | `AGENT_ROLES`、`PROMPT_PARTS`、`ROLE_PROMPT_PARTS`、`builtInPrompt(role)`、`agentPrompt(config,role,profile)` |
| `agent/environment.js` | 每次 invocation 热加载 `.lush/agent/agent.env` 与角色 env，校验并叠加环境；为 Web/RPC 提供按公共/角色文件读取与 owner-only 原子写入，空表删除文件 | `AGENT_ENV_TARGETS`、`parseAgentEnv(source,file)`、`readAgentEnvironment(config,target)`、`saveAgentEnvironment(config,target,values)`、`agentEnvironment(config,role)` |
| `agent/settings.js` | `.lush/agent.json` 的兼容读取、校验、原子写入、角色继承与 Web 选项（含各角色内置 Prompt）；旧 `prompt` 迁到 `append_prompt`，资源选择存 `extensions` / `skills` | `AGENT_ROLES`、`AGENT_BACKENDS`、`THINKING_LEVELS`、`MODEL_PRESETS`、`normalizeAgentConfig()`、`normalizeAgentProfile()`、`normalizeSoftBudget(value)`、`AgentSettings` |
| `agent/models.js` | 有界、超时地读取 Pi / Codex CLI 模型目录，只投影安全的模型元数据，失败回退内置预设 | `discoverAgentModels(config, agent)` |
| `agent/resources.js` | 不执行资源代码地发现用户/项目 Pi 扩展、Skills 与已安装 package 资源；CLI 列表失败时保留本地目录结果 | `discoverAgentResources(config)` |
| `agent/provider.js` | 动态后端路由、Pi / Codex invocation、Codex thread 恢复与每轮 token 用量留存（不伪造费用）；调用 Prompt 与 env 组合器；子进程因 AbortSignal 结束时保留 scheduler / lifecycle 写入的具体超时或取消原因；关闭进程后读一次抢占的双向标记（<home>/preempt，无论采纳与否立即清掉）并抛 `AgentPreempted` | `PiProvider`、`CodexProvider`、`AgentProvider`、`MockProvider`、`AgentPreempted`、`preemptPaths` |
| `agent/pi-runtime.js` | 内置 Pi extension；记录 invocation 身份，达到可选软预算后在下一次自然请求提醒一次，不强停或制造新轮次；在 `turn_end`（本轮工具都结束）读一次抢占请求并写 stop 标记，让本轮就此收尾 | 默认导出 `lushRuntime(pi)` |
| `agent/guide.js` | 旧调用方兼容出口；内置 Prompt 的事实来源是 `prompts.js` | `GUIDE` |
| `core/transcript-reader.js` | 完整任务会话的流式检索、按类型／工具／失败过滤、步骤分段原文与同会话调用 ID 配对；单行超过 16 MiB 明确报不完整，不受快速视图前 8 MiB 的范围限制 | `searchTranscript(config,taskId,options)`、`transcriptStep(config,taskId,seq,offset)`、`transcriptPage(config,taskId,seq?,offset?)`（连续完整文字，有界分段） |
| `core/transcript.js` | 兼容快速记录与用量投影；保留调用身份；与全文读面共享步骤投影；`readTranscriptLatest` 另做一次完整的异步流式扫描，尾部不受前 8 MiB 窗口限制，只保留 `limit` 大小的环形窗口与当前 token 批次 | `projectRecord(record,max?)`、`readTranscript`、`readTranscriptLatest(config,taskId,{after,before,limit})`、`readUsage`、`sessionFiles`、`transcriptReadStats` |
| `core/usage-statistics.js` | 项目完整会话的异步流式只读统计；有限 LRU 精简用量缓存、并发扫描单飞、时间过滤、UTC 分桶、provider/model 汇总与覆盖说明 | `readUsageStatistics(config,options,metadata?)` |
| `core/usage-attribution.js` | 使用显式身份或唯一 Run 时间区间生成有界 task / role / invocation 统计，无法确认时保留 unknown | `usageAttribution(metadata)` |

## 运行设置：`src/core/settings.js`

并发上限与调用 / 拆解限额是可在运行时改写的软件设置，存储在 `<home>/settings.json`（version 1，权限 `600`）。`src/config.js` 构造时先校验环境变量得到默认值，再用这里的覆盖值算出生效的 `config.concurrency` / `config.controlConcurrency` / `config.timeout` / `config.maxCalls` / `config.maxDepth`；`configureRuntime(patch)` 写盘后同步内存并调用宿主的 `onKick` 重新准入。

| 文件 | 职责 | 导出 |
|---|---|---|
| `core/settings.js` | 运行设置的存储与校验：数字键 `concurrency`（1..64）、`control_concurrency`（1..16）、`call_timeout`（1..86400）、`task_call_limit`（1..1000）、`max_depth`（1..64），以及结构化 `input_routes`，`null` 清除该键；读时校验 uid / symlink / 大小 / 字段，写用临时文件加 rename 原子替换（`0600`）；`get()` 给出生效值 / 环境默认值 / 是否被覆盖与文件路径，`save(patch)` 先校验再落盘 | `RUNTIME_SETTINGS_KEYS`、`RUNTIME_SETTINGS_LIMITS`、`normalizeRuntimeSettings()`、`RuntimeSettings` |

## 快速介绍设置：`src/core/quick-intro.js`

选中文字后的「快速介绍」直连的 OpenAI 兼容模型配置，存在 `<home>/quick-intro.json`（version 1，权限 `600`）。没有环境默认值：未配置就是未配置，调用方明确拒绝并让用户去设置里填。只存 `base_url` / `model` / `api_key`；`base_url` 只接受 http(s) 且会去掉尾部斜杠与重复的 `/chat/completions`，`api_key` 可留空（本地服务）。读模型用 `has_key` / `key_hint` 遮蔽密钥，只有 daemon 内部的 `resolve()` 拿到完整 Key。

| 文件 | 职责 | 导出 |
|---|---|---|
| `core/quick-intro.js` | 快速介绍配置的存储与校验、密钥遮蔽；读时校验 uid / symlink / 大小 / 字段，写用临时文件加 rename 原子替换（`0600`） | `QuickIntroSettings`、`normalizeBaseUrl(value)` |

## 任务编排：`src/core/project.js` + `src/core/project/`

入口 `project.js` 只做装配：`export class Project extends ProjectBase {}`，
合并各 mixin 时查重名，并继续 `export const FLOWS`。

| 文件 | 职责 | 导出（作为 `Project.prototype` 的方法） |
|---|---|---|
| `project/sleep.js` | 项目级托管模式授权、预算采样与暂停、单并发管家调度、重新校验后执行、不可变 Event 审计、本会话进度汇总与恢复 | `sleepStatus`、`sleepProgress`、`startSleep`、`stopSleep`、`resumeSleepDevelopment`、`sleepTick`、`sleepChoices`、`butlerContext`、`completeButler`、`recoverSleep`（内部辅助同模块） |
| `core/sleep-policy.js` | 开启选项及结构化决策校验、确定性推荐策略与共享风险说明 | `SLEEP_WARNING`、`sleepOptions`、`recommendedChoice`、`validateSleepChoice` |
| `project/base.js` | 构造与实例状态（`config` / `store` / `agentSettings` / `quickIntro` / `provider` / `workspaces` / `running` / `introRunning` / `stopping` / `scheduled` / `ancestry`） | `class ProjectBase` |
| `project/internal.js` | 两个跨模块的私有助手 | `agentView(task, run, latestRun)`、`tokenHash(token)` |
| `project/agents.js` | 项目级 Agent 配置与环境文件读写接缝；配置和 env 都动态生效，按需查询 Pi / Codex 本机模型目录及 Pi 扩展/Skills，写入只允许用户侧 RPC；env 读取因含密钥也只允许用户 | `agentConfig()`、`agentModels(agent)`、`agentResources()`、`agentEnvironment(target)`、`configureAgentEnvironment(target,values)`、`configureAgents(value)` |
| `project/settings.js` | 项目级运行设置接缝：把运行设置的读模型喂给 `system.status`，并把用户侧的 `system.configure` 接到 `Config.configureRuntime` | `runtimeSettings()`、`configureRuntimeSettings(patch)` |
| `project/status.js` | 项目级读模型与廉价 `revision`；首页 `system.summary` 走独立的 `summary()`，用持久 `meta.overview_revision` 与覆盖索引聚合且不打开 Agent / 快速介绍配置，兼容 `system.status` 仍镜像完整 `agent_config` / `intro_config`，设置页再按需读取；运行设置另给 `settings` 镜像（并发额度 + 调用 / 拆解限额），顶层同名字段仍是生效值 | `overviewRevision()`、`summary()`、`status(includeAgentConfig=true)` |
| `project/deps.js` | 依赖边的读模型与结构校验；`decorate` 同时按 `input_id` 命中 `routedInputIds()` 给出 `route` 布尔（快速路由任务标记） | `decorate(tasks)`、`blockedBy(taskId)`、`assertDeps(taskId, parent, edges)` |
| `src/core/task-input-rule.js` | 仓库规则从固定 fork commit 读取、保存 Task 快照；可信子进程限时执行并校验输入分发结果（不传 Agent 凭证） | `readInputRule`、`saveInputRule`、`snapshotPath`、`decideTaskInput` |
| `project/say.js` | 新 say 的父分支所有者解析、daemon 启动/main say 幂等建立静息根 Task与输入/草稿直接生成 Task（不触碰历史 planner 路径） | `bootstrapMain()`、`ensureMainTask()`、`bindBranch(branch,commit)`、`say(content?,branch?,references?,draftId?)`、`reserveTask(taskId,kind)`（同类 pending 重查并记录阶段性阻塞）、`reservationWaitReason(task)`、`settleReservedMerge(taskId)`（父分支有别人的交付锁时保持 pending 并记 `parent_locked`）、`unreserveTask(taskId)`（pending 可撤；已发出未集成的 merge 请求可撤——解除交付锁、不删分支与提交、另记 `task.request_withdrawn`）、`noteBranchAdvance(taskId)`（父分支自己提交后把失效请求记成 `parent_moved`）、`recheckRequestedMerge(taskId)` 与 `clearReservationBlocked(taskId)`（已发出请求的只读复查：`source_moved` / `contained` / `parent_moved` / 清掉过期诊断；重启恢复与 `task.reserve` 复查共用）、`approveReservedMerge(taskId,commit,baseline)`（固定提交已在父分支内时退化为幂等关闭）、`integrateChild(parentId,childId,commit)`（只有交付锁持有者能写锁住的父分支；确认解分歧子 Task 时额外要求它包含固定的源与父两个提交，并一并结算被修复的已完子任务）、`resolveSayDivergence(taskId)`（固定两端 tip，在活动 say 下挂 child、终态 say 下挂目标 owner 并以 `resolves_task_id` 关联源；受影响 Task 先冻结、runtime 验证后推进源分支；未集成的完成分支须用户显式归档后才可重派）、`requestSettledShowcaseMerge(taskId)` / `pinSettledMergeRequest(task,parent,commit,baseline)`（终态 say 的展示交付后合并补口：快进则 requested，分歧则留 pending/diverged）、`finalizeTerminalDivergence(resolutionId)` / `scheduleTerminalDivergenceFinalize(resolutionId)` / `noteTerminalDivergenceFailure(resolution,status,error)`（兼容旧方法名：新 say/child 的独立解分歧子 Task 由 runtime 核验固定提交并收尾，失败保留现场；lifecycle 触发）、`resolveChildDivergence(parentId,childId)`（执行中的直接父 Agent 派解分歧子 Task；父本轮安全结束后由 runtime 核对固定提交并落地；父分支有交付锁时先拒）、`analyze(taskId,question)`（用户专属：在 main/owner 下建 `task_kind='analysis'` 只读分析子 Task，不建分支） |
| `project/inputs.js` | 从用户指定父分支创建可推进输入分支、在其中规划；`inputs()` 的意图列表由 `inputs JOIN tasks` 内连接派生（任务那一半是输入自己的根 planner），所以根 planner 被 `task.delete` 删掉的输入行仍在库里，但不再出现在这个列表里 | `anchorInput(branch)`、`insertInput(inputId, anchor, content, attach, references)`、`createInput(content, attach, branch, references)`、`submit(content, branch, references)`、`inputs()` |
| `project/drafts.js` | 输入缓存（增删改、结构化引用、逐条提交到指定父分支） | `draft`、`drafts`、`dropDraft`、`editDraft`、`submitDraft(id, branch)`（单条 say）、`commitDrafts(ids, branch)`（旧批量入口） |
| `project/references.js` | Input / Draft 的结构化上下文引用：校验、持久化与 invocation 时实时解析 | `normalizeReferences(references)`、`referencesForInput(inputId)`、`resolveInputReferences(inputId)` |
| `project/specs.js` | 结构化 Plan 与确定性编译入口；新路径不创建 scheduler agent | `compilePlans()`、兼容别名 `ensureScheduler()`、`addSpec(plannerTaskId, spec)`、`dropSpec(specId, note, actor)` |
| `project/plans.js` | 计划审批闸门 | `proposePlan`、`approvePlan`、`rejectPlan`、`planForApproval` |
| `project/tasks.js` | 派生任务、首页活动任务 + 最近历史的有界窗口、历史任务游标页与单任务详情（`inspect` 与 `decorate` 同口径带 `route`） | `spawn(parentId, goal, role, deps, name, specId)`、`activity(limit,scope='work')`、`taskPage(before,limit,scope='work')`（Web 显式用 all 包含两层任务）、`inspect(taskId)` |
| `project/progress.js` | task 的 versioned 执行计划与预约读面投影、整表汇报与按稳定 key 完成；自动记录每步 `started_at` / `completed_at` / `duration_ms`，改计划时同 key 的完成态与计时保留 | `progressView(task)`、`reportProgressPlan(taskId, steps)`、`completeProgressStep(taskId, key)` |
| `project/tree.js` | 任务树读模型（intent 层提上来当根） | `tree(taskId)` |
| `project/timeline.js` | 并发时间轴（run/wait 区间与原因） | `timeline({limit})` |
| `project/messages.js` | 收件箱、notice（question / plan / info 三类）、答复 | `message`、`sendTaskSignal(sourceId,targetId,type,key,payload)`、`notice`、`notify`、`answer` |
| `project/merge.js` | 批准合并、按目标分支批量交付、冲突收口、随带提交对账与交付队列；`ladder()` 只读取有界 pending、对应有效 resolver 与直接依赖头，不遍历历史任务 | `approveMerge`、`approveMergeMany`、`reconcileIntegrated`、`openResolution`、`settleResolution`、`mergeConflictContext`、`ladder()`、`containsCommit` |
| `project/merge-all.js` | 一键合并：只读计划（叶子到根排序、动作与阻塞）、按计划逐条 ff-only 收拢、分歧自动建子侧 merger 后暂停并在结算后继续、取消释放冻结；运行是目标分支附属的 `branches.merge_run` versioned JSON，不是新实体；`assertBranchWritable` 是写操作前的统一冻结守卫（新式解分歧冻结源分支/后代及其直接父分支；调度器暂停受影响 Task 的新调用，原调用只在安全点结束） | `branchFreeze`、`assertBranchWritable`、`branchHost`、`mergeAllPlan`、`mergeAll`、`cancelMergeAll`、`scheduleMergeRun`、`driveMergeRun`、`resumeMergeRun`、`finishMergeRun`、`ensureMergeTarget` |
| `project/orchestrate.js` | 新交付模型的合并编排：只读 `orchestratePlan` 枚举目标分支后代里每个 say 子分支的固定 `commit`、父 `baseline`、实时状态与动作（`merge` / `resolve` / `skip`）；`orchestrate` 在目标分支 main/owner 下创建 `task_kind='merge'` 的 runtime 驱动 Task，复用 `branches.merge_run`（`mode:'orchestrate'` + `task_id`）与同一套冻结，按叶子→根内部 ff-only 落地固定提交（没有合并预约但已静息、有已提交改动且无未收拢子分支的 say 由 `autoRequestBlockers` / `autoReserveOrchestratedMerge` 代发固定提交请求，仍在跑 / 等待用户答复 / 无提交 / 已合入的跳过并给原因），分歧时在编排 Task 下派源侧独立解分歧子 Task（`resolves_task_id` + `orchestrated:true`）并由 runtime 收尾；`cancelOrchestrate` 清运行、释放冻结并取消等待中的子任务；`scheduleOrchestrate` / `driveOrchestrate` / `finishOrchestrate` 与旧一键合并共用单飞驱动集合 | `orchestratePlan`、`orchestrate`、`cancelOrchestrate`、`scheduleOrchestrate`、`driveOrchestrate`、`finishOrchestrate`（内部：`orchestrateItem`、`autoRequestBlockers`、`autoReserveOrchestratedMerge`、`settleOrchestratedMerge`、`pinOrchestratedRequest`、`landOrchestratedMerge`、`markOrchestratedIntegrated`、`spawnOrchestratedResolution`、`finalizeOrchestratedDivergence`） |
| `project/graph.js` | 分支图读模型（全部本地分支 + fork 谱系边 + 任务关系）；每条 fork 边带三个可执行动作 `can_merge` / `can_sync` / `can_catchup`；每个 branch 节点带 `origin`（input / task / registered / local / placeholder）与配套 `title` / `summary` / `source_id` / `created_at`，`title` 优先用分支摘要（`branches.summary`），没有摘要才回落输入 / goal 首行截断，以及按自己 + 全部后代分支任务汇总的 `status`（active / failed / merged / ready / empty）与 `tasks` 计数，另带 `worktree` / `worktree_state`（worktree 路径与它现在还在不在磁盘上）与 `deleted`（该分支记录已被回收）；每个 branch 节点还带 `showcase` 增量：`allowed` / `reason` / `latest_task_id`（真实准入）与 `reserved` / `reserved_at` / `reserve_allowed` / `reserve_reason`（预约状态与只读 store 的静态可预约面）；归档分支的 `status` 固定为 `archived` 并带 `archived` / `archived_at`（时间戳复用 `branches.deleted_at`，不新增列），它名下的任务节点标 `archived:true` 且仍留在图上；意图层的 planner（拆解）与 scheduler（编排）也作为 `kind:'task'` 节点进图并像 worker 一样挂在输入锚点分支下：planner 取自己 `input_id` 对应输入的 `inputs.anchor_branch`，scheduler 取本批 spec（`task_specs.batch_id = scheduler.id`）的 `input_id` 对应锚点，批为空 / 没有锚点时回落该批 planner 的输入锚点，仍找不到才 `branch:null` 走兜底分组；`role='agent'` 里只有 say 与新派生的 child 作为任务节点进图（两者都有自己分支与 worktree），main/owner 是分支所有者（信息已在 branch 节点的 `title` / `source_id` 上，不重复画）且 analysis 无分支，都不进任务节点；verifier 自己虽不拥有分支，单 worker 检验派生为 `verifies_task_id` 的分支，Candidate 检验派生为 `review_candidate_id` 固定的 Intent 集成分支，因此验收任务及工作态、blocker 都挂在服务对象所在分支；它们没有自己的 worktree / 目标分支，`target_branch` / `ahead` / `behind` / `merged` / `branch_state` 一律 null（不画「未合并 / 缺失分支」），但按同一套派生分支计入锚点分支的 `status` 与 `tasks` 汇总（running 的 planner 让分支从 empty 变 active）；每个 `kind:'task'` 节点（含 planner / scheduler）带有界的 `progress` 摘要（完成数 / 总数 / 当前步骤）供分支诊断画执行进度，另带 `route` 布尔（该输入的 planner 有 `input.route` 事件即快速路由），并另带「待你决断」的 notice：`notice` 是 `status='open'` 且 `kind` 为 `question` / `plan` 的最新一条（按 id 最大，没有则 null），`notice_count` 是这类 open notice 的总数；`kind='info'` 的纯提醒（`status='sent'`）与 answered / dismissed 都不算，任务结算时 lifecycle 会把 open 置为 dismissed，所以终态任务不带——一次 SELECT 取回后按 task_id 在内存里归并，只读、不加列；每条 fork 边实时给出 `fast_forward` / `diverged` / `integrated` / `missing`、ahead/behind 与未收拢的直接子分支 | `graph()` |
| `project/branches.js` | 分支谱系读模型与用户批准的直接父子收敛：`branch merge` 只 fast-forward；落后时 `branch catchup` 让子分支快进跟上父分支；分歧时 `branch sync` 在子侧创建 merger；三者与非 internal 的写路径都先过 `assertBranchWritable`，冻结中的分支拒绝新的合并/同步/跟上（已有同名 merger 的幂等 sync 仍返回它）；`branch tree` 不画归档的分支（记录仍在，用 `branch show` 查），隐藏时把它们的后代接到最近的可见祖先上；`branch archive` 归档一整棵子树（先跑安全门：子树根的登记/状态、当前检出不在子树里、全树及关联效果展示没有未终态任务，再由 Git 边界把每条的 worktree / ref 与终态展示的 detached worktree 删掉，任务行、展示报告、消息、事件与 pi 会话文件都留着），并在同一个事务里清除被归档分支的效果展示预约（`showcase.unreserved`）；合并与跟上成功后会调度一次预约重扫；`setBranchSummary` 只写 / 更新这条分支的一句话摘要（分支图标题），不碰 status / ref / worktree / 任务，并落一条 `branch.summary` 事件 | `BRANCH_NODE_LIMIT`、`branchNodes`、`branchTree`、`branchShow`、`branchImport`、`approveBranchMerge(branch,expected,options)`、`catchupBranch`、`syncBranch`、`archiveBranch`、`setBranchSummary` |
| `project/explanations.js` | 用户专属执行步骤解释 Task、来源 Event 快照、状态与有界历史；无 Input / 分支 / worktree，不给 agent RPC 权限 | `startExplanation(taskId,seq,quote)`、`explanationContext(taskId)`、`explanation(taskId)`、`explanations(taskId,before)` |
| `project/intro.js` | 用户专属「快速介绍」：建 `running` 记录后台直连 OpenAI 兼容接口（不建 Task / Input / 分支、不读会话），结果与失败写回同一行，超时 / 中断落 `failed`；供应配置读写与按来源任务的有界历史 | `introConfig()`、`configureIntro(patch)`、`startIntro(quote,location)`、`runIntro(rowId,controller)`、`introInvoke(row,config,signal)`、`introduction(rowId)`、`introductions(taskId,before)` |
| `project/showcase.js` | 效果展示共用准入读面（任务稳定性、子分支收拢与历史文件树去重）、Task 创建/重试、固定上下文、报告校验、有界列表与预览启停；预约是分支附属元数据：`showcaseReservable` 是只读 store 的静态可预约面，`reserveShowcase` / `unreserveShowcase` 写入/清除 `branches.showcase_reservation` 并落 `showcase.reserved` / `showcase.unreserved`，`scheduleShowcaseSweep` 单飞调度 `sweepShowcaseReservations` 重扫全部 pending 预约，满足准入才启动；`startShowcase` 启动时消费 pending 预约并落 `showcase.reservation_started` | `showcaseEligibility`、`showcaseReservation`、`showcaseEventHost`、`showcaseReservable`、`reserveShowcase`、`unreserveShowcase`、`scheduleShowcaseSweep`、`sweepShowcaseReservations`、`retryShowcase`、`startShowcase`、`showcases`、`showcaseContext`、`prepareShowcaseReport`、`showcaseReport`、`startShowcasePreview`、`stopShowcasePreview` |
| `core/preview.js` / `core/preview-runner.js` | 本机预览端口分配、有限日志、子进程及进程组生命周期；runner 用 stdin EOF 监控 daemon 存活 | `startPreview`；runner 为内部子进程入口 |
| `project/verify.js` | worker / Candidate 检验、报告位置与 version 1 证据文件的严格校验；`pass` 拒绝非空 `failures` / `unverified`，允许记录 `baseline_failures` / `residual_risks`；commit 和报告引用由 runtime 绑定，旧/缺失 Artifact 投影为 `unknown`，正常返回但未交证据为 `unverified` | `verify(taskId)`、`verificationContext(task)`、`reportPath(taskId)`、`evidencePath(taskId)`、`hasReport(taskId)`、`verificationEvidence(task)`、`verificationResult(taskId)` |
| `project/candidates.js` | 固定 commit 的 Review Candidate、验收、反馈与最终人工接受；读模型带结构化 `verification`；所有用户动作通过 Store 的集中转换动作，进入 `accepted` 后拒绝 reject / changes / supersede 且不支持取消接受，Git 串行区间仍在 Workspaces，自动结论只可进入 `ready` / `failed`、不得合并 | `prepareCandidate`、`verifyCandidate`、`candidateContext`、`candidates`、`candidate`、`acceptCandidate`、`requestCandidateChanges`、`rejectCandidate` |
| `project/integration.js` | Plan worker 在私有 Intent branch 内自动叶子优先聚合；分歧派 merger，不动 target | `scheduleIntentIntegration`、`integrateIntent` |
| `project/transcript.js` | pi 会话记录的只读投影；底层按 64 KiB 分块、以 UTF-8 字节执行 8 MiB 预算，按文件身份/版本缓存完整 JSONL 行与未完尾行，并用头部/旧追加边界的有界字节守卫区分纯追加与同 inode truncate 后快速长回，替换/截断重建；用量在文件签名未变时复用聚合，每个 step 的 token 口径保持不变；`transcriptLatest` 走独立的全量流式扫描（不复用 8 MiB 预算缓存），按 `after/before` 取最新窗口 | `transcript(taskId, after, limit)`、`transcriptLatest(taskId,after,before,limit)`、`searchTranscript(taskId,options)`、`transcriptStep(taskId,seq,offset)`、`transcriptPage(taskId,seq,offset)`、`usage(taskId)`、`usageStatistics(options)`（项目统计走独立全量流式读面；测量接缝 `transcriptReadStats`） |
| `project/context.js` | 按角色和因果关系提供有界启动上下文；不注入全局任务历史 | `invocationContext(task,run)` |
| `project/scheduling.js` | 调度、invocation 生命周期、凭证；成功返回写 version 2 `run.result`，把 `invocation.status` 与 `verification.status` 分开；scheduler 持有调用截止时间并把超时规范化为带秒数的 failed Run，与用户取消的 cancelled Run 区分；用户追加输入时 `requestPreempt` 只在有安全边界的后端（当前 Pi）写一次性抢占请求，`AgentPreempted` 把该 Run 记成 `preempted` 而不是失败 | `kick()`、`pump()`、`actor(token)`、`hasActionableMessages(taskId)`、`wake(taskId)`、`invoke(taskId, run)`、`requestPreempt(taskId,reason)` |
| `project/lifecycle.js` | 结算、取消、重试（可冻结仅本轮生效的完整 task-local Agent profile）、清空、定向删除与恢复；Candidate verifier 只在当前状态为 `preparing`、`report_task_id` 仍匹配、报告存在且结构化结论为 `pass` 时结算为 `ready`，其余结论为 `failed`；迟到结果保留事件但不改 Candidate；结算与恢复在既有 `wake` / `kick` 之后各调度一次效果展示预约重扫 | `finish`、`cancel`、`retry`、`clear`、`reclaimThenPurge(tasks, anchors)`、`deleteTask(taskId)`、`subtreeTasks(taskId)`、`forgetTasks(root, subtree, ids)`、`recover`、`shutdown` |

`project/graph.js` 另把 Git 边界的 `branchDiagnostics()` 结果投影到 branch 节点的 `diagnostics`，不改变既有任务计数与父子关系口径。`taskGraph()` 独立投影 Task 父子边、解分歧的源 Task 引用/冻结原因、执行进度/待决/交付摘要与 Task 分支的实时诊断（已提交变更和未提交工作区分开），不复用 fork 边；最多 200 个任务并对文本字段设限。`project/messages.js` 对新 say/child 的用户消息先执行固定规则、再按结果软抢占或轮末交付；`project/tasks.js` 派生 child 时继承父的快照。

## Git 边界：`src/core/workspaces.js` + `src/core/workspaces/`

| 文件 | 职责 | 导出 |
|---|---|---|
| `workspaces/base.js` | 构造与串行队列状态（`queue` / `busy` / `namespace`） | `class WorkspacesBase` |
| `workspaces/git.js` | Git 原语与串行队列（无 shell 插值） | `exclusive`、`git`、`gitOutput`、`porcelain`、`clean`、`isAncestor`、`merging`、`unmerged`、`workspaceForBranch`、`checkedOut` |
| `workspaces/worktree.js` | worktree / 对照检出 / 可推进输入分支的创建与回收；planner 在输入 worktree 中运行，任务以直接父分支为 target；`task_kind='analysis'` 只给分支提交的分离检出（不建分支、调用结束回收） | `anchor(inputId, requestedBranch)`、`dropAnchor(anchor)`、`releaseAnchor(anchor)`、`reclaimAnchors(anchors)`、`inputAnchor(task)`、`ensure(task)`、`finish(task)`、`codeBase(task)`、`removeBaseline(taskId)` |
| `workspaces/showcase.js` | 已登记非主干准入、精确本地 ref / 起点解析、实际改动与工作区 / Git 中间态校验、固定提交树有界缓存、隔离 detached 检出及复用校验（归档显式 discard 时可只校验身份而允许脏目录）；不拥有或删除源分支 | `showcaseSnapshot`、`showcaseTree`、`showcaseCleanBranches`、`assertShowcaseCheckout`、`ensureShowcase` |
| `workspaces/diff.js` | 只读审阅视图（不进写队列）；分支诊断批量读取创建起点到 tip 的改动、最近提交与实际 worktree 未提交数，固定提交有界缓存；字段与限制见[分支诊断接缝](modules.md#分支诊断增量读面) | `diff(task)`、`branchDiagnostics(branches)` |
| `workspaces/merge.js` | 父子分支关系判定、两个方向的原子 fast-forward（子→父、父→子）、批量预检与任务兼容入口；绝不在父分支 no-ff | `branchTaskBlockers(child)`、`branchState(child)`、`mergeBranchUnsafe(child,expected)`、`mergeBranch(child,expected)`、`catchupBranchUnsafe(child)`、`catchupBranch(child)`、`preflightMerge(tasks)`、`merge(taskId)` |
| `workspaces/cleanup.js` | 分支回收与安全清理（`dropBranch` / `dropAnchor` 走祖先检查；`archiveBranches` 归档一整棵子树，是唯一一条明知未合并也允许的 compare-and-delete，两遍走：先把全树的 tip / worktree、关联终态展示的 detached worktree 与脏活检查完，再停展示预览并开始删，不留已知安全门导致的半归档） | `dropBranch`、`archiveBranch`、`archiveBranches`、`release`、`cleanup`、`reclaim` |

## 持久化：`src/persistence/store.js` + `src/persistence/store/`

| 文件 | 职责 | 导出 |
|---|---|---|
| `store/base.js` | 打开数据库、事务、id 分配与加列式 schema 演进 | `class StoreBase`（构造、`run`/`get`/`all`/`transaction`/`close`、`taskIdHigh`/`setTaskIdHigh`/`nextTaskId`、`inputIdHigh`/`setInputIdHigh`/`nextInputId`） |
| `store/schema.js` | 全部 DDL、项目绑定校验，以及首页持久 revision / 技术计数表 `overview_task_counts` 的触发器维护（旧库打开时一次性播种） | `SCHEMA`、`bindProject(db, project)` |
| `store/tasks.js` | tasks 表的读写与生命周期字段（新增可空 `task_kind`，旧记录为 legacy，新 say/main/owner 明确标识；`reservation` 是 say 的 versioned 互斥预约状态；merge 静息结算并向直接父 Task 发送请求，用户按固定源提交/父基线批准 main/owner；showcase 静息准入后冻结源/对照提交、创建原 say 的展示子 Task，子任务结算后完成原 say（含恢复补偿））、有界 task 页（scope 默认 work，all 包含 intent/work），以及 `tasks.progress_plan` 附属 JSON 的原子替换；`tasks.retry_profile` 保存已校验的本轮重试 Profile 并在终态清除；`routedInputIds()` 一次查出带 `input.route` 事件的 input id 集，供任务读模型标注快速路由 | `task`、`tasks`、`summaries`、`summaryPage`、`routedInputIds`、`create`、`update`、`setProgressPlan`、`children`、`touch`、`armAgent`、`touchAgent`、`agentByToken`、`activeTasks`、`purge`、`referringTasks`、`deleteTasks` |
| `store/specs.js` | 拆解队列 | `specDeps`、`addSpec`、`spec`、`specs`、`specStats`、`pendingSpecs`、`specsForBatch`、`specsByPlanner`、`nextSpecPlanner`、`assignSpecs`、`takeSpecs`、`plannedSpec`、`dropSpec`、`releaseBatch`、`discardBatch` |
| `store/deps.js` | 依赖边；`depMap(taskIds?)` 可只投影当前有界任务窗 | `addDep`、`deps`、`dependents`、`depsDetail`、`dependentsDetail`、`depMap`、`reaches`、`edgesOf` |
| `store/messages.js` | 收件箱 | `message`、`signal`（有键去重的 Task 信号）、`unread` |
| `store/events.js` | 审计事件；保留旧正向历史，并提供从最近记录向前翻页的游标页；事件只带 `message_id` 时一并附上被引用的消息正文（`event.message`） | `event`（返回新增 ID）、`history`、`historyPage` |
| `store/verification.js` | 检验与解冲突的关联读模型 | `verifications`、`activeVerification`、`resolutions`、`activeResolver`、`unlandedResolver`、`conflictsOn` |
| `store/drafts.js` | 输入缓存 | `addDraft`、`draft`、`updateDraft`、`openDrafts`、`draftCount` |
| `store/references.js` | Input / Draft 的引用元数据（不是新的业务实体） | `setDraftReferences`、`draftReferences`、`setInputReferences`、`inputReferences`、`referencesForDrafts` |
| `store/introductions.js` | 「快速介绍」读写：创建 / 收尾 / 恢复时把遗留 `running` 落成 `failed` / 按来源任务分页（不是任务，`task_id` 可空不加外键） | `intro`、`introCreate`、`introFinish`、`introFailRunning`、`introList` |
| `store/timeline.js` | 时间轴原料 | `timelineTasks`、`lifecycleEvents`、`childSpans` |
| `store/branches.js` | 分支谱系记录（写入即不可变，删除与归档都只标 `status`、不删行，另存一句人写的 `summary` 作分支标题，以及可空 `showcase_reservation` 效果展示预约）；`setBranchShowcaseReservation` 写/清预约，`branchShowcaseReservations` 只返回 `status='pending'` 且 JSON 可解析的预约，`markBranchDeleted` 顺手清预约并落 `showcase.unreserved` | `PARENT_RELATIONS`、`branch`、`branches`、`recordBranch`、`markBranchDeleted`、`markBranchArchived`、`setBranchSummary`、`setBranchShowcaseReservation`、`branchShowcaseReservations` |
| `store/runs.js` | 每次 invocation 的 Run 与结构化 Artifact；Run 状态含 `completed` / `failed` / `cancelled` / `preempted`（安全边界上被用户输入收尾，不是失败）；写入按 runtime 同一结论规则严格校验 version 2 `run.result`（`pass` 无 `failures` / `unverified`，但可有 `baseline_failures` / `residual_risks`），读取时兼容历史 payload 并把缺失或矛盾验收证据投影为 `unknown`；Run 固化这一次实际使用的 provider / model / thinking | `validateRunResultPayload(payload)`、`artifactPayload(kind,source)`；mixin：`startRun`、`finishRun`、`runsForTask`、`addArtifact`、`artifact`、`artifactsForTask`、`artifactsForInput` |
| `store/candidates.js` | Review Candidate 版本与集中状态机；Project 用户动作通过命名 action 转换，`updateCandidate` 兼容入口也校验同一转换图；`accepted` 是不可取消的决策边界，只接受 Git 成功/失败回报，拒绝 reject / changes / supersede；verifier 结算通过单条条件 UPDATE 原子核验当前状态与 `report_task_id`。事务只覆盖数据库，接受后的 Git 副作用仍由 Workspaces 串行，结果再回报状态机 | `CANDIDATE_STATUSES`；mixin：`candidate`、`candidates`、`latestCandidate`、`createCandidate`、`updateCandidate`、`transitionCandidate`、`settleCandidateVerification` |

---

[← 上一篇：模块地图总览](modules.md) · [下一篇：Web 前端 →](modules-web.md)
