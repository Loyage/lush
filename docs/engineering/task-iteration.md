# 已合并 Task 的持续迭代

本章说明 say/child 多轮开发的生命周期、验收与安全同步边界；接口签名见 [Task RPC](../reference/rpc/tasks.md)，前端动作集中在 `render-iteration.js`，Task 详情和 Task 图共同使用。

## 合并不是任务终点

version 2 合并落地后，原 Task 归还原父 Task，进入非终态 `awaiting_acceptance`（待验收），`integration='merged'`。这只代表本轮改动已交付，不代表用户已经验收，也不自动启动 Agent。分支、worktree、会话、消息、结果和历史保留。

- 用户可继续用 `task.message` 给当前 Task 追加输入，沿用原 Task / Agent 身份、分支和会话继续开发；不另造 say。新增提交仍须再次交付。
- `task.accept` 是用户验收：从待验收结算为 `completed`，写 `task.accepted`，不调用 Agent，不删除代码现场。仍待验收的后代必须先逐个验收；验收父 Task 不会偷偷替后代验收。
- `task.cleanup` / `branch.archive` 是独立的显式磁盘维护；验收不暗含归档，归档也不得假装验收；待验收 Task 须先验收才能归档，现有回收终态门保持。
- 原始 `base_commit` 永久保留创建起点；可空 `iteration_base_commit` 是本轮交付基线。后续无代码改动/差异/交付判断使用本轮基线，不能把已经交付的老提交重新当成本轮成果。
- 后代交付已结算与用户验收完成是不同条件：待验收不能被当作普通活动 Agent，也不能仅因它不是终态就阻止已经落地成果的父侧收敛。

Web 的状态标签、筛选、计数、Task 列表、图例、结果读面和父 Task 候选都必须理解待验收。最新结果仍可直接阅读，历史调用结果保留；待验收不显示「已解决」替代验收，也不显示无意义的运行中断按钮。

## 安全同步父分支

同步是吸收父分支已提交的改动到**当前 Task 源分支**，不是再次合并到父分支，不允许推进父分支或改其它 worktree。

1. 用户点击「同步父分支」（`task.sync_parent`）。后端串行校验状态、两端 ref、工作区、活动调用/后代及冻结，固定源与父提交。
2. 无冲突由程序直接完成；不调用 Agent。记录 `task.parent_synced`。
3. 冲突仅返回诊断，并持久化 `task.parent_sync_conflict`，数据包含 `{source_commit,parent_commit,reason}`；不留下半完成的冲突现场，不自动唤醒 Agent。
4. 用户另点紫色「Agent 解决同步冲突」（`task.resolve_sync`）才启动当前 Task 的 Agent，要求在源侧合入已记录的固定父提交、解决冲突、测试并提交。
5. 固定源或父提交已漂移时拒绝解冲突，请重新同步；失败保留现场与诊断，不用重置、清理、rebase 或父侧写入掩盖问题。

Task 详情和 Task 图共用这些动作、诊断和确认弹窗。只有解冲突与追加输入是 Agent 入口，须带 `agent-call` 和 `agentHelp`；同步、恢复待验收、验收完成均不能标成 Agent 调用。禁用动作的原因放 `.help-host`，最终严格准入由后端裁决。

## 历史兼容

不批量迁移旧 Task，也不自动重开历史记录。历史 `completed` / `integration='merged'` 的 say/child，只有分支和 worktree 仍保留、未归档且不是明确用户验收（`task.accepted`）的 Task，才可显式 `task.reopen`。

恢复只回到待验收，不调用 Agent；用户之后追加输入才启动新一轮开发。已验收完成的新任务不得误作历史任务再次恢复，归档任务不得重建；旧非 say/child 任务不套用新协议。两种读面用 `accepted` 区分验收事件，`parent_sync_conflict` 投影最近未解决的父同步冲突，不靠有界事件页猜全部历史。

相关：[模块地图](modules.md) · [Task 图](task-graph.md) · [磁盘回收](../reference/rpc/maintenance.md)
