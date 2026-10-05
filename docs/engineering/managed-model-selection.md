# 共享 API 与调用前模型选择

用户决定 #157 的[项目 Agent 双模式配置](agent-configuration-v2.md)优先于本章旧的“所有 Pi 调用必须托管”描述：默认 Lush 模式仍采用本章隔离和显式绑定规则；用户显式选择 Pi 默认模式时使用执行环境 Pi 配置，不混入托管来源，也不参与托管模型选择策略。来源模型目录自动维护及安装资源与启用分离同见该契约。

本章说明共享 API、手动模型选择及未来规则程序的受信扩展接口，面向维护者。用户决定 #142：内置服务商和自定义 OpenAI 兼容 API 均存入当前项目连接库；登录统一托管，按执行后端能力使用；提供项目默认与单 Worker 显式选择；本轮预留安全资源读面与受信调用前策略接口，不实现自动路由规则或用户脚本。

本章增补[账号连接契约](agent-connections.md)。连接仍是项目技术附属配置，不是 Host 的整机账号池。不迁移外部客户端登录，不修改旧观测历史。

用户决定 #152/#154：界面分为「Agent 配置」与「模型来源」；所有 Pi 调用必须绑定 Lush 来源，使用项目独立基础配置与每次调用快照，不再回退或继承用户默认 Pi。配置隔离及窄更新规则见[页面与运行设计](../design/agent-model-settings.md)。这些决定优先于原 #142 的未绑定兼容边界。

## 共享连接

- 新 provider `openai-compatible`，auth_type=`api_key`；用户必须显式填写 HTTPS 模型端点和非空物理模型 ID 列表。不同端点/密钥各自保存为不同连接。
- Pi 物理模型名使用 `openai-compatible/<model-id>`。invocation 的私有 models.json 为该端点注册指定模型，使用 OpenAI chat-completions 兼容协议，不向官方 OpenAI 接口转发自定义密钥。只支持此兼容协议，不声称覆盖 Responses、Anthropic 或任意私有协议。
- 兼容模型的本地运行预算固定为 32768 context / 4096 output，仅文本/tool，不声明图片或推理能力。这些值不是上游探测到的限制；更小的上游限制仍可能导致请求失败。Pi schema 的 cost 零值仅为占位，不代表免费或已测得真实成本，不能用于余额路由。
- 自定义 API 尚无专用余额适配；查询返回 unsupported/未知，不联网调用模型、猜测余额或发向内置服务商查询地址。未来可增补专用查询适配。本轮不新增任意查询脚本。
- API Key 和 OAuth 均归连接，不归 Worker/profile；只有支持该连接的后端能引用。当前托管 runtime 仅 Pi，Codex CLI 保留原认证；不能把支持 Codex 登录误称为支持 Codex CLI 托管绑定。

## 选择与默认兼容

- 项目默认/角色配置保留现有 connection_id + model 字段。Web 从本地连接列表展示匹配模型供选择；可填写内置服务商未限定的模型。
- 单 Worker 的暂停配置、继续与失败重试复用既有 profile 接口，补全显式连接选择和匹配模型。保存配置不调用 Agent；继续/重试才调用，必须沿用 agent-call 标识。不切换进行中的 invocation。
- Worker 的 task-local 覆盖跨交付、验收、无参数重试与合并轮次保留（`config_mode`、来源/模型与其它覆盖）；只有用户显式 `worker.clear_override {id}` 或重新保存完整覆盖才改变，不因交付自动切回项目默认或另一个模式。`worker.inspect.model_selection.explicit` 标明是否存在覆盖，Web 据此显示「清除运行覆盖」入口。该持续语义以[项目 Agent 配置与双模式运行](agent-configuration-v2.md)为准，优先于 #154 的一次调用范围。
- Lush 模式（`config_mode` 缺省/lush）的 Pi 调用必须绑定托管来源；未绑定时在创建 Run 与启动进程之前被拦截：Worker 保持非终态并写 `invocation.blocked` 与 info 提醒，提示去「Agent 配置」选择来源或在本 Worker 切换为 Pi 默认配置；输入与工作区不丢，不读取外部凭证。`config_mode:'pi'` 不算缺来源，不拦截。
- Pi 未绑定来源时明确失败并提示选择来源，不读取外部凭证、不隐式联网或回退外部 Pi；调度器在真正启动前拦截并保留输入，而不是先运行一轮再在后续迭代失败。需要执行机器 Pi 默认配置时由用户显式选择 `config_mode:'pi'`，不是自动回退。Codex CLI 仍保留自己的认证。独立 Pi 基础设置在 `<home>/pi/`，运行快照通过 `PI_CODING_AGENT_DIR` 注入，项目 `.pi` 不能重定向托管端点；显式资源与项目上下文保留。
- `worker.configure {id,model_selection:{connection_id,model}}` 与 `profile` 互斥，仅切换 Pi 来源/模型，后台保留其他完整覆盖，无覆盖时基于有效角色默认建立覆盖。不扩大暂停/请求中断准入，不自动继续、不联网刷新。`worker.inspect.model_selection` 为 `{agent,config_mode,connection_id,model,thinking,explicit}` 无秘密下次选择摘要，不能当作当前实际绑定。
- 明确设置的 Worker retry_profile 优先，不被自动策略覆盖；项目默认是策略的基线。策略返回空表示保留原配置，不能自动降级或换执行后端。

## Lush Pi 配置与诊断边界

- `pi-config.js` 原子初始化 `<home>/pi/settings.json`，要求 owner-only 目录与文件，拒绝链接、权限不安全或损坏配置，不自动修复/迁移用户已有文件。本轮没有新增基础文件的 CRUD UI/API。
- 每次调用只复制 `PI_RUNTIME_SETTINGS` 白名单：thinkingBudgets/modelThinkingLevels/defaultTools/compaction/branchSummary/transport/httpIdleTimeoutMs/websocketConnectTimeoutMs/retry/shellPath/shellCommandPrefix/images/warnings；项目信任固定 never，install telemetry/analytics 关闭、cacheWarming off。后端、来源、模型与思考深度由当前 Lush Profile 明确指定。
- `<home>/pi/models.json` 仅可为已选 provider/model 补充安全元数据，不复制 apiKey/headers 或其他账号配置；通用兼容端点维持上述保守定义。基础目录的 packages/扩展/Skills/Prompt 不自动带入调用，只发现已安装资源，运行时仅加载显式选择的扩展/Skills 与 Lush 内置 runtime。
- Pi 模型目录使用 auth-free、禁网络的 SDK 元数据进程；未声明独立元数据或 SDK 不可用时明确显示未验证 presets，不执行 Pi `--list-models`，不猜账号。配置页的 Pi 模型选择只使用已选来源，不显示这些预设。
- 高级诊断只读 Lush 独立目录；该目录未配置诊断凭证时列表为空，不从托管来源或用户默认 Pi 猜测。托管来源及其余额/套餐在「模型来源」查询。显式自定义 HTTP 额度模板仍可引用用户指定的环境变量，内置账号发现不使用 ambient provider keys。
- OAuth refresh 始终由 Lush 连接管理器协调，调用快照只有 access（refresh 为空）；长调用 access 到期仍可能失败，下一次 invocation 再准备/刷新，不自动重试或换账号。独立目录不是 OS 沙箱，受信扩展/工具仍拥有进程权限。

## 运行时扩展接口

新增 `src/core/agent-selection.js` 的 `AgentSelectionService(project, {strategy?})`，由 `new Project(config, store, provider, {modelSelectionStrategy})` 的可选内部 options 注入策略。不是 Agent/RPC 可写设置，不执行项目脚本。

- `resources()`：不含秘密的 version 1 资源读模型；复用连接 list 的端点、models、凭证状态、observation、last_success 和时间，追加支持的执行后端信息。仅本地缓存读取；失败、未知、旧值不能当零。
- 用户专属 RPC `agent.selection.resources {}` 与 GET `/api/agent/selection/resources` 暴露同一读面。显式刷新沿用 `agent.connections.query`，不额外做模型请求。
- `select(task, profile, {explicit, signal})`：无策略或 explicit=true 时原样返回，不读连接。否则策略收到最小 Worker 身份、无 Prompt/env/资源路径的基线 profile、安全 resources 和 AbortSignal；返回 null 或严格 `{connection_id, model}`。只能更改连接与物理模型，不改后端、Prompt、环境或权限。
- 策略结果必须严格验证：Pi 后端、连接存在/启用/可配置、provider/model 和范围匹配；启动前仍用 prepareRuntime + validateRuntimeConnection 冻结真实凭证与账号。无效或策略错误安全失败，不带原始错误/返回值、不静默回退。
- 在 invocation 创建 Run、记录有效模型和调用 provider 前选择；取消/停止防止迟到启动。正常调用超时覆盖策略等待；策略失败/超时尚未启动模型时不生成虚假的 Run。

策略回调形式为 `async ({worker, profile, resources, signal}) => null | {connection_id, model}`。其中 resources 的每个连接包含 `supported_agents:['pi']`、原有模型范围和观测；`checked_at` 顶层是读面生成时间，余额新鲜度必须看 `observation.checked_at` / `last_success.checked_at`。数据深冻结，不能由策略反写配置；没有策略时不创建 Manager。explicit Worker 配置由 scheduler 直接绕过策略。策略自身是受信代码，不是沙箱；取消只阻止其迟到结果启动调用，不能撤销受信代码已经造成的外部副作用。

## 并行文件职责

- Provider：src/agent/connections*.js、src/agent/connection-runtime.js；test/agent/connections*.test.js 与 connection-runtime.test.js；负责 generic provider 存储、查询、私有 Pi 模型注册及安全测试。读完整 Pi models/provider 相关官方文档后实现。
- Runtime：新 src/core/agent-selection.js、Project base/agents/scheduling、src/core/agent-connections.js 的 provider 白名单、Store 必要白名单、RPC/HTTP 接入与对应 tests。不得修改 Provider 或 Web assets。
- Web：render-agent-connections.js、render-settings.js、Worker profile 编辑/重试/继续模块及对应 DOM tests，必要样式。复用 connection list；不改 RPC/server/core/provider。
- 文档与集成：本章与设计/模块/用户文档、集成审查、组合测试与提交。

真实自定义端点模型请求和真实 OAuth 账号均需用户显式提供验证账号；自动测试只使用临时项目、mock 网络/CLI，不碰真实凭证。
