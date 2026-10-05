# 账号资源连接器（首版实施契约）

用户决定 #124/#126：本轮只做连接器与额度观测，不自动模型路由；Lush 自己管理多个账号的密钥与登录，采用项目私有 0700 目录/0600 凭证文件（不是静态加密保险箱），固定审查 MIT 核心代码，不直接加载第三方插件或付费探测。首版 DeepSeek/OpenRouter/Z.AI/Kimi API Key 和 Codex OAuth；既有 Agent 状态/用量配置与历史不迁移、不覆盖外部客户端认证。

## 用户目标和安全边界

连接是项目 Agent 配置的技术附属项，不是新的顶级业务实体，也不是 Host 的电脑级账号池。连接明确绑定服务商、模型端点、认证和模型范围。同一服务商多个账号不能合并观测；更换凭证/账号后的旧曲线不能冒充新账号。查询失败不等于资源耗尽，不把未知写成零；现金、Key 预算、订阅窗口不可互换。正常模型响应的套餐头可被动采集，普通 RPM/TPM 头不冒充套餐余额。

所有管理/登录/查询接口用户专属。秘密只通过写入请求进入私有凭证文件，绝不通过读 API 返回（包括掩码前缀）、会话、事件、历史或错误信息泄漏。配置文件不能放在 agent worktree；禁止 symlink 与错误权限，原子写入。失败不静默回写。删除连接只移除对应配置与凭证，不删除旧历史或外部凭证。OAuth 状态、PKCE verifier 和未完成登录只在服务端短期持有；有界生命周期、状态验证和一次性兑换；不在 Agent 中执行登录。网络固定目的地/HTTPS、拒绝重定向、有界响应/超时、无模型探测，代理凭证不送官方账号接口。

## Provider / 凭证模块

`src/agent/connections.js` 导出 `ConnectionManager(config, options={})`，内部可拆分私有文件/OAuth/查询模块；options 允许 mock fetch/now，不在自动测试中读取真实凭证。凭证与配置存放 `<home>/credentials/agent-connections.json`，文件 version 1。

公开连接字段：

```js
{ id, label, provider, endpoint, auth_type, enabled, models,
  credential: {status, identity, expires_at} }
```

- id 新建时生成随机 UUID，更新不可改变；label 有界纯文本。
- provider 是 deepseek/openrouter/zai/kimi-coding/openai-codex；endpoint 是模型端点，默认官方模型端点，必须明确显示；不在 URL 中放秘密。
- auth_type 为 api_key/oauth；Codex 只支持 oauth，其他只支持 api_key。
- models 是可空的模型 ID 限制列表（物理 model id，不含 provider 前缀），不声称联网验证可用。
- credential.status 为 configured/unconfigured/expired/unknown；存在本地凭证不代表验证登录成功；identity 服务端脱敏；expires_at 为 ISO/null。
- 凭证内保存的秘密从不放进公开连接。采样默认 `{enabled:false,interval_minutes:5,retention_days:90}`，校验范围同旧 usage 设置。

Manager 方法：

- `config()` -> `{version:1,sampling,connections:[公开连接]}`，本地只读，不联网。
- `save(connection, credential=null)` -> 公开连接。connection 全量公开配置 `{id?,label,provider,endpoint?,auth_type,enabled?,models?}`；不允许未知字段。credential 可选 `{api_key:string}`，省略/空不更换秘密；不得通过此方法写入任意 OAuth token。改 provider/auth_type 不沿用旧秘密。
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

Agent 管理页新增“账号连接” tab，`render-agent-connections.js` 导出 `createAgentConnections({ownsPage})` -> `{node,load()}`。本地列表、显式刷新单项/全部、添加/编辑/删除连接、密钥 password 输入（更换时才写，提交后清空）、采样设置、Codex 打开授权链接与粘贴回调、认证诊断、独立现金/Key预算/套餐窗口、旧值/来源/时间、历史和实际消费者。高级旧 HTTP 映射保留在旧状态页，不能成为首选流程。删除需确认，说明不删除历史。登录会联网但不调用 Agent，使用 help，不标 agent-call。

配置页 profile 可选 `connection_id`（空代表旧 CLI 认证）；由 parent 实现后端校验与执行绑定。Web可从 list API加载可用连接选项；首版只支持 Pi绑定（Codex执行后端仍走原凭证），明确提示固定物理 provider/model且模型限制必须匹配。配置保存不改变正在运行的 invocation。

## Codex 设备码登录追加

用户决定 #135：新增默认设备码登录，原回调 URL 登录保留为显式备用。新增用户专属 `agent.connections.device.start/poll/cancel`，协议、生命周期、Web 自动确认及文件分工见[Codex 设备码登录](codex-device-login.md)。仍只托管本项目凭证，不读取或改写外部 Pi 登录，不调用模型。

## Pi 显式绑定与被动观测（parent）

在 Agent profile 加可选 connection_id，仅 Pi允许。每次 invocation 用 prepareRuntime 冻结连接与账号，验证模型 provider/id、models范围。使用受控 invocation 私有 Pi认证目录把秘密提供给子进程，不放 argv/上下文/日志，不更改外部 Pi配置。明确指定物理模型；没有连接时旧行为不变。临时 Pi 认证只携带 access token，不复制可轮换的 refresh token；若长调用期间 access token 过期，当前调用安全失败，下一次由 Lush 协调刷新，不允许多个 Worker 竞争刷新。保留原全局 Pi 的受控行为设置与上下文文件，但不继承外部凭证、模型端点/请求头和自动资源发现；传 `--no-approve` 禁用 trust-gated 项目 `.pi` 配置，避免覆盖托管端点，显式扩展/Skills仍保留。本轮不实现虚拟模型、自动降级或付费切换。

正常响应只采集指定套餐头，匹配运行 provider，写入受限临时安全观测文件；daemon 在 invocation退出时吸收观测（不是实时轮询），失败退出也处理。文件不含原始 headers/token；记录后清理。本轮空闲时仍通过专用接口查询。需要跨账号绑定和实际模型请求的真实验证，由用户显式提供测试账号另行进行，不在自动测试中操作真实凭证。

## 并行边界

- Provider child：`src/agent/connections*.js`、`test/agent/connections*.test.js`、新 MIT attribution/LICENSE；不改旧 status/usage，也不改 parent profile/provider。
- Runtime child：`src/core/agent-connections.js`、Project base/agents/lifecycle、Store新表/mixin、RPC registry/system、Web server路由、新 test/project/persistence/rpc/web-server；不改 provider、settings、Pi extension或Web assets。
- Web child：Web新 panel/style及 Agent页/设置页/index 接入、新 DOM测试；不改 server/RPC/backend。
- Parent：本契约与设计理念/索引/模块文档、Agent profile/runtime显式绑定、Pi被动观测、组合验证和全量测试。
