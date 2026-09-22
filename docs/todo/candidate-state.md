# 防止迟到验收覆盖用户决定

本条面向 Candidate 生命周期维护者，处理 verifier 结算与用户拒绝、要求修改、候选替换之间的竞争。实现入口是 `src/core/project/lifecycle.js` 与 `src/core/project/candidates.js`。

## 状态与优先级

- 优先级：P0。
- 状态：已修复。
- 依据：可控直接结算回归覆盖 `rejected`、`changes_requested`、`superseded` 与失效 `report_task_id`。

## 当前问题

`finish()` 遇到带 `review_candidate_id` 的 task 时，会根据 task 完成状态及报告是否存在，无条件将 Candidate 写为 `ready` 或 `failed`，并覆盖 `report_task_id`。

但用户可以在验收期间拒绝候选或要求修改。旧 verifier 随后完成时，不应再改变已作出的决定。

本轮受控复现顺序：

1. 创建 Candidate 并请求 verifier。
2. 用户拒绝 Candidate，状态成为 `rejected`。
3. 模拟 verifier 的迟到结算，提供存在的报告文件。
4. Candidate 被写回 `ready`。

同一无条件更新路径还需要检查 `changes_requested`、`superseded` 与不同验收任务的结果竞争。

## 修复结果

`settleCandidateVerification()` 用单条条件更新同时要求 Candidate 仍为 `preparing` 且 `report_task_id` 等于本次 verifier。条件不满足时保留当前 Candidate 状态；task、报告和 `candidate.verified` 事件仍保留，事件明确记录 `applied:false` 与当前状态。

本修复不主动取消用户拒绝或要求修改时仍在运行的 verifier，只约束迟到结算不能覆盖用户决定；是否主动取消仍可作为独立产品行为讨论。

## 验收标准

- [x] `rejected` 不会被迟到的成功或失败结果覆盖。
- [x] `changes_requested` 与 `superseded` 不会被旧 verifier 恢复。
- [x] 旧 `report_task_id` 的回调不能替代当前验收任务结果。
- [x] 当前有效 verifier 仍可正常使候选进入验收完成状态。
- [x] 被忽略的迟到结果保留可追溯记录。
- [x] 测试使用可控 gate 或直接结算模拟，不依赖随机时序。

[返回待办索引](README.md)
