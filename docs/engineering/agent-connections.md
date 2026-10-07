# 账号资源连接器（首版实施契约）

用户决定 #124/#126：本轮只做连接器与额度观测，不自动模型路由；Lush 自己管理多个账号的密钥与登录，采用项目私有 0700 目录/0600 凭证文件（不是静态加密保险箱），固定审查 MIT 核心代码，不直接加载第三方插件或付费探测。首版 DeepSeek/OpenRouter/Z.AI/Kimi API Key 和 Codex OAuth；既有 Agent 状态/用量配置与历史不迁移、不覆盖外部客户端认证。

用户决定 #142 的共享保存、自定义 OpenAI 兼容 API、单 Worker 选择与默认关闭的受信调用前策略接口，由[共享模型选择增补](managed-model-selection.md)规定；该增补优先于本文的首版服务商列表和“本轮不实现”范围描述。

## 用户目标和安全边界

连接是项目 Agent 配置的技术附属项，不是新的顶级业务实体，也不是 Host 的电脑级账号池。连接明确绑定服务商、模型端点、认证和模型范围。同一服务商多个账号不能合并观测；更换凭证/账号后的旧曲线不能冒充新账号。查询失败不等于资源耗尽，不把未知写成零；现金、Key 预算、订阅窗口不可互换。正常模型响应的套餐头可被动采集，普通 RPM/TPM 头不冒充套餐余额。

所有管理/登录/查询接口用户专属。秘密只通过写入请求进入私有凭证文件，绝不通过读 API 返回（包括掩码前缀）、会话、事件、历史或错误信息泄漏。配置文件不能放在 agent worktree；禁止 symlink 与错误权限，原子写入。失败不静默回写。删除连接只移除对应配置与凭证，不删除旧历史或外部凭证。OAuth 状态、PKCE verifier 和未完成登录只在服务端短期持有；有界生命周期、状态验证和一次性兑换；不在 Agent 中执行登录。网络固定目的地/HTTPS、拒绝重定向、有界响应/超时、无模型探测，代理凭证不送官方账号接口。

## Provider / 凭证模块

`src/agent/connections.js` 导出 `ConnectionManager(config, options={})`，内部可拆分私有文件/OAuth/查询模块；options 允许 mock fetch/now，不在自动测试中读取真实凭证。凭证与配置存放 `<home>/credentials/agent-connections.json`，文件 version 1。

公开连接字段：

```js
{ id, label, provider, endpoint, auth_type, enabled, models, default_model, default_thinking, notify_reset,
  credential: {status, identity, expires_at} }
```

- id 新建时生成随机 UUID，更新不可改变；label 有界纯文本。
- provider 是 deepseek/openrouter/zai/kimi-coding/openai-codex；endpoint 是模型端点，默认官方模型端点，必须明确显示；不在 URL 中放秘密。
- auth_type 为 api_key/oauth；Codex 只支持 oauth，其他只支持 api_key。
- models 是可空的模型 ID 限制列表（物理 model id，不含 provider 前缀），不声称联网验证可用。
- default_model / default_thinking 是可空的默认设定：物理模型 ID（非空时必须在 models 范围内）与 Pi 思考等级（`settings.THINKING_LEVELS.pi`）。它们供「运行设置」一键填入；已有 Worker 主动换源时自动填入默认模型的界面规则见[切换来源](../design/agent-model-settings.md#切换来源)。它们不参与连接身份、凭证轮换或额度历史。
- notify_reset 是布尔本地偏好：用户在「模型来源」勾选后，页面在缓存观测的 `reset_at` 到达时标出该额度；系统通知开关已开启且已授权时另发浏览器通知。它不参与连接身份、凭证轮换或额度缓存命名空间，也不新增 daemon 后台调度。
- credential.status 为 configured/unconfigured/expired/unknown；存在本地凭证不代表验证登录成功；identity 服务端脱敏；expires_at 为 ISO/null。
- 凭证内保存的秘密从不放进公开连接。采样默认 `{enabled:false,interval_minutes:5,retention_days:90}`，校验范围同旧 usage 设置。

Manager 方法：

- `config()` -> `{version:1,sampling,connections:[公开连接]}`，本地只读，不联网。
- `save(connection, credential=null)` -> 公开连接。connection 全量公开配置 `{id?,label,provider,endpoint?,auth_type,enabled?,models?,default_model?,default_thinking?}`；不允许未知字段。credential 可选 `{api_key:string}`，省略/空不更换秘密；不得通过此方法写入任意 OAuth token。改 provider/auth_type 不沿用旧秘密。
- `remove(id)` -> `{removed:id}`；不存在 ID 明确失败。
- `configureSampling(sampling)` -> sampling。
- `identity(id)` -> 私密同步 `{account_key,source_key,revision}`，前两项与 query/prepareRuntime 一致；revision 是配置/凭证变动指纹，供迟到与外部更换校验，不经 RPC 返回。
- `query(id)` -> Promise `{id,account_key,source_key,observation}`；单连接专用额度查询，失败返回安全状态。不创建模型调用。OpenRouter Key 预算和账号 credits 两次查询独立，权限不足不能抹掉成功指标。
- `prepareRuntime(id)` -> Promise 私密 `{connection,credential,account_key,source_key}`；credential 为 `{type:'api_key',key}` 或 `{type:'oauth',access,refresh,expires,accountId?}`。检查 enabled/可用凭证，必要时仅刷新本项目自己的 Codex 凭证；更新/删除在途必须防止旧刷新覆盖新配置。
- `loginStart(id)` -> `{id,login_id,url,expires_at,redirect_uri,instructions}`；只允许 Codex oauth，固定授权 URL、PKCE/state。首版手动粘贴回调 URL，兼容远端 SSH，不启动不受控浏览器/CLI，也不覆盖外部 auth.json。
- `loginFinish(id,login_id,redirect_url)` -> 公开连接；验证回调 origin/path、state、超时和一次性消费；兑换失败只返回固定安全错误。OAuth refresh 与登录写回协调，不能覆盖已更换/删除的连接。
- `stop()` 取消未完成登录及在途请求；实现可同步或 Promise。

`observation`：

```js
{status, checked_at, source, resources, error_code, reason}
// status: available|partial|unknown|error|unsupported|unconfigured
// source: usage_api|client_rpc|response_headers|none
// resources: [{id,kind,scope,label,unit,remaining,total,used,used_percent,
//              reset_at,window_seconds,models}]
// kind balance|quota; scope account|key|model
```

所有字段严格白名单、有限数值、未知 null；reason 固定安全解释。partial 表示部分资源成功，不把可选 credits 无权限解释成 Key 预算失败。account_key 为匿名账号身份（OAuth 稳定账号 ID 或 API Key 摘要），source_key 隔离来源/端点配置；秘密不在这些标识中明文暴露。

## 项目服务 / 存储 / API

`src/core/agent-connections.js` 导出 `AgentConnectionsService(project, options={})`；持有 manager（可注入测试 stub）。

- `list()` -> manager.config() 加 checked_at；connections 每项追加 `observation`（无观测为 unknown）、可空 `last_success`、`consumers:[{task_id,model}]`（仅实际绑定且正在运行的本项目 Worker，不猜历史归因）。不联网。
- `save(connection,credential)` / `remove(id)` / `configureSampling(sampling)`，经项目写入准入，返回安全管理结果。
- `query(id=null)` -> Promise list()；null 刷新所有 enabled 连接；单飞按连接及实际配置/账号版本隔离，网络并发有界。每次真实观测存一次。配置/删除期间的迟到响应不覆盖当前连接。
- `history(id,days=7)` -> `{version:1,from,to,retention_days,series,truncated}`；series 形状兼容旧 renderUsageSeries 并追加 scope/models/source。连接内仍按 account_key/source_key/kind/id/unit/window 隔离。可读已删除连接历史。最多 40 series/500点每系列/680KB，降采样覆盖完整所选范围，失败/重置保留且标明截断。
- `observe(id,account_key,source_key,observation)` 为受信 runtime 内部入口，校验安全投影，只记录属于冻结的运行连接的反馈；不公开给 Agent 读写。
- `start()` / `stop()`：默认不采样；明确启用才启动 daemon 定时器，关页仍运行、停机不补采样。停止取消/等待在途操作。
- `prepareRuntime(id)` / `loginStart(id)` / `loginFinish(id,login_id,redirect_url)` 转发 manager 的同名方法；私密 runtime 结果不返回 RPC。

新增专用 Store mixin `store/agent-connections.js` 和附属表，不迁移旧 agent_usage 表。Store 独占 SQL，可自行命名内部方法，提供安全观测/最新成功/历史/清理能力。旧曲线按旧接口继续可读。

RPC（全部 USER_ONLY）：

- `agent.connections.list {}`
- `agent.connections.save {connection,credential?}`
- `agent.connections.remove {id}`
- `agent.connections.sampling {sampling}`
- `agent.connections.query {id?}`
- `agent.connections.history {id,days?}`
- `agent.connections.login.start {id}`
- `agent.connections.login.finish {id,login_id,redirect_url}`

HTTP GET `/api/agent/connections`、GET `/api/agent/connections/history?id=&days=`；其余统一 POST `/api/action` 转上述管理/查询 RPC。保留项目路由、Origin/认证、no-store。即使 query 是只读远端查询也用显式 action。不要把用户提交的 secrets/回调 URL写到审计事件或错误里。

## Web

用户决定 #152/#154：托管账号集中在独立「模型来源」页面（`#model-sources`），不再是 Agent 管理 tab；Agent 配置保留 `#agent-status`。`render-model-sources.js` 导出 `openModelSources({connectionId?})`；`render-agent-connections.js` 导出 `createAgentConnections({ownsPage,connectionId?})`，保留 `{node,load()}` 并增加来源选择与清理接口。本地列表、显式刷新单项/全部、添加/编辑/删除连接、密钥 password 输入（更换时才写，提交后清空）、采样设置、Codex 打开授权链接与粘贴回调、认证诊断、独立现金/Key预算/套餐窗口、旧值/来源/时间、历史和实际消费者。套餐额度用进度条表达已用比例并标出窗口（如 5 小时 / 7 天）与重置时间，详细口径、适用范围与原始读数收进折叠区；现金余额仍显金额，不用无总数的进度条。详情编辑器可设置 `default_model` / `default_thinking`。#255 已退役旧 HTTP 查询/映射编辑与旧采样；模型来源页仅按需保留旧余额历史只读存档，不与正式连接混合，契约见[旧存档](agent-usage.md)。删除需确认，说明不删除历史。登录会联网但不调用 Agent，使用 help，不标 agent-call。

用户决定 #249 的精简展示优先于 #186 的全量总览：默认等高行只显示来源名称、服务商 / 启停、本地凭证状态、默认模型、最多两项结构化余额 / 套餐摘要与缓存相对时间。套餐摘要保留结构化已用比例进度条，未知比例不画伪进度条，现金仍显金额；省略成功状态文字，保留失败 / 未知 / 部分可用提示，缓存相对时间放在刷新按钮旁。超过两项显示剩余项数并引导详情；失败不显示旧成功值冒充当前资源，未知不填零，现金与 Key 预算 / 套餐保持区分。端点、全部模型、默认思考深度、详细观测读数 / 来源 / 重置时间、旧值和实际消费者保留在单来源详情中，详情节点移到所选摘要行下方内联展开，重复点击 / 返回收起；列表仍可操作，重新读取和筛选后重新定位详情，未匹配的已选详情保留在列表底部。编辑、登录 / 历史 / 采样仍复用原操作面板。余额、剩余量和用量百分比加粗。列表位于管理台首部，统计 / 搜索 / 筛选 / 批量操作及添加等工具移到列表下方；追加排版反馈改为最右侧操作列，上次刷新时间在刷新按钮上方，详情按钮在刷新下方，编辑入口仅在详情中，窄屏也不把按钮另放一整行。订阅窗口标题简写为结构化 `5h` / `7d`，摘要显示额度重置剩余时间、本地按分钟更新，绝对日期 / 时间仅留在详情折叠区，到期标待刷新；时长与重置时间未知时明确提示，不按窗口位置猜测。原始指标名仍保留在详情折叠区。不提供全局「详情模式」开关；摘要不影响完整字段的本地搜索、筛选、多选或编辑 / 刷新动作。

用户决定 #186 的管理台改造优先于旧列表 / 详情布局（信息密度以 #249 为准）：全宽总览同时展示多连接设定、认证、观测与实际消费者；添加等操作位置以上述信息前置规则为准，逐行编辑走侧边面板，窄屏可读卡片与独立面板。勾选支持批量刷新、启用 / 停用，配置变更先确认具体范围、逐项报告失败；继续使用既有 `save` / `query` RPC，不新增批量接口。全量保存必须保留公开配置中的模型范围、默认模型 / 思考深度及端点，不提交未知读面字段或凭证状态。

页面保存或完成登录后，通过独立 `query {id}` 刷新支持查询且已启用、有凭证的连接，提前说明联网但不调用模型；`save` / 登录 RPC 本身不因此查询额度。保存成功与查询失败分开反馈，迟到结果仍遵守页面身份与账号隔离。主显示用本地重置倒计时，绝对时间留在详情；到期提示待刷新，不修改观测状态或额度。

额度区主显示「上次刷新」相对时长，绝对观测时间与来源收进折叠详情。逐来源可勾选 `notify_reset` 额度刷新提醒：页面在缓存观测的 `reset_at` 到达时标出到期并按来源/指标/`reset_at` 去重提醒；同一 `reset_at` 只提醒一次，刷新后 `reset_at` 变化则按新时间重新计时。浏览器系统通知沿用既有总开关，首次载入与刷新不补发页面关闭期间积压的提醒；提醒不新增 daemon 调度，也不断言额度已恢复。模型输入提供物理 ID 示例与限定调用名预览；合法 `vendor/model` 物理 ID 不得按斜杠机械截断。设计取舍见[模型来源](../design/agent-model-settings.md#模型来源)。

「运行设置」共用表单（`agent-profile-form.js`）在已选托管来源时可一键填入该来源的默认模型（限定为 `provider/model`）与思考深度；只改这两项，未读来源或无默认时给就地提示，不调用 Agent，保存前仍可修改。已有 Worker 主动换源时默认模型的自动填入例外见[切换来源](../design/agent-model-settings.md#切换来源)；思考深度仍不自动改变。

配置页 profile 的 `connection_id` 为后续 Pi 调用必需来源（空不会恢复外部 Pi 认证）；由 parent 实现后端校验与执行绑定。Web可从 list API加载可用连接选项；首版只支持 Pi绑定（Codex执行后端仍走原凭证），明确提示固定物理 provider/model且模型限制必须匹配。配置保存不改变正在运行的 invocation。

## Codex 设备码登录追加

用户决定 #135：新增默认设备码登录，原回调 URL 登录保留为显式备用。新增用户专属 `agent.connections.device.start/poll/cancel`，协议、生命周期、Web 自动确认及文件分工见[Codex 设备码登录](codex-device-login.md)。仍只托管本项目凭证，不读取或改写外部 Pi 登录，不调用模型。

## Pi 显式绑定与被动观测（parent）

Agent profile 的 connection_id 仅 Pi 允许，所有后续 Pi invocation 必须绑定，未绑定明确失败、不回退外部认证。prepareRuntime 冻结连接与账号并验证物理 provider/model、模型范围。`<home>/pi/` 为 Lush 项目独立基础配置，每次调用使用私有快照经 `PI_CODING_AGENT_DIR` 提供，不复制用户默认 Pi 的设置、模型覆盖、全局 Prompt 或凭证，不改写外部 Pi。秘密不放 argv/上下文/日志。临时 OAuth 认证只携带 access token，不复制 refresh token；长调用过期可能失败，下一次由 Lush 协调刷新，不能让多个 Worker 竞争刷新。`--no-approve` 防项目 `.pi` 重定向端点，项目 AGENTS 和显式扩展/Skills 保留。旧历史不迁移删除；不实现虚拟模型、自动降级或付费切换。Worker 窄更新与安全选择摘要见[共享模型选择](managed-model-selection.md)。

正常响应只采集指定套餐头，匹配运行 provider，写入受限临时安全观测文件；daemon 在 invocation退出时吸收观测（不是实时轮询），失败退出也处理。文件不含原始 headers/token；记录后清理。本轮空闲时仍通过专用接口查询。需要跨账号绑定和实际模型请求的真实验证，由用户显式提供测试账号另行进行，不在自动测试中操作真实凭证。

## 并行边界

- Provider child：`src/agent/connections*.js`、`test/agent/connections*.test.js`、新 MIT attribution/LICENSE；不改旧 status/usage，也不改 parent profile/provider。
- Runtime child：`src/core/agent-connections.js`、Project base/agents/lifecycle、Store新表/mixin、RPC registry/system、Web server路由、新 test/project/persistence/rpc/web-server；不改 provider、settings、Pi extension或Web assets。
- Web child：Web新 panel/style及 Agent页/设置页/index 接入、新 DOM测试；不改 server/RPC/backend。
- Parent：本契约与设计理念/索引/模块文档、Agent profile/runtime显式绑定、Pi被动观测、组合验证和全量测试。
