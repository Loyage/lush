# 一次性整合与历史归并：Runtime 地图

本篇定位长期职责，不复制内部导出或公共参数。当前行为见[实施接缝](merge-convergence-implementation.md)，公共接口见[接口参考](../reference/rpc/convergence.md)。Project／Workspaces／Store 沿用 mixin 装配，不新增核心业务实体。

> [模块总览](modules.md) → [Runtime 地图](modules-runtime.md) → **整合** → [公开接口](../reference/rpc/convergence.md)

## Project 模块

| 入口（src/core/project/） | 职责 |
|---|---|
| one-shot-integration | 只读全量计划、原子固定、一个自主 integration 身份、目标变动的新尝试、取消与显式重试、merge_operation 投影 |
| convergence-policy | 真实目标与历史策略／默认只读兼容、退休 setter、历史运行分页 |
| convergence-queue | 固定来源守卫、事件驱动晋级与共享调度；旧 v3 组批仅兼容既有固定请求 |
| convergence-prepare | 分派新自主准备／基线刷新；旧叶子、两两对象和 command 验证继续原协议 |
| convergence-workers | 私有身份与上下文、有效 invocation、真实退出后的候选接收 |
| convergence-land | 新旧共用父发布门、精确收据恢复、完整成员结算与一次父 Hook |
| convergence-safety | generation 失效、取消后真实退出再释放、孤儿调用与未知结果保护 |
| convergence-acceptance | 来源安全验收后的辅助资源收口、共享引用与部分回收续办 |

入口由 project.js 注册。merge-queue 对新普通单项／自动请求只固定 v2 serial，不再按历史目标策略生成新 v3；原 v1/v2/v3 在途不转换。内部旧方法仍存在不表示可从公开入口新建持续归并。

## 持久化与不可变上下文

store/convergence.js 复用 delivery_runs／delivery_nodes，data.operation_mode 区分 one_shot。新成员存于追加的 integration_members；旧 delivery_members 的八项 CHECK 与历史行原样保留，all_delivery_members 统一读取、计数与引用保护。跨表 active 领取唯一性、事务与 generation CAS 保护同一来源；技术关联不是重挂真实父关系。

每操作只有一个自主节点身份，后续 generation 追加新节点／integration.attempt_fixed 事件，convergence.integration_created 保持初始记录不变。core/convergence-resources.js 为新操作读取最新固定尝试；旧调用的 token 或返回不能推进新代。运行状态、来源预约状态、Worker 状态与实际 integration=merged 各自独立。

core/convergence-plan.js 的相邻两两规划只服务历史固定 v3；新操作不调用其容量／拓扑决策。源码中的 delivery／convergence 名称属于技术兼容，不恢复独立交付产品模型。

## Git 与生命周期接缝

workspaces/delivery-publish.js 固定单父候选与完整来源映射，receipt 带 one_shot 标记时不套旧八项上限。发布核验 parent／baseline／tree／commit／workspace／run／generation、成员及 evidence；以 ref transaction／CAS 和受检检出更新真实目标，source refs 只验证不修改。

workspaces/delivery-objects.js 的固定对象合成与 delivery-validation.js 的隔离命令验证仅为旧在途服务。新组合由 Agent 在登记私有 worktree 完成；runtime 不伪造测试通过，验证责任见[实施接缝](merge-convergence-implementation.md#验证责任与在途兼容)。Git 写入／资源回收仍经 Workspaces 串行，不能跨 Agent 调用持有 Git gate。

- 固定来源的普通追加持久暂存，解冻且实际退出后才投递；取消不丢输入或代码。
- 多轮增量、父同步、版本图、验收与删除共用精确来源映射，不以单源树等于组合树或目录消失猜成功。
- integration 不继承来源 checkpoint，不回落 canonical；只允许[注册表窄权限](../reference/rpc/convergence.md#专用整合-worker-的-rpc-能力)。这是权限隔离，不是 OS 沙箱。
- 所有来源安全验收前保留辅助现场；回收不得连带验收独立指令，不提高源自动级别。

CLI／RPC／Web 只适配公开接口；graph 与 inspect 使用同源 merge_operation，历史 delivery 读面保留诊断与截断语义。

## 验证定位

新行为以 test/project/one-shot-integration.test.js、test/branch-integrate-api.test.js、test/web/branch-integrate-api.test.js 为入口；旧协议、Git／CAS／映射与权限分别位于 convergence 专项和 test/integration-rpc-permissions.test.js。完整分层责任与限制见[验证范围](merge-convergence-rollout.md)，不把测试文件存在或历史通过记录当作当前树已通过。
