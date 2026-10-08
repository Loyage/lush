# 时间信号与管理型 Worker

本章是用户追加需求与决定 #270 的实现契约，补充 [Hooks 接缝](hooks.md)；设计入口是 [Worker Hooks](../design/hooks.md)。先前决定 #266 的一次性／每日、显式时区、停机错过跳过、已提交项等待安全点和未知副作用不重放继续适用。

## 产品和授权

Hooks 页面增加两个独立区域：时间信号、管理指令。用户保存具名时间信号（例如「Codex 额度更新时间已到」），创建管理型 Worker，写「开始 Wxx」／「重试失败的 Wxx」，选择信号及一次性／持续绑定。一个信号可绑定多个管理 Worker。默认一次性；创建、绑定不调用 Agent，信号到来才持久排队，不保证 Agent 准点获得槽。默认开发输入框、order.submit 和开发 Worker 流程不变。

信号只说明时间已到，不是实际额度恢复的观测，不自动查询／切换账号，不跨项目、不启动停止的 daemon。管理 Worker 的模型／来源由用户明确选择或创建时冻结项目管理角色有效默认；不把目标 Worker 的 Codex 账号自动当作管理 Agent 的来源。

用户决定 #270：管理型 Agent 首版仅可查询当前项目、开始／继续 paused 的开发 Worker、重试 failed 的开发 Worker。目标可为当前项目任意 order/child，不限父子，但不得复活 completed/cancelled、已验收／归档或祖先关闭的任务。不增加追加输入、创建开发任务、取消、中断、合并、验收、归档、删除、配置账号／Hook／服务的权限。

## Worker 与执行隔离

管理工作仍用 Worker / Run / Artifact / Message / Event，不新增核心业务实体。新记录 role='manager', task_kind='management'；指令放 goal，不伪造开发 Input，不建立 Git 分支，不加入自动合并／验收链。management Worker 可以没有 worker_number，Hooks 卡片按名称与内部 ID 定位；普通目标的 W 编号解析规则保持不变。

Workspace 是项目 .lush 下专属 management 目录，不是 canonical 项目或任意开发 worktree。Workspaces.ensure/finish 明确识别此类型，不跑 Git clean/commit。Provider 使用独立 manager 提示词、独立会话，不能继承开发提示词、项目 AGENTS 或分支 checkpoint。管理调用只使用可信的查询／开始／重试工具；不加载用户扩展／skills、不提供 read/bash/write/edit 或任意 Shell 工具，运行时扩展的连接观测／安全停止接缝保留。没有专用受限工具适配的旧 Codex CLI 后端拒绝管理调用；Pi 中使用 Codex 模型／连接不受此限制。mock／可控测试 provider 可用。

管理 Provider 不读取 Lush 公共／角色 env 文件，也不注入继承或显式 profile.env；机器运行环境、项目出站网络策略和所选托管连接的必要管道仍保留。管理提示词忽略开发 Prompt 补充和覆盖，普通开发调用的环境继承不变。

这是工具和 RPC 能力隔离，不声称提供操作系统沙箱。普通开发 Agent 的权限、USER_ONLY 方法以及每轮 token 的 hash / running / abort 核验保持不变。管理方法要求合法 invocation actor 且 role/task_kind/绑定/当前 occurrence 全部通过后端核验，不能靠 Prompt 宣称授权。Dispatcher 按 Store 中真实管理身份把该 token 可调用方法严格限制为 manager.query/start/retry 与 worker.lookup，不能借普通 Agent 可用的 notice/progress/message 等方法扩权。

## 数据与时间

项目时间信号采用 meta 中 versioned JSON 附属配置，管理绑定／occurrence／受控动作收据采用 tasks.management 附属 JSON。不改写历史行／分支。最多 64 个信号、64 个启用管理绑定，每个 occurrence 最多 32 项动作；信号库与单 Worker 私有状态分别最多 128 KiB，管理列表最多 512 KiB。revision 与运行动态分离，读取无副作用。

信号定义 `{id?:UUID,name,enabled?:boolean,schedule}`，schedule 复用 normalizeHookSchedule / nextHookRun。一次性创建／改时间／重新启用须在未来；已错过或已发出的同一一次性规则不能靠回拨重放。每日 DST 重叠取首次，缺失跳过。停用／停机未提交过期项不补跑。一次性信号显式改为新的未来时刻时保留旧发出历史，但旧历史不消费新时刻；仍不重放已消费的绑定，需另建管理指令或使用此前授权的持续绑定。

到点事务持久 Event occurrence 并给当时已启用的绑定投递。绑定最多一个未结算 occurrence，忙时后续每日信号不堆积；不同绑定独立。注册／新启用绑定不订阅旧历史。管理调用和受控动作各自有持久身份；同 occurrence、动作、目标去重。持久提交但尚未开始模型的项重启后仍可排队；已启动模型／未知动作不自动重放，留 failed/unknown 诊断并停用绑定。可证明完成的动作使用精确收据收口。

持续绑定每个 occurrence 使用同一个管理 Worker，但不并发启动，等待上轮实际退出与未完成动作收口。一次性绑定执行后停止。失败不以新一天为理由自动重试。停用撤销未开始的未来／待执行授权，不撤销已完成操作；运行中停止绑定不强杀 Agent，但拒绝后续新管理操作。重新启用不重放 consumed / unknown 的 occurrence。

临时冻结、同步、清理、正在退出的旧目标调用只阻塞受控请求。管理工具返回已提交待安全点，不要求模型等待／轮询；后端持久请求在首个安全点执行，不再次调用模型来重发。目标状态不适用／永久不可用记录 skipped。安全门通过后动作异常不是可自动重试的临时 gate。开始／重试沿用目标已保存配置，不接收 profile、不切账号；仍通过原生命周期入口。

## 接口（父负责适配）

`hooks.list` 保留既有字段，新增：
- `signals:{version:1,revision,items:[{id,name,enabled,schedule,next_run_at,last_due_at,last_execution}]}`，只读安全投影。
- `management_workers:[{id,name,goal,goal_truncated,goal_length,status,management,model_selection}]`，最多 100 个管理摘要，启用绑定优先且全部可见。goal 最多 160 字符，name 最多 64 字符；pending_signal / last_execution 各显示至多 2 项动作并提供 `actions_count/actions_truncated`。过长目标 W 编号置 null 并提供 `target_worker_number_truncated`，不得截成另一个合法编号。详情 inspect 保留完整指令与至多 32 项安全收据；management 是安全对象，含 `version,revision,signal_id,mode,enabled,can_enable,state,pending_signal,last_execution,reason`；`can_enable` 明确是否可重新启用授权，已消费一次性／failed／unknown 等不可启用，模型／来源仅安全摘要，不含完整 profile/env/Prompt/凭证。pending_signal / last_execution 暴露 due_at、occurrence id、结果、安全原因及受控动作结果，不含任意原始错误。

用户专属 RPC／POST action：
- `hooks.signal_save {signal,expected_revision}` → Project.saveHookSignal(signal,expectedRevision)，返回 hooksList。
- `hooks.signal_remove {id,expected_revision}` → Project.removeHookSignal(id,expectedRevision)，返回 hooksList。已启用或尚未收口的绑定引用时拒绝移除；已停止的 failed/unknown 历史诊断不永久锁住信号，保留可读历史。
- `management.create {name,instruction,signal_id,mode?,profile?,client_request_id?}` → Project.createManagementWorker(options)，返回 `{task:安全 Worker}`。默认 mode='once'。profile 是写入私有设置，读取裁去；保存失败保留编辑内容，禁止立即调用 Agent。可选 client_request_id 是去重身份，非空、trim 后不变、最多 128 字符、无控制字符；Web 每份表单固定一个 key、失败重试不换 key。同 key 同原提交定义（省略 profile 仍视为原始省略）返回原 Worker，不因 signal 已发出或默认来源变化而重建；同 key 不同定义拒绝，并发／重启后保留去重。定义 fingerprint 与 key 放私有附属状态，不作为授权。mutation 已成功而后续 refresh 失败必须显示成功／刷新诊断，不能自动重做创建；无 key 客户端收到未知断连须先检查历史，不盲目重试。
- `management.binding_update {id,enabled,expected_revision}` → Project.updateManagementBinding(id,enabled,expectedRevision)，返回安全 Worker。用于停用／重新启用授权；已 consumed 的一次性或 unknown／失败必须另建管理指令，不借启用重放。

专用 Agent-only RPC（只由受限管理工具使用，不为 Web 或普通开发 Agent开放用户方法）：
- `manager.query {id?}` → Project.managementQuery(actorId,id?)。无 id 返回有界当前项目目标摘要；有 id 返回单目标安全诊断。工具层可用既有 worker.lookup 将 W 编号解析为整数 ID。
- `manager.start {id}` → Project.requestManagementAction(actorId,'start',id)。
- `manager.retry {id}` → Project.requestManagementAction(actorId,'retry',id)。

受控动作返回 `{status:'succeeded'|'waiting'|'skipped'|'unknown',target_id,target_worker_number,reason?,receipt_id}`（尚未创建新动作的校验失败可拒绝）。成功仅表示生命周期操作已提交／排队，不冒充目标业务成功或额度已恢复。每项操作先记录授权、触发身份和收据，禁用后拒绝新操作。

普通 worker.inspect 及所有公开 RPC/HTTP 出口不得泄漏字符串 management 私有 JSON 或 retry_profile。管理型 Worker 在 Hooks 页面显示历史／结果入口，不假装有分支可合并。配置 revision 不因时钟 tick 变化而让未改配置的表单失效。跨项目迟到响应使用现有 Hooks 页面项目身份守卫，不串页；延迟安排 Agent 的按钮使用 agent-call 与 agentHelp。

## 实施分区与验证

- Runtime 子 Worker：core/project management + signals、统一有界 timer、恢复、调度／生命周期／Workspaces、Store 新附属列和安全 projection、必要管理读面，runtime tests；不修改 agent/provider/prompts/settings、RPC/CLI/Web、文档。
- Provider 子 Worker：manager Prompt、role/settings、Pi 可信受限工具扩展和 provider 参数隔离、Provider/Prompt tests；不修改 core/RPC/Web/文档。先读 Pi 扩展文档及交叉参考；SDK extension 只用项目可信代码，不引入 daemon/CLI 运行时依赖。
- Web 子 Worker：Hooks 信号编辑与管理指令创建／停用／状态／历史入口、DOM tests；不修改 core/agent/RPC/CLI/文档。使用本契约字段和上述 action。
- 父 Worker：RPC／HTTP／CLI入口适配、文档／模块地图、跨区集成测试及最终验证。

测试只用临时项目、mock／受控 provider，不调用真实模型、不重启用户服务。覆盖时间提交、共享信号、一／持续、忙时单项待执行、停止／重启／unknown、重复动作、冻结后安全执行、失效目标、非法 Actor／旧 token、开发输入无变化、私有投影、页面迟到响应和按钮标识。真实 Codex 额度恢复、真实模型理解自然语言及真实浏览器行为另行验收。
