# 工作区与分支回收

本文件管工作区与分支回收的安全门：`update-ref` compare-and-delete、`keep-branch`，以及与安全回收不同的归档和用户确认的彻底删除路径。

工作区清理不强制删除。Worker分支只有在 tip 仍包含审阅过的 `head_commit`、且整个 tip 已进入其 recorded direct parent / `target_branch` 时才删；因此聚合进来的子分支提交不会被误判为篡改，也不会丢失。删除使用 compare-and-delete；拿不准就保留并说明 reason。`--keep-branch` 可只回收 worktree。入口是 `worker.cleanup`，见[磁盘回收](../reference/rpc/maintenance.md)。

分支真的被删掉时，谱系记录只把 `status` 标成 `deleted`，**不删行**：子分支的 parent 指针必须继续有效，所以 `[deleted]` 的节点仍出现在 `lush branch tree` 里，它的子分支照旧挂在下面。外部（用户自己 `git branch -D`）删掉的分支由读模型按 ref 现状显示，不写库。详见 [分支谱系](branch-genealogy.md)。

## 分支归档

`lush branch archive BRANCH [--discard] [--continue]`（RPC `branch.archive {branch, discard?, continue?}`，用户专属）是**显式放弃一条分支的代码**的路径，与上面的安全回收是两件不同的事。**归档一条＝归档它整棵子树**：Worker分支是从父分支长出来的，只删一半会留下一批「父分支已不在」的后代，所以传进来的那条是子树根，它的全部后代一起归档（已经归档 / 回收过的后代跳过）。Web 上 Worker 图与 Worker 详情两个入口共用同一个动作（`branch-archive.js`）：界面先按与 `archiveBranch` 对齐的只读判据（`branches.branchArchivability`）决定按钮出不出现，真正的安全门仍在 runtime。

- cleanup / `worker cleanup` 是**安全回收**：必须先证明分支的成果已经进入目标分支（tip 仍含审阅过的 `head_commit`，且 tip 是目标分支的祖先），证明不了就保留并说明 reason。
- 归档是**明知可能未合并也允许删**：用户明确表示不再要这棵子树的代码，runtime 不再做祖先检查——因此 `archiveBranch` 不做祖先检查、仍用 compare-and-delete；明确确认的 `worker.delete` 也允许丢弃未交付代码，但另有资源预检与历史清除契约。

新式 version 2 Squash 合并落地后不再自动走归档：当前父自有交付队列不改变请求 Worker 的父子关系，分支与 worktree 保留，直到用户显式 `worker cleanup` / `branch archive` 才按上面同一套安全门删除。Squash 只保证树相同，源 ref 并不在目标分支的祖先链上，所以 `archiveSquashedTaskUnsafe` 用「源树等于已落地树 + 落地提交仍在目标分支」替代祖先检查；在归档前，`branchState` 通过 `Workspaces#squashedLanded` 就把这条分支按已收拢报告，既不冒充分歧，也不挡住父分支。

历史 version 2 merge 队列身份随其明确的父 Worker 归档，可在 Worker 图中切换查看历史；当前交付不新建该身份。旧在途重挂只凭预约／审计记录恢复原父，不猜身份或删除旧记录。

归档保留的东西：`branches` 谱系行（`status` 标成 `archived`，`deleted_at` 兼作归档时间，不为它另加列）、子树里每条分支上的Worker行、消息、事件，以及不随 worktree 消失的 pi 会话文件（`<home>/sessions/`；位置写进 `branch.archived` 事件）。被删掉的是子树里每一条的 worktree 与本地 ref，以及旧效果展示遗留的 detached worktree（如果存在）；对应Worker行的 `workspace` / `baseline_workspace` 清成 `NULL`，历史字段继续保留。

**归档的节点不再占分支树**（`branch tree` 不画；Worker 图默认隐藏归档 Worker，可切换显示）：它们是记录，用 `branch show` / `branch.archive` 事件 / Worker详情查；见[分支谱系](branch-genealogy.md)。

安全门（任一不满足就报错且无副作用）：子树根必须已登记、当前不是 `archived` / `deleted`、当前检出分支不在子树里，并且**整棵子树都没有未终态Worker**（`completed` / `failed` / `cancelled` 之外的状态）。默认不丢未提交改动：Git 边界先把整棵子树的 tip / worktree 收齐，`clean` 不过就直接报错，提示用 `--discard` 才能继续。只有显式 `--discard` 才会连着未提交改动一起删掉 worktree。ref 仍用 compare-and-delete，只删掉我们看过的那一个 tip。

已知拒绝条件（`locked` / `prunable` / 已初始化 submodule / 主检出 / 脏工作区未 `--discard`）都在**删除任何一条之前**对整棵子树预检。第二遍删除里仍可能撞上未知失败：这时已 settle 的每条分支立即回写 `branches.status` 与 Worker 的 `workspace`，已完成的保留、失败项与没轮到的分支如实回报（`failed` / `remaining`），并写一条 `branch.archive` 总账事件；库与磁盘一致，不丢已完成部分。

**续办**：上一次中途失败后，根可能已是 `archived` 而仍有活动后代。`branch archive BRANCH --continue`（`continue:true`）从 `branches.parent` 谱系重算剩余活动后代并继续归档，根已归档不报错、不重复删；没有剩余时明确返回 `no_remainder`。根仍活动时 `continue` 被拒（正常归档即可）。

归档不删行、不动后代与父分支的 `parent` 指针，所以谱系仍是历史；它与「删除」只在 `branches.status` 上分开（`active` / `archived` / `deleted`）。详见 [分支谱系](branch-genealogy.md)。

## 远端 Runner 回收

已绑定 Runner 的普通 order／child 不以 `workspace=null` 视为无现场。验收、归档和确认删除先完成整批中央安全检查，再在 Git 串行区外核对节点身份、代次、固定 HEAD、实际无租约／写入和干净状态，最后才执行登记资源回收。只有持久 `cleanup/removed` 收据允许删除中央 refs；停止信号、目录缺失、SSH 离线和旧 merged 状态都不是回收证明。旧本地 Worker 不变。

- `worker.accept` 保留原批量、输入、待决、后代、冻结与交付门。远端资源部分删除后仍保留整批身份及中央 refs；失败显式从原根续办，不可单独验收子 Worker 绕过根批次。成功只清理开发资源，Runner／Run／执行历史仍保留。
- ACK 丢失查询原请求并核验固定参数。节点明确已知失败／partial 可以在显式续办时登记新子尝试；unknown 不换请求重放，也不因重启自动回收。恢复仍检查原节点安装身份，不能指向另一机器。
- 当前远端受检回收拒绝脏文件（包括 ignored），`branch.archive --discard` 和 `worker.delete --force` 不突破节点身份／清洁度门。`worker.cleanup --keep-branch` 对远端保留整个登记现场与中央 ref，不销毁仅存的可继续开发副本；本地仍沿用只回收 worktree 的原语义。已移除远端现场不能 reopen 或静默转成本地检出。
- 删除预检显式查询远端，返回 `resources.runners` 身份、代次、HEAD 与状态，并纳入固定 revision；不可达时不能确认删除。执行再次核验原范围，远端移除后才删除中央资源与 Runner 附属外键记录；保留历史的普通验收不会清这些记录。

## 与彻底删除的区别

`worker.delete_preview` 先列出完整 Worker 子树、原始输入与实际专属资源，用户用固定 revision 最终确认后 `worker.delete` 才丢弃未交付代码现场并清除专属历史；活动调用、外部依赖、共享资源、冻结和未知路径归属默认均拒绝。W194／D460 新增用户显式 `force:true` 预检与确认，仅放宽项目私有 worktrees 内精确运行时命名的未登记检出 `.git` 归属证明，连同全部残留代码删除；其他保护不放宽，强制/普通 revision 不通用，失败不丢弃 Worker 身份。它不保留仅作历史的专属分支谱系行：有范围外后代指向时先拒绝，绝不留下孤立谱系。归档与 cleanup 的保留行为不变。HTTP / CLI 与失败重试说明见[彻底删除 Worker](../reference/rpc/maintenance.md#彻底删除-worker)。

相关：[批准合并](merge.md)、[分支谱系](branch-genealogy.md)、[磁盘回收](../reference/rpc/maintenance.md)。
