# Valet 权限与诊断扩展评估（待批准）

本文是 W362 对当前项目的方案评估，不是扩权授权或已实现契约。用户澄清的目标是：**让 V16 自己通过可信管理入口读取 V15 的必要诊断证据并分析，不依赖开发 Worker 代查转述，也不另建诊断 Agent。** 结论基于代码基线 `c508db6ca63dc780b81f95d2bcd2bf153e1e9577`；现行权威仍是 [Valet 管理契约](../engineering/hook-signals-management.md)。本次不修改权限、提示词、bridge、配置或历史，不恢复／重放 V15 的未知请求。

## 1. 结论与证据范围

**推荐在现有 Valet 中实现直接、受控的跨 Valet 只读诊断。** “V16 读 V15”并非完全缺失：当前代码已允许同项目管理身份读取另一 Valet 的元数据、调用摘要及已知收据的安全时间线；没有仅可读自身收据的限制。真正不足是可供 V16 推理的具体抛错位置、可信细分类、历史检查点及业务完成关联，不是把所有用户权限打开。推荐补精确诊断索引、源侧安全采样与按目标／用途授权的证据包，由固定 lush_cli 直接返回给 V16 的模型；不默认采用开发 Worker 转述、用户手工转贴或独立 Agent。

本次核验的是仓库实现及隔离测试，不是生产权限配置或运行进程版本。未读取设备私密设置、认证、私有提示词、原始会话或真实项目数据库，未调用 Host／设备管理，也未查询或处置真实 V15／W360。背景收据事实来自任务提供的可信元数据，不冒充本次独立取证。

| 依据 | 实际核验内容 |
| --- | --- |
| [设计：Hooks](hooks.md)、[公共管理契约](../engineering/hook-signals-management.md)、[RPC](../reference/rpc/hooks.md) | 默认开放、精确确认、隔离、收据及恢复语义 |
| [`management-policy.js`](../../src/rpc/management-policy.js)、[`management-permissions.js`](../../src/core/management-permissions.js) | 方法审核上限、默认、实时配置、私有字段拒绝、设备作用域 |
| [`catalog.js`](../../src/cli/catalog.js)、[`management-cli.js`](../../src/agent/management-cli.js)、[`pi-management.js`](../../src/agent/pi-management.js) | 命令静态准入、真实处理器、唯一工具、预算及固定身份 |
| [`dispatcher.js`](../../src/rpc/dispatcher.js)、[`management-code.js`](../../src/core/project/management-code.js)、[`management.js`](../../src/core/project/management.js)、[`management-auth.js`](../../src/core/project/management-auth.js) | 真实 actor、受控代理、Worker 元数据投影、跨目标查询与读取者的活跃身份校验 |
| [`诊断协议`](../../src/core/management-diagnostic.js)、[`收据`](../../src/core/project/management-receipt.js)、[`调用审计`](../../src/core/project/management-calls.js) | 固定白名单、关联时间线、首次失败和历史缺证据 |
| [`management-control.js`](../../src/core/project/management-control.js)、[`merge-conditions.js`](../../src/core/project/merge-conditions.js) | 执行边界与 catch 分类；条件合并的业务校验和事务 |
| [`invocation-error.js`](../../src/agent/invocation-error.js)、[`provider.js`](../../src/agent/provider.js) | Provider 启动错误类别与管理工具／资源隔离 |

历史核对：W316 对应的默认开放已见于当前实现和提交 `c321a24`；W343 对应的结构化诊断已见于当前实现和提交 `bc8c2ab`，不是待从零建设。W341 的独立设计结果没有随本次上下文提供，也不在本开发 invocation 的直接父子读取范围；未换管理入口读取它，不能断言其独立诊断角色已落地。当前实际注册与 Provider 路径仍是受限 Valet。上述核对不等于审阅过这些 Worker 的全部历史或核实了生产部署。

## 2. “全部权限”的能力矩阵

必须分开四层：**真实工具／命令可达性 → 方法实时授权 → 数据投影 → 原业务安全门**。静态目录、默认权限、实际配置和本轮执行授权不是同一个事实。

静态枚举当前 202 个注册方法的审核策略：49 read、75 automatic、1 confirmation、77 unavailable；其中分别有 35、55、1、0 个方法被 Valet 静态 CLI 叶命令声明，Valet 视图共 98 个叶命令（含 help）。这只是代码级声明可达性，不证明每条命令的参数模式、前置读取及真实目标均可执行；内部 manager 传输也不按独立业务能力计权。每次调用仍须重检最新权限。

### V16 现在已经能直接读 V15 什么

以下是代码及隔离真实链路验证出的能力，不是本次实际访问 V15 的结果；生产是否可用仍取决于部署版本、V16 的有效 invocation 和最新逐项权限。

| V16 的固定 lush_cli argv（示意） | 已有结果 | 读不到什么／注意事项 |
| --- | --- | --- |
| `["worker","show","V15"]` | 身份、状态、goal 摘要及安全 management 对象；pending／last occurrence 的安全 control_calls 含收据 ID、方法和诊断 | 不是全部历史、原错误或私有 management JSON；某项缺失不证明从未发生 |
| `["valet","context","show","V15"]` | 指定目标状态、安全摘要和开始／重试门禁原因 | 不是异常证据包；“该目标不可开始／重试”不表示禁止读其历史；无 ID 的查询列表主要列开发目标，不能代替显式 V15 查询 |
| `["valet","context","history","--worker","V15"]` | 有界 Run 状态、耗时、模型、事件数量 | event_count 仅按 Run 时间窗统计，不是调用因果关联；没有完整参数或错误正文 |
| `["worker","events","V15"]`／`["worker","transcript","V15"]` | 事件 ID／类型／时间及步骤元数据；按真实游标续读，可发现旧收据锚点 | 无事件 data、步骤正文、工具参数／输出；不是“管家完全不能看另一管家的执行记录”，而是只能看元数据 |
| `["valet","receipt","show","45440"]`（也可用已知 call 45439） | 同项目任意管理身份所拥有的合法收据；原错、安全关联时间线和后续处置 | 当前 management.receipt 由锚点找到源 Valet，没有 actor=source 限制；仍无具体异常消息／抛错点，也不提供全量用户审计流 |

已有真实通路是 `V16 模型 → 唯一 lush_cli → 真实 CLI/parser → manager.call → 当前权限／actor 校验 → V15 的安全投影／收据 → V16 工具结果`，不是 V16 调用 lushw 的开发父子接口。读取者必须是有效活跃的 Valet；源 Valet 可以已失败或 isolated，无须启用、恢复其 invocation 或复用其授权。原收据 correlation.actor_id 指 V15，本次只读调用的外层审计 actor 指 V16，二者必须分开。项目串行执行位仍不放宽；若 V15 仍占位，V16 无法靠诊断自行抢占／救援，应交用户原急救流程处理。

| 能力 | 当前默认／可达性 | 仍需保留的边界或缺口 |
| --- | --- | --- |
| 状态、列表／树、详情、历史与单收据 | read；status、worker、valet 相应读命令 | 当前项目安全投影，具体跨 Valet 范围及缺口见上表；不是全会话／全项目审计 |
| 项目运行诊断 | read；`project diagnostics` | token／估算费用速率及覆盖说明，不是异常日志或 Host 全局诊断 |
| 草稿、开发指令、消息、派工 | automatic；input/order/worker 命令 | 生命周期和真实目标复核；spawn 须明确活动开发父；可能调用模型、产生费用 |
| 暂停、继续、重试、取消 | automatic；对应 worker 命令 | 继续／重试经受控动作引擎；未知副作用不重放；请求停止不证明实际退出 |
| 合并请求、条件合并、同步、验收 | automatic；worker merge/sync/accept | revision、冻结、Git、交付和资源门不豁免；不证明目标业务完成 |
| 彻底删除 | automatic；先 delete-preview，再 delete | 即便 automatic 仍须原接口的精确 revision、`confirm` 及归属保护；不等于额外逐次用户 Notice |
| 注册 Shell 功能、固定版本挂载 | automatic；automation register、worker automation attach | 先登记再独立挂载；不得用两步合规推导命令内容安全，见下节 |
| 自动链、普通 Notice 答复 | automatic；现有相应命令 | child 流程锁定；不能批准管家授权 Notice 或借自动答复代理用户授权 |
| 模型／来源、观测与支持的配置 | 安全读取 read，刷新／配置写 automatic；agent/config 命令 | 刷新可联网，不证明额度恢复；设备操作须本轮指令与 device scope 明确，拒绝私有 env／Prompt／认证字段，不热换当前调用 |
| 项目维护暂停／恢复、受控停止 | automatic；project pause/resume、daemon request-stop | 不是本地 daemon start/restart、Host 控制或操作系统进程工具 |
| 修改管家权限 | **confirmation**；config valet-permission set | 唯一默认 confirmation 业务项；真实用户批准精确旧值／新值／全局 revision；本次不调用 |
| 任一普通写能力被用户收紧 | confirmation 或 unavailable | 需确认时真实用户精确批准；禁用时不能由 Agent 自改；已开始操作不回滚 |
| 图、部分高级统计／旧维护功能 | 例如 worker.graph 为 read、worker.cleanup 为 automatic，但无当前 Valet CLI | 工具缺失／CLI 精简，不是权限不足；不可绕成 raw RPC，逐条证明必要性后另行批准恢复窄命令 |
| 管家全量调用事件流、急救、强制验收 | worker.management_calls、management.emergency_*、worker.accept_force 等 unavailable | 用户专属；普通管理代理不能复用用户入口；急救不交给被救身份 |
| 原始会话、完整运行配置、私有环境／Prompt、认证及设置迁移 | unavailable 或无工具 | 保护边界，不列为默认待开放的“缺失功能” |
| 自建／续轮其它管家、跨项目、任意文件／Shell、Host 控制、退役入口 | 不开放或无入口 | 不以放宽权限恢复；管理 token 不能变用户身份或永久凭证 |

### 必须正视的间接执行权

无 `bash/read` 工具并不代表 Valet 无法造成操作系统级副作用：当前允许登记 Shell 指令并挂到合法节点，实际以 daemon 用户权限运行，**不是 OS 沙箱，也不保证只访问当前项目**。现有真实链路测试实际执行固定 Hook 命令，证实这不是文案上的能力。提交开发指令／派工也会把工作转交给具备开发工具的 Worker；它们有自己的身份和范围，但不是靠管家 Prompt 就能保证的安全沙箱。

因此不建议再增加任意执行入口；更不应借 Hook／开发 Worker 读取受限诊断、私密材料或代批授权。后续若用户希望加强而非放宽控制，可单独批准将 Shell 注册／挂载及破坏性管理收紧为 confirmation，或设计受审命令模板与执行隔离；**这是产品取舍，本次不修改 W316 的默认**。只收紧 register 不会阻止既有定义被挂载；还要评估 command_save、功能版本编辑、挂载／启用、已有运行和开发委派等完整调用链，不能宣称一个开关就阻断所有间接执行。

## 3. 缺口分类与路径比较

五类缺口不可互相替代：**工具缺失**补窄命令而非 raw RPC；**投影裁剪**审核新增字段而非把 read 当全文；**授权不足**经真实用户精确确认而非自补指令；**分类不足**在失败源采样而非增加写权；**历史缺证据**明示不可追溯而非重试或邻近时间猜配对。

| 路径 | 收益／必要性 | 风险与相对成本 | 建议 |
| --- | --- | --- | --- |
| A：现有 Valet 增加脱敏分类 | 对所有未来失败有效，不增加私有读取；最直接补 V15 类缺口 | 低至中；需贯通业务错误、收据、双端协议和 UI，误分类有安全风险 | 首先做 |
| B：现有 Valet 直接跨 Valet 诊断 | V16 直接获得 V15 的安全证据并推理，无需开发 Worker／用户转述 | 中；需区分读取者／被诊断者／业务目标，限制聚合和增强授权 | **主路径**；复用现有跨身份收据读取，补诊断索引、采样与证据包 |
| C：独立只读诊断角色 | 可与可写管家隔离，但不是用户此次要求的能力 | 高；需新角色准入、调度、token、会话、权限和交付；仍共享 daemon 故障域 | 不纳入本次实施建议，仅保留为比较项 |
| D：全部用户权限／任意 Shell／私有会话 | 能扩大观测，但仍不能补回从未保存的错误 | 极高；凭证、跨项目、删除、代批和提示注入风险，违背现行隔离 | 不推荐作为诊断方案 |

A 与 B 必须结合：只有读取接口而没有源侧采样，V16 仍只能重复“底层原因未分类”；只有采样而不送入 V16 的实际工具结果，也不满足自主诊断。用户鉴权 Web 可保留同源安全读面供人工核对，但不是要求用户代取证再转述的主流程。

## 4. 推荐接口与权限设计（均未实施）

### 阶段一：记录足够细、但不多泄漏

保留现有 `stage/code/effect/evidence/original_failure/correlation/disposition` 语义；另设计版本化 `failure_detail`，仅含固定枚举，例如 `category: revision_conflict|lifecycle_gate|dependency_gate|resource_gate|storage_io|provider_transport|internal_error|unclassified`、code-owned `site_id` 和固定恢复说明。不包含 Error.message、stack、任意 cause、路径、参数值或原始返回。

分类必须由可信业务错误类型／代码拥有的抛错点产生，不能把模型可控的 Error.code、任意字符串或正则命中当可信来源。以条件合并为首个纵向切片：给每个关键 check 及辅助函数失败源分配固定 site_id，例如 `merge_after.revision_matches`、`merge_after.source_editable`、`merge_after.delivery_editable`、`merge_after.dependency_eligible`、`merge_graph.acyclic`、`merge_after.transaction_save`；同类多个 check 不共用一个模糊“生命周期失败”。保存代码构建标识、失败 site、已通过的固定检查点和首次安全类别，再经控制引擎／收据／bridge 送给 V16。必要谓词只给固定布尔值（如 revision_match:false），不返回实际 revision、完整 conditions 或原始入参。点位名称是设计示例，不是本次 V15 的已采集事实。

可信 site_id 足以把未来已覆盖的业务拒绝定位到对应构建中的具体校验路径，无需开放原始堆栈；对未覆盖的内部异常，最后成功检查点只能缩小区间，不能承诺精确 throw 行或完整调用栈。未知类别仍明确 unclassified；不把自造 stack、Error.code 或当前状态当历史证据。

**错误类别不决定副作用确定性。** 即使分类为 revision_conflict，若已越过管理 dispatch 边界，外层仍为 unknown；只有业务层可验证的无副作用边界或独立持久完成凭据才能进一步收窄。不得把同一个错误文本映射成可重试授权。原始分类与首次失败一起固定，隔离／停用只改 disposition；事务／Event 写失败不得伪造已记录的身份或完成证明。

Provider 启动类别已有单独实现；此处重点是管理 handler 失败，不用“Pi 扩展错误”解释所有 execution_failed。可增加固定代码构建标识与协议版本以定位部署差异，不返回安装路径、环境或完整依赖清单。条件合并等写路径还应在原事务内将业务 Event（例如 merge.conditions_configured）与真实 capability/call/occurrence 关联，诊断包仅返回经校验的 operation_event_id 和该方法的完成范围；不输出条件正文或参数指纹，不靠同目标、同 revision 或相近时间猜测。没有该关联的旧记录继续 unknown；关联配置提交也不证明后续合并已落地。

### 阶段二：只读诊断包与按需授权

建议复用 Event、Notice 和管理附属状态，不新建日志／授权核心实体。以下是**当前项目跨 Valet** 接口提案，不是现有可执行命令；批准后须贯通同源注册、schema、目录、固定 CLI、Provider 和模型实际工具结果。actor 永远取真实 V16 token，不接收 requester 参数或 V15 的身份凭据。

| 提案接口／固定 CLI | 权限粒度 | 数据／行为 |
| --- | --- | --- |
| `management.diagnostic_index {target_id,purpose,method?,before?,limit?}`；`valet diagnostic list V15 --purpose failure_analysis` | read；交集检查 worker.history、management.receipt 等对应源权限 | 定位 V15 的历史安全锚点：receipt/call/run/occurrence ID、已注册 method、固定状态、时间、可用证据段；不转发全量 worker.management_calls，不枚举原始事件正文 |
| `management.diagnostic_bundle {target_id,receipt_id,purpose,after?,limit?,grant_id?}`；`valet diagnostic show V15 --receipt 45440 --purpose failure_analysis` | read；基础包仍取当前各源权限交集；增强段另需 grant | 检查 receipt 真归 V15；返回精确关联的原错／安全类别、已采集的 site/build/checkpoint、业务证据、后续处置、来源与覆盖；不因聚合绕过被禁用的源方法 |
| `management.diagnostic_request {target_id,receipt_id,purpose,sections,expected_revision}`；`valet diagnostic request V15 --receipt 45440 --purpose failure_analysis …` | 固定 confirmation／unavailable，不可 automatic | V16 申请该 V15 收据的增强段，发布自身精确用户确认；批准前不读取额外材料，不重启 V15 或另建 Agent；revision 是诊断预检版本，不是 merge 条件 revision |
| 用户侧批准／撤销 | 用户认证入口，Agent 不可代理 | 锁定项目、读取者 V16／其本轮 occurrence、被诊断者 V15／原 run/occurrence、收据、字段集、用途、期限及预算；撤销与读取准入同锁／事务排序 |

`purpose` 首期仅接受固定枚举 `failure_analysis`；method 只接收已审核方法枚举，初期聚焦 worker.merge_after。target 必须是当前项目 management 身份；业务目标 W360 由该收据的可信关联取得，不能由 V16 任填或扩成 W360 的完整数据读取。省略 target、锚点归属不符、跨项目、任意字符串／字段均拒绝；游标绑定 source／receipt／purpose／授权，不可换目标续读。

结果建议为 `{version,reader,subject,anchor,evidence,timeline,coverage,missing_sections,collected_at}`：reader 是 V16，subject 是 V15，anchor 固定原 call/run/occurrence/receipt；每个 evidence 项附 source_event_id、evidence_kind 和采样时刻，original_failure 与当前 disposition 分开。固定 site/build/category 属于获批后的安全收据字段；增强段可含收据关联的当前业务门禁谓词、交付状态及 provider_cleanup/control_owner/control_busy 固定布尔和计数。各项区分 `recorded_at_failure`、`observed_now`、`not_recorded`，没有采样绝不补成 false／not_started。无 PID、文件路径、原 Error.message／stack、会话／工具正文、私有配置或可执行内容；历史用户输入即便只读也不作为指令注入。

增强授权建议：绑定 `current_project × reader V16/current occurrence × subject V15/anchored occurrence × receipt 45440 × purpose failure_analysis × sections`；**不是要求 V16=V15，也不要求 V15 活跃**。相关 W360 字段只限同收据白名单。默认 15 分钟、最多 10 页、每页最多 100 项／64 KiB，总计最多 256 KiB；均是待批准默认，不提高现有 bridge 30 秒／256 KiB 上限。基础包同样有总预算；保留真实游标、missing_sections、truncated、history_complete:false，不把局部包标成全量。

用户确认显示“V16 为诊断 V15 的指定失败要读哪些新增字段、涉及哪个业务目标、排除什么、期限／预算及模型处理成本”；批准必须来自真实用户，不接受自动选择、模型答复、dismiss、旧确认或“想要这个能力”的概括性偏好。grant 仅是服务端记录，不是永久 bearer 凭证；不读取 V15 的 token。每页复核 V16 当前身份、源权限交集和 grant；禁用、撤销、到期、预算耗尽、读取者 occurrence 结束均阻止后续增强读取，不启用 V15 未来绑定。响应前复核撤销，不再释放尚未返回内容；已送给模型的内容无法收回。

增强采集只调用 code-owned 只读适配器，不接收 path、query、SQL、URL、Shell、env 或任意文件选择器，不借 Hook／开发派工代取。审计分别记录 reader V16、subject V15、原业务目标及各自 invocation／锚点、purpose、批准／拒绝／撤销、schema/policy revision、字段枚举、页边界／条数／字节和覆盖；拒绝只记录已认证请求的固定类别，不记录 token、正文或原始参数。审计不可写时不释放新增材料；日志不伪装成 V15 原始事件，也不修改原收据或证明副作用完成。安全包默认不另存原材料，用户主动导出仍限同一白名单。

## 5. 兼容、实施阶段与最小验证

现有 v1 sanitizer 会丢弃新字段，安全 envelope 校验还要求重建结果完全一致，不能只在 daemon 加字段就宣称模型可见。应由同一纯 Node/Bun 协议源提供 v1/v2 编解码和能力协商；旧客户端得到合法 v1 降级及覆盖说明，新客户端只接受已支持的严格白名单。构建／协议不匹配时增强能力拒绝，不能回落用户身份或原始错误。部署由用户在安全点更新相关进程，本次不重启服务。

不重写旧 Event／收据、授权快照、旧配置或私有文件；旧记录继续 legacy_unknown，空白分类不补猜。新授权仅前向创建。新增可读方法不得因当前 `managementPermissionsView` 对缺项继承默认的机制而意外开放增强材料：基础 read 上限之外，增强部分始终另需有效 grant；旧 read／automatic 及用户禁用项保持语义，不借新增方法扩大已有禁用能力。

| 阶段 | 实施范围与退出条件 | 最小验证 |
| --- | --- | --- |
| P0：跨 Valet 基线 | 确认现有直接读取链、来源归属与真实限制，不实施扩权 | 在隔离项目生成失败源 Valet、安全隔离后由第二个活跃 Valet 经唯一 lush_cli 读源身份／历史／收据；原错、unknown、隔离同时保留，不恢复源身份 |
| P1：定位型安全诊断 | 可信分类／精确 site 与业务关联采样，加按目标定位的索引／基础包，直接交给 V16 | 复用现有 CLI 主链：源 Valet 触发已知 check 拒绝及写后异常 → 第二 Valet 真实 CLI 读取 → 返回 source build/site 或 not_recorded；不把成功调用或配置提交当合并成功 |
| P2：按目标／用途授权 | 用户批准新增门禁／owner 证据段，再做固定确认与撤销 | V16 申请 V15 指定收据 → 用户确认 → V16 实际读取 → 撤销；隔离临时验证错目标／错用途／换 occurrence／到期／权限禁用／分页及 canary 不泄漏，不扩长期矩阵 |

实施优先修改／复用现有少量主流程测试，不恢复已删除的大型历史矩阵。快速集成检查若适用，应在最终全量前核对相关 CLI／RPC／UI 接线断言；最终实施指令 Worker 对最终树负责全量，不能以本次方案核验或 runtime 合并代替。

本次修订仅文档，并运行隔离临时探针 `bun run .lush/verification/w362/cross-valet-probe.js`：受控 Node Provider → 唯一 lush_cli → 真实 CLI／bridge／权限 → 另一已 isolated Valet 的 show/context/history/events/transcript/receipt → 读取者工具结果，全部断言通过；业务写后抛错仍为 execution_failed/unknown，原异常 canary 不泄漏，原收据与外层审计分别保留源／读取者身份。测试源／读取者是临时项目 V1/V2，不是真实 V15/V16；只证明当前读链，不证明未来提案已实现。初版既有专项 `bun run test test/project/management-cli.test.js test/web/dom-management-diagnostic.test.js test/cli-catalog.test.js` 为 5/5；DOM 用例走旧 RPC 兼容链，不冒充新 CLI 链。本轮另运行 `bun run docs:check`，日志在 `.lush/verification/w362/`；不增加长期测试／用例、不因纯文档跑全量，不验证付费模型或物理浏览器。W362 负责本次核验，未来顶层实施指令负责最终集成／全量；被测树和证据来源见交付结果。

## 6. 对 V15／W360 能解释与不能解释的范围

已提供元数据：receipt 45440、call 45439、run 2872，方法 worker.merge_after，目标 W360；2026-10-20T02:28:38.955Z 进入执行，02:28:38.974Z 记录 execution_failed／unknown／dispatch_entered，后来 occurrence unknown，约十分钟后急救隔离。

据当前代码，这能支持“已越过管理执行边界、执行回调阶段失败且缺少完成证明”，**不能支持**“权限不够”“一定没有写入”“已请求合并／已合入”或具体底层根因。mergeTaskAfter 在 handler 内仍会检查 revision、目标生命周期、固定交付、依赖和图，再执行事务；这些都可能落入通用 execution_failed，但只是候选失败点，不是已确认原因。19 毫秒间隔不能替代因果证据；后续隔离说明处置，不解释原错或撤销已发生副作用。

对真实 V15，V16 即使现在能读 45440／45439，也只能分析既存安全证据；本评估没有额外发现其底层原错。若当时没有保存 check site、运行构建、分类或精确业务完成关联，新的索引／授权／包不能补回，不能承诺本次就能定位具体抛错路径。当前门禁或 revision 只是现在的状态，无法倒推失败瞬间；也不假设私有日志存有完整异常，不扫描私有日志碰运气，不重放以“复现”未知写请求。

对**未来同类失败**，P1 在具体 check 或 helper 抛错时记录的 build+site+类别+锚点，才足以让 V16 直接区分“revision 检查失败”“固定交付不可编辑”“依赖无效／成环”等具体路径；精确业务 Event 关联另用于判断是否已有该方法提交证据。若仅有阶段或最后检查点，结论只能是候选区间；任意未插桩内部异常仍可能无法精确定位。P2 的当前运行／门禁事实用于进一步排除阻塞，不替代失败时采样。V16 的分析输出应逐项给证据 ID、已确认事实、候选解释和缺失项，不把推测写成根因；无需开发 Worker 介入取证。

## 7. 后续需要用户批准的取舍

1. **实施范围**：用户已澄清主路径为 V16 直接诊断 V15，但尚未授权开发；推荐批准 P1 的最小纵向切片：worker.merge_after 的安全采样＋跨 Valet 索引／基础包，P2 单独审批。不再把“用户转贴”或“另一个 Agent”列为默认解法。
2. **数据粒度**：是否将固定 build/site/category 随现有 read 收据提供，并允许精确确认后的目标门禁／owner 谓词；不选择原始参数、异常堆栈、私有会话或 Prompt 全文。
3. **授权体验**：推荐增强包按 V16 本轮＋V15 指定收据＋failure_analysis 逐次确认，默认 15 分钟／10 页／256 KiB；若要跨多收据或持续授权，必须另定有界范围和风险，不能暗扩成整个项目历史。
4. **独立治理**：Shell Hook 等高影响管理是否收紧是另一个议题；本次不改变 W316 默认、不新增诊断角色、开发 Worker 代查或调度旁路。

以上只是待批准事项；本次交付不更改任何实际授权，也不代表用户已批准未来实施。
