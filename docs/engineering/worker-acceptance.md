# 验收即归档（W169／用户决定 #418）

本文是统一验收、归档与父级安全批量验收的权威契约。验收不是测试或质量证明；父检查 child 默认不提前回收。

## 用户含义与保留范围

“验收”表示对该 Worker 的工作不再有异议，授权删除其 worktree、本地分支 ref 等开发资源，同时保留可查阅的 Worker、指令、消息、Notice、事件、结果、会话与相关运行文件。它不是质量证明，也不是彻底删除 Worker；不撤销已合并代码或改写 Git 历史。

- 成功交付只有一个“验收”动作，用户与直接父 Agent 确认 child 都采用相同语义。页面仅显示本 Worker 的验收阶段与回收异常，按钮帮助说明“验收即归档并回收开发资源”及删除范围，不再提供仅验收、验收并归档两套入口，也不额外发第二次 branch.archive 请求。
- 失败、取消、历史特殊分支的收起操作称“清理资源”，不伪装为成果验收；保留原失败／取消结果与现有显式丢弃确认能力。
- 验收严格阻止脏工作区，不默许丢弃未提交改动；消息（含暂存输入）、待决、后代、冻结、同步、实际 invocation 退出及交付检查不放宽。
- 归档范围继续沿用受检的分支子树，不删除 canonical 检出或其他 Worker 仍使用的共享资源。已验收／已回收的子 Worker 不阻止父级验收。无代码改动也需回收其开发资源。

## Valet 自身验收（W383／D761）

Valet 没有 Git 分支、没有合并步骤，不参加开发 Worker 自动验收链；只有真实用户能通过同一 `worker.accept` 入口验收其正常返回且安全收口的成果。开发 Agent、普通及提权 Valet 不能验收自己或其他 Valet。失败、取消、急救隔离、未启动／未收口事项、实际 invocation／控制 owner／busy、未读或暂存输入、待决、waiting／running／unknown 副作用与冻结／回收竞态均阻止验收；不能借验收取消排队或在途工作。

验收只回收该身份专属的非 Git 空运行目录；未知文件、符号链接、共享、归属变化或没有精确回收收据的资源缺失均保留并拒绝。保留编号、目标、Message、Notice、Event、结果、Run、执行历史和会话文件，不删除共享时间信号，不连带验收其管理／创建的开发 Worker。验收后拒绝追加、启用和重放，历史只读；旧创建 key 的精确重试只返回原归档身份，不产生新授权。

仅剩尚未触发的未来信号绑定时，用户专属 `worker.accept_preview {id}` 返回 `kind:'management'`、revision、`ends_future_binding`、回收目录及历史保留事实。界面明确显示将结束未来绑定与回收范围后，用户用 `worker.accept {id,revision,confirm:true}` 确认同一精确版本；同一安全操作永久结束此身份的未来授权并归档，不删除共享信号。旧 `{id}` 普通入口仍适用无未来绑定的安全收口 Valet；有未来绑定时拒绝静默解绑。Valet 不支持 `worker.accept_force`，开发 Worker 原强制验收与自动链授权不变。

`task.acceptance_started` 固定 `kind:'management'`、task／occurrence 与专属目录设备／inode；未来解绑与开始证据同事务保存，完成回收后才写 `task.accepted`。失败记录 `task.acceptance_failed`，禁止追加或启用；显式续办只接受同一固定身份与仍在原位的空目录，不从目录缺失猜成功，daemon 重启不自动重放删除。验收不挂载开发 `worker.accepted` 自动链。`management` 公开投影提供当前 `accepted/archived/acceptance_recovery/can_accept/acceptance_reason/requires_confirmation`，详情与图共享 `iterationControls`；`completed` 本身从不证明已验收。

## 父级安全批量验收（W197／用户决定 #462）

- 父 Agent 必须检查子成果、测试及交付事实，完成集成验证；不得仅因合并成功、本轮交付或准备收口就逐个验收 child。默认保留 `awaiting_acceptance`、分支、worktree 和会话，后续需求通过 `worker.message` 交给同一个 child。
- 用户验收父 Worker，或父 Worker 按用户已授权的自动到验收流程执行时，同一安全动作可纳入已交付的多级派生 child 委派链。用户独立创建的指令不被连带验收；失败／取消后代沿用原维护语义，不冒充成果验收。
- 全批次仍检查实际调用退出、交付预约、未读／暂存输入、待决、脏现场、未交付提交、冻结、同步及共享资源。活动或尚未交付的后代仍阻塞；不是仅将待验收状态视为终态。
- 单独提前验收 child 只应在用户明确要求回收，或整个相关目标已稳定结束、不会再追加工作且确有回收必要时考虑。有疑问就保留；父 Agent 只能将自己的直接 child 作为单独验收目标，不扩大指令／自己／兄弟的权限。
- 批量回收成功后才结算本次纳入的 child、记录逐 Worker 验收与父级批次来源。部分失败保留精确批次收据，显式续办，不因目录缺失猜成功；残缺批次不能接收追加开发输入或另行验收绕过根批次恢复。

## 运行时与失败语义

用户项目管理 CLI 为 `lush worker accept ID`，直接父开发 Agent 使用 `lushw children accept ID`；原验收安全门不变。Valet 跨树验收按最新管理权限经同一统一动作入口复核安全门；设为 confirmation 时必须持久预检并由用户精确确认，默认 automatic 不额外要求逐次确认，授权与恢复见[Valet 契约](hook-signals-management.md#开发能力的受控代理)。

`acceptTask` 是统一动作的权威入口。Git 操作串行执行，资源检查与删除过程中复核身份、消息和授权；不能在仍活跃的 invocation 中删检出，也不能通过嵌套排队造成 Git gate 死锁。

只有回收成功才宣称此次统一验收完成并发出 `task.accepted`／`worker.accepted`。受检回收使用 `task.acceptance_started`、`task.acceptance_failed` 审计；旧已验收记录补办成功写 `task.acceptance_reclaimed`，不重写旧验收事件。父级批量 `task.acceptance_started` 收据固定 `accepting_task_ids` 与 `rows`，成功子验收带 `via:'parent_acceptance'`、`acceptance_root_id`、`delegator_id` 和共享 `acceptance_execution`，可追溯确认来源但不冒充 child 独立获得自动验收级别。`branch.archive.outcome` 逐资源持久保存 `{acceptance_execution,outcomes}`，`branch.archive.outcomes` 保留原总账；单项回收事实不是整批验收成功。资源删除部分失败时逐资源保留磁盘事实、诊断及可继续的审计，不把 partial/unknown 冒充成功；恢复依据精确持久收据，不靠目录不存在猜测，不因 daemon 重启自动重放未知删除。显式重试须能续办失败范围而不重新删除已完成资源。

inspect／graph 同源增加 `acceptance_recovery:boolean`：仅据当前轮未完成验收的精确持久 started/failed 审计投影，不凭目录缺失猜测。true 只表示可显示显式续办候选，实际请求仍复核安全门；根资源已删除而后代失败时不应被普通已归档过滤隐藏或由 workspace 缺失禁用。

历史 `completed` 不能仅凭状态推断已验收；历史真实验收但尚未归档的记录允许显式补办资源回收，不改写旧事件。无需新核心实体。内部 branches.archived 与历史事件名可保留，公开说明解释它是验收后的资源状态，而非另一个成功流程步骤。

## 用户显式强制验收（W318／D682）

普通验收默认保持全部未读检查。用户可在未读阻塞后选择次级「强制验收…」，先预检列出终态 Worker 的系统通知、失败／取消状态及资源回收范围，再二次确认；不调用 Agent。强制验收只保留用户 Web／RPC；CLI `worker accept` 仅普通模式，开发 `children accept` 也不提供 force。RPC 为 `worker.accept_preview {id}` 与 `worker.accept_force {id,revision,confirm:true}`；两者均用户专属，不开放给开发 Agent、Valet 或自动 Hook。

仅允许跳过有精确同收件箱 `task.signal` 来源证据的已结算通知，且接收 Worker 必须是 completed／failed／cancelled。未知类型、修复／合并请求、普通消息、用户追加、暂存输入和待决问题不放行；运行退出、脏现场、未交付改动、在途预约／冻结和共享资源检查全部保留；[已退役远端 Worker](execution-model.md#单机执行与执行节点退役) 即使显式强制验收也必须拒绝。具体可跳过类型由 `project/acceptance-force.js` 单点定义。

预检只读，revision 固定子树身份、未读内容和资源元数据；执行重检 Git、范围及每条精确通知，新增输入或范围变化须重新预检确认。原消息不标为 consumed，也不伪装成 Agent 已处理；`task.acceptance_forced` 记录用户确认的 revision、通知身份及关联 `acceptance_execution`，只有完整回收后才记验收成功。失败／取消后代保留原结果与状态；部分回收沿原精确收据续办，但须用户重新预检确认，普通验收／自动链不继承强制跳过权限。预检不是业务质量证明，也不保证后续执行必然成功。

## 自动链兼容

用户明确授权旧“自动到验收”直接采用新语义，包括已有 Worker 和设备默认流程。新界面只有关闭／合并／验收三个最高环节；验收包含资源回收，启用须说明删除范围与安全限制。

旧存储/API 的 `archive` 值继续兼容作为 `accept` 的等价授权，不机械改写历史记录；公开读面宜规范为 `accept`，旧私有执行收据与未知结果仍须尊重，不得因此绕过恢复检查或重复执行。旧自动归档已授权行为保留。旧已验收未回收的 accept 授权可安全补办回收；失败/unknown 不自动重试。

child 的配置仍锁定、默认自动合并，由直接父 Agent 检查成果，但默认保留待验收现场供追加需求；检查通过不等于立即执行验收回收。父级验收可安全纳入已交付的派生 child，不把子 Worker 提升为自动验收，不继承父授权。Agent 不可修改结束级别。开发 Worker 的 `worker.accept` 参数继续为 id（Valet 未来绑定确认扩展见上），`branch.archive` 保留低层／特殊现场清理兼容入口，CLI 文案解释统一语义。

## 分区与验证

统一入口位于 `project/iteration.js`，Git 回收经 Workspaces；Web 共享验收控件普通验收只发 worker.accept，强制验收先预检确认再发 worker.accept_force，均不串发 branch.archive。接口与职责定位见[模块地图](modules.md)。

实际验证手动／父 Agent／自动验收、无改动回答、旧 accept/archive、已验收未清理补办、dirty／消息／待决／后代／共享资源／冻结／同步阻塞、删除部分失败及重启 unknown、保留运行会话与结果、UI 单动作失败保护、迟到响应和费用标识。全部测试使用临时项目／设备根，不重启用户 daemon/Host。

## W169 验证记录

保留此历史入口。当前仅在 `test/project/merge-queue.test.js` 保留正常交付后的批量验收冒烟，不再保留独立 HTTP／DOM、恢复与回收失败组合；覆盖取舍见[贡献指南](../contributing/README.md#覆盖取舍)。历史通过数与失败日志留在 Worker／提交记录，不证明当前树。运行历史保留不承诺备份、安全擦除或 Git 对象永久保留。

### 固定父基线修复（交付 15152／尝试 15155）

一次性自定义 Hook 成功退役不影响持久内置合并／验收 Hook，验收后通知仍执行、审计保留；生命周期兼容须由受影响回归验证，不能仅以 Git 无冲突判断。
