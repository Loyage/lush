# 分支归并首版：Runtime 模块地图

本篇定位归并的长期职责与安全接缝，不重复内部导出清单。公共参数、当前模式及限制见[实施契约](merge-convergence-implementation.md)，算法取舍见[协议方案](merge-convergence-protocol.md)。Project／Workspaces／Store 沿用 mixin 装配，不新增核心业务实体。

> [模块总览](modules.md) → [Runtime 地图](modules-runtime.md) → **归并首版** → [公共接口](../reference/rpc/convergence.md)

## 纯规划与持久记录

`core/convergence-plan.js` 只按固定入队顺序、依赖和容量规划拓扑，不访问 Git／DB；`convergence-contract.js` 集中内部状态／版本校验。`store/convergence.js` 负责原子领取、成员唯一 active 归属、generation CAS、节点／发布收据与历史删除保护；技术记录归父，成员／helper ID 不是级联删除依据，新编号快照不回填历史。

运行的 preparing／resolving／awaiting／validating／ready／landing／integrated／failed／blocked／withdrawn／stale 与源预约状态分离。预约 v3 使用 requested／executing／blocked／integrated 等安全投影，generation 是尝试而非 Worker 轮次，不能互换状态或身份。

## Project 归并模块

| 入口（`src/core/project/`） | 长期职责 |
|---|---|
| convergence-policy | 真实目标所有者、挂载／启停／未来默认，revision 与旧验证引用兼容 |
| convergence-queue | 事件驱动领取／准备、固定来源静息与授权守卫、显式重试 |
| convergence-prepare | 叶／双项对象、基线刷新与不可变修复新尝试，区分 Agent／旧命令验证 |
| convergence-land | 新旧队列共用真实父发布门、精确收据、整批结算及一次父 Hook |
| convergence-workers | 仅内部工厂创建 integration、固定上下文／私有 worktree，真实退出才晋级 |
| convergence-safety | generation 先失效再撤回／取消，安全退出后释放来源，未知不重放 |
| convergence-acceptance | 来源全部安全验收后收口 helper、共享资源与部分回收续办 |

入口注册位于 project.js；merge-queue 在真实安全点按目标策略固定 v2／v3，旧请求不转换，关闭策略不撤回已固定交付、不提高合并／验收授权。v3 准备不占父发布执行位，真实／未知发布才冻结父；旧 v2 源侧修复规则不变。

## Git 与隔离验证

`workspaces/delivery-objects.js` 只用固定对象、显式等价／真实多基点 merge-tree／commit-tree，冲突种子保留双输入，不写源／父 ref 或 index。`delivery-publish.js` 核验固定成员与对象，持久精确收据后 CAS 更新目标和 evidence ref，并提供只读恢复证明。`delivery-validation.js` 仅旧命令模式登记精确临时检出，隔离环境／授权、取消／超时／输出限额和受检回收。

Git 创建／回收／真实发布仍串行，Shell 不跨进程持有 Git gate。新请求 `verification_mode:'agent',validation:null`，不造命令 passed 证据；旧 command 的 passed 必须绑定精确候选 SHA／tree，缺损引用不能转免命令路径，不同模式分批。

receipt 固定 parent／baseline／tree／commit／workspace／run／generation、完整成员与 evidence ref／commit。成员树通常不等于批次树；已落地判断、同步增量基点、验收及删除必须用精确成员映射，不能凭树相等或 patch-id 推断。

## 既有生命周期与权限接缝

- 固定来源冻结，追加持久暂存、不混入固定交付；merge.requested 不唤醒父开发 Agent。仅真实／未知发布冻结父。
- 版本图复用纯成员收据核验，v3 组合树和单源树分开；旧协议保留树相等门，固定对象读核验落点／证据与来源祖先。
- 调度／上下文固定 helper 身份与一次性 token；收回 token 和 running 后才接受产物，旧 generation 不推进新尝试。
- integration 不继承源 checkpoint，仅登记私有 worktree，不回落 canonical。Prompt 不是权限门或 OS 沙箱；RPC 默认拒绝，只允许明确安全只读及自身 Notice／进度，见[归并权限](../reference/rpc/convergence.md#专用整合-worker-的-rpc-能力)。策略接口均用户专属。
- 成员／helper／共享证据在用时阻止回收。独立来源可单独安全验收或删除，不连带关闭兄弟指令；批次每成员结算不提高验收授权。一批只触发一次父 worker.merge_received。

HTTP／CLI／Web 只适配[公开接口](../reference/rpc/convergence.md)，不复制调度、授权或证据判断。

## 回归分区

纯规划／契约用 `test/convergence-{plan,contract}.test.js`，Runtime 用 `test/project/convergence-*.test.js`，真实 Git／CAS／收据用 `test/workspaces/convergence-*.test.js`；权限用 `test/integration-rpc-permissions.test.js`，跨层组合用 `test/web/branch-convergence-integration.test.js`、`convergence-automation-integration.test.js`，界面用 `dom-branch-convergence.test.js`。临时项目和受控 provider，不操作用户队列。

分层验证责任见[贡献指南](../contributing/README.md#分层测试与交付)；mock／DOM 不证明实际模型、视觉或吞吐，限制见[首版契约](merge-convergence-implementation.md#限制与验证)。
