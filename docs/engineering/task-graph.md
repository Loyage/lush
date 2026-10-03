# Worker 图与输入规则（增量实现）

Worker 图是 `#worker-graph` / `worker.graph` / `/api/worker-graph` 的有界读面：节点是 Worker（含 main、owner、旧Worker），边来自当前 `parent_id`；当前 version 2 父自有交付队列不创建 merge Worker、不改源 Worker 的 `parent_id`，父子边始终表达委派关系；排队、源侧修复和落地待验收的 Worker 都留在直接父 Worker 下，不靠展示层抬升。旧 version 2 在途重挂仅凭明确预约／审计恢复原父，历史身份与事件保留，不猜父关系。落地不自动归档。卡片显示目标摘要、Agent 类型、分支合并状态（`integration`：待合并 / 已合并 / 合并中等，与Worker详情同源，做成首行标签）、工作/静息与冻结原因、结果预览、计划进度、子 Worker 数、分支/worktree、当前 HEAD、已提交与未提交诊断、交付预约与就地待决；say 交付操作复用Worker详情，普通问答/计划审批使用 `task-graph-parts.js` 的就地处理按钮，问卷跳到Worker详情按完整选项作答。点标题看完整Worker详情；历史独立解分歧 Worker 用父子边挂在负责集成的活动 Worker 下，另以「正在解决 Worker #ID」链接被修复的历史 Worker，不能把后者的终态/父子身份改掉。最多返回 200 条，优先保留分支所有者和活动Worker。画成卡片的只有自己拥有分支/worktree 的 main / owner / say / child，以及**旧 version 2 的历史 merge 队列身份**：已有 `task_kind='merge'` 卡片与类型过滤保留，摘要明确标为历史；空闲记录仍可查看，父 Worker 分支归档后随父归档、默认隐藏，可通过「显示已归档」查看。新请求由父自有队列的 runtime 串行处理，不额外调用父 Agent；按持久入队顺序、代码依赖优先，取得父执行位后才固定父基线。源侧修复期间保留父执行位，挂起释放，恢复重新排队并固定新基线；完整协议见[分支合并](merge.md)。被状态筛选或归档筛掉的父节点不制造孤儿：还在图上的子 Worker 按「最近的可见祖先」上浮，找不到可见祖先时顶成根；当前请求始终保留原父关系；历史在途请求由 runtime 受检恢复，不依赖展示层猜测。只有真的找不到父节点（被截断的那页或数据缺失）才画为根并说明。诊断/正文未知时明示不可用或截断，不能当作零。旧「分支与合并」视图与 `/api/graph` HTTP 路由已删除，旧 `#graph` 回概览；完整谱系与本地未绑定分支绑定保留在 CLI / RPC。Worker 卡片增加真实 Git 父分支、当前检出、领先/落后与一致/分歧/缺失等精简诊断，边仍只表示 Worker 父子关系。历史分支引用保留快照，但 Web 定位入口明确报已移除；Worker 图不新增语义引用，仍可通用选区引用。分支已由用户显式归档的 Worker 默认不画在图上，表头提供「显示已归档（N）」开关，只在当前页面临时显示、不写库、不改Worker状态，重开页面仍默认隐藏；只有无独立分支的历史内部 merge 队列继承直接父 Worker 的归档事实（读模型的 `archived`，父节点被截断时也有效，兼容已归档的历史父 Worker，不写新状态）；其它未归档子 Worker 会顶成根，不会仅因父 Worker 归档而消失。表头的状态计数同时就是筛选开关：点某个状态就隐藏 / 恢复该状态的 Worker，偏好按项目存在 `lush.taskGraph.hiddenStatuses`（`prefs.js` 管理的受管键，会被「恢复默认设置」清空），默认全部显示；筛选与归档开关一样只改这一页的显示，不写库、不改Worker状态。

交付后的 Worker 显示 say「待验收」/ child「待父确认」（`awaiting_acceptance`），使用独立状态色与筛选/计数，不当作已完成。Worker 图与详情通过 `render-iteration.js` 共用验收完成、历史继续开发、同步父分支和紫色 Agent 解决同步冲突；追加输入继续当前 Worker，验收不归档，归档不重建。详见[持续迭代](task-iteration.md)。

## 展示模式

默认使用极简模式：等高双行展示标题、状态、待决与进度/合并摘要，操作收进省略号菜单。顶部「详情模式」默认未勾选，主动勾选后展开目标、结果、进度、分支诊断与操作，取消勾选回到极简。模式偏好按项目保存在当前客户端，保留已有显式选择；无偏好、坏值或恢复默认设置时使用极简。两种模式共用折叠、筛选与归档显示，切换不丢弃未提交的待决答复，不改变 Worker 事实。

## 合并关系、展示排序与动效

卡片中的合并关系只认持久预约 `version=2,kind=merge,queue_protocol=1` 且预约父 ID 与真实 `parent_id` 一致。executing 显示「合并中」、resolving 显示「分歧处理中」，轻微呼吸点表达处理阶段，不代表源 Agent 正在运行；requested 显示静态「已请求等待合并」。pending/自动合并开关不算已请求；suspended 为静态「交付挂起」，blocked 为静态「落地待核验」（仍占执行位，但不冒充推进中）；integrated 沿用已合并结果。历史协议不推断当前执行位，Git 分歧不冒充合并分歧处理。

父卡片 `merge_queue` 摘要来自完整直接子Worker的 SQL 聚合，不随图的 200 节点限制、状态筛选或折叠漏计；每阶段最多列 3 个可点编号，多余明确提示。子卡片显示「→ 真实父Worker / 目标分支 · 阶段」，布局跳过隐藏中间节点不会改变交付目标。两种模式都可读，极简仍为 68px 双行，第二行优先合并关系，过长时可聚焦并横向滚动；完整进度和诊断在详情。

同一真实父下的子Worker按 executing/resolving、requested、其余分组，组内 ID 降序，根顺序不变；这不是严格队列序号，runtime 仍以入队顺序和代码依赖决定实际执行。仅同一可见结构下真实重排对卡片播放 250ms FLIP，连线不动；不自动滚向被提升的Worker。保留阅读锚点、滚动与焦点，首次加载、普通刷新、筛选、折叠、模式切换/尺寸变化不播放；有编辑草稿/选区/弹层/未结束动效时暂缓刷新，下次轮询再更新。遵循系统与应用减少动效设置。

字段契约见[模块地图](modules.md#worker-图合并关系读面接缝)。旧服务未提供摘要时不以局部Worker计数冒充全量。

## Worker 作为主要对象

卡片用状态配色一眼区分「在跑」与「停下来」：running 有活动色的呼吸外环，其余按真实状态各给一边框色（排队 / 在等 / 待你决定 / 已完成 / 失败 / 已取消），只有既非活动又无明确终结语义的才落到中性 idle；表头汇总行用同一套状态色把各状态计数排成兼作说明的图例。

`worker.graph` 只读投影每条 Worker 自己分支下的 say 子分支数（`branch_info.subtree_say`）与仍在跑的合并运行（`branch_info.merge_run`），作为交付诊断；旧 `branch.orchestrate_plan` / `branch.orchestrate` 一键编排入口已下线，卡片不再提供。归档按钮如今也进 Worker 图与 Worker 详情：读模型给 `branch_info.archivable` / `subtree_branches`（详情给 `branch_archive`），两处入口共用同一 `branch.archive`（归档一条＝归档它整棵子树，删 worktree 与本地 ref，保留 Worker／消息／事件／会话，不是删除 Worker）；完整 Git 谱系用 CLI 查询。精简关系字段 `branch_info.parent/current/relation` 见 [Worker RPC 参考](../reference/rpc/tasks.md)；Squash 后真实 Git 分歧不否认 `integration=merged`。

## 新 Worker 的输入处理

新 say 创建时，从其父分支**已提交的 fork commit** 读取 `.lush-task/input.mjs`（若存在），冻结为 `<project>/.lush/task-rules/task-<id>.mjs`。子 Worker 继承直接父 Worker 的固定快照；没有规则就使用内置默认规则。不会读取之后修改的 worktree 文件，也不会自动覆盖已创建 Worker 的规则。归档分支不会删除此快照。文件上限 16 KiB；提交的规则太大时拒绝创建新 say，不静默忽略。

程序是可信的仓库代码，**以 daemon 用户权限执行**，可访问磁盘/网络；仅从执行环境里去掉 Agent token / LUSH_* 凭证，不能把它当作安全沙箱。输入通过 stdin 的一行 JSON：`{version:1,task:{id,status,task_kind,branch},input:"..."}`；stdout 应输出一份 JSON：`{"delivery":"message"}` 或 `{"delivery":"interrupt"}`。例如：

```js
const { input } = await Bun.stdin.json();
console.log(JSON.stringify({ delivery: input.startsWith('稍后') ? 'message' : 'interrupt' }));
```

每次提交到 say / child Worker 的用户消息执行一次固定规则（限时 1s、stdout/stderr 最多 16 KiB），不传一次性 Agent 凭证。规则返回 `message` 时只写入收件箱、轮末交付；返回 `interrupt` 时先写入收件箱，再请求**有安全边界的后端**在安全点软抢占；不支持安全抢占的后端轮末交付，**绝不硬杀**。规则失败或输出无效：记录 `task.input_routed` 错误并回退 `interrupt`，输入仍持久化、不丢失。Agent 发来的消息不执行用户输入规则。无规则的新 say 保持现有安全抢占行为。

## 读面边界

本次读面与规则不改写旧数据：历史 Intent / Plan / Candidate 与旧 planner / scheduler 的行、会话与工作区保留在磁盘上，但不再有公开入口，也不会被新版本自动启动或重放。规则目前只作用于 say / child Worker 的用户消息；`say.submit` 创建时的初始 goal、notice 答复与非 say/child Worker 不走这条固定规则。当前可调用面见[核心 API 收敛](core-api.md)。
