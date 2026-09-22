# 集中状态转换与明确模块契约

本条面向核心架构维护者，记录在保留现有模块入口和 mixin 组装方式的前提下，Candidate 状态转换的第一步集中化。入口为 `src/core/project/candidates.js`、`src/core/project/lifecycle.js` 与 `src/persistence/store/candidates.js`。

## 状态与优先级

- 优先级：P2。
- 状态：Candidate 范围已实施；其余 Project 状态按实际需求渐进推进。
- 范围：没有大规模搬文件，没有修改公开 Project/RPC/CLI 入口或 SQLite schema。

## 已实施契约

- `store/candidates.js` 保存一份 Candidate 转换图，并提供命名动作 `transitionCandidate`；准备验收、替代、接受、要求修改、拒绝、Git 成功与 Git 失败都通过该入口。
- 兼容的 `updateCandidate` 仍保留，但 status patch 也必须满足同一转换图；终态回写等非法转换被确定性拒绝。
- verifier 结算保留单条条件 UPDATE：仅当前 `preparing` 且 `report_task_id` 匹配的回调可写 `ready` / `failed`，迟到回调只留事件。
- 数据库事务只覆盖 Candidate 状态与事件。Git merge 不伪装在事务里：`accept` 先进入 `accepted`，Workspaces 在既有串行边界交付固定 commit，再以 `integration_succeeded` / `integration_failed` 回报状态机。
- 自动 verification 只能把 Candidate 结算为 `ready` / `failed`；只有用户调用既有 `candidate.accept` 才会进入 Git 边界。
- `project.js` / `store.js` 的公开入口、mixin 装配与重名检查保持不变；模块职责和新内部签名已写入 `docs/engineering/modules-runtime.md`。

## 验收标准

- [x] Candidate 用户动作与异步回调遵循同一份转换规则。
- [x] 非法转换可被确定性拒绝，不依赖调用者自行记住所有限制。
- [x] 旧数据和兼容入口仍有明确行为。
- [x] 模块依赖、事务边界和 Git 串行边界有可查契约。
- [x] 静态契约通过局部 JSDoc/校验函数渐进增加，不要求一次迁移整个仓库。
- [x] 不以大规模搬文件代替实际不变量测试。

## 实施证据

- `test/project/verification-evidence.test.js` 覆盖 rejected 终态不能回写 ready、终态不能重新启动 verification。
- `test/project/candidates.test.js` 覆盖迟到成功/失败回调不能复活 rejected / changes_requested / superseded Candidate，以及 Git 落地失败回到 ready。
- `src/persistence/store/candidates.js` 的注释明确事务与 Git 串行边界；`docs/engineering/modules-runtime.md` 是模块签名权威地图。

[返回待办索引](README.md)
