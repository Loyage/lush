# 分支归并首版：Runtime 模块地图

本篇记录 W205 首版的实际文件、导出与安全接缝；公共参数和默认关闭策略见[实施接口与限制](merge-convergence-implementation.md)，长期算法方向见[协议方案](merge-convergence-protocol.md)。路径以 `src/` 为起点，Project/Workspaces/Store 使用现有 mixin 装配，不增加核心业务实体。

> [模块总览](modules.md) → [Runtime 地图](modules-runtime.md) → **归并首版** → [公共接口](../reference/rpc/convergence.md)

## 纯规划与持久记录

| 文件 | 职责 | 导出 / 接入 |
|---|---|---|
| `core/convergence-contract.js` | 内部限额、状态枚举、revision 与 JSON/预约解析；不提供用户策略写入口 | `CONVERGENCE_LIMITS`、`CONVERGENCE_STATES`、`CONVERGENCE_COUNT_STATES`、`CONVERGENCE_POLICY_PREFIX`、`convergenceRevision`、`convergenceJSON`、`convergenceBooking` |
| `core/convergence-plan.js` | 按真实入队序号与已落地 code 上游选择成员，固定相邻两两平衡拓扑；不访问 Git/DB | `selectConvergenceMembers(candidates,dependencies,landedIds,limit=8)`、`convergenceTopology(members)` |
| `persistence/store/convergence.js` | 原子成员领取、唯一 active 归属、generation CAS、固定节点输入、安全历史快照、共享证据删除保护 | `ensureConvergenceColumns(db)`；Store `createDeliveryRun`、`deliveryRun`、`updateDeliveryRun`、`deliveryRuns`、`deliveryMembers`、`releaseDeliveryMembers`、`createDeliveryNode`、`deliveryNode`、`deliveryNodes`、`updateDeliveryNode`、`deliveryHistoryBlockers`、`deleteDeliveryHistory` |
| `persistence/store/schema.js` | `delivery_runs/nodes/members` 及索引；父记录归属，成员/helper 历史 ID 不作级联删除依据 | `SCHEMA`；加列快照只对新记录写入，不补写历史编号 |
| `core/convergence-resources.js` | 基础设施身份的固定关联、在用资源与内部产物交付判断 | `convergenceHelperContext(store,task)`、`convergenceResourceReason(project,task)`、`convergenceHelperDeliveryState(project,task)` |

运行 `preparing/resolving/awaiting/validating/ready/landing/integrated/failed/blocked/withdrawn/stale` 与源预约状态分开。预约 version 3 保留 `requested/executing/blocked/integrated` 等既有安全投影词汇，不能把运行状态直接写入预约；generation 是尝试标识，不是 Worker 轮次编号。

## Project 归并模块

| 文件 | 职责 | 主要方法 |
|---|---|---|
| `core/project/convergence-policy.js` | 真实目标与唯一活动所有者、默认关闭、精确授权引用和 revision；有界安全只读投影 | `branchConvergence`、`branchConvergenceList`、`setBranchConvergence`、`branchConvergenceRuns`、`convergencePolicy`、`convergenceRunView`；具名 `safeConvergenceError`、`convergenceRunRevision`、`convergenceRunView` |
| `core/project/convergence-queue.js` | 有界事件驱动领取/准备，来源静息与固定身份守卫；精确版本/授权事件戳；显式重试 | `scheduleConvergence`、`driveConvergence`、`formConvergenceBatch`、`startConvergenceJob`、`assertConvergenceRun`、`assertConvergenceAuthorization`、`convergenceAuthorizationStamp`、`setConvergenceState`、`retryBranchConvergence` |
| `core/project/convergence-prepare.js` | 固定叶子/双项对象，隔离最终命令，基线刷新与不可变整合新尝试 | `prepareConvergenceRun`、`refreshConvergenceBaseline`、`forkConvergenceRepairGeneration`、`requestConvergenceRepair`、`convergenceIntegrationCapacity`、`wakeConvergenceAfterIntegration` |
| `core/project/convergence-land.js` | 新旧队列共用真实父发布门，持久精确收据，整批 DB 结算和一次父 Hook | `activeConvergenceLanding`、`nextConvergenceLanding`、`convergenceCanPublish`、`publishConvergence`、`finalizeConvergence` |
| `core/project/convergence-workers.js` | 仅内部工厂创建 integration，冻结输入/配置、登记私有 worktree；实际退出后才能晋级 | `createConvergenceIntegration`、`convergenceIntegrationReady`、`convergenceIntegrationContext`、`completeConvergenceIntegration`、`onConvergenceIntegrationExit` |
| `core/project/convergence-safety.js` | generation 先失效再撤回/取消；安全退出后释放来源；重启不重放未知动作 | `convergenceHelpers`、`assertConvergenceResourcesFree`、`cancelConvergenceIntegration`、`withdrawConvergenceMember`、`drainConvergenceWithdrawals`、`recoverConvergence` |
| `core/project/convergence-acceptance.js` | 相关来源全部安全验收后辅助资源收口，来源独立删除后的验收快照、部分回收续办 | `convergenceAcceptanceHelpers`、`reclaimConvergenceAfterAcceptanceUnsafe` |

`core/project.js` 注册上述模块。`merge-queue.js` 在真实安全点按分支策略固定 version 2 或 3；已有请求不转换，关闭不撤回，分支策略不改变自动合并/验收级别。v3 准备不拿父逻辑执行位，只有发布/未知发布冻结父；旧 v2 的源侧修复规则仍保留。

## Git 与隔离验证

| 文件 | 职责 | 导出 / 方法 |
|---|---|---|
| `core/workspaces/delivery-objects.js` | 纯固定对象 `merge-tree/commit-tree`，显式等价基点或真实多基点；冲突种子保留两输入，不写源/父 ref/index | `convergenceOID`；`mergeConvergenceObjects({base=null,left,right,message,parents=null})` |
| `core/workspaces/delivery-publish.js` | 单父受检候选；锁定来源并 CAS 更新目标与 evidence ref，检出/来源身份校验；只读恢复证明 | `prepareConvergencePublishUnsafe`、`applyConvergencePublishUnsafe`、`verifyConvergencePublishUnsafe`；具名 `convergenceWriteGuard`、`assertConvergenceEvidenceObjects`、纯 `convergenceMemberReceipt`、`assertConvergenceMemberReceipt` |
| `core/workspaces/delivery-validation.js` | 登记精确临时检出、独立 Shell、环境剥离、取消/超时/输出界限、前后清洁度与授权守卫、安全回收 | `createConvergenceValidationUnsafe`、`runConvergenceValidation`、`removeConvergenceValidationUnsafe`；具名 `convergenceValidationEnvironment`、`executeConvergenceValidation` |

`core/workspaces.js` 注册三组方法。ref/worktree 创建、回收与真实发布仍经 Git 串行队列，Shell 不跨进程持有它。候选单父提交在测试前固定；`validation_result.state='passed'` 必须关联精确候选 SHA/tree，不能用来源测试、UI 展示或 helper 报告代替。

发布 receipt 含真实 parent、baseline、tree、commit、workspace、run/generation、完整固定成员及 evidence ref/commit。成员树通常不等于批次树；`workspaces/merge.js` 的 `squashedLanded`、归档和 helper 内部释放，以及 `task-sync.js` / `project/iteration.js` 的增量基点与交付判断都用精确成员映射，不用树相等或 patch-id 推断。

## 既有生命周期与权限接缝

- `core/branch-freeze.js`：固定来源冻结；只有真实发布或未知父侧效果冻结父。
- `project/input-queue.js/messages.js` 与 `store/messages.js`：来源追加持久暂存；不混入固定交付。v3 `merge.requested` 不唤醒父开发 Agent。
- `project/version-graph.js` / `workspaces/version-graph.js`：复用 `delivery-publish.js` 的纯成员收据核验，将 v3 组合树与单源树分开；保留旧协议树相等门，隔离 Git 对象读取核验批次落点／证据和来源祖先。
- `project/scheduling.js/context.js`：固定 helper 上下文、能力／Skills 快照、无 Worker 并发额度的安全准入、一次性 invocation token；收回 token 和 `running` 后才接受产物，旧 generation 不推进新尝试。
- `agent/prompts.js/provider.js`、`workspaces/worktree.js`：integration 只在登记私有工作区运行，不继承源 checkpoint，不回落 canonical。Prompt 不代替 RPC/写入守卫，也不是 OS 沙箱。
- `rpc/dispatcher.js`：integration 默认拒绝，仅明确安全只读及自身 Notice/进度允许；五个 `branch.convergence*` 全部 USER_ONLY，详见[能力表](../reference/rpc/convergence.md#专用整合-worker-的-rpc-能力)。
- `project/lifecycle.js/deletion.js/iteration.js`、`workspaces/cleanup.js` 与 Store 删除：在用成员/辅助/共享证据受保护；独立来源可单独验收或删除，不能连带关闭兄弟指令。
- `project/convergence-land.js`：一批一次 `worker.merge_received`，成员各自交付结算/自动环节；不批量授权验收。

接口实现位于 `rpc/handlers/branch.js`、`cli/commands/branch.js` 与 `ui/web/server.js`；自动化页的安全读写/分页位于 `ui/web/assets/branch-convergence.js`，详见 [Web 地图](modules-web.md)与[路由参考](../reference/web-routes.md)。

## 回归分区

- 纯规划/契约：`test/convergence-plan.test.js`、`convergence-contract.test.js`。
- Runtime 与 SQLite：`test/project/convergence-*.test.js`；真实调用生命周期含受控 provider 的 assembled-workers，覆盖权限、问卷、退出、撤回、修复、多轮与辅助回收。
- Git/进程边界：`test/workspaces/convergence-*.test.js`；真实对象、CAS、锁、收据、增量、输出与授权中断，不操作用户队列。
- Provider/权限：`test/agent/convergence-provider.test.js`、`test/integration-rpc-permissions.test.js`。
- 公共面：`test/branch-convergence-api.test.js`、`test/web/branch-convergence-api.test.js`；真实 HTTP→RPC→Runtime→Git/Shell 在 `test/web/branch-convergence-integration.test.js`，UI 在 `test/web/dom-branch-convergence.test.js`。

专项由分区负责人负责；顶层 W205 在收齐最终代码树后运行完整 `bun run test`。受控模型/DOM 不能证明实际模型质量、视觉与吞吐，限制以[首版接缝](merge-convergence-implementation.md#首版实现与明确限制)为准。
