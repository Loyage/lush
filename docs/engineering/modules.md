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

- RPC 方法名与参数表（`registry.js` 的 `PARAMS`）、`USER_ONLY` / `AGENT_ONLY` 权限集合。
- CLI 命令与 `lush help` 的语义。
- SQLite schema、表名、列名与 `meta.task_id_high` / `meta.input_id_high` 的行为。加列式演进（只给已有表补缺失的可空列）登记在 `store/base.js` 的 `ADDED_COLUMNS`；它不改类型、不重写任何行。
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
- 环境变量与 agent capability 语义（`LUSH_PROJECT` / `LUSH_HOME` / `LUSH_TASK_ID` / `LUSH_AGENT_TOKEN`）。
- `src/core/genealogy.js`（分支谱系的纯逻辑：`buildForest` / `parentOf` / `childrenOf` / `ancestorsOf` /
  `descendantsOf` / `rootOf` / `chainOf`）与 `types.js` / `naming.js` 一样是共享纯模块：不碰 git、不写盘、
  不渲染，只被 `project/branches.js` 与 `test/branch-tree.test.js` 使用。`naming.js` 导出 `slugify` /
  `taskSlug` / `taskLabel` 与 `inputLabel(id)`（输入聚合分支的 `input-<id>` 名）。

## 分区总览

| 分区 | 入口 | 细粒度模块 | 独立可并行 |
|---|---|---|---|
| 任务编排 | `src/core/project.js` | `src/core/project/`（18 个） | ✅ |
| Git 边界 | `src/core/workspaces.js` | `src/core/workspaces/`（5 个） | ✅ |
| 持久化 | `src/persistence/store.js` | `src/persistence/store/`（9 个） | ✅ |
| 前端 | `src/ui/web/assets/app.js` | `src/ui/web/assets/`（见下表） | ✅ |
| CLI | `src/cli/main.js` | `src/cli/`（10 个） | ✅ |
| RPC | `src/rpc/protocol.js` | `src/rpc/`（7 个） | ✅ |
| 测试 | `test/*.test.js` | `test/<分区>/*.test.js` | 依赖上面六个落定后 |

前六个分区 **互不共享文件**，可以同时开工。测试分区要等它们落地，否则测的是半成品。

---

## 1. 任务编排：`src/core/project.js` + `src/core/project/`

入口 `project.js` 只做装配：`export class Project extends ProjectBase {}`，
合并各 mixin 时查重名，并继续 `export const FLOWS`。

| 文件 | 职责 | 导出（作为 `Project.prototype` 的方法） |
|---|---|---|
| `project/base.js` | 构造与实例状态（`config` / `store` / `provider` / `workspaces` / `running` / `stopping` / `scheduled` / `ancestry`） | `class ProjectBase` |
| `project/internal.js` | 两个跨模块的私有助手 | `agentView(task, run)`、`tokenHash(token)` |
| `project/status.js` | 项目级读模型（任务分布、layers、意图、spec、drafts、agents、待合并、合并冻结、notice 计数） | `status()` |
| `project/deps.js` | 依赖边的读模型与结构校验 | `decorate(tasks)`、`blockedBy(taskId)`、`assertDeps(taskId, parent, edges)` |
| `project/inputs.js` | 从用户指定父分支创建可推进输入分支、在其中规划，以及流程判定 | `anchorInput(branch)`、`insertInput(inputId, anchor, content, attach)`、`createInput(content, attach, branch)`、`submit(content, branch)`、`inputs()`、`setInputFlow(taskId, flow)` |
| `project/drafts.js` | 输入缓存（增删改、整体提交到指定父分支） | `draft`、`drafts`、`dropDraft`、`editDraft`、`commitDrafts(ids, branch)` |
| `project/specs.js` | 拆解队列与批次的出生 | `ensureScheduler()`、`addSpec(plannerTaskId, spec)`、`dropSpec(specId, note, actor)` |
| `project/plans.js` | 计划审批闸门 | `proposePlan`、`approvePlan`、`rejectPlan`、`planForApproval` |
| `project/tasks.js` | 派生任务与单任务详情 | `spawn(parentId, goal, role, deps, name, specId)`、`inspect(taskId)` |
| `project/tree.js` | 任务树读模型（intent 层提上来当根） | `tree(taskId)` |
| `project/timeline.js` | 并发时间轴（run/wait 区间与原因） | `timeline({limit})` |
| `project/messages.js` | 收件箱、notice、答复 | `message`、`notice`、`answer` |
| `project/merge.js` | 批准合并、按目标分支批量交付、冲突收口、随带提交对账与交付队列 | `approveMerge`、`approveMergeMany`、`reconcileIntegrated`、`openResolution`、`settleResolution`、`mergeConflictContext`、`ladder()`、`containsCommit` |
| `project/graph.js` | 分支图读模型（全部本地分支 + fork 谱系边 + 任务关系）；每条 fork 边带三个可执行动作 `can_merge` / `can_sync` / `can_catchup`；每个 branch 节点带 `origin`（input / task / registered / local / placeholder）与配套 `title` / `source_id` / `created_at`，以及按自己 + 全部后代分支任务汇总的 `status`（active / failed / merged / ready / empty）与 `tasks` 计数；每条 fork 边实时给出 `fast_forward` / `diverged` / `integrated` / `missing`、ahead/behind、未收拢直接子分支 | `graph()` |
| `project/branches.js` | 分支谱系读模型与用户批准的直接父子收敛：`branch merge` 只 fast-forward；落后时 `branch catchup` 让子分支快进跟上父分支；分歧时 `branch sync` 在子侧创建 merger | `BRANCH_NODE_LIMIT`、`branchNodes`、`branchTree`、`branchShow`、`branchImport`、`approveBranchMerge`、`catchupBranch`、`syncBranch` |
| `project/verify.js` | 检验任务与报告位置 | `verify(taskId)`、`verificationContext(task)`、`reportPath(taskId)`、`hasReport(taskId)` |
| `project/transcript.js` | pi 会话记录的只读投影 | `transcript(taskId, after, limit)`、`usage(taskId)` |
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
| `workspaces/cleanup.js` | 分支回收与安全清理 | `dropBranch`、`release`、`cleanup`、`reclaim` |

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
| `store/timeline.js` | 时间轴原料 | `timelineTasks`、`lifecycleEvents`、`childSpans` |
| `store/branches.js` | 分支谱系记录（写入即不可变、删除只标状态） | `PARENT_RELATIONS`、`branch`、`branches`、`recordBranch`、`markBranchDeleted` |

## 4. 前端：`src/ui/web/assets/`

浏览器端 ES module，无打包器：`index.html` 只加载 `/app.js`，其余模块走 import 图，
由 `server.js` 的扩展名白名单按 basename 服务。

**两个必须遵守的接缝：**

- **`app.js` 导出 `boot()`**，并在被当作模块加载时执行一次 `await boot()`。
  `boot()` 先清掉上一次的定时器/监听器，再按当前全局 DOM 重新装配。理由：`bun test`
  在多个测试文件之间**共享模块注册表**，DOM 测试要给每个文件装自己的 stub，只能靠重复调用 `boot()`。
- **面板之间不互相 import 实现，只 import 接缝。** 跳转走 `navigate.js`，共享可变状态走 `state.js`，
  这既断掉循环依赖，也让面板文件之间没有编辑冲突面。

| 文件 | 职责 | 导出 |
|---|---|---|
| `app.js` | 唯一入口：装配顶部按钮、移动端任务浏览开关、hashchange、两个定时器 | `boot()` |
| `appearance.js` | head 中同步初始化深浅主题（避免闪屏），装配主题切换；持久化偏好，未指定时跟随系统 | 独立 classic script，无导出 |
| `styles.css` | 双主题设计 token、应用布局、组件、响应式与 reduced-motion 动效 | CSS |
| `state.js` | 共享可变状态（一个对象，新字段不必改别的文件就能加） | `ui`、`transcriptOpen`、`transcriptCache`、`mergeSelection`、`resetUiState()` |
| `navigate.js` | 导航间接层（断循环依赖） | `registerNavigation({refresh, detail, overview})`、`refresh()`、`detail(taskId)`、`overview()` |
| `api.js` | fetch 与用户动作 | `api(url, options)`、`action(method, params)`、`loadHistory(taskId)` |
| `format.js` | 标签映射与格式化（纯函数） | `STATUS`、`INTEGRATION`、`ROLE`、`EVENTS`、`HOT`、`TERMINAL_STATUS`、`WAIT_REASON`、`PLAN_GATE`、`SPEC_STATUS`、`MERGE_STATUS`、`CHANGE`、`DEP_HELP`、`STEP`、`MD_STEP`、`statusOf`、`relative`、`duration`、`absolute`、`clock`、`tokens`、`money`、`depsOf`、`waitingDeps`、`resolverOf`、`specStatus`、`specTitle`、`edgeLabel`、`lastView`、`short` |
| `dom.js` | DOM 原语 | `el`、`button`、`syncChildren`、`block`、`kv`、`badge`、`statusBadge` |
| `text.js` | agent 输出的 Markdown 开关 | `agentText(value, opts)`、`syncMarkdownToggle()`、`toggleMarkdown()` |
| `gauge.js` | 顶部并发槽表 | `slotGauge(data)` |
| `filters-ui.js` | 筛选控件与选项工具 | `filterSelect`、`filterToggle`、`filterInput`、`syncSelectOptions`、`withCurrent`、`uniqueValues`、`roleOption`、`statusOption`、`specStatusOption`、`plannerOption`、`filterUi` |
| `sidebar-ui.js` | 左栏导航 / 折叠 / 计数 | `paintCollapsed`、`setNavCount`、`selectNav`、`navTo` |
| `sidebar-init.js` | 装配导航与五组筛选条 | `initSidebar()` |
| `composer.js` | 输入缓存与提交表单 | `buffer()`、`selectedDraftIds()`、`syncComposer()`、`initComposer()` |
| `render-drafts.js` | 待提交缓存 | `renderDrafts(data)` |
| `render-intents.js` | 意图面板（planner 闸门 + scheduler 进度 + 输入分支） | `renderIntents(data)` |
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
| `render-detail.js` | 任务详情整页：目标标题、状态、结果优先的阅读顺序与任务操作 | `renderDetail(task, history, diff, usage)`、`renderDetailError(taskId, message)` |
| `render-overview.js` | 项目工作台：关键指标、优先待决事项、交付队列、运行与时间轴、折叠运行时维护信息 | `renderOverview(data)` |
| `graph-layout.js` | 分支图纯逻辑：fork 边拼出分支森林（任务挂到自己的分支下并把父分支作为嵌套）、每棵子树的 `subtreeBranches` / `subtreeTasks` 计数（收起时告诉用户藏了什么）、组内 code 层级、标签与廉价结构指纹，以及折叠偏好的 localStorage 形态 | `graphLayout(graph)`、`graphFingerprint(snapshot)`、`graphRenderKey(graph)`、`parseGraphCollapsed(raw)`、`serializeGraphCollapsed(set)`、`aheadBehindText(node)`、`nodeMarks(node)` |
| `render-graph.js` | 交互式分支流程图：面板与连接线按父子关系着色（领先绿 / 一致灰 / 落后蓝 / 分歧琥珀 / 缺失红），表头给出该关系的动作（合入父分支 / 让子分支跟上父分支 / 在子分支解决分歧），做不了的也画出来但禁用并写明原因；父子关系靠 CSS 画的竖线与拐角表达，整棵子树可收起（状态存 localStorage，重画不丢） | `openGraph()`、`loadGraph()`、`renderGraph(graph, opts)` |
| `detail.js` | 拉取并渲染任务详情；窄屏新导航收起索引并定位内容，轮询保留滚动 | `loadDetail(taskId)` |
| `docs.js` | 「文档」视图：路由（`#docs` / `#doc-<id>`）、取数与站内相对链接解析 | `docsTarget(hash)`、`resolveDocPath(from, raw)`、`docLinkResolver(current, docs)`、`openDocs(id)`、`loadDocs(id)`、`DOCS_HASH` |
| `render-docs.js` | 「文档」视图的目录、正文与兜底 | `renderDocsIndex(docs, onOpen)`、`renderDoc(doc, resolveLink, onOpen)`、`renderDocError(id, message, onOpen)` |
| `refresh.js` | 轮询快照、概览、热任务增量刷新、筛选重画 | `refresh()`、`overview()`、`liveRefresh()`、`applyFilters()` |

其它纯逻辑模块：`markdown.js`、`tree-order.js`、`live.js`、`sidebar.js`；`merge-select.js` 是交付队列的候选、冻结与 code-only 顺序预览接缝，由 `render-ladder.js` 使用。

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
| `cli/print.js` | 树 / 阶梯 / 时间轴 / 合并 / 会话 / 用量 / 分支谱系的渲染 | `printTree`、`printLadder`、`printTimeline`、`printMergeMany`、`printTranscript`、`printUsage`、`printBranchTree`、`printBranchShow`、`printBranchImport` |
| `cli/commands/intent.js` | `say` / `intent` / `input` | `run` |
| `cli/commands/draft.js` | `draft` | `run` |
| `cli/commands/task.js` | `task` | `run` |
| `cli/commands/spec.js` | `spec` | `run` |
| `cli/commands/plan.js` | `plan` | `run` |
| `cli/commands/notice.js` | `notice` | `run` |
| `cli/commands/branch.js` | `branch`（tree / show / import / merge / sync / catchup） | `run` |
| `cli/commands/system.js` | `daemon` / `status` / `doctor` / `log` / `web` / `web-restart` / `web-stop` / `web-status` | `run` |
| `cli/main.js` | 全局参数、命令分发表、fingerprint 提醒 | `main(argv)`（并 re-export `HELP`） |

## 6. RPC：`src/rpc/protocol.js` + `src/rpc/`

处理器的统一签名：`(project, params, actor) => result | Promise<result>`。

| 文件 | 职责 | 导出 |
|---|---|---|
| `rpc/protocol.js` | framing（编码、解析、帧上限）；并 re-export `Dispatcher` 保持旧 import 可用 | `MAX_FRAME`、`encode`、`errorResponse`、`parseRequest`、`Dispatcher` |
| `rpc/registry.js` | 方法白名单、参数白名单、权限集合与统一校验 | `PARAMS`、`USER_ONLY`、`AGENT_ONLY`、`assertAllowed(method, params, actor)` |
| `rpc/handlers/system.js` | `system.*`、`graph.get` | `handlers` |
| `rpc/handlers/input.js` | `input.*`、`draft.*` | `handlers` |
| `rpc/handlers/task.js` | `task.*` | `handlers` |
| `rpc/handlers/spec.js` | `spec.*`、`plan.*` | `handlers` |
| `rpc/handlers/notice.js` | `notice.*` | `handlers` |
| `rpc/handlers/branch.js` | `branch.tree/show/import/merge/sync` | `handlers` |
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
| 工作台与主题 | `test/web/appearance.test.js`（首屏主题、系统偏好、持久化与存储失败）、`test/web/dom-studio.test.js`（信息优先级、折叠保留、移动端索引） |
| `integration.test.js` | `test/integration/{daemon,pi,verify,shutdown,merge}.test.js` |

`test/helpers.js`、`test/dom-stub.js` 是被多个文件共用的**公共面**：只增不改，改签名会同时影响所有分区。
