# 分支归并实施接缝

本篇固定归并自动化的当前行为与兼容边界（W205、W225／D527、D528）。产品取舍见[归并合并](../design/merge-convergence.md)，模块见[Runtime 地图](merge-convergence-runtime.md)，精确公共参数见[接口参考](../reference/rpc/convergence.md)。代码合入不代表运行中的 daemon／Host 已更新；部署由用户在安全点重启两者。

## 挂载、启停与默认

- 归并是接收成果的**目标 Worker／分支策略**，不是来源 Worker 的自动合并授权。开启 main 只影响之后交付到 main 的新固定成果，不提高任何 Worker 的自动合并／验收级别。
- 实际挂载 `mounted` 与启停 `enabled` 分开。未挂载必须关闭；项目页与 Worker 详情「自动化」操作同一策略与 revision，不保存两份状态。main 初始化时一次性挂载且关闭，其他未配置 Worker 不挂载；移除保留墓碑、历史与旧验证引用，不在读取或重启时重装。
- 项目默认 `{mounted,enabled}` 初始均为 false，只在之后实际创建 order／child 时复制，不从父继承、不回写已有实例。未默认挂载时可以记住开启偏好，但实际实例始终关闭。child 的目标归并策略独立于其锁定的结束自动链。
- 旧已保存策略没有 mounted 字段时视为已挂载，保留原启停、精确验证引用与历史。不批量修改历史行、分支、会话或交付收据；新所有者不继承旧所有者的授权。
- 全部策略操作用户专属；只接受具有唯一活动 main／owner／order／child 所有者的真实本地分支，不接受 SHA、tag、ref 表达式或任意路径。setter 经 Project 写门、Git 串行区、真实目标与 revision 乐观锁；读取不安装配置、不启动 daemon、Agent 或命令。

## 验证责任与在途兼容

新固定 v3 预约明确保存 `verification_mode:'agent', validation:null`，运行 data 保存同一模式。**不要求最终验证快捷指令、不创建命令验证检出、不运行组合 Shell，也不制造 passed 或 tested_commit/tree 证据。** 原开发 Agent 与冲突整合 Agent 负责各自的专项和受影响回归；顶层开发指令的最终集成与全量责任不变。无冲突对象归并不会为了验证额外启动 Agent，准备就绪与落地不能冒充测试通过；来源测试不证明组合语义兼容，这是明确的质量限制。

原有在途 v1／v2 不转换。已经固定的旧 v3 command 请求／运行仍按精确授权指令、撤权／版本戳、隔离检出、最终证据、失败修复与中断恢复门收口；旧引用不会因新挂载默认被静默升级。旧 Shell 上限20分钟、8 MiB输出，只保存安全结果，剥离 invocation/provider 环境；隔离不是 OS 沙箱。

缺失模式只能按合法旧 command 请求处理，未知模式或缺失／损坏验证引用不得成为免命令授权。新旧模式及不同旧指令版本不混批。关闭／移除只影响之后新固定交付，不撤回已有批次、不重放未知副作用。显式重试核验精确 revision、模式、来源、调用退出与待决；旧模式另核验命令授权，landing／blocked 未知现场不得盲重放。

## 固定成果与发布

事件驱动固定1..8名成员及相邻两两平衡拓扑，不等凑满；不实现200ms窗口、动态扩批或阻塞批次内部拆分。无已知依赖的后续批次可绕过失败／待决批次，code 上游必须已落地。项目最多4个非 Worker 准备作业；不设置 Worker invocation 并发额度，同批节点按固定拓扑计算。

准备只生成私有固定对象，不修改源／父 ref，不占父发布执行位。冲突才由 runtime 工厂创建绑定固定节点／generation 的 `integration`，使用登记私有 worktree、父侧运行配置与窄权限；不重挂来源、不接受普通委派或推进源／父分支。Agent 提问后释放调用，未知模型结果不自动重放；产物实际退出并核验后才推进节点。

精确单父候选与完整成员收据在真实发布前固定。新旧队列共用每目标发布门，复核 generation、成员、来源／父 ref、静息、消息、安全冻结、检出与清洁度，再以 CAS 发布。父 tip 变化时重新适配固定组合，自动刷新最多3次，每节点最多2次整合尝试；不覆盖新父树、不丢掉已付费修复成果。发布未知保留写门与现场，仅凭精确收据核验恢复，Git已落地而DB未结算不得重发。

多源落地树通常不等于单源树。后续增量、父同步、版本图、验收／删除必须使用精确成员映射，不靠树相等或patch-id猜交付。每批一次父 `worker.merge_received`，成员各自结算、保留原身份和工作区；归并不批量授权验收。全部关联来源安全验收后，辅助资源才按原安全门收口；部分失败保留诊断与续办入口。

## 方法与安全读面

```js
branchConvergence(branch)
branchConvergenceList()
setBranchConvergence(branch, enabled, validation, expectedRevision, mounted = true)
branchConvergenceDefaults()
setBranchConvergenceDefaults(mounted, enabled, expectedRevision)
branchConvergenceRuns(branch, before = null, limit = 20)
retryBranchConvergence(id, expectedRevision)
```

分支读面为 `{version:1,branch,owner_id,owner_worker_number,mounted,enabled,validation,revision,editable,reason,counts}`。validation 仅为兼容历史的安全引用；setter省略时保留，显式null可清除，开启不要求授权。list为 `{version:1,items,count,truncated,defaults}`，最多500个活动所有者分支、main优先；完整活动counts来自持久事实，不从有界分页或Worker图推导。

defaults 为 `{version:1,mounted,enabled,revision,editable,reason}`。`task.hooks.convergence` 是同源分支安全投影，不加入通用 Hook actions／mounts；非适用、终态或归档身份返回null。同步详情读面不执行Git查询，实际ref被外部删除时保存仍由真实Git目标校验拒绝，不改投其他分支。

runs按运行ID倒序分页，默认20、最多50项；成员最多8个、超限明示。状态、辅助身份、候选与落地提交、失败／待决及旧验证结果可查；新运行validation为null，不宣称最终命令通过。读面不含完整profile、Prompt、env、token、原始Shell输出或内部堆栈。

## Web 与权限

项目「自动化 → 归并合并」管理目标实际挂载／启停、未来默认、活动计数与历史分页。main及其他已挂载Worker详情的「自动化」在折叠时仍显示归并启停；未挂载不显示开关。开启及可能安排Agent的重试同时使用 `agent-call` 与 `agentHelp`，禁用帮助由外层宿主承载，说明批次单提交与费用；关闭不冒充撤回。

失败保留草稿与原revision，过期拒绝后显式重新读取；ACK与后续刷新失败区分，切页／换项目／目标后的迟到响应不覆盖新目标、不自动重发mutation。旧服务缺字段时保守禁用，不推断默认或授权。

所有 `branch.convergence*` RPC均USER_ONLY；HTTP读写保持登录、Origin、no-store、固定项目路由、严格参数与JSON envelope。integration权限仍由Dispatcher默认拒绝的[窄白名单](../reference/rpc/convergence.md#专用整合-worker-的-rpc-能力)决定，Prompt不是权限或OS沙箱。

## 限制与验证

Git须支持实际 `merge-tree --write-tree --merge-base`；不支持则保留失败现场，不静默降级。尚无独立启动能力预检、动态扩批、自动语义风险识别、预算调优、独立贡献撤销或完整归并树仪表盘；不能承诺固定加速或自动保证满足全部需求。

验证使用临时项目、真实HTTP／RPC／SQLite／Git、受控provider与DOM，不操作用户队列或服务。子分区做专项及受影响回归，顶层开发指令收齐最终树后负责集成与完整 `bun run test`，自动合并与CI不代替责任。受控测试不证明真实模型整合质量、浏览器视觉或生产负载性能。
