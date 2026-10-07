# 托管来源的模型目录与来源 CLI

用户决定 #157：Lush 托管账号/API 属于当前项目；连接必须在添加或成功登录后自动维护可用模型目录，避免每次设置任务重新查询；CLI 要能展示来源与额度，作为未来智能管家的安全读面。本章固定模型目录的缓存、隔离与刷新边界，以及 `agent sources` / `agent resources` 命令面；双配置模式与资源安装见[项目 Agent 配置与双模式运行](agent-configuration-v2.md)，凭证与额度契约见[账号资源连接器](agent-connections.md)。

## 目标与边界

模型目录只回答“这个连接可能能调用哪些模型”，不保证账号当前有额度、不保证单次请求成功。目录读取默认走本地缓存，不联网、不启动模型；刷新是显式动作或后台低频任务，绝不发“便宜”的探测请求。`connection.models` 仍是用户手动限制范围，不写入自动目录。Worker/Profile 选择器优先完整展示用户填写的列表，缓存目录仅补充匹配项的名称与能力，不得因目录缺失或不完整隐藏已填写模型；列表为空时才使用同来源缓存候选。CLI 目录读面仍展示缓存，不改写手动范围。

## 手动填写与 Worker 选择

用户决定 #176：Codex 模型列表由用户在模型来源页面填写，不为本次改动新增账号目录接口或读取外部 Pi 配置。

1. 打开「模型来源」，在对应账号总览行点击「详情」，再点击「编辑」。
2. 在模型范围输入中填写物理模型 ID，例如 `gpt-6.1-sol`，不加 `openai-codex/` 等服务商前缀；面板预览最终调用名，保存连接。物理 ID 自带的 `vendor/model` 斜杠应保留。
3. 发射 Worker 的运行设置中选择该来源，从已填写模型列表选择；若表单此前已打开，点击「读取项目连接」取得更新。

选择器加上 `provider/` 前缀后提交，不从目录自动选中模型、不因读取目录覆盖草稿、不联网验证。已有 Worker 主动换源时从连接配置自动填入默认模型的规则见[切换来源](../design/agent-model-settings.md#切换来源)。非空列表同时限制此来源允许使用的模型；空列表保留“不限制范围”的原语义，无缓存候选时显示填写引导与来源详情链接，仍可手填。

## 读面

单连接目录与连接列表使用同一套严格、有界的投影：

```js
{ version: 1, id, checked_at, status, source, models: [{ id, name, thinking_levels, context, max_output, images, reasoning }], warning, error_code }
```

- `id` 是 connection UUID；`models[].id` 是 `provider/model` 限定物理名（自定义兼容端点沿用其 provider 前缀）。
- `status` 为 `fresh | cached | unknown | error | unsupported`。`fresh` 表示本次成功取得；`cached` 表示来自本地元数据、手动范围或上次成功但已过期的缓存；`error`/`unsupported` 明确表示没有可确认目录，不能用空数组冒充“没有模型”。
- `source` 为 `listing | pi-local | manual | none`。
- `thinking_levels` 只在有证据时给出思考档位列表；`null` 表示未知，`[]` 表示已知不支持。不能因为后端通用档位存在就宣称某模型支持。
- 所有字段严格白名单、定长、有限数值；凭证、密钥摘要、上游原始响应与错误原文永不进入读面。

`agent.selection.resources` 的每个连接追加同一读面（`model_catalog`），供未来受信策略与只读界面使用；读取失败降级为 `unknown`，不让单个目录拖垮整个列表。

## 缓存与身份隔离

自动目录写入项目私有 `<home>/credentials/agent-connection-catalog.json`（owner-only 0600、原子 rename、目录 0700，不含秘密），与连接文件同级。缓存键是 `digest(['agent-catalog-v1', provider, endpoint, models, account_key, source_key])`：

- 同服务商多账号因 `account_key` 不同而互不复用；换端点、换账号或改 `models` 限制后旧目录不再作为当前结果。
- OAuth access 刷新不改变稳定 `accountId`，因此同账号目录不会因 token 轮换反复失效。
- 写入前重新核对连接身份；配置或身份在请求途中变化时丢弃迟到结果，不覆盖新账号目录。关闭项目会取消在途目录请求。

## 目录来源

1. **经审核的列表接口。** 只使用固定路径且解析受限的适配器：OpenRouter `GET {origin}/api/v1/models`（公开，不带凭证）与 DeepSeek `GET {origin}/models`（同源，带本次 API Key）。请求走项目网络快照、拒绝重定向、限时/限响应；URL 由连接自身端点 origin 派生，不把凭证送到用户未为该连接配置的目的地。
2. **Pi auth-free 本地元数据。** 无列表接口的服务商（如 Codex OAuth）使用 Lush 独立 Pi 的本地 SDK 模型元数据，按 provider 过滤，标记 `pi-local` 且明确“未联网验证”。
3. **手动范围。** 都没有时退回 `connection.models`，状态 `unknown`/`cached`，提示尚未与账号同步。
4. **明确不支持。** 三者皆空时返回 `unsupported` 与原因，不猜测余额、不发探测请求。

后台目录同步默认低频（6 小时，可注入用于测试）；仅在服务已启动、存在启用连接且运行时有目录能力时调度，关停后不再重排。添加连接、设备码/回调登录完成后**不**在同一次调用里联网，而是把已启动服务的下一次后台同步提前到短延时后执行：保存 RPC / 列表路径仍不查询目录，未启动的服务（例如单元测试）不会因编辑而联网。用户决定 #186 的 Web 保存后余额 / 额度刷新是页面额外发出的 `agent.connections.query`，不是模型目录刷新，不改变本节后台目录同步边界。

## RPC / HTTP

全部用户专属；秘密写入仍走既有 `agent.connections.save` 私有文件路径。

| 方法 | 用途 |
|---|---|
| `agent.connections.models {id}` | 读取某连接本地缓存目录，不联网 |
| `agent.connections.models.refresh {id?}` | 显式刷新单连接或全部启用连接；`id` 省略时返回 `{version,checked_at,catalogs}` |

HTTP：`GET /api/agent/connections/models?id=...` 只读且 `no-store`，缺少 `id`、重复 `id` 或未知查询参数一律 400；联网刷新只经 `POST /api/action` 的 `agent.connections.models.refresh`。

## CLI

`lush agent sources ...`（用户专属，`--json` 输出与上面读面一致）：

- `list` / `show ID` / `remove ID`：来源清单与单项；只投影安全字段。
- `refresh [ID]`：显式刷新额度观测（沿用 `agent.connections.query`），随后重读来源列表。
- `models ID [--refresh]`：读取或显式刷新缓存目录。
- `save --file PATH`：从 owner-only 输入文件读取 `{connection, credential?}`；凭证不经过 argv，也不出现在输出。输入文件按 `O_NOFOLLOW|O_NONBLOCK` 打开并对文件描述符校验 owner、`0600`、链接数、类型与大小，拒绝 symlink、目录、FIFO、越权与超限，失败只返回固定错误，不回显路径或内容。
- `login ID`（设备码开始）/ `--poll LOGIN_ID` / `--cancel LOGIN_ID` / `--callback`（备用回调开始）/ `--finish LOGIN_ID --url-file PATH`（从同规格 owner-only 文件读取回调 URL，不回显 code）。CLI 输出的嵌套观测、额度资源、历史成功与消费者均按白名单重建，未知字段不会进入 stdout。

`lush agent resources` 只读返回共享模型选择资源读面（连接、额度观测、缓存目录），不列出已安装扩展或 Skills；后者属于资源管理面。CLI 与 RPC 都拒绝 agent token。

## 验证

自动测试使用临时项目与注入的 mock fetch/Pi 元数据，不触碰真实凭证，不发真实模型请求。覆盖：列表解析与限定名、手动/本地/不支持回退、账号/端点/限制隔离、OAuth 刷新不失效、迟到结果丢弃、停止取消、后台同步调度与关闭、单连接/全量刷新、CLI 投影与私有文件凭证、RPC/HTTP 用户专属与查询参数校验。
