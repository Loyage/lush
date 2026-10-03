# 已合并 Worker 的持续迭代

本章说明 指令/child 多轮开发的生命周期、验收与安全同步边界；接口签名见 [Worker RPC](../reference/rpc/tasks.md)，前端动作集中在 `render-iteration.js`，Worker 详情和 Worker 图共同使用。

## 合并不是Worker终点

当前 version 2 父自有交付队列不创建 merge Worker、不改 `parent_id`；合并落地后，原 Worker 保持委派关系，进入非终态 `awaiting_acceptance`（待验收），`integration='merged'`。这只代表本轮改动已交付，不代表用户已经验收，也不自动启动 Agent。分支、worktree、会话、消息、结果和历史保留。

- 用户可继续用 `worker.message` 给当前 Worker 追加输入，沿用原 Worker / Agent 身份、分支和会话继续开发；不另造指令。新增提交仍须再次交付；Worker 的自动合并开关跨轮保留，已开启时在本轮再次就绪后自动请求，未开启时仍由用户显式合并。单次 `worker.reserve` 不会打开持久开关。
- `worker.accept` 区分责任：用户直接创建的指令由用户验收最终效果；派生 child 由运行中的直接父 Agent 检查结果、测试与交付事实后确认，无需用户逐个点击。两者都结算为 `completed`，写 `task.accepted`（`accepted_by:'user'|'parent'`，父确认另记 `parent_id`），不调用 Agent，不删除代码现场。用户仍可显式确认 child，但不是必经流程。
- 父 Agent 不得验收自己、兄弟、间接后代或用户创建的指令；其 invocation 必须仍有效，child 必须已交付并处于 `awaiting_acceptance`。失败、在途交付、未读消息、未决问题、脏工作区、新增未交付提交与未结算后代都不得自动当作成功。Git 检查后复核权限与新输入；需要修改时先 `worker.message` 继续 child，检查通过再确认。父 Worker 验收不隐式确认后代，直接父 Agent 应在收口前完成内部确认。
- Web 点击「验收完成」直接调用 `worker.accept`，不再事前二次确认；成功并刷新视图后询问「是不是要直接归档」。只有再选择「直接归档」才调用 `branch.archive`，不重复弹归档确认；选择「保留」、Esc 或关闭弹窗均保留分支与 worktree，不撤销已完成的验收。验收失败不询问归档，归档失败不回滚验收，可从原归档入口重试。详情与 Worker 图共用此流程，不调用 Agent。
- `worker.cleanup` / `branch.archive` 是独立的显式磁盘维护；验收不暗含归档，归档也不得假装验收；待验收 Worker 须先验收才能归档，现有回收终态门保持。
- 原始 `base_commit` 永久保留创建起点；可空 `iteration_base_commit` 是本轮交付基线。后续无代码改动/差异/交付判断使用本轮基线，不能把已经交付的老提交重新当成本轮成果。
- 验收检查真实输入与待决事项；已完成的历史 version 2 内部 merge 队列中，来自有重挂审计且已终态源 Worker 的历史失败／修复消息不要求再调用 Agent。消息原文与未读标记保留，不伪装成 Agent 已处理；用户输入、来源不明消息、普通 Worker 收件箱仍严格阻止验收，错误标明实际阻塞 Worker ID。
- 后代交付已结算与用户验收完成是不同条件：待验收不能被当作普通活动 Agent，也不能仅因它不是终态就阻止已经落地成果的父侧收敛。

Web 的状态标签、筛选、计数、Worker 列表、图例、结果读面和父 Worker 候选都必须理解待验收。最新结果仍可直接阅读，历史调用结果保留；指令待验收显示用户验收入口；child 显示「待父确认」，不显示用户验收按钮、不计入「待我处理」或用户待验收数量（真实待决问题仍计入）。待验收不显示「已解决」替代验收，也不显示无意义的运行中断按钮。

## 安全同步父分支

同步是吸收父分支已提交的改动到**当前 Worker 源分支**，不是再次合并到父分支，不允许推进父分支或改其它 worktree。

1. 用户点击「同步父分支」（`worker.sync_parent`）。后端串行校验状态、两端 ref、工作区、活动调用/后代及冻结，固定源与父提交。
2. 无冲突由程序直接完成；不调用 Agent。记录 `task.parent_synced`。
3. 冲突仅返回诊断，并持久化 `task.parent_sync_conflict`，数据包含 `{source_commit,parent_commit,reason}`；不留下半完成的冲突现场，不自动唤醒 Agent。
4. 用户另点紫色「Agent 解决同步冲突」（`worker.resolve_sync`）才启动当前 Worker 的 Agent，要求在源侧合入已记录的固定父提交、解决冲突、测试并提交。
5. 固定源或父提交已漂移时拒绝解冲突，请重新同步；失败保留现场与诊断，不用重置、清理、rebase 或父侧写入掩盖问题。

Worker 详情和 Worker 图共用这些动作、诊断和确认弹窗。只有解冲突与追加输入是 Agent 入口，须带 `agent-call` 和 `agentHelp`；同步、恢复待验收、验收完成均不能标成 Agent 调用。禁用动作的原因放 `.help-host`，最终严格准入由后端裁决。

## 历史兼容

旧 version 1 的人工固定提交确认语义不改。旧 version 2 merge 身份和在途重挂保留，只凭明确预约／审计恢复原父，不猜身份、不删历史；当前队列的源侧修复保留父执行位，挂起释放、恢复重新排队并固定新基线，不能用旧尝试回复推进新尝试。完整协议见[分支合并](merge.md)。

不批量迁移旧 Worker，也不自动重开历史记录。历史 `completed` / `integration='merged'` 的 指令/child，只有分支和 worktree 仍保留、未归档且不是明确用户验收或父 Agent 确认（`task.accepted`）的 Worker，才可显式 `worker.reopen`。

恢复只回到待验收，不调用 Agent；用户之后追加输入才启动新一轮开发。已验收或父确认完成的新Worker不得误作历史Worker再次恢复，归档Worker不得重建；旧非 指令/child Worker不套用新协议。两种读面用 `accepted` 区分验收事件，`parent_sync_conflict` 投影最近未解决的父同步冲突，不靠有界事件页猜全部历史。

相关：[模块地图](modules.md) · [Worker 图](task-graph.md) · [磁盘回收](../reference/rpc/maintenance.md)
