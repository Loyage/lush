# Candidate 接受时固定被审阅提交

本条面向 Candidate 与 Git 合并流程的维护者，目标是保证用户接受的精确提交就是最终交付内容。实现入口是 `src/core/project/candidates.js` 与 `src/core/workspaces/merge.js`。

## 状态与优先级

- 优先级：P0。
- 状态：已修复。
- 依据：临时 Git 仓库中的确定性 gate 回归覆盖校验前漂移、Git 队列内漂移、父分支已检出与未检出。

## 当前问题

`acceptCandidate()` 先读取分支 tip 并检查它等于 `candidate.commit_hash`，随后调用 `approveBranchMerge()`。实际 Git 串行区间在更下层的 `mergeBranch()` 中建立，合并时重新读取当前分支状态。

因此顺序可能变成：

1. 接受请求检查分支指向已审阅提交 A。
2. 在实际合并取得串行执行权之前，另一个操作把分支推进到 B。
3. 合并层读取 B，并将 B 合入父分支。
4. Candidate 被标记为 `integrated`，但其固定提交仍是 A。

审查时使用临时 fixture，在 `mergeBranch()` 执行前插入一次遵循 Git 串行队列的分支推进，观察到 `landedUnreviewed: true`。这是受控交错复现，不是对真实用户操作发生频率的测量。

## 修复结果

Candidate 的 `commit_hash` 现在经 `approveBranchMerge(branch, expectedCommit)` 传到 Git 边界。`mergeBranch()` 在同一串行区间内核对分支顶端，并以固定提交执行 `merge --ff-only` 或 `update-ref`；固定提交已在父分支中时幂等成功，分支漂移不会扩大交付内容。

用户确认后 Candidate 先保持 `accepted`；Git 落地成功才进入 `integrated`。落地失败会原样抛错并保留 `accepted`，既记录用户决定，也允许修复分支状态后重试或准备新候选。没有新增用户命令。

## 验收标准

- [x] 增加确定性的交错测试，不依赖 sleep 碰运气。
- [x] 校验前发生分支漂移时拒绝接受。
- [x] 校验与合并之间发生分支漂移时，不得把未审阅提交合入目标。
- [x] 成功交付只能落地固定提交，或确认该提交已集成；不能因 child 漂移扩大交付范围。
- [x] 覆盖父分支已检出、未检出和并发推进情形。
- [x] 既有 Candidate、分支合并及 worktree 安全测试通过。

[返回待办索引](README.md)
