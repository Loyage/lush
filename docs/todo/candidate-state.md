# 防止迟到验收覆盖用户决定

本条面向 Candidate 生命周期维护者，处理 verifier 结算与用户拒绝、要求修改、候选替换之间的竞争。实现入口是 `src/core/project/lifecycle.js` 与 `src/core/project/candidates.js`。

## 状态与优先级

- 优先级：P0。
- 状态：待修复。
- 依据：`rejected → ready` 已在临时 fixture 中复现；其它状态需要补充回归测试。

## 当前问题

`finish()` 遇到带 `review_candidate_id` 的 task 时，会根据 task 完成状态及报告是否存在，无条件将 Candidate 写为 `ready` 或 `failed`，并覆盖 `report_task_id`。

但用户可以在验收期间拒绝候选或要求修改。旧 verifier 随后完成时，不应再改变已作出的决定。

本轮受控复现顺序：

1. 创建 Candidate 并请求 verifier。
2. 用户拒绝 Candidate，状态成为 `rejected`。
3. 模拟 verifier 的迟到结算，提供存在的报告文件。
4. Candidate 被写回 `ready`。

同一无条件更新路径还需要检查 `changes_requested`、`superseded` 与不同验收任务的结果竞争。

## 建议方向

- 结算时同时核验 Candidate 当前状态和 `report_task_id` 是否仍属于该 verifier。
- 使用事务内的条件更新，避免先检查后无条件写入。
- 迟到结果可以保留为 task、Run、Artifact 或事件历史，但不能恢复旧候选的可接受状态。
- 明确用户拒绝或反馈后是否主动取消验收；这是产品行为选择，实施前确认，不必作为防覆盖修复的前置条件。
- 候选状态规则集中维护，避免各入口分别直写状态。

## 验收标准

- [ ] `rejected` 不会被迟到的成功或失败结果覆盖。
- [ ] `changes_requested` 与 `superseded` 不会被旧 verifier 恢复。
- [ ] 旧 `report_task_id` 的回调不能替代当前验收任务结果。
- [ ] 当前有效 verifier 仍可正常使候选进入验收完成状态。
- [ ] 被忽略的迟到结果保留可追溯记录。
- [ ] 测试使用可控 gate 或直接结算模拟，不依赖随机时序。

[返回待办索引](README.md)
