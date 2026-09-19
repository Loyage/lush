# 批准合并

本文件管批准合并、快进优先策略、内容冲突与合并冻结、解冲突任务的落地守卫与 `superseded`。

worker worktree 与分支的创建见 [Git 边界](git-boundary.md)。

结果提交后进入 `integration=pending`。用户 `task.merge` 检查主工作树/worker 干净（脏工作树的拒绝发生在 `merge`，不在建 worktree 时；错误列出具体文件）、原目标分支、已审阅的 commit 未变化，再持久化批准事件和 `merging`，执行 merge。成功 `merged`。合并优先快进：目标分支顶端是该提交的祖先时用 `--ff-only`，不产生合并提交；只有目标分支已经前进、快进不了时才用 `--no-ff --no-edit` 生成带 merge 信息的合并提交。`merge.approved` 事件里的 `fast_forward` 记录实际采用的策略。

**内容冲突不是异常，是第三种正常结局。** `workspaces.merge` 在真合并失败时先取 `git diff --diff-filter=U` 的冲突文件，再 `merge --abort`，只有在主树确实回到合并前的干净状态时才把结果（而不是错误）交给上层；abort 不成功就保持原来的「主树需人工检查」语义，绝不把卡住的合并现场交给 agent。上层 `Project.approveMerge` 把冲突转成一次用户决定：任务进入 `integration=conflict`，同时开一个 `role=merger`、`resolves_task_id` 指向该任务的解冲突任务（关联边而非父子边，所以「终态任务没有活动后代」不被破坏），并挂一条 notice 请示。解冲突任务先预置成 `awaiting`（不占并发槽、不烧 token），答复即开工、忽略即撤销；它的 worktree 以**目标分支顶端**为基线，agent 把那次审阅过的提交并进来、解冲突、提交成合并提交，因此批准落地时能用 `--ff-only`：成功等价于「main 没被推走」，落地的树就是它测过的那棵树，不会再冲突一次。落地时同时要求解冲突结果真的包含原任务的 `head_commit`（防「解冲突」把对方改动整个丢掉），并把两个任务一起标成 `merged`。

`integration=conflict` 同时就是一把**按目标分支**的合并锁：同一 `target_branch` 上其它任务的合并会被拒绝，直到解冲突落地或撤销。锁从状态派生，不另建表，所以崩溃重启后锁跟着行一起还在，也不会留下无人认领的锁；三条显式解除路径是忽略那条 notice、重试原任务的合并（会作新一轮解冲突）、或让解冲突任务失败/取消（`finish` 把原任务放回 `pending`）。解冲突任务若完成但没落地（例如用户直接往 main 提交，快进失败），重试原任务的合并会把它标成 `superseded`：分支与目录一律保留，只是允许用户单独回收。中断的 merging 仍恢复为 review，不猜测 Git 操作是否完成。

相关：[工作区与分支回收](cleanup.md)、[生命周期不变量](invariants.md)。
