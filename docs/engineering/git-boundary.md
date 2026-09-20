# Git 边界

所有 runtime 管理的 Git 写操作使用 argv 数组、无 shell 插值，并共享异步串行队列。外部 Git 进程无法被 Lush 锁住，所以每次推进 ref 都重新验证。

## 分支与 worktree

- 输入提交：从用户指定的本地父分支 tip 创建 `lush/<hash>/input-<id>` 与 `.lush/worktrees/input-<id>`；planner cwd 就是这里。
- 普通 worker：从输入提交时冻结的 commit 创建；direct parent / target 是输入分支。
- `code` 下游：从上游任务 reviewed commit 创建；direct parent / target 是上游任务分支。
- branch-sync merger：从 child tip 创建；direct parent / target 是该 child，agent 在这里 merge 冻结的 parent commit。
- verifier：使用被检验 worktree 加一个 detached 对照检出，不产生交付分支。

分支名、base、target 与 worktree 在 Git 创建前先落库；崩溃后不会出现 runtime 不知道属于谁的目录。谱系 parent 一经记录不重写。

## 指定输入父分支

`input.submit` / `draft.commit` 可传 `branch`。它必须精确命中 `refs/heads/<branch>`，不接受 tag、SHA 或 rev 表达式；省略时使用项目当前检出分支。父分支不必在项目主 worktree 检出，也可以由另一个 worktree 持有。

未提交修改不会进入新分支。若父分支正被某个 worktree 检出，其 porcelain 差异记录在 `input.anchor` 事件；否则输入只锚定 ref tip。

## fast-forward 落地

`branchState(child)` 用 commit graph 实时判断 direct parent 与 child：fast-forward / diverged / integrated / missing，并检查 child 的直接子分支是否都已收拢。

落地时：

- parent 已检出：要求 parent / child worktree 干净，在 parent worktree 执行 `git merge --ff-only <child-tip>`；
- parent 未检出：执行 `git update-ref refs/heads/<parent> <child-tip> <old-parent-tip>`，用 compare-and-swap 防止覆盖外部推进。

runtime 不在 parent 上执行 `--no-ff`，也不让 parent worktree进入冲突状态。分歧改由独立子侧 merger 处理。

## 回收

任务 reviewed commit 必须仍是 branch tip 的祖先，branch tip 必须已经进入 target，才可删除任务分支。输入分支若从初始 commit 前进，也只有在当前 tip 已进入它的直接父分支后才可回收。删除使用 compare-and-delete，不 force。

相关：[分支优先架构](branch-first.md) · [分支合并](merge.md) · [工作区回收](cleanup.md)
