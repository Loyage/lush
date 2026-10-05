# 共享 API 与调用前模型选择

本章说明共享 API、手动模型选择及未来规则程序的受信扩展接口，面向维护者。用户决定 #142：内置服务商和自定义 OpenAI 兼容 API 均存入当前项目连接库；登录统一托管，按执行后端能力使用；提供项目默认与单 Worker 显式选择；本轮预留安全资源读面与受信调用前策略接口，不实现自动路由规则或用户脚本。

本章增补[账号连接契约](agent-connections.md)。连接仍是项目技术附属配置，不是 Host 的整机账号池。不迁移外部客户端登录，不修改旧观测历史。

## 共享连接

- 新 provider `openai-compatible`，auth_type=`api_key`；用户必须显式填写 HTTPS 模型端点和非空物理模型 ID 列表。不同端点/密钥各自保存为不同连接。
- Pi 物理模型名使用 `openai-compatible/<model-id>`。invocation 的私有 models.json 为该端点注册指定模型，使用 OpenAI chat-completions 兼容协议，不向官方 OpenAI 接口转发自定义密钥。只支持此兼容协议，不声称覆盖 Responses、Anthropic 或任意私有协议。
- 兼容模型的本地运行预算固定为 32768 context / 4096 output，仅文本/tool，不声明图片或推理能力。这些值不是上游探测到的限制；更小的上游限制仍可能导致请求失败。Pi schema 的 cost 零值仅为占位，不代表免费或已测得真实成本，不能用于余额路由。
- 自定义 API 尚无专用余额适配；查询返回 unsupported/未知，不联网调用模型、猜测余额或发向内置服务商查询地址。未来可增补专用查询适配。本轮不新增任意查询脚本。
- API Key 和 OAuth 均归连接，不归 Worker/profile；只有支持该连接的后端能引用。当前托管 runtime 仅 Pi，Codex CLI 保留原认证；不能把支持 Codex 登录误称为支持 Codex CLI 托管绑定。

## 选择与默认兼容

- 项目默认/角色配置保留现有 connection_id + model 字段。Web 从本地连接列表展示匹配模型供选择；可填写内置服务商未限定的模型。
- 单 Worker 的暂停配置、继续与失败重试复用既有 profile 接口，补全显式连接选择和匹配模型。保存配置不调用 Agent；继续/重试才调用，必须沿用 agent-call 标识。不切换进行中的 invocation。
- 无连接、无策略时不能为启动普通 Worker 读取托管凭证文件或联网，原 provider.resolve/profile 行为不变。
- 明确设置的 Worker retry_profile 优先，不被自动策略覆盖；项目默认是策略的基线。策略返回空表示保留原配置，不能自动降级或换执行后端。

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
