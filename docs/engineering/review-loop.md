# 交付与验收

本章面向维护交付链路的开发者，区分新式 Worker 的自动合并与统一验收（验收即归档回收资源）；历史 version 1 固定提交批准仍保留。

> 连续阅读：[架构总览](../core-architecture.md) → [执行模型](execution-model.md) → **交付与验收** → [工程索引](architecture.md)

## 从子Worker到父分支

Agent 派出的新 child 默认预约合入直接父 Worker；用户直接创建的指令仍由用户决定何时预约。安全结束、后代交付收敛、工作区干净且有提交时，runtime 请求合并并冻结源 Worker，由父 Worker 自有队列的 runtime 串行 Squash（含 main），不创建 merge Worker、不改变父子关系，也不额外调用父 Agent。无提交的干净 child 只交付结果，不产生合并提交。

取得父执行位后才固定尝试基线；分歧由源 Worker 吸收固定父提交、保留原源提交、解决冲突并测试，期间保留父执行位，修好后由 runtime 核验并落地。挂起释放执行位，恢复重新排队并固定新父基线；不得由普通 Agent 在父 worktree 擅自造合并提交或 rebase。失败保留分支、工作区与历史。详细交付协议见[分支合并](merge.md)；历史 version 2 merge 身份及在途重挂仅凭明确预约／审计兼容恢复，保留历史。历史 version 1 的 `worker.integrate` / `worker.approve_merge` 固定提交确认见[Worker RPC](../reference/rpc/tasks.md)。

## 多轮交付不是一次性销毁

本轮 Squash 落地后，原 Worker 保持原父子关系，进入非终态 `awaiting_acceptance`，保留分支/worktree/会话，不自动调用 Agent。用户可以追加输入继续**同一 Worker**，后续提交再交付；原始 `base_commit` 不改写，本轮基线由 `iteration_base_commit` 表达。

`worker.accept` 把已交付 Worker 结算为 `completed`：用户验收自己创建的指令，运行中的直接父 Agent 检查并确认派生 child，无需用户逐个验收。不调用 Agent，验收表示不再有异议，同时受检回收分支子树 worktree/ref，保留完整运行历史；脏现场阻止，资源回收成功才完成本次验收并写审计，部分失败保留事实和显式续办。父验收不隐式确认后代，未处理问题和未交付改动不能当作成功。失败／取消另用「清理资源」，不伪装成功验收。见[统一验收](worker-acceptance.md)。

父分支继续前进时，用户 `worker.sync_parent` 只在源侧安全吸收父提交；无冲突程序直接完成，冲突先持久化固定提交诊断，另点 `worker.resolve_sync` 才调用 Agent。漂移拒绝旧解冲突请求，失败不重置现场。历史未归档且保留分支/worktree 的 completed/merged 指令/child 可显式 `worker.reopen` 恢复待验收；明确用户验收或父确认过的新Worker不误重开，归档Worker不重建，不批量迁移旧行。完整边界见[持续迭代](task-iteration.md)。

## 状态不互相代替

`waiting` 表示静息等待，`awaiting_acceptance` 表示本轮交付后指令等待用户验收、child 等待父 Agent 确认，`completed` 表示 Worker 已结算，`integration` 表示代码进入了直接父分支；即使进入直接父分支，也未必进入 main。交付静息不是用户验收，验收意味着安全归档回收代码现场但保留完整运行历史；历史 completed 不能替代真实验收或资源回收审计。失败现场不因结算自动清除。用户可查[分支与回收](branch-first.md)及[工作区回收](cleanup.md)。

---

[← 上一篇：执行模型](execution-model.md) · [下一篇：工程架构索引 →](architecture.md)
