# 生命周期不变量

本文件是生命周期不变量清单，逐条原样。

<a id="status"></a>- 状态：queued / running / waiting / awaiting / completed / failed / cancelled。
<a id="credential"></a>- 一个 task 同时只有一个 invocation，且只有一个 agent 身份；身份跨唤醒不变，凭证只在该 invocation 活动期间有效，重启后全部作废。
<a id="terminal"></a>- 终态 task 没有活动子 task。失败和取消会先自底向上取消活动后代，再结算自身。
<a id="parent-edge"></a>- 父子边只由已有父 task 的创建操作建立，不允许环或任意 reparent。
<a id="message-consumption"></a>- 消息只有在一次调用成功返回后才消费，失败后可以在明确重试时再次交付。
<a id="transaction"></a>- 取消、notice 答复与 completion 的核心状态变更都在同步短事务中完成；事务内不等待模型或 Git。
<a id="retry"></a>- 重试必须是用户显式动作，且父 task 不能已终态。
<a id="history"></a>- 不删除任务历史；工作区清理与任务终态是不同操作。
<a id="explain"></a>- `explain` 输入的子树只允许 research；runtime 在 spawn 层拒绝 worker/coordinator，保证了解类输入不产生待合并改动。
<a id="conflict"></a>- 内容冲突不当作错误：它进入 `integration=conflict`、开一个 runtime 专属的 `merger` 任务并请求用户决定；解冲突结果只用 `--ff-only` 落地（落地的树＝测过的树），落地期间同一目标分支上的其它合并被冻结。agent 不能自行派 merger，也不能自行合并或解决冲突。
<a id="genealogy"></a>- 分支谱系只在分支被创建那一刻写入，之后不可变：merge 不改写 parent，重试不重写已有记录；分支被删除只把记录标成 `deleted` 并保留行，子分支的 parent 指针继续有效。没有记录的已有分支一律显示为 untracked / `parent: unknown`，runtime 不用 merge-base 事后推断出一个 parent 当成事实。

相关：[实体](entities.md)、[Git 边界](git-boundary.md)、[批准合并](merge.md)、[分支谱系](branch-genealogy.md)。
