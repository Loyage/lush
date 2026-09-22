# 生命周期不变量

本文件是生命周期不变量清单，逐条原样。产品主链与设计原则见[核心架构](../core-architecture.md)。

<a id="status"></a>- 状态：queued / running / waiting / awaiting / completed / failed / cancelled。
<a id="credential"></a>- 一个 task 同时只有一个 invocation，且只有一个 agent 身份；身份跨唤醒不变，凭证只在该 invocation 活动期间有效，重启后全部作废。
<a id="terminal"></a>- 终态 task 没有活动子 task。失败和取消会先自底向上取消活动后代，再结算自身。
<a id="parent-edge"></a>- 父子边只由已有父 task 的创建操作建立，不允许环或任意 reparent。
<a id="message-consumption"></a>- 消息只有在一次调用成功返回后才消费，失败后可以在明确重试时再次交付。
<a id="transaction"></a>- 取消、notice 答复与 completion 的核心状态变更都在同步短事务中完成；事务内不等待模型或 Git。
<a id="retry"></a>- 重试必须是用户显式动作，且父 task 不能已终态。
<a id="history"></a>- 不删除任务历史；工作区清理与任务终态是不同操作。唯一例外是用户显式的定向删除（`task.delete` / `lush task delete`，只删一条已结束任务及其已结束后代）与项目级清空（`task clear`）：两者都只由用户触发，都先过工作区回收的安全门，都不复用 task id，并把被删的任务 id / 角色 / 状态写进一条 `task_id` 为空的 `task.deleted` 事件。Agent 不能删任务。
<a id="explain"></a>- `explain` 输入的子树只允许 research；输入分支只提供稳定读取上下文，不产生任务子分支或待交付改动。
<a id="anchor"></a>- 输入提交时从用户指定本地父分支创建独立输入分支与 worktree；planner 在其中运行。`anchor_commit` / 谱系 parent 创建后不变，但输入分支 tip 可以通过直接子分支 fast-forward 推进。
<a id="conflict"></a>- 所有写入只沿 recorded direct-parent 边、只做 fast-forward。父子分歧时不在父侧 no-ff；用户创建子侧 merger，把冻结的父 commit 合入子侧并测试，再逐层 ff。
<a id="genealogy"></a>- 分支谱系只在分支被创建那一刻写入，之后不可变：merge 不改写 parent，重试不重写已有记录；分支被删除只标 `deleted`。没有 recorded parent 的分支只能查看，不能作为 `branch.merge/sync` 的依据。
<a id="leaf-first"></a>- 一条分支还有未进入自己的直接子分支时不得向上合并；代码从叶子向 Intent 集成分支、再向用户目标分支逐层收敛。Plan 编译出的工作由 Integration Service 在私有 Intent 分支内自动完成这段收敛，但不触动目标分支。
<a id="candidate"></a>- 用户验收的是 Review Candidate 固定的不可变 commit，不是可移动的 branch 名。接受前必须重新校验 branch tip 仍等于该 commit；不等时拒绝并要求生成新版本，绝不夹带未审阅内容。进入 `accepted` 后是不可取消的决策边界，reject / changes / supersede 必须拒绝，直到 Git 结算为 `integrated` 或失败回到 `ready`。
<a id="run"></a>- 每次 provider invocation 先写一条 `agent_runs`，结束（成功 / 失败 / 取消）后写终态；重试与唤醒产生新的 Run，不覆盖 Run 历史。Task 的 `calls` / `agent_wakes` 只是兼容读模型。
<a id="control-lane"></a>- 规划（control lane）与执行（execution lane）分开计数；执行面的长 worker 不得饿死新 Intent 的规划。等依赖、等子任务、等用户的 task 不占调用槽。
<a id="compile"></a>- Plan 编译是确定性代码，不调用模型：一轮 planner 写完后由 runtime 在事务里创建根 WorkItem 与依赖边，不存在 scheduler agent 或全项目串行批次。
<a id="auto-integration"></a>- 自动中间集成只写私有 Intent 集成分支及其后代，永不自动推进用户目标分支；目标分支只在用户接受 Candidate 时前进。

相关：[实体](entities.md)、[Git 边界](git-boundary.md)、[批准合并](merge.md)、[分支谱系](branch-genealogy.md)、[Review Candidate](../reference/rpc/candidates.md)。
