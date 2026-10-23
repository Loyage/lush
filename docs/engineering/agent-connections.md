# 账号资源连接器（首版实施契约）

本章负责账号连接与安全资源观测：私有 0700 目录／0600 文件不是加密保险箱或 OS 沙箱，不加载未经审查插件、不发付费模型探测。技术配置设备唯一，项目执行／历史隔离，旧源只经[显式迁移](device-settings.md)；当前 scope 以[用户工作台](user-workspace.md#设备配置分区)为准。

Manager／Service 的派生作用域共用受控生命周期，登录／目录／OAuth 锁落实际凭证根，stop 包含派生实例，无项目 Host 不建项目历史／消费者。storage_scope 为公开读字段，不能据此授权选根。自定义兼容端点和默认关闭受信策略见[模型选择](managed-model-selection.md)。

## 用户目标和安全边界

连接是设备技术配置的附属项，不是新的顶级业务实体或 Host 跨项目调度账号池。连接明确绑定服务商、模型端点、认证和模型范围。同一服务商多个账号不能合并观测；更换凭证/账号后的旧曲线不能冒充新账号。查询失败不等于资源耗尽，不把未知写成零；现金、Key 预算、订阅窗口不可互换。正常模型响应的套餐头可被动采集，普通 RPM/TPM 头不冒充套餐余额。

所有管理/登录/查询接口用户专属。秘密只通过写入请求进入私有凭证文件，绝不通过读 API 返回（包括掩码前缀）、会话、事件、历史或错误信息泄漏。配置文件不能放在 agent worktree；禁止 symlink 与错误权限，原子写入。失败不静默回写。删除连接只移除对应配置与凭证，不删除旧历史或外部凭证。OAuth 状态、PKCE verifier 和未完成登录只在服务端短期持有；有界生命周期、状态验证和一次性兑换；不在 Agent 中执行登录。网络固定目的地/HTTPS、拒绝重定向、有界响应/超时、无模型探测，代理凭证不送官方账号接口。

## Provider / 凭证模块

`src/agent/connections.js` 导出 `ConnectionManager(config, options={})`，内部可拆分私有文件/OAuth/查询模块；options 允许 mock fetch/now，不在自动测试中读取真实凭证。生产凭证与配置固定存放 `<deviceHome>/credentials/agent-connections.json`，文件 version 1；旧项目文件只供[显式迁移](device-settings.md#显式迁移连接与迁移分区)，不作活跃覆盖。

公开连接字段：

```js
{ id, label, provider, endpoint, auth_type, enabled, models, default_model, default_thinking, notify_reset,
  credential: {status, identity, expires_at} }
```

- id 新建时生成随机 UUID，更新不可改变；label 有界纯文本。
- provider 是 deepseek/openrouter/zai/kimi-coding/openai-codex/openai-compatible；endpoint 是模型端点，默认官方模型端点，必须明确显示；不在 URL 中放秘密。
- auth_type 为 api_key/oauth；Codex 只支持 oauth，其他只支持 api_key；兼容端点规则见[模型选择](managed-model-selection.md#共享连接)。
- models 是可空的模型 ID 限制列表（物理 model id，不含 provider 前缀），不声称联网验证可用。
- default_model / default_thinking 是保留的可空来源设定：物理模型 ID（非空时必须在 models 范围内）与 Pi 思考等级（`settings.THINKING_LEVELS.pi`）。W392 的运行设置改用[已注册模型](#设备共享命名模型登记w392--d770)，不再从来源一键填入模型／思考深度。它们不参与连接身份、凭证轮换或额度历史。
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
- `prepareRuntime(id)` -> Promise 私密 `{connection,credential,account_key,source_key}`；credential 为 `{type:'api_key',key}` 或 `{type:'oauth',access,refresh,expires,accountId?}`。检查 enabled/可用凭证，必要时协调刷新实际存储根的 Lush 托管 Codex 凭证，多个 daemon 复用同一 refresh 锁；更新/删除在途必须防止旧刷新覆盖新配置。
- `loginStart(id)` -> `{id,login_id,url,expires_at,redirect_uri,instructions}`；只允许 Codex oauth，固定授权 URL、PKCE/state。此为手动回调的显式备用路径，默认设备码协议见[设备码登录](codex-device-login.md)，兼容远端 SSH，不启动不受控浏览器/CLI，也不覆盖外部 auth.json。
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

- `list()` -> manager.config() 加 checked_at；connections 每项追加 `observation`（无观测为 unknown）、可空 `last_success`、`consumers:[{task_id,task_worker_number,model}]`（仅实际绑定且正在运行的本项目 Worker，不猜历史归因；`task_worker_number` 为可空的显式用户编号，`task_id` 仍为内部整数）。不联网。
- `save(connection,credential)` / `remove(id)` / `configureSampling(sampling)`，经项目写入准入，返回安全管理结果。
- `query(id=null)` -> Promise list()；null 刷新所有 enabled 连接；单飞按连接及实际配置/账号版本隔离，网络并发有界。每次真实观测存一次。配置/删除期间的迟到响应不覆盖当前连接。
- `history(id,days=7)` -> `{version:1,from,to,retention_days,series,truncated}`；series 形状兼容旧 renderUsageSeries 并追加 scope/models/source。连接内仍按 account_key/source_key/kind/id/unit/window 隔离。可读已删除连接历史。最多 40 series/500点每系列/680KB，降采样覆盖完整所选范围，失败/重置保留且标明截断。
- `observe(id,account_key,source_key,observation)` 为受信 runtime 内部入口，校验安全投影，只记录属于冻结的运行连接的反馈；不公开给 Agent 读写。
- `start()` / `stop()`：默认不采样；明确启用才启动 daemon 定时器，关页仍运行、停机不补采样。停止取消/等待在途操作。
- `prepareRuntime(id)` / `loginStart(id)` / `loginFinish(id,login_id,redirect_url)` 转发 manager 的同名方法；私密 runtime 结果不返回 RPC。

Store 的附属观测表负责项目历史／最新成功／清理，SQL 不进入 Provider 或 Web。不迁移旧 agent_usage 表，旧曲线仍按旧只读接口可查。

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

## 设备共享命名模型登记（W392 / D770）

模型登记是设备设置的附属索引，不是运行时虚拟模型或新核心实体。`RegisteredModelManager`（`src/agent/registered-models.js`）由 ConnectionManager 懒加载，项目通过 AgentConnectionsService / Project 转发，无项目 Host 复用同一 Manager。存储固定 `<deviceHome>/credentials/agent-registered-models.json`，version 1；不导入旧配置、不读外部认证、不改来源、profile、Worker 或历史。

- 每行保存 `{id,name,connection_id,model}`。id 为服务端生成的稳定随机 UUID；更新必须引用现存 id，删除后的 id 不能用于重建。name 去首尾空白后非空、最多 128 UTF-8 字节、无控制／方向覆盖字符，设备内大小写敏感精确唯一；拒绝与其他登记 id 冲突的名称。
- model 是最多 256 UTF-8 字节的限定 `provider/physical-model-id`，不带思考深度；只移除已匹配的 provider 前缀检查范围，物理 ID 中的斜杠保持原样。未限定 models 的既有来源沿用原允许范围，不把目录缓存或本地登记当作远端验证。
- 最多 50 条，不分页、不静默裁剪或淘汰；超限保存明确拒绝。文件沿用 ConnectionFile 的 0700/0600、所有者／非链接／单硬链接、有界读取、原子替换协议；写入使用同一设备 `settings-write` 跨进程门与独立登记锁，和来源变更串行。读取缺失返回空列表且不创建目录，损坏／不安全存储 fail closed，不修复、不回退。
- save 仅允许现存、启用、有已配置凭证且模型在范围内的来源。OAuth 过期但可经原 runtime 刷新的连接仍可选；不在 list/save/resolve 中联网、刷新登录或探测模型。`selectable` 只表示本地配置资格，真实调用仍由原 prepareRuntime 校验／刷新。
- list/save 返回安全行 `{id,name,connection_id,model,selectable,reason,storage_scope:'device',source}`。source 为 null 或 `{id,label,provider,endpoint,enabled,auth_type,credential_status}`，无秘密／账号身份／原始响应。reason 为 null（可选）或 `source_missing|source_disabled|credential_unconfigured|source_unsupported|provider_mismatch|model_out_of_scope`。来源删除／停用／换 provider／缩小范围后保留登记并即时给诊断；resolve 拒绝失效登记，不回退其他来源。

RPC：

- `agent.registered_models.list {scope?}` → `{version:1,models:[安全行],storage_scope:'device'}`。
- `agent.registered_models.save {model:{id?,name,connection_id,model},scope?}` → 安全行。
- `agent.registered_models.remove {id,scope?}` → `{removed:id}`。
- `agent.registered_models.resolve {selector,scope?}` → **仅** `{id,name,connection_id,model}`；selector 必须精确匹配稳定 id 或唯一名称，不裁剪查询、不模糊猜选。

scope 缺省为 device，project 明确拒绝。全部方法对普通开发 Agent 为 USER_ONLY；W400／D782 使项目 Valet 经既有受控管理桥获得 list/resolve 的安全 read 权限，无需设备关键词或显式 `scope:'device'`，仍受最新 read／unavailable 限制；指定 scope 时只接受 device。设备共享写方法不向普通项目身份或项目单条提权开放，旧管理员目录不恢复授权，边界见[管家权限](hook-signals-management.md#设备全局管家权限)。CLI 查询／选择由同源 CommandSpec 注册，经真实 `lush_cli` bridge 使用这些接口；不以 RPC 可调用冒充 Provider 工具可用。

HTTP 本地读取为 GET `/api/agent/registered-models` 与 `/api/host/settings/agent/registered-models`；save/remove/resolve 分别经原项目 `/api/action` 或 Host `/api/host/settings/action` 的同名 RPC action，复用认证、Origin、参数白名单和 no-store。可选 scope 只接受 device，拒绝未知／重复 query。

选择后，调用方将 resolve 的 **connection_id + model 值** 提交既有 profile／Worker 配置，不保存登记 id 为动态绑定。登记编辑／删除不追改任何已有具体绑定；旧绑定没有对应登记时应显示「未注册当前配置」，不能自动导入或重新匹配来源。思考深度独立保存。本阶段不改变 scheduler/profile schema，也不改变 `agent.selection.resources`。

### CLI 与管家选择

```bash
bun run lush agent model list --scope device
bun run lush agent model resolve astra --scope device
bun run lush order '实现功能' --registered-model astra --scope device --data '{"thinking":"high"}'
bun run lush worker config set W5 --registered-model astra --scope device
```

`agent model list` 默认列已注册模型、具体来源和不可选原因；显式 `--backend pi|codex` 保留原后端候选查询，不能混为登记清单。`resolve` 只读精确名称或稳定 ID，不联网、不探测、不模糊匹配。Valet 应先读取清单再按精确名称选择；安全读取和解析不需要用户设备关键词，`--scope device` 可省略。读取权限被用户收紧为 unavailable 时仍拒绝，不换身份或接口绕过。

`order --registered-model` 先解析，再显式提交 Pi/lush 的具体 profile；`--data` 可补其它合法运行参数，不能包含 connection_id/model（包括 null）或冲突 agent/config_mode。不读取私有默认配置、不偷偷改写用户显式模式。`worker config set --registered-model` 与 `--connection/--model/--data` 互斥，解析后走既有 `model_selection` 原子窄更新，保留其余覆盖；目标不是 Pi lush 时拒绝，不隐式切换。`--scope device` 在这两个项目命令中仅用于登记解析，后续项目写请求不携带 scope，仍独立检查原权限、确认与生命周期。

高级暂存／其他入口可将 resolve 返回的具体 connection_id+model 放入用户明确提供的完整 `--data` profile。选择不授予登记写权限，登记编辑／删除不追改已保存绑定；失效、未找到或拒绝授权时不回退、不启动。专项以 `test/project/management-cli.test.js` 的可控 Provider→唯一真实 CLI 工具→解析／权限→具体绑定链为证，不使用付费模型或真实凭证。

## 设备共享最新余额缓存（W152）

设备连接的最新观测以 `<deviceHome>/credentials/agent-connection-observations.json` 持久化，所有生产连接均读同一设备根，不从旧项目凭证或数据库补当前设备值。项目数据库只保留自身观测历史，不自动导入旧余额。缓存归实际设备根，Manager `cachedObservation(id)` 只读本地文件，`recordObservation(id,account_key,source_key,observation)` 校验当前匿名身份后写入。项目显式查询、启用后的采样、受信被动反馈及无项目 Host 显式查询均更新共享缓存；所有项目和 Host 列表直接重读该文件，无需逐项目联网刷新，不复制进各项目历史。

缓存仅保存归一化的最新 `observation` 和 `last_success:{checked_at,observation}|null`。命名空间包括稳定 connection ID、账号与来源（含服务商、端点及模型限制），同服务商／同名不同连接、不同账号及迁移来源的同 UUID 不得互用；旧源不形成活跃阴影。普通 OAuth token 轮换保留同账号观测，修改标签/默认模型不要求重新查询。最新失败不冒充零余额，旧成功仅作为 `last_success`；按 `checked_at` 单调更新，迟到观测不能覆盖更新值。

文件 0600，凭证目录 0700；沿用实际存储根校验、跨进程配置/缓存锁、原子替换、无 symlink/foreign owner/硬链接和有限大小（2 MiB、60 个命名空间，超限淘汰最旧条目）。不保存原始响应、headers、凭证、Worker、消费者或历史曲线。损坏或不安全缓存明确失败，不回退其它项目值或偷偷修复。既有项目数据库样本不自动导入设备缓存；首次使用新缓存需在任一入口刷新一次，之后各项目复用同一观测。

历史仍只由实际产生观测的项目记入自己的 SQLite，读取共享最新值不补造本项目历史；实际消费者只来自当前项目冻结运行绑定，无项目 Host 仍无历史和消费者。连接配置主流程见 `test/agent/connections.test.js`；设备观测、项目查询与迟到身份变化组合不再保留独立回归，覆盖取舍见[贡献指南](../contributing/README.md#覆盖取舍)。

## Web

W392／D770 将页面升级为「模型和来源」，默认模型页签，旧来源管理归来源页签；当前注册、共享选择器及深链规则以[页面设计](../design/agent-model-settings.md#模型和来源)为准。下文历史来源管理决定仅描述保留的来源功能，不恢复独立来源选择流程。

用户决定 #152/#154：托管账号集中在独立「模型来源」页面（`#model-sources`），不再是 Agent 管理 tab；Agent 配置保留 `#agent-status`。`render-model-sources.js` 导出 `openModelSources({connectionId?})`；`render-agent-connections.js` 导出 `createAgentConnections({ownsPage,connectionId?})`，保留 `{node,load()}` 并增加来源选择与清理接口。本地列表、显式刷新单项/全部、添加/编辑/删除连接、密钥 password 输入（更换时才写，提交后清空）、采样设置、Codex 打开授权链接与粘贴回调、认证诊断、独立现金/Key预算/套餐窗口、旧值/来源/时间、历史和实际消费者。套餐额度用进度条表达已用比例并标出窗口（如 5 小时 / 7 天）与重置时间，详细口径、适用范围与原始读数收进折叠区；现金余额仍显金额，不用无总数的进度条。详情编辑器可设置 `default_model` / `default_thinking`。#255 已退役旧 HTTP 查询/映射编辑与旧采样；模型来源页仅按需保留旧余额历史只读存档，不与正式连接混合，契约见[旧存档](agent-usage.md)。删除需确认，说明不删除历史。登录会联网但不调用 Agent，使用 help，不标 agent-call。

用户决定 #249 的精简展示优先于 #186 的全量总览：默认等高行只显示来源名称、服务商 / 启停、本地凭证状态、默认模型、最多两项结构化余额 / 套餐摘要与缓存相对时间。套餐摘要保留结构化已用比例进度条，未知比例不画伪进度条，现金仍显金额；省略成功状态文字，保留失败 / 未知 / 部分可用提示，缓存相对时间放在刷新按钮旁。超过两项显示剩余项数并引导详情；失败不显示旧成功值冒充当前资源，未知不填零，现金与 Key 预算 / 套餐保持区分。端点、全部模型、默认思考深度、详细观测读数 / 来源 / 重置时间、旧值和实际消费者保留在单来源详情中，详情节点移到所选摘要行下方内联展开，重复点击 / 返回收起；列表仍可操作，重新读取和筛选后重新定位详情，未匹配的已选详情保留在列表底部。编辑、登录 / 历史 / 采样仍复用原操作面板。余额、剩余量和用量百分比加粗。列表位于管理台首部，统计 / 搜索 / 筛选 / 批量操作及添加等工具移到列表下方；追加排版反馈改为最右侧操作列，上次刷新时间在刷新按钮上方，详情按钮在刷新下方，编辑入口仅在详情中，窄屏也不把按钮另放一整行。订阅窗口标题简写为结构化 `5h` / `7d`，摘要显示额度重置剩余时间、本地按分钟更新，绝对日期 / 时间仅留在详情折叠区，到期标待刷新；时长与重置时间未知时明确提示，不按窗口位置猜测。原始指标名仍保留在详情折叠区。不提供全局「详情模式」开关；摘要不影响完整字段的本地搜索、筛选、多选或编辑 / 刷新动作。

用户决定 #186 的管理台改造优先于旧列表 / 详情布局（信息密度以 #249 为准）：全宽总览同时展示多连接设定、认证、观测与实际消费者；添加等操作位置以上述信息前置规则为准，逐行编辑走侧边面板，窄屏可读卡片与独立面板。勾选支持批量刷新、启用 / 停用，配置变更先确认具体范围、逐项报告失败；继续使用既有 `save` / `query` RPC，不新增批量接口。全量保存必须保留公开配置中的模型范围、默认模型 / 思考深度及端点，不提交未知读面字段或凭证状态。

页面保存或完成登录后，通过独立 `query {id}` 刷新支持查询且已启用、有凭证的连接，提前说明联网但不调用模型；`save` / 登录 RPC 本身不因此查询额度。保存成功与查询失败分开反馈，迟到结果仍遵守页面身份与账号隔离。主显示用本地重置倒计时，绝对时间留在详情；到期提示待刷新，不修改观测状态或额度。

额度区主显示「上次刷新」相对时长，绝对观测时间与来源收进折叠详情。逐来源可勾选 `notify_reset` 额度刷新提醒：页面在缓存观测的 `reset_at` 到达时标出到期并按来源/指标/`reset_at` 去重提醒；同一 `reset_at` 只提醒一次，刷新后 `reset_at` 变化则按新时间重新计时。浏览器系统通知沿用既有总开关，首次载入与刷新不补发页面关闭期间积压的提醒；提醒不新增 daemon 调度，也不断言额度已恢复。模型输入提供物理 ID 示例与限定调用名预览；合法 `vendor/model` 物理 ID 不得按斜杠机械截断。设计取舍见[模型来源](../design/agent-model-settings.md#模型来源)。

「运行设置」共用表单（`agent-profile-form.js`）选择已注册模型并固定具体来源／模型值，思考深度独立保存；旧来源默认填入动作已被替代。未注册旧绑定与登记变更后的展示规则见[切换来源](../design/agent-model-settings.md#切换来源)。

来源／配置模式的选择以[双模式契约](agent-configuration-v2.md#profile-模式)为准；Web 只读本地连接选项，后端核验 Lush Pi 的精确来源及物理 provider/model 范围，Codex CLI 保持自身认证。保存不改变当前 invocation，不把未绑定当成自动切换机器默认 Pi 的授权。

## Codex 设备码登录追加

用户决定 #135：新增默认设备码登录，原回调 URL 登录保留为显式备用。新增用户专属 `agent.connections.device.start/poll/cancel`，协议、生命周期、Web 自动确认及文件分工见[Codex 设备码登录](codex-device-login.md)。凭证仍归私有设备根，不读取或改写外部 Pi 登录，不调用模型。

## Pi 显式绑定与被动观测（parent）

模式、独立配置、项目上下文和资源隔离只以[双模式契约](agent-configuration-v2.md#profile-模式)为准。本节的托管准备／反馈只用于 Lush Pi：prepareRuntime 固定设备连接／账号与物理模型范围；项目私有调用快照仅携 access token，不复制 refresh token。秘密不进 argv／上下文／日志，令牌过期可使长调用失败，下一次由设备连接管理器协调刷新，多个 Worker 不竞争刷新。旧会话／历史不删除，不实现虚拟模型或隐式付费切换；窄更新与安全选择摘要见[模型选择](managed-model-selection.md)。

正常响应只采集指定套餐头，匹配运行 provider，写入受限临时安全观测文件；daemon 在 invocation退出时吸收观测（不是实时轮询），失败退出也处理。文件不含原始 headers/token；记录后清理。显式资源查询使用专用接口，不因 Pi 默认模式而引入托管绑定。需要跨账号绑定和实际模型请求的真实验证，由用户显式提供测试账号另行进行，不在自动测试中操作真实凭证。

## 并行边界

凭证／Provider、项目观测与调用绑定、用户编辑界面分离；长期职责从[模块地图](modules.md)定位。专项与受影响回归使用临时文件／mock 上游；真实账号登录／跨账号模型调用须用户显式提供测试资源，不用配置保存或 mock 证明可用。
