# 分支合并与收敛

Lush 的合并单位是分支谱系中的一条 `direct child → parent` 边。Task 提供审阅结果和 agent 审计，代码是否能落地由 Branch + Git commit graph 决定；新 say / child 的落地只接受**固定提交**，绝不 no-ff、绝不 rebase。

## 当前 version 2：父 Task 自有交付队列

新式 say/child 的预约由父 Task 自有队列的 runtime 串行 Squash（`queue_protocol=1`），包括 main / owner，不创建 `task_kind='merge'`、不改源 Task 的 `parent_id`，不额外调用父 Agent 或要求 `task.integrate`。say 默认关闭自动合并，由用户开启跨轮 hook 或显式请求；新 child 默认开启且锁定。无提交的干净 child 直接交付结果、等父确认，不产生合并提交。

### 请求与尝试分开

- `tasks.reservation` 是持久交付事实，结构化 Message/Event 仅通知。真实源安全点须确认 invocation 已退出、后代交付收敛、待决与消息已处理、工作区干净，才固定 `delivery_id`、`enqueue_seq`、源 `commit` 与 `parent_id`。
- 排队按持久入队顺序而非 Task ID，代码依赖优先。排队只冻结源 Task 的普通开发；父 invocation 实际退出、取得父分支逻辑执行位后，才固定本次 `attempt_id`、父 `baseline` 与 `original_commit`。
- 父普通开发、兄弟落地、父向上交付及同步写入共享互斥门。兄弟独立开发不占父执行位。每项落地是调度安全边界，不能用无限队列饿死父普通消息。
- 状态从 `pending` 到 `requested`，取得执行位后为 `executing` / `resolving`，成功为 `integrated`。`suspended` 明确释放执行位；恢复重新排队、固定当前父基线并生成新尝试，不允许旧回复推进新尝试。

### 源侧修复与安全落地

分歧唤醒原 Task，在它自己的 worktree 合入消息给定的固定父提交、解决冲突、测试并提交；runtime 核验产物保留原源提交和固定父提交。修复期间保留父逻辑执行位，防止兄弟落地使基线反复失效；不得跨 Agent 调用持有全项目 Git 锁。失败、等待用户或取消必须挂起／撤销尝试并释放执行位；若父落地工作区已被修改、结果未知，则保留现场并以 `blocked` 阻止下一项写入，不能贸然释放。

Git 写入前再次复核取消、新输入、固定 refs、清洁度与祖先保留。`prepareTaskSquashUnsafe` 先生成未落地提交，将精确落地凭据持久化到 `reservation.landing_receipt`（含落地提交、固定源提交、父基线与树）后，`applyTaskSquashUnsafe` 受检推进父工作区/ref；Git 成功而 DB 尚未写入时，恢复只能按精确提交、父、树与目标祖先核验凭据，未知副作用不重放。接口契约见[模块地图](modules.md)。

落地进入非终态 `awaiting_acceptance` / `integration='merged'`，保留原父子关系及分支/worktree/会话。追加输入继续当前 Task；say 用户验收 / child 直接父 Agent 确认（`task.accept`）与显式归档分开。本轮使用 `iteration_base_commit`，原始起点不改写。安全父同步只在源侧吸收固定父提交，冲突先诊断、另点 Agent；详见[持续迭代](task-iteration.md)。

### 历史兼容

旧 version 2 的 merge Task、事件与在途重挂记录保留。恢复原父只接受预约／审计中明确保存的父身份，并复核谱系；不得猜父或删除历史。旧落地凭据按精确父、树与完整标题核验，不能用标题前缀判断成功。历史 merge 卡片和类型过滤仍可回看，不代表新请求会创建中间 Task。

以下 fast-forward、用户批准和独立解分歧子 Task 的描述仅是历史 version 1 接缝，语义不变，不适用于当前自动 Squash 队列。

## 历史正常路径：fast-forward

1. child 在 `branches` 中有 `parent_relation=recorded` 的直接父分支；
2. child 与 parent ref 都存在；
3. child 对应 task（若有）已经结算；
4. child 自己的 worktree、parent 已检出的 worktree 都干净；
5. child 没有尚未收拢的直接子分支；
6. parent tip 是 child 固定提交的祖先。

父分支有 worktree 时在该 worktree 运行 `git merge --ff-only <landed-commit>`，使 index 与工作目录同步；没有 worktree 时用带旧值的 `git update-ref` compare-and-swap 原子推进 ref。外部进程抢先推进会失败，不覆盖它。

成功后，关联 task 的 integration 收敛为 `merged`。

## 历史 version 1：谁可以推进

- **直接父 Task 是活动 say / child 时**：只有该 Agent 能在运行中调用 `task.integrate`，核对子任务固定提交并快进；不能推进 main，父分支不干净、HEAD 漂移、子任务未结算或有未集成后代时保留现场并拒绝。
- **父是 main / owner 时**：只有用户按请求里的 **commit + baseline** 调用 `task.approve_merge` 批准快进。批准前在 Git 串行区复核源 ref、父 ref、工作区与后代，任何漂移拒绝旧批准；提交已落地而 DB 尚未记录时，相同固定值可幂等核对（不再要求旧 baseline）。

## 历史 version 1：交付锁与冻结

say 的合并请求（`task.reserve {kind:'merge'}`）在静息、后代结算、工作区干净且可快进时冻结源 `commit` 与父 `baseline`，并在同一事务向父 Task 发去重信号。请求**不等于批准**。

请求发出后 `target_branch` 进入分支写冻结（`status.branch_freeze` / `graph.get` 的 branch 节点 `freeze`，`kind='delivery'`）：不再接受任何 Lush 侧写入（新建 say、`task.retry`、`branch.archive` 等），另一个 say 的同类请求保持 pending 并记 `blocked_code='parent_locked'`；父为 say 时只有锁持有者自己的 `task.integrate` 能写这条分支。解除只有集成或用户显式撤销（`task.unreserve`，另记 `task.request_withdrawn`）。源分支也不能被归档：`branch.archive` 拒绝源分支带未集成请求的子树。

daemon 挡不住父分支自己的 say Agent 提交，也不挡外部 git：那时请求会失去快进前提，`noteBranchAdvance` / `task.integrate` / `task.approve_merge` 会把诊断写进 `reservation.blocked_code='parent_moved'` 与 `blocked_reason`。此时可撤销请求，或先把该固定提交合入父分支再幂等关闭。

## 历史 version 1：在子侧收敛

分歧时 runtime **不会**在 parent 上执行 `--no-ff`，也不会把冲突留在 parent worktree。它派一个**解分歧子 Task**：

1. 冻结源侧固定提交与父分支固定顶端；
2. 从源侧提交创建一个独立分支 / worktree；
3. Agent 在其中合入冻结的父提交、解决冲突、提交并测试；
4. runtime 在父 Agent 安全结束后核对产物同时包含两端固定提交；
5. 依次 fast-forward 源 child 与父分支（main / owner 仍须用户按固定值批准）。

`task.resolve_child_divergence` 由执行中的直接父 Agent 发起；`task.resolve_divergence` 由用户发起，用于活动 say 或展示交付后的终态 say。重复请求返回未集成的同一活动 child；已完成但不合格或已失败 / 取消的 child 需用户检查并显式归档其仍活动的旧分支（保留 Task / 事件 / 会话，未提交文件必须另行确认丢弃）后才可重新派。该类子 Task 不走 `task.retry` 重放未知文件副作用。

冻结语义由 `src/core/branch-freeze.js` 从已有事实现算：目标分支上活动的运行、未结束的解分歧任务、以及已发出但尚未集成的合并请求分别冻结相应分支。它拦截新建 say、`task.retry` / `task.cleanup` / `branch.archive`；`task.cancel` 保持可用（释放路径）。

## 历史 version 1：从叶子向根

一条分支还有未进入自己的直接子分支时，向上落地会被拒绝。典型顺序：

```text
解分歧 child → 子 Task 分支 → say 分支 → 用户指定父分支
```

并行 sibling 都进入同一个父分支。第一个 sibling 落地会推进父分支，后续 sibling 的固定提交往往因此不再能快进；它们按上述子侧解分歧流程逐个重新确认。系统宁可要求显式解分歧，也不在聚合分支上产生未经独立测试的 merge commit。

相关：[分支优先架构](branch-first.md) · [Git 边界](git-boundary.md) · [分支谱系](branch-genealogy.md) · [Task RPC](../reference/rpc/tasks.md)
