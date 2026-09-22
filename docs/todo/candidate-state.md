# 防止迟到验收覆盖用户决定

本条面向 Candidate 生命周期维护者，处理 verifier 结算与用户拒绝、要求修改、候选替换之间的竞争。实现入口是 `src/core/project/lifecycle.js` 与 `src/core/project/candidates.js`。

## 状态与优先级

- 优先级：P0。
- 状态：已修复。
- 依据：事务内条件结算与确定性直接结算测试覆盖 `rejected`、`changes_requested`、`superseded` 和旧 `report_task_id`。

## 当前问题

`finish()` 遇到带 `review_candidate_id` 的 task 时，会根据 task 完成状态及报告是否存在，无条件将 Candidate 写为 `ready` 或 `failed`，并覆盖 `report_task_id`。

但用户可以在验收期间拒绝候选或要求修改。旧 verifier 随后完成时，不应再改变已作出的决定。

本轮受控复现顺序：

1. 创建 Candidate 并请求 verifier。
2. 用户拒绝 Candidate，状态成为 `rejected`。
3. 模拟 verifier 的迟到结算，提供存在的报告文件。
4. Candidate 被写回 `ready`。

同一无条件更新路径还需要检查 `changes_requested`、`superseded` 与不同验收任务的结果竞争。

## 实现结果

- `store.settleCandidateVerification(candidateId, reportTaskId, status)` 用一条条件 `UPDATE` 同时要求 Candidate 为 `preparing` 且 `report_task_id` 等于当前 verifier。
- `finish()` 在原事务内调用该入口；匹配时才写入 `ready` / `failed`，不匹配时 Candidate 完全不变。
- 被忽略的 verifier 仍正常结算自己的 Task、Run、Artifact 与报告，并新增 `candidate.verification_ignored` 事件，记录当前 Candidate 状态和当前 `report_task_id`。
- 当前有效 verifier 继续写 `candidate.verified`，事件明确带上最终 Candidate 状态与报告存在性。
- 本修复保持现有产品行为：用户拒绝、要求修改或替代 Candidate 后不主动取消正在运行的 verifier；它完成后只留历史，不再拥有状态写入权。

## 验收标准

- [x] `rejected` 不会被迟到的成功或失败结果覆盖。
- [x] `changes_requested` 与 `superseded` 不会被旧 verifier 恢复。
- [x] 旧 `report_task_id` 的回调不能替代当前验收任务结果。
- [x] 当前有效 verifier 仍可正常使候选进入验收完成状态。
- [x] 被忽略的迟到结果保留可追溯记录。
- [x] 测试使用可控 gate 或直接结算模拟，不依赖随机时序。

## 验证记录

- `bun test test/project/candidates.test.js`：12 通过；包含迟到成功／失败、拒绝、反馈、替代版本、旧／当前 verifier 和缺失报告。
- `bun test test/verify.test.js test/integration/verify.test.js test/integration/candidate.test.js`：8 通过。
- `bun test test/project/lifecycle.test.js test/project/recovery.test.js test/project/status.test.js`：8 通过。
- `bun test test/candidate-cli.test.js`：3 通过。
- `bun run docs:check`：通过，检查 54 个 Markdown 文件。
- `bun run test`：466 个测试中 458 通过、8 失败；失败项与[测试基线](testing.md)记录的 questionnaire / Web 用例一致，本次相关测试全部通过。

## 剩余限制

- Candidate 其它用户动作仍通过各自入口写状态；本次只把 verifier 的结算权限集中到持久化条件更新，没有扩展成完整状态机重构。
- 不主动终止失效 verifier，可能继续消耗已经开始的 invocation；这是为了保留现有产品行为，结果会被审计但不会影响 Candidate。

[返回待办索引](README.md)
