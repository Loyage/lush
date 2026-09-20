# 工作区与分支回收

本文件管工作区与分支回收的安全门：`update-ref` compare-and-delete 与 `keep-branch`。

工作区清理不强制删除。任务分支只有在 tip 仍包含审阅过的 `head_commit`、且整个 tip 已进入其 recorded direct parent / `target_branch` 时才删；因此聚合进来的子分支提交不会被误判为篡改，也不会丢失。删除使用 compare-and-delete；拿不准就保留并说明 reason。`--keep-branch` 可只回收 worktree。

**输入分支**（`lush/<项目哈希>/input-<id>` 与它的检出）没有 task owner。未推进时可直接回收；若已聚合子分支，只有在 worktree 干净且当前 tip 已进入 recorded parent 后才 compare-and-delete。否则目录与分支一起保留并说明原因。只有 `task clear` 调 `reclaimAnchors`；字段/返回名继续用 anchor 以兼容旧库。

分支真的被删掉时，谱系记录只把 `status` 标成 `deleted`，**不删行**：子分支的 parent 指针必须继续有效，所以 `[deleted]` 的节点仍出现在 `lush branch tree` 里，它的子分支照旧挂在下面。外部（用户自己 `git branch -D`）删掉的分支由读模型按 ref 现状显示，不写库。详见 [分支谱系](branch-genealogy.md)。

相关：[批准合并](merge.md)、[检验与对照检出](verification.md)、[分支谱系](branch-genealogy.md)。
