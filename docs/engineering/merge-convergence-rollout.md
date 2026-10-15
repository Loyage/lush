# 一次性整合：验证与部署边界

本文定位验证责任与上线风险，不保留已被 W287／D646 替代的持续归并开发路线，也不把测试清单当作通过证据。当前范围见[实施接缝](merge-convergence-implementation.md)，职责见[Runtime 地图](merge-convergence-runtime.md)，参数见[接口参考](../reference/rpc/convergence.md)。

阅读路线：[产品理念](../design/merge-convergence.md) → [持久协议](merge-convergence-protocol.md) → [异常与恢复](merge-convergence-cases.md) → **验证与部署（本篇）**。

## 验证分层

新增能力先验证真实入口 → 单一 RPC 注册 → 权限 → 受控 Provider／真实 bridge → 结果与 Git 落地，再覆盖模块专项。mock 不得冒充 Provider 调用链；不要求为测试调用付费模型。

| 范围 | 主要入口与核验点 |
|---|---|
| 一次性核心 | test/project/one-shot-integration.test.js：三来源真实落地、无冲突也调用 Agent、单次 Squash、源身份不变；不再覆盖超过旧八来源边界及摘要截断 |
| 迭代 | 同文件：多轮精确增量、目标前进后重新适配与验证；不再保留完整准入、取消、重试及中断矩阵 |
| 公开适配 | test/branch-integrate-api.test.js、test/web/branch-integrate-api.test.js：RPC／CLI／HTTP、严格参数、revision、用户专属、来源与操作读面 |
| 权限／Provider | test/integration-rpc-permissions.test.js、test/agent/convergence-provider.test.js；核心专项另覆盖受控 Pi 子进程与真实 lushc bridge |
| 普通串行 | test/project/merge-queue.test.js、test/integration/automation-mount-runtime.test.js：普通交付与挂载的代表链路 |
| Git／历史兼容 | test/workspaces/convergence-publish.test.js：一次真实批量发布与精确收据恢复；其余旧 v3 专项矩阵已删除，不表示产品兼容被移除 |
| 前端最终组合 | 工作树／Worker 详情的新操作、ACK 与刷新失败、取消／重试、真实状态、Agent 紫色标识／帮助、窄屏与异常；必须在最终前后端树实际验证 |

使用临时项目、隔离设备设置、可控进程及真实 HTTP／RPC／SQLite／Git，不操作用户运行中的队列或服务。选定范围必须完整跑完；日志、命令、被测树、结果与未覆盖风险进入实际交付记录，不在本文长期保存某次测试计数。

子 Worker 默认专项及受影响回归；汇总增加跨模块集成，直接交付 main／owner 的顶层开发指令对最终树负责项目完整 bun run test。代码树变化不能沿用旧全量。只改文档运行 bun run docs:check，不空跑全量。详细规则以[分层测试与交付](../contributing/README.md#分层测试与交付)为准，CI／自动合并不替代验证。

## 部署与兼容

- 新普通请求固定为 serial；新一次性操作显式触发，不设置持续开关。旧 v1／v2／固定 v3 保留原在途与历史，不中途转换、删除或重新调度未知副作用。
- 新成员表与统一读取视图为追加存储，旧八项表约束保留。不能假设旧二进制认识新操作，遇到不认识的状态不得静默忽略或回退重放。
- daemon 与 Host 独立进程；修改两端必须分别由用户在安全点更新。刷新浏览器、代码合入或单端重启不是另一端已更新的证明，不默认停止活动项目。
- 对未知发布先核验精确收据与目标现场，不能靠换版本、取消或清目录修复。保留原模型调用与 Git 审计。

## 成本与未验证风险

无冲突也调用整合 Agent 是明确的语义审查与验证选择，不保证比纯 Git 更快。整合不能发现所有隐式需求依赖，安全落地也不能证明满足业务目标；模型质量、浏览器视觉及生产负载须另行验证。

如需比较收益，应在同一环境／最终测试范围与相同来源集下对比普通 serial 和一次性整合，记录从固定到实际落地的延迟分布、Agent 次数／token 成本、最终测试成本、目标变化重试、资源峰值与失败率。不得以减少卡片或增大集合宣称固定倍数提速，不以跳过最终验证换吞吐。

历史两两拓扑、形成窗口或拆分愿景不是新验收门槛，也不是当前已有功能；仅保留[历史算法兼容说明](merge-convergence-protocol.md#历史-v3-两两算法仅在途兼容)。

上一篇：[异常与恢复](merge-convergence-cases.md)；回到[产品理念](../design/merge-convergence.md)。
