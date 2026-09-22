# Candidate 接受时固定被审阅提交

本条面向 Candidate 与 Git 合并流程的维护者，目标是保证用户接受的精确提交就是最终交付内容。实现入口是 `src/core/project/candidates.js` 与 `src/core/workspaces/merge.js`。

## 状态与优先级

- 优先级：P0。
- 状态：已修复。
- 依据：确定性交错回归测试覆盖校验前漂移、校验后推进、固定提交落地与失败恢复。

## 当前问题

`acceptCandidate()` 先读取分支 tip 并检查它等于 `candidate.commit_hash`，随后调用 `approveBranchMerge()`。实际 Git 串行区间在更下层的 `mergeBranch()` 中建立，合并时重新读取当前分支状态。

因此顺序可能变成：

1. 接受请求检查分支指向已审阅提交 A。
2. 在实际合并取得串行执行权之前，另一个操作把分支推进到 B。
3. 合并层读取 B，并将 B 合入父分支。
4. Candidate 被标记为 `integrated`，但其固定提交仍是 A。

审查时使用临时 fixture，在 `mergeBranch()` 执行前插入一次遵循 Git 串行队列的分支推进，观察到 `landedUnreviewed: true`。这是受控交错复现，不是对真实用户操作发生频率的测量。

## 实现结果

- `acceptCandidate()` 将 `candidate.commit_hash` 传给 `approveBranchMerge(branch, expected)`，再传到 `mergeBranch(child, expected)`。
- Git 串行区间内重新读取父子状态；固定提交已在 parent 中时幂等成功，否则只允许 parent fast-forward 到该提交。
- parent 已检出时执行 `git merge --ff-only <expected>`；未检出时用 `git update-ref <parent> <expected> <old-parent>` compare-and-swap。
- child 在前置校验后继续前进不会扩大交付范围，返回结果用 `landed` 明确记录实际交付提交。
- 合并抛错或返回未落地结果时 Candidate 回到 `ready`，并写入 `candidate.accept_failed` 事件；只有固定提交已落地或已集成才进入 `integrated`。
- 未增加用户命令、持久化实体或 schema。

## 验收标准

- [x] 增加确定性的交错测试，不依赖 sleep 碰运气。
- [x] 校验前发生分支漂移时拒绝接受。
- [x] 校验与合并之间发生分支漂移时，不得把未审阅提交合入目标。
- [x] 成功交付只能落地固定提交，或确认该提交已集成；不能因 child 漂移扩大交付范围。
- [x] 覆盖父分支已检出、未检出和并发推进情形。
- [x] 既有 Candidate、分支合并及 worktree 安全测试通过。

## 验证记录

- `bun test test/project/candidates.test.js`：7 通过，覆盖前置漂移、确定性交错、已检出／未检出 parent、已集成与失败事件。
- `bun test test/workspaces`：44 通过。
- `bun test test/merge-ff.test.js test/merge-batch.test.js test/merge-conflict.test.js test/merge-select.test.js test/drafts/deps.test.js`：37 通过。
- `bun test test/integration/candidate.test.js`：2 通过；`bun test test/candidate-cli.test.js`：3 通过。
- `bun run docs:check`：通过，检查 54 个 Markdown 文件。
- `bun run test`：461 个测试中 453 通过、8 失败；失败项与[测试基线](testing.md)记录的 questionnaire / Web 用例一致，本次相关测试全部通过。

## 剩余限制

- Lush 的串行队列只能约束自身 Git 写操作；外部进程推进未检出的 parent 时仍由 `update-ref` compare-and-swap 安全失败，推进已检出的 parent 时由 `merge --ff-only <expected>` 拒绝不兼容状态。
- 校验前已发生的 child 漂移仍按产品规则拒绝旧 Candidate，即使固定提交从 Git 图上仍可 fast-forward；需要重新准备 Candidate。

[返回待办索引](README.md)
