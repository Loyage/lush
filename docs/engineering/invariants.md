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
<a id="explain"></a>- `explain` 输入的子树只允许 research；输入分支只提供稳定读取上下文，不产生任务子分支或待交付改动。
<a id="anchor"></a>- 输入提交时从用户指定本地父分支创建独立输入分支与 worktree；planner 在其中运行。`anchor_commit` / 谱系 parent 创建后不变，但输入分支 tip 可以通过直接子分支 fast-forward 推进。
<a id="conflict"></a>- 所有写入只沿 recorded direct-parent 边、只做 fast-forward。父子分歧时不在父侧 no-ff；用户创建子侧 merger，把冻结的父 commit 合入子侧并测试，再逐层 ff。
<a id="genealogy"></a>- 分支谱系只在分支被创建那一刻写入，之后不可变：merge 不改写 parent，重试不重写已有记录；分支被删除只标 `deleted`。没有 recorded parent 的分支只能查看，不能作为 `branch.merge/sync` 的依据。
<a id="leaf-first"></a>- 一条分支还有未进入自己的直接子分支时不得向上合并；代码从叶子向输入聚合分支、再向用户分支逐层收敛。

相关：[实体](entities.md)、[Git 边界](git-boundary.md)、[批准合并](merge.md)、[分支谱系](branch-genealogy.md)。
