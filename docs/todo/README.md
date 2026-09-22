# 改进待办

这里保存基于源码审查与测试得到的改进清单，供后续开发规划使用。每个条目记录自己的实施状态与验证结果；现行架构和接口仍以工程文档为准。

## 审查基线

初始审查基于含未提交改动的工作区，Bun 为 1.4.2：456 个测试中 448 通过、8 失败。后续条目与审查修复组合后重新建立了可复验基线（Bun 1.4.2、darwin/arm64）：

- `bun run test`：482 个测试全部通过，覆盖 94 个测试文件。
- `bun run docs:check`：通过，检查 54 个 Markdown 文件。
- `bun run measure:read-performance`：20 / 1,000 / 10,000 条任务的真实 `UIClient.overview()` 分别为 9.355 / 6.110 / 17.311 ms（渲染 0.936 / 2.482 / 1.393 ms）；10,000 条历史任务只返回 50 条任务窗口，首页 ladder 只查有界待交付项、resolver 与直接依赖，不再读取全任务表。12 MiB 日志实际只读取 8 MiB，冷读 11.844 ms、热读 0.106 ms、timer 延迟 11.871 ms；脚本会汇总 violations 并在任一阈值超限时以非零状态退出，本次 `ok: true`。
- `accepted` 后并发 reject / changes / prepare 被集中转换契约拒绝，并由占住 Git 队列的确定性回归覆盖；`pass` 携带 `failures` / `unverified` 在证据文件与新 Artifact 写入时都会被拒绝，历史矛盾 Artifact 投影为 `unknown` 且不能让 Candidate 进入 `ready`。
- 同路径日志 truncate 后在两次轮询间快速长回、且长度超过旧 offset 的回归同时校验 transcript 与 usage 缓存，确保丢弃旧前缀并重建。
- GitHub `main` 要求 `Bun tests and docs` 状态检查成功；不强制 PR 审核。

## 推荐顺序

| 优先级 | 待办 | 依据 |
|---|---|---|
| P0（已完成） | [Candidate 接受时固定被审阅提交](candidate-acceptance.md) | 固定提交在 Git 串行区间内校验并落地 |
| P0（已完成） | [防止迟到验收覆盖用户决定](candidate-state.md) | 条件结算拒绝迟到 verifier 覆盖用户状态 |
| P1（已完成） | [恢复可靠测试基线与持续集成](testing.md) | 最终集成基线 482/482 通过；GitHub 必需检查已启用 |
| P1（已完成） | [结构化验收证据](verification-evidence.md) | version 2 结果、固定提交证据、旧数据兼容与完整结论回归已落地 |
| P2（已完成） | [控制快照与日志读取成本](read-performance.md) | 有界首页、历史分页、8 MiB 日志预算与增量缓存已通过测量 |
| P2（Candidate 范围已完成） | [集中状态转换与明确模块契约](architecture-contracts.md) | Candidate 转换图、条件结算、事务与 Git 边界已有契约和回归 |
| P2（已完成） | [统一用户流程、文档与版本诊断](product-and-docs.md) | 交付口径已统一，daemon / Web 身份可分别只读诊断 |

四个后续条目的验收标准已在集成分支逐项复核，并由全量测试、文档检查和性能测量共同复验。架构条目只宣告既定的 Candidate 范围完成；其它 Project 状态若将来需要集中化，仍按实际需求渐进推进，不把大规模重写列为本轮遗留。

## 维护方式

- 修复后记录回归测试、验证命令与剩余限制，不能仅凭代码改动勾选完成。
- 区分已复现行为、源码推断和设计建议，不把建议写成现行规则。
- 涉及架构、产品行为、公共接口或数据模型的选择，应在实施前确认。
- 文件移动或接口变化继续遵循[模块地图](../engineering/modules.md)，文档修改遵循[文档约定](../contributing/documentation.md)。

[返回文档索引](../README.md)
