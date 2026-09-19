# 合并

本节管 `task.merge`（以及批量入口 `task.merge_many`）：三种返回值、冲突后的解冲突任务与落地守卫、合并冻结、`superseded`。

| CLI | RPC | 参数 |
|---|---|---|
| `task merge ID` | `task.merge` | `{id}` |

`task.merge` 是**用户明确批准合并**的唯一入口（仍限用户）。三种返回值：干净合并成功 `merge: {status: 'merged'}`；落地一次解冲突结果 `merge: {status: 'resolved', resolved_task_id}`；内容冲突 `merge: {status: 'conflict', files, resolution_task_id, notice_id, superseded_task_id}`——冲突是正常返值，不是 RPC 错误。

冲突的处理：真跑一次 merge，失败时取未解决冲突的文件路径并 `merge --abort`，主树回到合并前（abort 不成功就直接报错，不进入冲突状态）。然后原任务进入 `integration=conflict`，runtime 同步开一个 `role=merger`、`resolves_task_id=<原任务>`、`target_branch` 相同的解冲突任务（`parent_id` 为空，与 verifier 一样用关联边）并预置成 `awaiting`，同时用 `notice.post` 发一条待决问题：冲突文件、git 输出、接下来会发生什么、以及「同一目标分支上的其它合并已被冻结」。**`merger` 不是一个可 spawn 的角色**：agent 调用 `task.spawn --role merger` 仍会被拒。

答复那条 notice 即批准开工：解冲突任务此时才建 worktree，基线是**目标分支当前顶端**（不是 HEAD，用户可能已经切走），agent 把原任务已审阅的 `head_commit` 并进来、解冲突、提交成合并提交。忽略那条 notice 则直接取消这个从未被唤醒过的解冲突任务，并把原任务放回 `pending`（`integration_error` 记下原因）。

解冲突任务完成后走同一条 `task.merge`：落地必须同时满足两道额外守卫——结果分支真的包含原任务的 `head_commit`（防止「解冲突」把对方改动整个丢掉）、且只能用 `git merge --ff-only` 落地（成功即证明目标分支没被推走，落地的树就是 agent 测过的那棵树）。成功后原任务一起标成 `merged`（事件 `merge.resolved`），冻结随之解除；快进失败则主树未被动过、原任务仍挂起，重试原任务的合并会开新一轮并把上一轮标成 `integration=superseded`（分支与目录保留，可以直接 `task.cleanup` 回收）。

**合并冻结**：`integration=conflict` 就是一把按 `target_branch` 的合并锁。同目标分支上其它任务的 `task.merge` 会被拒（`merging into <branch> is frozen by the unresolved conflict on #N`），`system.status.merge_freeze` 给出 `[{task_id, resolves_task_id, target_branch}]` 供界面禁用按钮。锁从状态派生，不另建表，所以重启后仍然准确、也不会留下无人认领的锁。`task.merge` 对 stacked 任务仍多一道检查：上游的 `head_commit` 必须已经是当前目标的祖先（即上游先合并），否则拒绝，防止把未合并的改动一起带进目标分支。`integration=conflict` 的任务可以直接重试（这是冲突后唯一的出路）。

## 批量合并

多个 id 时走 `task.merge_many`，参数 `{ids}`。CLI 帮助原文：

```
task merge ID [ID...]           用户明确批准合并到原目标分支（多个 id 时批量合并，按依赖顺序逐个）；
```

它同样限用户，逐个走**同一个** `approveMerge`，不绕过它的任何门槛（资格、`code` 上游、冲突冻结），也绝不并行写主树。一次最多 50 个任务。

- 顺序只看「本次选中集合内」的依赖边（`code` 与 `order` 都算先后），并列者按 id 升序。
- 遇到第一个冲突或硬失败就停下：后续条目标 `skipped`，错误为 `batch stopped at #<id>: <reason>`。
- 返回 `{merges, merged, stopped}`，`merges` 每项 `{id, status, integration, error?, resolution_task_id?}`，`status` 为 `merged` / `conflict` / `failed` / `skipped`。

清理这些任务的分支与 worktree 见 [磁盘回收与清空](maintenance.md)。
