# Agent 管理、状态与用量历史

本文说明 Web「Agent 管理」页面的配置、安装、账号、额度查询及历史曲线。查询不调用模型，额度请求不依赖 Pi 运行时；已选官方 Codex 的过期 OAuth 可通过独立认证适配刷新。数据来自当前项目 daemon 的 Pi 配置，不是浏览器本机。实现与字段契约见 [Agent 额度查询与历史曲线](../../engineering/agent-usage.md)。

## 页面与数据来源

其他分组的「Agent 管理」沿用 `#agent-status` 地址，分「状态 / 账号连接 / 设置」页签，默认打开旧状态。账号连接独立管理托管账号，不改旧查询和历史。设置页签容纳项目默认 Agent、角色覆盖、模型、思考深度、软预算、Prompt、扩展 / Skills 与环境变量；配置按需读取，保存只影响后续调用，不会启动 Agent。切换页签保留已查询状态和未保存输入。

原「设置」更名为「系统设置」（`#settings`），仅管理界面偏好与系统运行参数。Agent 管理的状态页签展示：

- **安装**：Pi 命令、版本、真实路径、配置目录及当前 Agent 后端和模型；失败字段显示未知。
- **账号**：本地 `auth.json`、模型配置和已知凭证环境变量；身份脱敏，凭证存在不等于联网登录验证成功。
- **模型**：安全读取已安装 Pi SDK 的本地元数据并按本地凭证筛选，不加载扩展动态模型；失败回退明确标为预设。
- **资源**：已发现的扩展、Skills、包声明与安装路径；发现不代表运行中的 Worker 已加载。
- **余额 / 额度**：当前查询结果、额度窗口和重置时间；失败时可附最后成功值及其旧时间，不冒充最新。
- **查询设置与剩余量历史**：页面表单配置查询来源、范围、后台采样及保留期；账号和指标分别成图，附数据表。

页面不自动轮询。进入页面或点击「刷新状态」发起查询并自动缓存；查看历史、切换范围或点击「刷新历史缓存」只读本地数据。实时状态查询整体失败时，仍可独立读取查询设置和缓存历史。

## 托管账号连接

在「账号连接」添加 DeepSeek、OpenRouter、Z.AI、Kimi API Key 或 Codex OAuth 连接。同服务商可保存多个账号，每项有独立名称、模型端点、认证诊断、模型范围和资源观测。密钥仅在录入/更换时提交，读 API 不返回秘密或前缀；保存后输入清空。不自动导入外部 Pi/Codex 凭证。

配置与秘密在项目 `.lush/credentials/agent-connections.json`，目录 0700、文件 0600。这不是静态加密保险箱或 Agent 沙箱；同一系统用户仍可读取，权限无法验证的平台拒绝托管。删除连接不删除旧历史或外部认证。跨目标更换端点需重新录入密钥，不将旧密钥自动发向新服务器。

Codex 默认设备码登录：先添加并保存 `openai-codex` 连接，再点击卡片“登录 / 重新登录”，复制短设备码，打开 OpenAI 官方授权页面输入该码。完成授权后，Lush 按服务端指定间隔自动确认并保存，无需回调端口或粘贴 URL。设备码最多有效 15 分钟，取消、离开登录面板或更换编辑会停止检查；失败可重新发起。若服务商要求，请在 ChatGPT 安全设置允许 Codex 设备码登录；只授权本人发起的设备码，不要分享。

“备用：回调 URL 登录”保留原 PKCE 流程：打开授权链接，完成认证后将最终 `http://localhost:1455/auth/callback?...` URL 粘贴回来。不启动本机回调服务器，浏览器可能显示连接失败，复制地址栏最终 URL 即可；支持远端 Host。两种方式均有时限、一次性兑换、不自动切换，刷新只写 Lush 自己的凭证，不覆盖外部客户端。

连接页进入只读本地列表和缓存，单项/全部刷新显式联网；后台采样默认关闭。现金余额、Key预算和订阅窗口分开，OpenRouter credits 与 Key预算独立取得，缺少权限不抹掉成功指标。失败/未知不显示成零，旧成功值明确带旧时间。历史按账号与端点来源分段，不把账户余额差归因为 Lush 独占消费。

设置页可以显式选择连接，或通过 CLI：

```bash
bun run lush agent set default --agent pi --model deepseek/deepseek-chat --connection CONNECTION_UUID
bun run lush agent set default --connection off
```

绑定仅支持 Pi、固定物理模型，模型服务商和限制范围必须匹配。保存只影响后续 invocation，不自动切换模型、账号、付费资源或执行后端。临时 Pi目录只携带 access token，不复制 OAuth refresh token；长调用期间 access 过期可能失败，下一次调用再由 Lush协调刷新。保留原全局 Pi 的行为设置与上下文，但不继承外部凭证、模型端点/头和自动资源发现；绑定时 `--no-approve` 禁用 trust-gated 项目 `.pi` 配置，避免它覆盖模型端点并转发托管密钥，显式选择的扩展/Skills仍加载。

已绑定的正常 Codex 请求可被动采集明确的套餐百分比/窗口头，在 invocation 退出时写入历史（不是实时轮询）；普通 RPM/TPM 头不代表套餐额度，WebSocket 等没有头的路径仍需专用查询。消费者只显示真正冻结了该连接的本项目运行 Worker。

新增接口全部用户专属，管理/登录/查询均禁止 Agent token，秘密和回调 URL不进事件或错误：

| RPC | HTTP / 参数 |
|---|---|
| `agent.connections.list {}` | `GET /api/agent/connections`，本地列表/缓存 |
| `agent.connections.save {connection,credential?}` | POST action；创建或更新，credential 可选 `{api_key}`，省略保留秘密 |
| `agent.connections.remove {id}` | POST action；移除连接/自己的秘密，保留历史 |
| `agent.connections.sampling {sampling}` | POST action；enabled / interval_minutes / retention_days |
| `agent.connections.query {id?}` | POST action；省略 ID 刷新 enabled 连接 |
| `agent.connections.history {id,days?}` | `GET /api/agent/connections/history?id=&days=`，1/7/30/90天 |
| `agent.connections.login.start {id}` | POST action；返回授权 URL、login_id、截止时间 |
| `agent.connections.login.finish {id,login_id,redirect_url}` | POST action；校验并一次性兑换备用回调 |
| `agent.connections.device.start {id}` | POST action；返回 login_id、官方授权页、用户短码、截止时间和检查间隔 |
| `agent.connections.device.poll {id,login_id}` | POST action；单次检查，返回 pending 或 complete（公开连接），不返回设备授权 ID 或 token |
| `agent.connections.device.cancel {id,login_id}` | POST action；幂等取消指定设备码会话，不删除已有凭证 |

完整字段与安全/模块接缝见[账号连接契约](../../engineering/agent-connections.md)。下面是仍保留的旧 Pi状态查询，不会迁移或覆盖已有配置。

## 内置查询

默认仅查询当前 Agent 服务商；可在「查询服务商」中选择多个服务商，不自动遍历所有保存账号。

| 服务商 | 数据及限制 |
|---|---|
| DeepSeek | 官方现金余额，按币种显示 |
| OpenRouter | API Key 消费上限、已用量及剩余额度，不是账户现金余额；未设置上限不等于零 |
| OpenAI Codex | 使用有效的本地 OAuth access token 请求 `https://chatgpt.com/backend-api/wham/usage`，显示主要 / 次要额度窗口的剩余百分比和重置时间；这是网页后端接口，**不是稳定公开 API** |
| Z.AI | 各额度限制独立显示；没有窗口时长或单位时不猜测每日 / 每周额度或 token 数量 |
| Kimi For Coding | 会员额度与滚动窗口；保留提供商额度单位，不将其当成现金 |

Codex 凭证过期时，仅已选内置官方查询允许独立刷新并安全写回原 `auth.json`；不会调用 Pi SDK、插件或模型注册表。刷新使用固定 OpenAI OAuth 地址，与原凭证锁目录协议协调；锁忙、文件变化、刷新失败明确报错，不强制删锁、不覆盖其他服务商。刷新拒绝凭证文件的 symlink / 硬链接及别名父路径，避免同一文件使用不同锁名。进程崩溃后的残留锁不会自动抢占，须人工确认无使用者后处理；不遵守锁协议的外部写者无法获得同等并发保证，快照校验也不能消除校验至原子替换之间的系统竞态。自定义查询、代理端点与普通 API Key 不触发刷新，不执行 `!` 密钥命令。缺失字段保留未知，0.5% 不误算为 50%，失败也不写成零。Codex 的 `used_percent` 独立保留；当前接口百分比窗口中的 `total=100`、`used/remaining` 均为 `%` 尺度，不代表实际 token / 请求总额度。时长按真实窗口显示 5 小时、7 天（周）等，未知不猜每日。429、超时、401/403、无效 JSON / 格式变化均返回安全独立分类，不自动无限重试。使用自定义模型端点的账号，不会仅因服务商 ID 相同就把凭证发送至官方端点。

## 自定义 HTTP 查询

在「查询与采样设置」添加自定义查询并保存：

1. 填服务商 ID、名称、受信任的 **HTTPS** 地址、GET / POST 和数值类型（现金余额或额度）。自定义来源覆盖同 ID 内置查询。
2. 添加请求头，例如 `Authorization: Bearer ${MY_USAGE_KEY}`。在「Agent 管理 → 设置 → 环境变量」的公共 / agent 环境中配置 `MY_USAGE_KEY`；不要在地址、请求头或请求体中填写明文密钥。
3. POST 可填 JSON 请求体模板，如 `{"token":"${MY_USAGE_KEY}"}`；环境引用放在 JSON 字符串中，GET 请求体必须为空。
4. 添加指标：稳定 ID、名称、单位、剩余 / 总量 / 已用量的 JSON 字段路径（如 `data.remaining`、`limits.0.remaining`），可选重置时间路径和窗口秒数。至少映射一个数值；可用总量减已用量推导剩余量。
5. 将服务商 ID 加入上方查询范围（当前服务商可留空使用默认范围），保存后点击页面顶部刷新状态验证。

字段路径不支持脚本或表达式；百分比单位须明确选择 `%`，不猜测小数尺度。重置时间接受 ISO 时间或 Unix 秒数。自定义查询**不会自动附带 Pi 凭证**，只展开显式配置的环境引用，禁止 invocation 凭证引用。查询不跟重定向，超时和响应大小有界。目标由配置用户负责信任；这不是运行任意脚本的沙箱，也不提供复杂签名适配。

配置保存在项目 `.lush/agent-usage.json`，权限 `0600`，原子替换。损坏或权限不安全的文件拒绝读取和覆盖，不静默丢失设置。

## 后台采样与历史

- 默认后台关闭；启用后默认每 **5 分钟**查询，可设 1..1440 分钟。关闭页面仍采样，daemon 停止期间无数据，重启不补发停机期间的请求。
- 默认保留 **90 天**，可设 1..3650 天。缩短期限会清理旧数据，不能撤销；历史只在本项目 SQLite 中，不存凭证、环境值或上游原始响应。
- 曲线提供 24 小时、7 天、30 天、90 天范围。账号、查询来源配置、指标、单位及窗口分开，切换凭证 / 账号不会串线。
- 每次实际查询自动缓存；并发请求共用同次结果时只保存一次。成功、失败与未知分别记录，失败时不沿用旧值作为新样本。
- 最多返回 40 条曲线、每条 500 点，并受总响应字节预算约束。大范围覆盖整个查询时段抽取首尾、极值及代表性失败 / 重置点，并标为已截断 / 降采样；此时只画观测点，不连线冒充完整历史。样本总数仍显示真实数量。
- 未压缩的曲线在失败、未知、额度回升 / 重置处断开；后台采样超过两倍间隔也留空。连接线只是观测点之间的辅助线，不推测期间实际消耗。所有时间显示 UTC。

## RPC / HTTP

以下接口全部**仅用户可调用**，禁止 Agent token；HTTP 沿用登录、Origin、项目路由和 `Cache-Control: no-store`。全局 Host 模式须带 `/p/<project-id>` 前缀。

| RPC | HTTP / 参数 |
|---|---|
| `agent.status {}` | `GET /api/agent/status`，完整安装 / 账号查询，自动缓存用量；不接受参数 |
| `agent.usage.config {}` | `GET /api/agent/usage/config`，读取规范化查询设置 |
| `agent.usage.configure {config}` | `POST /api/action`，完整替换查询设置；保存本身不查询上游 |
| `agent.usage.history {provider?,account_key?,days?}` | `GET /api/agent/usage/history`，同名 query 参数；days 为 1 / 7 / 30 / 90，缺省 7 |

配置结构、余额字段和历史响应见[工程契约](../../engineering/agent-usage.md)。后台采样复用轻量账号查询，不执行 Pi 版本 / 模型目录探测，也不进入 Worker 调度。

## 安装与验证限制

当前页面仍查询 Pi；项目选择 Codex CLI 后端时，不会冒充该 CLI 的账号状态。使用 mock HTTPS 响应验证适配器、独立认证及端到端缓存，不使用真实凭证跑自动化测试。用户授权的本轮只读验证发现 Codex 使用自定义模型端点，安全检查阻止请求（实际请求数 0），未刷新或写回真实凭证；因此认证后的接口当前可用性和真实响应结构仍未验证。Codex 网页接口可能随提供商变更而失效。

合入新代码后，需在项目无活动调用时重启 daemon 和 Host 才能使用；开发测试不会替用户重启正在使用的服务。

[返回 RPC 索引](README.md) · [Web 路由](../web-routes.md)
