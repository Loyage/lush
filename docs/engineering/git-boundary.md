# Git 边界

所有 runtime 管理的 Git 写操作使用 argv 数组、无 shell 插值，并共享异步串行队列。外部 Git 进程无法被 Lush 锁住，所以每次推进 ref 都重新验证。

## 分支与 worktree

- 新指令：从父分支（main 或已绑定 owner）的已提交 tip 创建 `lush/<hash>/<id>-<name>` 与 `.lush/worktrees/<id>-<name>`，Agent cwd 就是这里。
- 子 Worker：从父分支当前已提交 tip 创建独立的直接子分支与 worktree。
- 当前 version 2 分歧：原 Worker 在自己的 worktree 吸收固定父提交、保留原源提交并测试；历史 version 1 的独立解分歧子 Worker 从源侧固定提交创建分支/worktree。
- 归档与回收：`branch.archive` 与 `worker.cleanup`，见[分支谱系](branch-genealogy.md)与[工作区回收](cleanup.md)。

分支名、base、target 与 worktree 在 Git 创建前先落库；崩溃后不会出现 runtime 不知道属于谁的目录。谱系 parent 一经记录不重写。

## 父分支选择

新指令可传 `branch`。它必须精确命中 `refs/heads/<branch>`，不接受 tag、SHA 或 rev 表达式；省略时使用项目当前检出分支。父分支不必在项目主 worktree 检出，也可以由另一个 worktree 持有；非 main 分支必须先 `branch.bind` 显式绑定 owner，否则新指令直接拒绝。

未提交修改不会进入新分支。

## 当前父自有队列的 Squash 落地

`prepareTaskSquashUnsafe` 从固定源提交与父基线生成未落地 Squash 提交；runtime 先持久化精确凭据，再由 `applyTaskSquashUnsafe` 复核 refs、清洁度、取消／新输入并受检推进父工作区/ref。`verifyTaskSquashUnsafe` 核验精确提交、父、树与目标祖先，覆盖 Git 成功而 DB 未写的窗口；未知父侧现场保留并阻塞后续写入，不重放未知副作用。

父分支逻辑执行位跨源侧修复保留，但全项目 Git 串行锁不得跨 Agent 调用持有。挂起释放执行位，恢复重新排队并固定新父基线。接口以[模块地图](modules.md)为准，完整协议见[分支合并](merge.md)。

## 历史 version 1 的 fast-forward 落地

`branchState(child)` 用 commit graph 实时判断 direct parent 与 child：fast-forward / diverged / integrated / missing，并检查 child 的直接子分支是否都已收拢。

历史 version 1 Worker 中心交付把固定提交作为 `expected` 一路传到 Git 边界：Git 串行区间内重新读取父子状态，并只接受两种结果：父分支已经包含该固定提交，或父分支能 fast-forward 到该固定提交。实际 Git 命令不再引用可变的 child tip，因此批准前校验通过后即使 child 又前进，也不会扩大交付范围。

落地时：

- parent 已检出：要求 parent / child worktree 干净，在 parent worktree 执行 `git merge --ff-only <landed-commit>`；
- parent 未检出：执行 `git update-ref refs/heads/<parent> <landed-commit> <old-parent-tip>`，用 compare-and-swap 防止覆盖外部推进。

runtime 不在 parent 上执行 `--no-ff`，也不让 parent worktree 进入冲突状态。分歧改由子侧解分歧 Worker 处理；固定提交若已不能从 parent fast-forward，则拒绝落地并保留错误记录。

## 回收

Worker reviewed commit 必须仍是 branch tip 的祖先，branch tip 必须已经进入 target，才可删除Worker分支。删除使用 compare-and-delete，不 force。`branch.archive` 是唯一一条明知未合并也允许的 compare-and-delete，由用户显式触发，见[分支谱系](branch-genealogy.md)。

相关：[分支优先架构](branch-first.md) · [分支合并](merge.md) · [工作区回收](cleanup.md)
