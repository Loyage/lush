# 时间信号与 Valet

本章记录时间信号及即时管理输入的权限、隔离和恢复契约（W240 / D565），补充 [Hooks 接缝](hooks.md)；设计入口是 [Worker Hooks](../design/hooks.md)。先前决定 #266 的一次性／每日、显式时区、停机错过跳过、已提交项等待安全点和未知副作用不重放继续适用。

## 产品和授权

Valet 是管理 Lush 的受限管家，与开发 Worker 共享持久执行底座，权限按真实身份授权，Git 开发与交付流程仍独立。项目「工作列表」仅查看开发 Worker，「管家列表」仅查看持久 Valet，复用同源有界分页、状态筛选和显式文本搜索，检索只针对已读取范围；通用详情共享指令、结果、Agent 信息、调用历史和执行阅读器，Valet 另展示绑定与受控操作收据。工作树只表达开发委派，管理操作目标不伪造成父子关系。

W263／D611 删除独立「Valet 设置」及全部 Web 信号／绑定编辑入口，不迁到其他页面；旧 `#management`／`#management-history` 跳「管家列表」并说明入口已移除。管家列表读取持久 Worker 记录及有界历史，不使用 `hooks.list` 的最多 100 个绑定摘要冒充完整记录。项目自动化首页不混入 Valet 配置；已有时间信号、绑定、授权、API／CLI 与历史保留。用户通过既有管理接口保存具名时间信号（例如「Codex 额度更新时间已到」），创建 Valet，写「开始 Wxx」／「重试失败的 Wxx」，选择信号及一次性／持续绑定。一个信号可绑定多个 Valet。默认一次性；创建、绑定不调用 Agent，信号到来才持久排队，不保证 Agent 准点获得槽。主输入框显式「管理 Lush」通过 `management.submit` 即时新建 Valet，不要求时间信号；正常结束后可由用户追加开启新一轮，边界见下文。开发输入的可靠挂载另见[条件发射](conditional-emission.md)。

信号只说明时间已到，不是实际额度恢复的观测，不自动查询／切换账号，不跨项目、不启动停止的 daemon。管理 Worker 的模型／来源由用户明确选择或创建时冻结项目管理角色有效默认；不把目标 Worker 的 Codex 账号自动当作管理 Agent 的来源。

管理 Agent 可发现全部当前 RPC 能力；`lushw` 集合从 `src/cli/catalog.js` 的 `LUSHW_METHODS` 派生。W316／D677、D678：全部已支持的受控接口默认开放，读取为 read，其余可执行操作为 automatic，包括取消、中断、合并、验收回收、删除、支持的配置与服务操作，以及自动化注册、挂载。自动化仍必须[先注册再单独挂载](../reference/rpc/hooks.md#先注册再单独挂载)：hooks.register 只注册指令及项目功能，成功后才可用明确登记版本独立请求 worker.hook_attach；注册不挂载、不执行。旧 hooks.install／Project／CLI 原子捷径全部拒绝，管家目录标 unavailable，不能借旧权限快照恢复。注册 schema／示例由同一纯协议源提供，事务收据可证明注册完成；挂载仅接受登记引用，无内联动作或运行参数旁路。

执行权限统一来自 `src/rpc/management-policy.js`；用户可分别收紧为 confirmation／unavailable，需要确认时由真实用户批准各个精确请求，权限修改能力本身始终须真实用户精确批准。不扩大固有不可用的私有材料、交互认证、原始会话、自复制或任意文件／Shell 工具边界。自动执行不绕过预检、revision、目标、Git、冻结或生命周期安全门，不复活终态、已归档或祖先关闭的工作。快捷指令不恢复独立预授权或已删除的 command_authorize，普通开发 Agent 不因此扩权。

### 设备全局管家权限

W302／D659、D660：「CLI 接口」位于全局工作台，命令学习与设备用户所有项目的统一 Valet 权限在同页；不设项目选择，项目侧栏不显示入口。旧项目 `#cli-interfaces`／`#valet-settings` 书签提供原生新标签链接，保留项目现场；根旧书签兼容新入口。目录只是说明，不代表执行授权；交互与缓存见[CLI 目录](../hooks.md#cli-目录缓存与权限)。

用户专属根接口 `GET /api/host/management/permissions` 无 query；同路径 `POST` 严格接受 `{permissions,expected_revision}`，复用登录、Origin、JSON 和 no-store。该 Host 接口不向 Agent 开放，不依赖项目登记或 daemon 在线，不启动后台。旧 `management.permissions`／项目 GET 仅兼容读取有效权限；`management.permissions_update` 保留注册但拒绝所有写入，不能建立项目覆盖。新增逐项 CLI／RPC 查询与审核修改见下文。

全局读模型为 `{version:1,scope:'device',configured,revision,groups,methods,permissions}`。`configured:false` 表示**内建默认已生效**，不是待启用草稿，无需首次保存。W316／D677 明确使旧版 `management-permissions.json` 和项目 meta 限制退出授权，原数据及历史快照保留、不自动导入或改写；用户之后的自定义权限仅保存至设备私有 `management-permissions-v2.json`。页面首次保存自定义更改说明全部项目影响。离线项目恢复时读取共享权威；旧版本进程不会自动更新，须由用户在安全点分别更新 Host 与各 daemon，混用版本时不能声称权限已统一。无配置读取不创建根；新文件不安全／损坏时拒绝授权，不回退默认或旧项目值。已有 v2 文件内退役 hooks.install 的旧允许值仅留历史，读取投影钳制为 unavailable、不改文件、不阻断其他合法权限；下次显式保存使用当前目录。

页面按需读取全局权限，核对动态审核上限／可选值与静态目录（包括保存 ACK）一致；版本不匹配时禁止编辑。groups 为 `{id,label,description}`；methods 为 `{method,group,label,description,base_access,access,allowed_access,reason}`。目录、分组、原始分级、可选值和执行校验均来自 `src/rpc/management-policy.js`。permissions 是**完整** `method -> access` 映射，包含不可用条目；不接受 sparse patch、未知字段、缺项或提权，使用 revision 防并发覆盖。私有文件原子发布与最终授权／持久开始使用同一跨进程 `settings-write` 锁排序，开始后释放锁再执行副作用；各 daemon 的一秒只读观察在修订变化后协调未开始请求，不重放失败。锁忙保守拒绝，不偷锁。`read` 仅可 read／unavailable，`automatic` 可 automatic／confirmation／unavailable，`confirmation` 可 confirmation／unavailable，`unavailable` 不可提升；必要发现 `manager.catalog` 固定 read。权限修改 `management.permission_set` 的上限固定 confirmation，仅可 confirmation／unavailable，不能设为 automatic。manager.call/start/retry 是传输／兼容入口，不是独立提权项。

逐项用户 RPC `management.permission_get {method,scope:'device'}` 返回接口权限、可选值及全局 revision；`management.permission_set {method,access,expected_revision,scope:'device'}` 以单项 CAS 保存并返回 `{method,access,revision}`，复用同一私有文件、完整映射校验与设备写锁。CLI 为 `lush hooks management permission-get METHOD --scope device`／`permission-set METHOD ACCESS --revision REV --scope device`。Valet 只能经 `manager.call` 代理，普通开发 Agent 不可直调；设备操作仍须用户指令与 scope 明确。修改请求先展示接口、旧值、新值、修订及同设备用户所有项目影响，真实用户批准精确请求后执行，不接受自动选择或模型授权。批准前不写入，修订变化时拒绝旧批准覆盖新设置；修改审核能力自身也不能取消审核，结果未知不自动重放。

即时输入、等待信号、持续绑定及已有无快照历史 Valet 均动态读取**最新有效权限**（无配置为内建默认，有配置为设备共享值），正在运行的模型后续调用也同样检查；持续绑定不冻结下一 occurrence 的权限。`permissions_snapshot:{version,scope,revision,permissions}` 可保留为创建时历史，不回写、不迁移、不作为后续请求授权；快照缺项或无快照不再切换到另一套执行策略。client_request_id 去重仍返回原 Worker，不能因此创建重复身份或恢复旧权限。公开 inspect 不输出私有快照。

未开始的排队 capability、等待动作及 pending_confirmation 在执行前重新检查最新权限，包括异步资源预检结束后及写入准入边界。变为 unavailable 时不执行：pending_confirmation 记 rejected 并关闭未答 Notice，approved 记 failed，waiting 动作记 skipped。旧 automatic→confirmation 的 approved 请求或 waiting 动作若没有真实用户的精确批准，同样失败／跳过，须重新请求确认，不能把旧 approved 当批准。尚未回答的 pending_confirmation 若放宽为 automatic，关闭原 Notice并继续同一精确请求，仍保留参数、目标、资源和生命周期安全门；已拒绝、失败、取消或 skipped 不因放宽重放。

capability 仅在真正进入执行回调、完成最新权限及精确确认校验后标 running，私有 `execution_authorization` 固定该方法开始时的权限，后续真实 bridge／receipt 校验不因项目权限变化误拦截。已经开始的操作不因之后修改权限被强制中断，完成的副作用不撤销；历史 running 收据保留原开始授权及既有 unknown／精确完成证明恢复规则。开始／重试返回的 waiting 动作仍是**未开始**：capability succeeded 仅表示提交，动作真正执行前还须用最新权限和原精确批准重新核验。

查询契约由 `src/core/worker-query.js` 同源供给 CLI 学习目录、管家目录及校验，包含类型、枚举、默认值、分页说明与参数示例。`worker.graph.scope` 是 `all|tree`，`worker.activity/page.scope` 是 `work|all`；这些是当前项目的查询范围，不要求设备指令或 `scope:'device'`，也不接受自造 `development`。设备设置仍须显式指令与设备作用域，不能以查询例外扩权。只有这组契约在执行前产生的固定参数错误使用 `-32030`，可信 bridge 双端按代码和固定消息白名单投影为 `kind:'invalid_parameters',execution:'not_started'`，不回显错误参数值、路径或任意异常；可修正参数后重新提交只读查询。权限拒绝、普通 handler 错误、输出超限、超时、断连及未知结果仍采用保守失败，不声明未执行、不自动重放。

`manager.query`、`manager.history` 是独立审核的安全 read 条目；直接工具与 manager.call 使用同一最新项目权限检查。worker.lookup 的真实管理 actor 亦需该条目 read 授权。manager.start 对应 worker.resume，manager.retry 对应 worker.retry；两个专用入口和 manager.call 均遵守对应权限。收紧为 confirmation 时发布既有精确用户确认 Notice，用户批准后交给原受控动作引擎，不直接转发普通 resume/retry handler；仍检查目标类型／状态、祖先、冻结、旧调用、配置、去重、等待与 unknown，不允许 profile 覆盖。自动权限也走同一动作引擎，不能借 manager.call 绕过目标门禁。确认收据 succeeded 只表示已提交，result.action 及独立 action receipt 显示 waiting／skipped／succeeded 等实际结果。

### 开发能力的受控代理

`lushw` 是开发协作入口，`lush` 是管理入口，二者共用命令目录与业务实现。Valet 继续仅通过可信 `manager.call`／真实 bridge 调用开发能力，不获得 Shell、本地文件工具、开发 Skill 或任意 RPC 直通；本地 help、指南和问卷示例不是 RPC，不构成文件或命令执行授权。CLI 分区与迁移见[双入口](../reference/api.md#开发与管理双入口)。

Valet 可向当前项目任意合法开发目标发消息，保存真实 Valet sender；可在指定活动 order/child 下派生 child，child 的分支基线、父子编号与交付目标仍属于该开发 parent，不挂在无 Git 分支的 Valet 下。进度、自动标题与决策 Notice 只作用于 Valet 自身。`worker.accept` 按最新权限经原统一验收入口执行；设为 confirmation 时须真实用户批准精确目标，默认 automatic 时无需逐次确认，但仍复核干净现场、交付、消息、后代、冻结及资源归属；接口默认开放不提高 Worker 的自动链最高级别。普通开发 invocation 的直接父子约束不变。

`worker.graph` 的管理调用同样只返回 `worker_metadata_only`，剔除结果预览、通知正文、资源和 Git 诊断；在真实图查询入口将页大小限制为 100，游标按实际返回节点推进，不经事后裁剪跳过记录。`worker.page` 的管理分页同样在实际查询前限制为 100 条，返回的 limit/cursor 对应实际页，不丢弃同页尾部。查询 scope、筛选及 cursor 语义仍与普通入口相同。

`worker.inspect`／`worker.tree` 的管理调用返回 `coverage:'worker_metadata_only'`，剔除原始 Run 结果／错误、收件箱正文、Artifact 与 Notice 正文，避免绕过执行记录的安全读面。`worker.history`／`worker.transcript` 返回有界、可续读的 `event_metadata_only`／`step_metadata_only` 投影。条数预算与通用安全出口同源，最多 100 条；`next` 固定在末个实际返回记录，`has_more` 包含本层未返回记录，不能按请求 limit 推算游标。`steps_truncated`／`events_truncated` 标明本层条数裁剪，`truncated` 保留上游字节预算事实，不混为同一原因。inspect／tree 的 `goal_truncated`／`goal_length`（UTF-16 长度）标明目标摘要范围，不能把已有树摘要当完整目标；不返回原始事件正文、提示词、工具参数／输出或会话路径，不把安全摘要冒充完整执行记录。Valet 发布自身决策问题后结束调用，同一 occurrence 挂起并保留项目串行执行位；用户答复后受控恢复，答案来自 `context.management.decisions` 的真实 Notice 来源与截断标志，不开放任意管理收件箱。这是当前事项的决策恢复，不是新一轮追加授权，也不重放已执行动作；设为 confirmation 的动作仍采用独立的精确确认收据。

### 历史订阅刷新时间辅助实现

Web 时间信号设置入口已退休；下述保留辅助函数的缓存、时间与迟到保护语义不代表仍有页面入口，也不迁往其他设置。历史时间信号编辑器按需 GET `/api/agent/connections`，仅读取当前项目有效模型来源与本地观测，不调用 `query`。候选为当前 `available|partial` 观测中 `kind:'quota',scope:'account'` 的资源；显示账号名称、指标、结构化窗口与刷新时刻，填入后显示 `checked_at`。缺失／无效／已到期 `reset_at` 不可选，失败或 unknown 不从 `last_success` 补候选。不按来源启停推断额度已恢复，停用来源明确标注。

显式选择直接改为 `kind:'once'`，保留表单当前 IANA 时区，以缓存明确瞬间转换本地显示；精确 UTC at（含毫秒／DST 重叠中的明确偏移）保存，手改日期或时区后仍走既有无歧义校验。保存参数仍仅信号定义，不新增账号绑定或公开接口，不追踪后续观测。读取失败不阻塞手填；重新读缓存不覆盖已填时间；离页／跨项目／替换表单的迟到响应作废，保存中禁止填入。

## Worker 与执行隔离

管理工作复用既有 Worker / Run / Artifact / Message / Event 底座，不新增平行的核心存储实体。Valet 记录仍为 role='manager', task_kind='management'；指令放 goal，不伪造开发 Input，不建立 Git 分支，不加入自动合并／验收链。新 Valet 在共享 `worker_number` 字段保存独立 V 编号；历史未编号记录继续回退 `#内部ID`，不补号、不改写正文或引用。编号分配、持久性与只读解析见[用户编号](../reference/api.md#用户编号与-cli-身份)。内部 manager/management、RPC、事件、路径和整数身份保持兼容，不因界面名称改变而机械更名。

Workspace 是项目 .lush 下专属 management 目录，不是 canonical 项目或任意开发 worktree。Workspaces.ensure/finish 明确识别此类型，不跑 Git clean/commit。Provider 使用独立 manager 提示词、独立会话，不能继承开发提示词、项目 AGENTS 或分支 checkpoint。管理调用只使用可信的查询／开始／重试／能力目录／安全历史／受控操作工具；不加载用户扩展／skills、不提供 read/bash/write/edit 或任意 Shell 工具，运行时扩展的连接观测／安全停止接缝保留。没有专用受限工具适配的旧 Codex CLI 后端拒绝管理调用；Pi 中使用 Codex 模型／连接不受此限制。mock／可控测试 provider 可用。

管理 Provider 不读取 Lush 公共／角色 env 文件，也不注入继承或显式 profile.env；机器运行环境、项目出站网络策略和所选托管连接的必要管道仍保留。管理提示词忽略开发 Prompt 补充和覆盖，普通开发调用的环境继承不变。

管家 Pi 扩展只导入 Node 可加载的纯协议定义，不从 daemon 总注册表间接引入 Bun 实现；RPC 传输只在固定 Bun bridge 中按需加载。失败时 `Run.error`、`Worker.error` 与管理执行原因保留固定白名单诊断及处理建议（扩展加载、模型／来源、进程启动、输出上限、超时／中断、未分类失败），不持久化原始 stderr、凭证或异常正文。UI 在详情顶部完整显示安全原因，旧记录缺少诊断时明确不可还原，不从通用“调用中断”倒推根因；失败后不提供自动重试，不改变 unknown 收据与禁止重放规则。

这是工具和 RPC 能力隔离，不声称提供操作系统沙箱。普通开发 Agent 的权限、USER_ONLY 方法以及每轮 token 的 hash / running / abort 核验保持不变。管理方法要求合法 invocation actor 且 role/task_kind/绑定/当前 occurrence 全部通过后端核验，不能靠 Prompt 宣称授权。Dispatcher 按 Store 中真实管理身份把该 token 可调用方法严格限制为 manager.query/start/retry/catalog/history/call 与 worker.lookup，拒绝直接调用普通 Agent 的 notice/progress/message 等方法；已审核 `lushw` 能力须通过 `manager.call` 检查真实管理身份、最新项目权限（已开始操作使用固定开始授权）、作用域与目标后代理执行。

## 数据与时间

项目时间信号采用 meta 中 versioned JSON 附属配置，管理绑定／occurrence／受控动作收据采用 tasks.management 附属 JSON。不改写历史行／分支。最多 64 个信号、64 个启用管理绑定，每个 occurrence 最多 32 项动作；信号库与单 Worker 私有状态分别最多 128 KiB，管理列表最多 512 KiB。revision 与运行动态分离，读取无副作用。

信号定义 `{id?:UUID,name,enabled?:boolean,schedule}`，schedule 复用 normalizeHookSchedule / nextHookRun。一次性创建／改时间／重新启用须在未来；已错过或已发出的同一一次性规则不能靠回拨重放。每日 DST 重叠取首次，缺失跳过。停用／停机未提交过期项不补跑。一次性信号显式改为新的未来时刻时保留旧发出历史，但旧历史不消费新时刻；仍不重放已消费的绑定，需另建管理指令或使用此前授权的持续绑定。

到点事务持久 Event occurrence 并给当时已启用的绑定投递。绑定最多一个未结算 occurrence，忙时后续每日信号不堆积；不同绑定独立。注册／新启用绑定不订阅旧历史。管理调用和受控动作各自有持久身份；同 occurrence、动作、目标去重。持久提交但尚未开始模型的项重启后仍可排队；已启动模型／未知动作不自动重放，留 failed/unknown 诊断并停用绑定。可证明完成的动作使用精确收据收口。

W279／D635：当前项目的 Valet 共用一个串行执行位，不引入跨项目锁。即时输入从持久排队起占位；信号绑定只等待未来时间、尚未触发时不占位。已触发的既有绑定持久排队，按 occurrence 身份及 Worker ID 公平准入；已准入 occurrence 在模型运行、实际退出清理、危险操作等待用户确认、受控动作等待／执行及完整收口期间都保留执行位。冻结、停用或维护暂停不释放未收口占位；重启仅恢复可证明未开始的队列，不重放未知副作用。占位时所有新建管理身份入口（包括即时 submit 和 signal create）拒绝；同 client_request_id 的精确重试先返回原身份，不受忙碌状态影响。

W323／D686：用户可通过 `worker.message {id,body}` 向正常返回且安全收口的同一 Valet 追加输入，创建新的 occurrence；仅接受真实用户调用，不开放 Agent 自行续轮。保留最初 goal、V 编号、模型配置、会话与历史；追加以独立 Message 留痕，不创建开发 Input、分支或 A/O 编号。失败、取消、退役、未实际退出、待决／未读输入及未收口操作均拒绝。其他管家占位时拒绝，不持久排队追加，客户端保留原文。公开 management 投影提供 `can_append/append_reason`，后端执行时再次核验。

追加正文仅保存在真实 Message 中，pending occurrence 固定其 message_id；`management.instruction` 是本轮唯一管理指令来源，设备／全局作用域校验也只看本轮，不沿用最初 goal 的授权。新 occurrence 使用最新权限、独立收据和去重范围，不重放旧操作；历史 Run／Event 保留旧结果。显式追加只授权当前一轮，不重新启用原先停用的未来信号绑定。自身决策答复及安全维护暂停仍继续原 occurrence；未开始的追加可恢复，已开始但未知的调用仍停止、不重放。

持续绑定每个 occurrence 使用同一个管理 Worker，完整收口后才可准入下一项。一次性绑定执行后停止。失败不以新一天为理由自动重试。`management.binding_update enabled:false` 撤销未开始的未来／待执行动作及危险操作确认（关闭对应 Notice），不强杀正在运行的 Agent，但立即拒绝新管理操作。`worker.cancel` 同样撤销未执行授权并请求中止模型；返回 cancelled 只表示停止已请求，`running` 真实退出及已开始的受控操作仍须独立收尾。已经完成的操作不撤回，running／unknown 副作用不伪装成已撤销。重新启用不重放 consumed / unknown 的 occurrence。

临时冻结、同步、清理、正在退出的旧目标调用只阻塞受控请求。管理工具返回已提交待安全点，不要求模型等待／轮询；后端持久请求在首个安全点执行，不再次调用模型来重发。目标状态不适用／永久不可用记录 skipped。安全门通过后动作异常不是可自动重试的临时 gate。开始／重试沿用目标已保存配置，不接收 profile、不切账号；仍通过原生命周期入口。

## 接口

`hooks.list` 保留既有字段，新增：
- `signals:{version:1,revision,items:[{id,name,enabled,schedule,next_run_at,last_due_at,last_execution}]}`，只读安全投影。
- `management_workers:[{id,worker_number,name,goal,goal_truncated,goal_length,status,management,model_selection}]`，最多 100 个管理摘要，启用绑定优先且全部可见。goal 最多 160 字符，name 最多 64 字符；pending_signal / last_execution 各显示至多 2 项动作并提供 `actions_count/actions_truncated`。过长目标 W 编号置 null 并提供 `target_worker_number_truncated`，不得截成另一个合法编号。详情 inspect 保留完整指令与至多 32 项安全收据；management 是安全对象，含 `version,revision,signal_id,mode,enabled,can_enable,state,pending_signal,last_execution,reason`；`can_enable` 明确是否可重新启用授权，已消费一次性／failed／unknown 等不可启用，模型／来源仅安全摘要，不含完整 profile/env/Prompt/凭证。pending_signal / last_execution 暴露 due_at、occurrence id、结果、安全原因及受控动作结果，不含任意原始错误。control_calls 的安全摘要包含 notice_id 与 notice_kind；kind 仅从同一 Valet 的实际关联 Notice 读取，缺失、跨身份或未知为 null，界面保守显示 N，不按收据状态或标题推断 D。

用户专属 RPC／POST action：
- `hooks.signal_save {signal,expected_revision}` → Project.saveHookSignal(signal,expectedRevision)，返回 hooksList。
- `hooks.signal_remove {id,expected_revision}` → Project.removeHookSignal(id,expectedRevision)，返回 hooksList。已启用或尚未收口的绑定引用时拒绝移除；已停止的 failed/unknown 历史诊断不永久锁住信号，保留可读历史。
- `management.create {name,instruction,signal_id,mode?,profile?,client_request_id?}` → Project.createManagementWorker(options)，返回 `{task:安全 Worker}`。默认 mode='once'。profile 是写入私有设置，读取裁去；保存失败保留编辑内容，禁止立即调用 Agent。可选 client_request_id 是去重身份，非空、trim 后不变、最多 128 字符、无控制字符；Web 每份表单固定一个 key、失败重试不换 key。同 key 同原提交定义（省略 profile 仍视为原始省略）返回原 Worker，不因 signal 已发出或默认来源变化而重建；同 key 不同定义拒绝，并发／重启后保留去重。定义 fingerprint 与 key 放私有附属状态，不作为授权。mutation 已成功而后续 refresh 失败必须显示成功／刷新诊断，不能自动重做创建；无 key 客户端收到未知断连须先检查历史，不盲目重试。
- `management.binding_update {id,enabled,expected_revision}` → Project.updateManagementBinding(id,enabled,expectedRevision)，返回安全 Worker。用于停用／重新启用授权；已 consumed 的一次性不能借启用重放；正常收口后可显式追加新一轮，unknown／失败必须另建管理指令。
- `management.submit {instruction,profile?,client_request_id?}` → Project.submitManagementInstruction(options)，返回 `{management:true,task:安全 Worker}`；即时创建独立管理身份并排队，不创建开发 Input 或 Git 分支。请求 key 与精确原定义去重，旧信号绑定不迁移。

专用 Agent-only RPC（只由受限管理工具使用，不为 Web 或普通开发 Agent开放用户方法）：
- `manager.query {id?}` → Project.managementQuery(actorId,id?)。无 id 返回有界当前项目目标摘要；有 id 返回单目标安全诊断。工具层可用既有 worker.lookup 将明确的 W／V 编号解析为整数 ID；查询能力不扩大开始／重试等操作的目标准入。
- `manager.start {id}` → Project.requestManagementAction(actorId,'start',id)。
- `manager.retry {id}` → Project.requestManagementAction(actorId,'retry',id)。
- `manager.catalog {}`：返回当前项目能力目录、参数及 `read|automatic|confirmation|unavailable` 分级和限制，不赋予泛化用户权限。
- `manager.history {id?,before?,limit?}`：有界调用状态、模型、耗时、事件计数，limit 1..100，返回 items/next_cursor；不读取原始提示词、工具参数／输出、会话或凭证，流程诊断仅基于这份安全摘要。
- `manager.call {method,params,request_id?}`：可信受控代理，检查注册参数、私有字段、作用域和管理身份；写操作按精确请求指纹去重。`system.diagnostics` 是当前项目安全只读采集，返回 token／估算费用速率和覆盖不足，不开放跨项目 Host 聚合或原始会话。已移除的手动快捷指令 run/start 不进入目录、不保留执行别名。返回安全 `{receipt_id,method,status,notice_id?,reason?,result?}`；需用户确认时返回 `pending_confirmation`，不是操作已完成。

受控动作返回 `{status:'succeeded'|'waiting'|'skipped'|'unknown',target_id,target_worker_number,reason?,receipt_id}`（尚未创建新动作的校验失败可拒绝）。成功仅表示生命周期操作已提交／排队，不冒充目标业务成功或额度已恢复。每项操作先记录授权、触发身份和收据，禁用后拒绝新操作。

普通 worker.inspect 及所有公开 RPC/HTTP 出口不得泄漏字符串 management 私有 JSON 或 retry_profile。Valet 使用通用工作详情／历史／执行入口；Valet 自身仅支持上述受控用户追加，不提供开发暂存／条件发射、运行配置编辑、合并、开发验收或 Git 分支，不假装有分支可合并；代理开发目标的能力遵循上文受控契约。删除复用用户专属 `worker.delete_preview`／`worker.delete` 的精确 revision、confirm 与原安全门。启用绑定、模型未实际退出、未收口 occurrence、危险确认、受控动作 waiting／running／unknown 都阻止删除；用户可先停用或停止，安全撤销尚未开始授权，实际退出且无未知在途副作用后再预检删除。已停用且安全收口的 waiting Valet 无须开发验收即可删除。只清理该身份专属非 Git management 目录、会话／日志及历史，不删除其管理操作创建的独立开发 Worker 或项目时间信号库；共享、符号链接、未知归属及资源变化仍拒绝。Web 时间信号与绑定设置入口已移除；管家列表和详情不提供旧操作重放入口；用户追加明确授权新一轮。保留 API／CLI 的 revision、去重与失败语义：成功 mutation 不依赖概览刷新，不因刷新失败重做创建，配置 revision 不因时钟 tick 变化而变更。列表分页和执行阅读器继续以页面、项目与 document 身份守卫迟到响应；仍可见的延迟安排 Agent 按钮使用 agent-call 与 agentHelp。

## 确认、作用域与恢复

confirmation 操作（包括始终需审核的权限修改）先保存精确方法／参数、目标快照与资源预检，发布管理授权 Notice；普通自动选择必须跳过。只有 `answer_source='user'` 的固定问卷答复可授权，dismiss、模型答复、参数或目标变化都不是批准。用户答复在事务后由 `resolveManagementConfirmation` 安排可信执行，不再调用管理模型。目标、脏现场、冻结及 revision 等安全门仍由原引擎复核；模型不能代理答复自身或其它管理授权。

`tasks.management.control_calls` 保存确认／执行收据；批准但暂受阻的操作等待安全点，已经 started/running 而结果未知的操作重启标 unknown，不自动重放。`managementControlJobs` 计入维护忙碌和停机 drain；待用户确认或 unknown 不靠定时轮询。资源回收与服务停机沿用真实入口，`system.stop_if_idle` 因管理执行自身占忙而明确不可用，不伪装成功。

作用域仅当前项目，无跨项目、任意 Shell、read/write/edit 或凭证工具。设备共享设置须指令明确提出设备／全局操作且工具带 `scope:'device'`；device-only 旧别名也要求该授权元数据，不传给普通 handler。私有 env、Prompt、凭证、原始会话正文及需交互认证／设置迁移的能力保留目录但不可用，指向用户界面。管理模型不得创建其它管理身份或自行改变授权；仅可发起需真实用户批准的逐项权限修改请求。只读结果再次做秘密字段和字节裁剪，公开 inspect 不暴露 control_calls 原参数、预检指纹或私有 JSON。

验证使用临时项目与受控 Provider；`test/project/automation-registry-bridge.test.js` 实际覆盖目录／默认自动注册／独立挂载／权限收紧后的精确确认与禁用／真实命令执行及收据，并核对 Provider 工具集、目录、RPC 注册一致；`management-tool-chain.test.js` 保留其他代表性工具／bridge 调用主流程。固定确认、权限变更竞态、自身待决恢复和完整工具隔离组合不再保留独立回归，覆盖取舍见[贡献指南](../contributing/README.md#覆盖取舍)。不调用真实模型、不重启用户服务；真实自然语言理解、额度恢复和物理浏览器行为仍需另行验收。
