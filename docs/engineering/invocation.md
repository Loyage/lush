# 一次 invocation 与多级协作

本文件管一次 invocation 的七步、agent 的派活权限，以及 verifier 与各类上限。

## 一次 invocation

1. 按任务 ID 从 queued 中挑选，不超过对应槽限制。
2. 在 `running` Map 中占位并签发本次 invocation 的 token（库里只写 hash），再异步准备 worker worktree（verifier 则准备目标分支的对照检出）；将 task 标为 running。
3. 读取此次未消费消息、当前任务/子任务和最近任务摘要，启动 provider。
4. provider 按 role 组合命名 prompt 片段并追加项目/本机补充，热加载公共与角色 env 文件；pi 收到项目/任务/token 环境变量、固定代码路径下的 lush CLI、独立 session 和输入文件。在 cwd 中运行工具循环；Lush 不在 argv 中传入巨大的项目快照。prompt 与 env 的组成见[Agent 环境与权限](../reference/agent-environment.md)。
5. provider 正常返回后消费**启动时读到的消息**，记录结果。运行期间到达的消息留给下次。
6. 依次判定：还有未读消息 → queued；有未决 notice → awaiting；有活动子任务 → waiting；否则校验 worker 提交并 completed。
7. 释放 running 占位并作废 token，再次检查未读消息，防止 child settled 与 parent park/清理之间丢唤醒。

结构化问卷是正常返回之外的主动暂停路径：`notice.post` 带 `questions` 时，同一事务保存 notice、消费本轮已交付消息、记一条 `invocation.completed {suspended:true}` 并设置 awaiting；提交后中止进程组。本轮不执行 worker finish、不标失败。调度器的 `questionPending` 闸门阻止普通消息和子任务结果提前唤醒；答复/忽略落收件箱后，在旧 invocation 清理完毕时重新排队，防止 lost-wakeup。已暂停 task 在关闭/重启时保留 awaiting，而不是把主动暂停当异常失败。详见[待决问题](../reference/rpc/notices.md)。

waiting / awaiting 不占 agent 槽，也不运行 sleep/poll 子进程。最终输出是 task result；不提供可被 agent 提前调用的 complete 命令。

## 多级协作

agent 只能从自己的 task 派生子任务、给直接父/子发消息、给自己发 notice。用户可以给任意活动 task 追加输入。子任务结算发送状态、结果与错误给父 task；父 task 重新入队后自己决定继续派活或汇总。角色 planner / coordinator / worker / research 由 agent 自己派生；verifier 只能由用户经 `task.verify` 创建（RPC 层是 USER_ONLY），它以被检验 worktree 为 cwd，用最直观的方式演示结果并在目标分支的对照检出上重跑同一场景，最后把自包含 HTML 报告写到 `.lush/verify/<id>/report.html`。

最大层数、活动任务数上限、调用次数上限和 invocation 超时限制失控分派。默认 maxDepth=8、活动任务上限=1000、maxCalls=24。

相关：[意图层与拆解队列](intent-layer.md)、[检验与对照检出](verification.md)、[生命周期不变量](invariants.md)。
