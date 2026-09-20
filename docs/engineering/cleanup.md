# 工作区与分支回收

本文件管工作区与分支回收的安全门：`update-ref` compare-and-delete 与 `keep-branch`。

工作区清理不强制删除；即使 failed/cancelled task 的 integration=none，也检查其 commit 是否已包含在项目 HEAD 中，防止删除未交付成果。任务分支也只在能证明它已经是恢复不必要时才删：分支顶端仍等于审阅过的 `head_commit`，且该提交已经是 `target_branch` 的祖先。删除用 `update-ref -d` 的 compare-and-delete，`head_commit` 之外多出来的任何提交都留得住；拿不准就保留（`reason` 说明原因）。`keepBranch` / `--keep-branch` 可以把分支单独留成恢复点。

**输入锚点**（`lush/<项目哈希>/input-<id>-anchor` 与它的检出）单独一套门：它没有任务、也没有 `integration`，只要求检出 `clean` 且分支顶端仍等于 `anchor_commit`（没人往里提交，所以“没动过”是可证的），然后 `update-ref -d` compare-and-delete。主工作树脏不影响它。任一条不满足就目录与分支一起留着，并在 `reason` 里说明。只有 `task clear` 会调 `reclaimAnchors`；失败写回滚用 `releaseAnchor`（同一条路，只是单条）。

分支真的被删掉时，谱系记录只把 `status` 标成 `deleted`，**不删行**：子分支的 parent 指针必须继续有效，所以 `[deleted]` 的节点仍出现在 `lush branch tree` 里，它的子分支照旧挂在下面。外部（用户自己 `git branch -D`）删掉的分支由读模型按 ref 现状显示，不写库。详见 [分支谱系](branch-genealogy.md)。

相关：[批准合并](merge.md)、[检验与对照检出](verification.md)、[分支谱系](branch-genealogy.md)。
