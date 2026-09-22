# Candidate 接受时固定被审阅提交

本条面向 Candidate 与 Git 合并流程的维护者，目标是保证用户接受的精确提交就是最终交付内容。实现入口是 `src/core/project/candidates.js` 与 `src/core/workspaces/merge.js`。

## 状态与优先级

- 优先级：P0。
- 状态：待修复。
- 依据：已在临时 Git 仓库中通过受控插入并发变更复现。

## 当前问题

`acceptCandidate()` 先读取分支 tip 并检查它等于 `candidate.commit_hash`，随后调用 `approveBranchMerge()`。实际 Git 串行区间在更下层的 `mergeBranch()` 中建立，合并时重新读取当前分支状态。

因此顺序可能变成：

1. 接受请求检查分支指向已审阅提交 A。
2. 在实际合并取得串行执行权之前，另一个操作把分支推进到 B。
3. 合并层读取 B，并将 B 合入父分支。
4. Candidate 被标记为 `integrated`，但其固定提交仍是 A。

审查时使用临时 fixture，在 `mergeBranch()` 执行前插入一次遵循 Git 串行队列的分支推进，观察到 `landedUnreviewed: true`。这是受控交错复现，不是对真实用户操作发生频率的测量。

## 建议方向

- 将 Candidate 的预期提交传递到 Git 合并边界。
- 在同一个 Git 串行区间内完成预期提交校验和落地。
- 实际 Git 命令使用固定 commit，不再由可变分支 tip 决定交付内容。
- 继续保留工作区干净检查、直接父分支约束与未检出父分支的 compare-and-swap。
- 明确合并失败时 Candidate 状态与错误记录的语义。

具体内部签名先按模块地图确认；不需要为了修复引入新的用户命令。

## 验收标准

- [ ] 增加确定性的交错测试，不依赖 sleep 碰运气。
- [ ] 校验前发生分支漂移时拒绝接受。
- [ ] 校验与合并之间发生分支漂移时，不得把未审阅提交合入目标。
- [ ] 成功交付只能落地固定提交，或确认该提交已集成；不能因 child 漂移扩大交付范围。
- [ ] 覆盖父分支已检出、未检出和并发推进情形。
- [ ] 既有 Candidate、分支合并及 worktree 安全测试通过。

[返回待办索引](README.md)
