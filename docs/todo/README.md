# 改进候选清单

这里保留尚有未完成事项的改进建议，供维护者选择下一步投入。**候选不等于批准需求，测试通过不等于安全认证**；当前实现以[工程文档](../engineering/README.md)和[接口参考](../reference/README.md)为准。

## 从哪里开始

先读[当前优先级与实施前决策](00-priorities.md)，再进入专题。专题混有已完成条目的历史证据，只要仍有待办就保留整篇；已完整完成的专题和方案不再留在 `todo/`，历史可从 Git 查阅。

| 专题 | 剩余方向 |
|---|---|
| [Git / Worktree 与交付](02-git-worktrees.md) | G-03 更强外部并发隔离；现有漂移检测不等于消除竞态 |
| [安全与边界](03-security-boundaries.md) | S-04 可信代理与登录限流；真实客户端边界验收 |
| [Web / 桌面体验](04-web-desktop-experience.md) | U-07 桌面偏好跨随机端口持久化；真实 IME / Electron 验收 |
| [测试与工程维护](05-testing-maintainability.md) | E-01 非 helper 测试入口隔离、E-02～E-06 剩余契约、兼容、冒烟、Markdown 和性能证据 |
| [多项目工作台](multi_proj/README.md) | Host 总连接 / 摘要并发预算与真实多客户端验收 |

## 已完成范围的现行入口

2026-10-03 对 `8dbde1b` 基线核对：运行时 R-01～R-07 已修复或随旧入口关闭；运行时资源包 R-03/R-06/R-07/G-04/S-05 及多项目核心身份隔离已实现，包含在该基线中。删除对应的运行时专题、方案草案和多项目身份规划，不恢复已退休的 Plan/spec、Candidate 或 Showcase 产品入口。

- agent 父死亡监护、Run 恢复记账及不重放：[项目身份与恢复](../engineering/identity-and-recovery.md)。
- inbox 分批与原文保留：[Token 效率](../engineering/token-efficiency.md)。
- Run / Artifact 最新窗口及继续读取：[Worker RPC](../reference/rpc/tasks.md)。
- 归档预检、部分失败与显式续办：[工作区与分支回收](../engineering/cleanup.md)。
- RPC 每连接回压预算：[HTTP 与传输边界](../reference/http.md)。
- 多项目请求身份与 Host 职责：[三层边界](../engineering/host-boundary.md)。

功能完成不代表所有平台、真实浏览器或生产规模都已验收；剩余测量与兼容投入保留在工程及多项目专题中。各专题的旧基线、行号、日志和“本轮”状态是历史记录，不替代当前验证。

## 后续维护

选中候选后，先确认产品 / 架构选项，再补最小回归并实施。部分完成的专题更新状态与证据；完整完成后删除待办文档及索引链接，必要的现行契约留在工程文档或接口参考。测试仅使用临时项目、mock 与受控进程，不操纵用户正在开发的项目。

[返回文档地图](../README.md)
