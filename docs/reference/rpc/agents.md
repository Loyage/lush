# Agent 配置、模型来源与用量历史

Web 将工作方式与调用资源分为两个独立页面。所有设置和账号都归当前项目 daemon，不是 Host 的整机账号池。理念见[页面组织](../../design/agent-model-settings.md)，运行契约见[共享模型选择](../../engineering/managed-model-selection.md)。

## 两个页面

- **Agent 配置**（`#agent-status`，保留旧地址）：默认打开项目配置，顶部显示已保存的后端、来源和模型；按模型与运行、工作方式、高级与诊断分区。管理思考深度、软预算、Prompt、扩展 / Skills 与环境变量。来源选择顺序是执行后端 → 来源 → 匹配模型。切换页签保留未保存输入，诊断失败不阻塞配置编辑。
- **模型来源**（`#model-sources`）：全宽多连接总览同时显示端点、模型范围与默认设定、本地认证、余额 / 套餐窗口及实际使用情况；窄屏为卡片。顶部添加连接，每行直接编辑、刷新或查看详情，侧边面板处理编辑 / 登录 / 历史。可搜索名称、端点、服务商和模型，筛选后勾选批量刷新、启用 / 停用；启用 / 停用前确认具体连接范围，逐项显示成败，不批量修改密钥或删除。来源深链接为 `#model-source-<连接 UUID>`。
- **系统设置**（`#settings`）：界面偏好、项目系统参数与出站网络；不再把项目网络代理放在 Agent 配置中。

打开 Agent 配置不查询上游账号。打开模型来源只读本地连接和缓存；刷新 / 登录会联网。页面保存连接或登录成功后，也会自动刷新支持查询且已启用、有凭证的该连接，操作前有说明；保存成功与额度刷新失败分别反馈。底层保存 RPC 仍只保存本地，不自动查询额度。保存设置不调用模型，不自动开始、继续或重试 Worker。

## 添加模型来源

支持 DeepSeek、OpenRouter、Z.AI、Kimi、自定义 OpenAI 兼容 API Key 和 Codex 订阅 OAuth。一个来源明确绑定服务商、端点、账号及模型范围；同服务商可保存多个账号。同模型的不同来源不能合并认证、额度或历史。

模型范围填写物理模型 ID，例如 Codex 的 `gpt-6.1-sol`，不是 `openai-codex/gpt-6.1-sol`；面板会预览完整调用名，默认模型可从已填模型列表选择。像 `vendor/chat` 这样的斜杠仍可以是合法物理模型 ID。非空模型范围限制此来源允许使用的模型，不表示联网验证通过。默认模型 / 思考深度供运行设置一键填入，不改变项目默认或正在运行的请求。

API Key 和登录统一保存在 `.lush/credentials/agent-connections.json`，目录 0700、文件 0600；读 API 不返回秘密或前缀。录入/更换时才提交密钥，提交后清空浏览器输入。不自动导入外部 Pi/Codex 凭证。严格文件权限不是静态加密保险箱或 Agent 沙箱，同一系统用户仍可读取；权限无法验证的平台拒绝托管。删除来源保留旧历史和外部认证。更换端点需重新授权密钥，不自动转发旧密钥。

Codex 默认设备码登录：保存 `openai-codex` 来源后点「登录 / 重新登录」，复制短码，打开 OpenAI 官方页面输入；Lush 按服务端间隔确认并保存。最多 15 分钟，取消、离开登录面板或更换来源会停止检查。如服务商要求，在 ChatGPT 安全设置允许 Codex 设备码登录；只授权本人发起的设备码，不分享。

「备用：回调 URL 登录」保留 PKCE 流程：打开授权链接后，将最终 `http://localhost:1455/auth/callback?...` 地址粘贴回来。不启动本机回调服务器，浏览器连接失败时可复制地址栏最终 URL；支持远端 Host。两种登录均有时限、一次性兑换、不自动切换，刷新只写 Lush 自己的凭证。

自定义 API 必须填写 HTTPS 基础端点（如 `https://api.example.com/v1`，不是完整 `/chat/completions` 地址）和非空物理模型 ID，例如 `vendor/chat`。Pi 模型名为 `openai-compatible/vendor/chat`。仅支持 OpenAI Chat Completions 文本/tool 协议；本地预算 32768 context / 4096 output，不声明图片/推理能力，不代表已验证上游限额。成本零值为占位，不表示免费。没有专用余额适配，刷新显示不支持而非零，不将密钥发往官方余额接口。

## Lush 独立 Pi 配置

Pi 调用必须选择 Lush 来源。原来没有绑定来源的配置、会话和历史不会删除，但后续调用会明确提示先选来源，**不回退用户默认 Pi 登录**。Codex CLI 仍使用自己的认证，不支持 Lush 托管绑定；托管 Codex 订阅供 Pi 使用不等于支持 Codex CLI。

Lush 在项目 `.lush/pi/` 管理独立基础配置，每次调用生成私有配置快照，通过 `PI_CODING_AGENT_DIR` 提供给 Pi。不读取/复制用户默认 Pi 的凭证、设置、模型覆盖或全局 Prompt；项目 `AGENTS.md` 与显式所选扩展/Skills 保留。`--no-approve` 防止项目 `.pi` 覆盖托管模型端点。环境变量不能覆盖 Lush 的运行配置目录。快照不是操作系统沙箱。

快照仅携带选定来源的认证；OAuth 只携带 access token，不复制 refresh token。长调用中 access token 过期可能失败，下一次由 Lush 连接管理器协调刷新，不承诺无损持续登录。会话仍保存在 Lush 的 Worker 会话目录，切换来源不删除既有执行记录或 fork 上下文。

在 Agent 配置页选来源与模型并保存，影响未独立覆盖的后续调用。也可使用 CLI：

```bash
bun run lush agent set default --agent pi --model deepseek/deepseek-chat --connection CONNECTION_UUID
```

关闭连接绑定不会恢复外部 Pi 认证，而是使后续 Pi 调用缺少必需来源。模型必须匹配来源的 provider 和配置范围；保存/切换不悄悄选择第一个模型，不自动更换账号、付费资源或执行后端。

## 单 Worker 切换

待开始/暂停或请求中断期间可点「切换模型来源」，只修改来源与模型，后台保留已有 Prompt、环境变量、资源、预算与思考等级。完整「调整运行设置」入口仍保留；失败/取消后的「检查后重试」仍使用完整参数确认。保存不自动继续，下一次 invocation 生效；进行中的请求不热切换。

用户专属窄更新：

```json
{"method":"worker.configure","params":{"id":123,"model_selection":{"connection_id":"连接 UUID","model":"deepseek/deepseek-chat"}}}
```

`model_selection` 与旧 `profile` 输入互斥，仅支持 Pi 托管来源，不切换后端。无已有覆盖时从有效角色默认建立覆盖；有覆盖时只更新这两个字段。返回 `{id,model_selection}` 安全摘要，不返回完整运行配置。旧 `profile` 完整替换和清除语义不变。

`worker.inspect.model_selection` 为 `{agent,connection_id,model,thinking,explicit}`，只表示**下次配置**，不含 Prompt、环境变量或资源路径。实际当前来源须有运行时冻结绑定证据，不能用该摘要或模型名猜测。Worker 本轮覆盖结算后按原规则清除。

## 额度和历史

现金余额、Key 预算、订阅窗口分别展示，标明作用域、单位、观测来源、时间和重置时间。OpenRouter credits 与 Key 预算独立取得，缺少一项权限不抹掉另一项成功指标。失败/未知不等于零；最后成功值明确标旧。来源模型目录只是配置范围，不表示已联网验证可用。

Codex 等套餐窗口主显示“约多久后重置”，绝对本地时间与原始读数留在详情。倒计时只更新显示，不联网；时间到了提示待刷新，不能据此认定额度已恢复。刷新中显示就地状态，同账号旧值标明缓存及时间，换账号不沿用旧观测。

正常 Codex 响应的套餐百分比/窗口头可在 invocation 退出时采集，不是实时轮询；普通 RPM/TPM 不是套餐额度。使用情况只列实际冻结绑定该来源的运行 Worker，不推测其他客户端消耗。余额差也不能归因为 Lush 独占消费。

后台采样默认关闭，显式开启后关页仍采样；daemon 停止期间留空、不补请求。默认 5 分钟、保留 90 天，缩短保留期会清理到期历史。历史区分账号、端点、指标、单位与窗口，失败/未知留缺口，不把采样曲线当逐笔账单。单来源历史最多 40 条曲线、每条 500 点、总预算 680 KB，降采样明确标注；不会删除外部认证。

## 诊断与旧查询兼容

「高级与诊断」显式读取 Lush 独立 Pi 的安装、配置目录、模型元数据及发现资源。发现不代表某 Worker 已加载，目录不保证模型请求成功，也不是当前 Worker 的实际配置快照。数据来自项目所在机器，不是浏览器本机。旧查询配置与本地历史保留，不导入托管来源，不写回用户默认 Pi 认证；不应把旧缓存冒充当前来源额度。

旧自定义 HTTPS 查询与 JSON 字段映射保留在诊断中的「查询与采样设置」，不是首选来源管理流程。配置保存于 `.lush/agent-usage.json`；环境引用在 Agent 配置的高级环境变量中显式配置。无脚本/表达式，不跟重定向，超时和响应有界；不自动附带 Pi 凭证，禁止 invocation 凭证引用。详情见[旧额度查询契约](../../engineering/agent-usage.md)。

## RPC / HTTP

管理、登录、查询及配置写入均用户专属；HTTP 沿用登录、Origin、项目路由及 `no-store`。全局 Host 模式带 `/p/<project-id>` 前缀，秘密和回调不进入事件或错误。

| RPC | HTTP / 参数 |
|---|---|
| `agent.selection.resources {}` | GET `/api/agent/selection/resources`，本地安全资源摘要 |
| `agent.connections.list {}` | GET `/api/agent/connections`，本地列表/缓存 |
| `agent.connections.save {connection,credential?}` | POST action，credential 可选 `{api_key}`，省略保留秘密 |
| `agent.connections.remove {id}` | POST action，保留历史 |
| `agent.connections.sampling {sampling}` | POST action，enabled / interval_minutes / retention_days |
| `agent.connections.query {id?}` | POST action，省略 ID 刷新 enabled 来源 |
| `agent.connections.history {id,days?}` | GET `/api/agent/connections/history?id=&days=`，1/7/30/90 天 |
| `agent.connections.login.start {id}` | POST action，备用授权 URL、login_id、截止时间 |
| `agent.connections.login.finish {id,login_id,redirect_url}` | POST action，一次性备用回调兑换 |
| `agent.connections.device.start {id}` | POST action，官方授权页、短码、截止时间、间隔 |
| `agent.connections.device.poll {id,login_id}` | POST action，pending / complete，不返回 token |
| `agent.connections.device.cancel {id,login_id}` | POST action，取消会话，不删除已有凭证 |
| `agent.status {}` | GET `/api/agent/status`，显式安装/配置诊断与旧查询 |
| `agent.usage.config {}` | GET `/api/agent/usage/config` |
| `agent.usage.configure {config}` | POST action，完整替换旧查询设置，不立即查询 |
| `agent.usage.history {provider?,account_key?,days?}` | GET `/api/agent/usage/history`，本地历史 |
| `worker.configure {id,model_selection}` | POST action，窄更新；与 profile 互斥 |

受信调用前策略仍默认关闭，不执行用户脚本；Worker 显式覆盖优先。`agent.selection.resources` 的顶层时间是读面生成时间，额度新鲜度须看各观测时间。没有策略不做自动付费切换。

## 验证与启用

自动测试使用临时项目和 mock 网络/CLI，不读取真实账号。真实 OAuth、自定义上游兼容性、跨机器与发布平台仍需显式验证；Codex 额度采用网页后端接口，不是稳定公开 API。

合入后，先配置有效来源，再在项目没有活动调用时重启 daemon 和 Host。两个进程独立更新；本次开发不会替用户重启在用服务。

[返回 RPC 索引](README.md) · [Web 路由](../web-routes.md)
