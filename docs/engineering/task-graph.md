# Task 图与输入规则（增量实现）

Task 图是 `#task-graph` / `task.graph` / `/api/task-graph` 的有界读面：节点是 Task（含 main、owner、旧任务），边来自当前 `parent_id`；新式 say/child 发出 version 2 合并请求后会重挂到原父 Task 的 merge 子 Task 下，原父关系保存在请求和重挂事件中，旧任务的父子边不迁移。合并落地后请求 Task 会被 runtime 归还到原父 Task（`task.merge_parent_restored`），不再自动归档，所以未落地的请求与已落地待归档的 Task 都能在原父下看到。卡片显示目标摘要、Agent 类型、分支合并状态（`integration`：待合并 / 已合并 / 合并中等，与任务详情同源，做成首行标签）、工作/静息与冻结原因、结果预览、计划进度、子 Task 数、分支/worktree、当前 HEAD、已提交与未提交诊断、交付预约与就地待决；say 交付操作复用任务详情，普通问答/计划审批使用 `task-graph-parts.js` 的就地处理按钮，问卷跳到任务详情按完整选项作答。点标题看完整任务详情；解分歧 Task 用父子边挂在负责集成的活动 Task 下，另以「正在解决 Task #ID」链接被修复的历史 Task，不能把后者的终态/父子身份改掉。最多返回 200 条，优先保留分支所有者和活动任务。画成卡片的只有自己拥有分支/worktree 的 main / owner / say / child / showcase（展示子 Task 用 detached worktree），以及**常驻的 merge 队列身份**：`task_kind='merge'` 的 Task 与其它 Task 一样出现在图上，队列在动时卡上多一行队列摘要（写明队列里在等什么、哪一条正在落地；落地顺序以库里 id 最小的 `requested` 为准，展示层不猜），空闲时也留一张卡——它是父 Task 的一等身份，不是临时中间层。被状态筛选或归档筛掉的父节点不制造孤儿：还在图上的子 Task 按「最近的可见祖先」上浮，找不到可见祖先时顶成根；已落地的请求 Task 已由 runtime 实际归还到原父 Task 下，不依赖展示层抬升。只有真的找不到父节点（被截断的那页或数据缺失）才画为根并说明。诊断/正文未知时明示不可用或截断，不能当作零。旧「分支与合并」视图与 `/api/graph` HTTP 路由已删除，旧 `#graph` 回概览；完整谱系与本地未绑定分支绑定保留在 CLI / RPC。Task 卡片增加真实 Git 父分支、当前检出、领先/落后与一致/分歧/缺失等精简诊断，边仍只表示 Task 父子关系。历史分支引用保留快照，但 Web 定位入口明确报已移除；Task 图不新增语义引用，仍可通用选区引用。分支已由用户显式归档的 Task 默认不画在图上，表头提供「显示已归档（N）」开关，只在当前页面临时显示、不写库、不改任务状态，重开页面仍默认隐藏；被归档父节点藏起来的未归档子 Task 会顶成根，不会跟着消失。表头的状态计数同时就是筛选开关：点某个状态就隐藏 / 恢复该状态的 Task，偏好按项目存在 `lush.taskGraph.hiddenStatuses`（`prefs.js` 管理的受管键，会被「恢复默认设置」清空），默认全部显示；筛选与归档开关一样只改这一页的显示，不写库、不改任务状态。

## Task 作为主要对象

卡片用状态配色一眼区分「在跑」与「停下来」：running 有活动色的呼吸外环，其余按真实状态各给一边框色（排队 / 在等 / 待你决定 / 已完成 / 失败 / 已取消），只有既非活动又无明确终结语义的才落到中性 idle；表头汇总行用同一套状态色把各状态计数排成兼作说明的图例。

`task.graph` 只读投影每条 Task 自己分支下的 say 子分支数（`branch_info.subtree_say`）与仍在跑的合并运行（`branch_info.merge_run`），作为交付诊断；旧 `branch.orchestrate_plan` / `branch.orchestrate` 一键编排入口已下线，卡片不再提供。归档按钮如今也进 Task 图与 Task 详情：读模型给 `branch_info.archivable` / `subtree_branches`（详情给 `branch_archive`），两处入口共用同一 `branch.archive`（归档一条＝归档它整棵子树，删 worktree 与本地 ref，保留 Task／消息／事件／会话，不是删除 Task）；完整 Git 谱系用 CLI 查询。精简关系字段 `branch_info.parent/current/relation` 见 [Task RPC 参考](../reference/rpc/tasks.md)；Squash 后真实 Git 分歧不否认 `integration=merged`。

## 新 Task 的输入处理

新 say 创建时，从其父分支**已提交的 fork commit** 读取 `.lush-task/input.mjs`（若存在），冻结为 `<project>/.lush/task-rules/task-<id>.mjs`。子 Task 继承直接父 Task 的固定快照；没有规则就使用内置默认规则。不会读取之后修改的 worktree 文件，也不会自动覆盖已创建 Task 的规则。归档分支不会删除此快照。文件上限 16 KiB；提交的规则太大时拒绝创建新 say，不静默忽略。

程序是可信的仓库代码，**以 daemon 用户权限执行**，可访问磁盘/网络；仅从执行环境里去掉 Agent token / LUSH_* 凭证，不能把它当作安全沙箱。输入通过 stdin 的一行 JSON：`{version:1,task:{id,status,task_kind,branch},input:"..."}`；stdout 应输出一份 JSON：`{"delivery":"message"}` 或 `{"delivery":"interrupt"}`。例如：

```js
const { input } = await Bun.stdin.json();
console.log(JSON.stringify({ delivery: input.startsWith('稍后') ? 'message' : 'interrupt' }));
```

每次提交到 say / child Task 的用户消息执行一次固定规则（限时 1s、stdout/stderr 最多 16 KiB），不传一次性 Agent 凭证。规则返回 `message` 时只写入收件箱、轮末交付；返回 `interrupt` 时先写入收件箱，再请求**有安全边界的后端**在安全点软抢占；不支持安全抢占的后端轮末交付，**绝不硬杀**。规则失败或输出无效：记录 `task.input_routed` 错误并回退 `interrupt`，输入仍持久化、不丢失。Agent 发来的消息不执行用户输入规则。无规则的新 say 保持现有安全抢占行为。

## 读面边界

本次读面与规则不改写旧数据：历史 Intent / Plan / Candidate 与旧 planner / scheduler 的行、会话与工作区保留在磁盘上，但不再有公开入口，也不会被新版本自动启动或重放。规则目前只作用于 say / child Task 的用户消息；`say.submit` 创建时的初始 goal、notice 答复与非 say/child Task 不走这条固定规则。当前可调用面见[核心 API 收敛](core-api.md)。
