# 生命周期不变量

本文件列出当前 say 主链必须守住的状态与 Git 约束；当前主链见[核心架构](../core-architecture.md)。旧 Intent / Plan / Candidate 的行只在磁盘上保留，不再产生新工作。

<a id="status"></a>- 状态：queued / running / waiting / awaiting / paused / completed / failed / cancelled。`paused` 是用户显式「中断」后的非终态停顿：不占并发槽，消息照收，只有用户「继续」才回到排队。
<a id="credential"></a>- 一个 Worker 同时只有一个 invocation，且只有一个 agent 身份；身份跨唤醒不变，凭证只在该 invocation 活动期间有效，重启后全部作废。
<a id="terminal"></a>- 终态 Worker 没有活动子Worker。失败和取消会先自底向上取消活动后代，再结算自身。
<a id="parent-edge"></a>- 父子边只由已有父Worker的创建操作建立，不允许环或任意 reparent。
<a id="message-consumption"></a>- 消息只有在一次调用成功返回后才消费，失败后可以在明确重试时再次交付。
<a id="transaction"></a>- 取消、notice 答复与 completion 的核心状态变更都在同步短事务中完成；事务内不等待模型或 Git。
<a id="retry"></a>- 重试必须是用户显式动作，且父Worker不能已终态。
<a id="history"></a>- 不删除Worker历史；工作区清理与Worker终态是不同操作。`task.delete` / `task.clear` 已下线，不再有公开入口；Worker行、消息、事件与会话留在磁盘上，工作区回收走 `worker.cleanup` 的安全门。
<a id="input-branch"></a>- 新 `say` 从父分支已提交 tip 创建独立分支与 worktree；`created_from_commit` / 谱系 parent 创建后不变，分支 tip 只能通过沿 direct-parent 边的 fast-forward 前进。
<a id="conflict"></a>- 所有写入只沿 recorded direct-parent 边、只做 fast-forward。父子分歧时不在父侧 no-ff；在子侧吸收冻结的父提交并测试，再逐层 ff。新 say 的代码落地由运行中的直接父 Agent `worker.integrate` 或用户 `worker.approve_merge` 按固定提交推进。
<a id="genealogy"></a>- 分支谱系只在分支被创建那一刻写入，之后不可变：merge 不改写 parent，重试不重写已有记录；分支被删除或归档只标 `status`。没有 recorded parent 的分支只能查看，不能作为合并依据。
<a id="leaf-first"></a>- 一条分支还有未进入自己的直接子分支时不得向上合并。新 say / child 不自动集成，须父 Agent 或用户确认。
<a id="run"></a>- 每次 provider invocation 先写一条 `agent_runs`，结束（成功 / 失败 / 取消 / 抢占）后写终态；重试与唤醒产生新的 Run，不覆盖 Run 历史。Worker 的 `calls` / `agent_wakes` 只是兼容读模型。
<a id="control-lane"></a>- 控制（control lane）与执行（execution lane）分开计数；执行面的长Worker不得饿死新输入的准入。等依赖、等子Worker、等用户的 Worker 不占调用槽。
<a id="delivery-lock"></a>- 合并请求一旦发出就冻结父分支基线与 Lush 侧写入；在集成或用户显式撤销前，同一父分支只接受一个未集成请求，也不允许归档源分支。

相关：[实体](entities.md)、[Git 边界](git-boundary.md)、[分支合并](merge.md)、[分支谱系](branch-genealogy.md)、[核心 API 收敛](core-api.md)。
