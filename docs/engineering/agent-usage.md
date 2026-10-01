# Agent 额度查询与历史曲线

本章固定 Agent 状态页用量扩展的跨模块接口。用户确认 HTTP 配置及 JSON 字段映射、默认按需与可选 daemon 定时采样、历史默认保留 90 天。追加决策 #39 仅完善 Codex，允许新增独立 OAuth 刷新适配（替代最初只读决策），不依赖 Pi 运行时；真实账号验证只允许一次额度 GET，不自动刷新或写回。

## 目标与边界

- 内置 DeepSeek 余额、OpenRouter Key 消费额度，新增 Codex、Z.AI、Kimi 额度查询；参考 pi-usage 请求，不把缺失值当零，不把短窗口武断称为每日额度。
- Codex 使用 ChatGPT 网页后端接口，明确其不是稳定公开 API；必须使用 OAuth access token，不使用普通 OpenAI API Key。允许过期时通过独立 `usage-auth-codex.js` 刷新并安全写回原凭证存储，不调用 Pi SDK/插件/模型注册表；自定义模型端点的现有凭证隔离规则仍保留。
- 凭证、环境变量值、上游原始响应与错误原文不进入 RPC/历史。自定义查询仅发向用户显式配置的 HTTPS 地址，无重定向、无 shell/脚本，无自动转发 Pi 凭证；配置人必须信任目标，环境引用是对目标的显式授权。拒绝引用 LUSH_*、PI_SESSION* 等 invocation 凭证。
- 账号匿名标识隔离更换账号后的曲线；OAuth 使用稳定 account ID 的摘要，不因 access token 刷新而切换身份；无稳定身份时使用凭证摘要，宁可分段也不串账号。不同项目的缓存独立。
- 曲线区分账号、来源配置、余额/额度、指标 ID、单位和窗口；失败/未知形成缺口，重置明确标注。只表示采样时刻观测值，不推测采样之间的实际消耗。

## 配置契约

`<home>/agent-usage.json` owner-only 原子写入，由 `src/agent/usage-settings.js` 的 `UsageSettings(config)` 独占读写。`get()` / `save(config)` 返回以下规范化对象，`save` 全量替换并拒绝未知字段，读损坏文件不得静默重写。可导出校验帮助函数。

```json
{
  "version": 1,
  "enabled": false,
  "interval_minutes": 5,
  "retention_days": 90,
  "providers": [],
  "custom": []
}
```

- enabled 仅控制后台采样，不禁用按需查询；interval_minutes 整数 1..1440，retention_days 整数 1..3650。
- providers 是显式选择的服务商 ID（最多 20 个）；空数组表示仅当前 Agent 服务商，不表示所有保存账号。
- custom 最多 20 项，每个 provider 只能有一个自定义查询；配置存在则覆盖该 provider 的内置查询。支持未在 Pi 凭证中发现的服务商。
- 自定义项：`{provider,label,url,method,headers,body,kind,items}`。method 为 GET 或 POST；headers 是字符串值对象，可含 `${ENV_NAME}` 环境引用；body 是可空 JSON 文本（支持同样环境引用，GET 时必须为空）；kind 为 balance 或 quota。
- URL 必须 HTTPS，禁止 userinfo/fragment、禁止 URL 中环境插值。header/body 中的凭证只使用环境引用，UI 明示不要填明文秘密；保存与读面仅配置模板，执行时展开后绝不回传。
- items 1..10 项：`{id,label,unit,remaining,total,used,reset_at,window_seconds}`。remaining/total/used/reset_at 为可空的 JSON 字段路径（例 `data.remaining`、`limits.0.remaining`），不支持脚本或表达式；id 在来源内稳定且唯一；window_seconds 为可空正整数常量。至少配置一个数值字段；未知保持 null，已用/总量可推导剩余量；reset_at 接收 ISO 字符串或 Unix 秒。百分比单位 `%` 必须由接口明确给出或用户明确映射，不猜小数尺度。

## Provider 查询接缝

`src/agent/status.js` 保持 `discoverAgentStatus(config,profile,options?)`；新增 `discoverAgentUsage(config,profile,options?)` 只读取必要配置和账号、查询额度，不运行 Pi 版本/模型/资源探测，供后台采样。两者 options 支持 `{usageConfig,fetch,timeout}`，`usageConfig` 为上述已校验配置，缺省按默认行为。内部受控只读验证可设 `refreshCodex:false`，过期时不刷新不写回；该选项参与单飞身份。独立认证测试可注入 `authFetch/authTimeout/authLockTimeout`，生产缺省刷新截止 8 秒、等锁截止 2 秒，不与真实凭证自动测试混用。

`discoverAgentUsage` 返回 `{query_id,checked_at,current_provider,accounts,warnings}`。query_id 为每次实际查询唯一的随机 ID，同次轻量/完整查询共享该 ID 和 accounts 的 checked_at，缓存据此去重。完整 status 仍 version 1，增加 `query_id`、`current_provider`。每个 account 增加 `account_key`（匿名稳定字符串）；balance 保持现有字段，增加 `queried:boolean`、`error_code:string|null`。queried 为本次选中并执行或因过期/缺失凭证而失败的查询尝试；未选中、根本不支持的 provider 为 false，防止未查询账号产生假历史。

balance items 增加 `id`、`reset_at`（ISO 或 null）、`window_seconds`（整数或 null）、`used_percent`（0..100 或 null），保留 label/remaining/total/used/unit。available 数值必须有限，缺少不补零。错误分类只用固定值（如 expired/unconfigured/network/unauthorized/invalid_response/unsupported）。query 单飞合并同配置并发，配置变化不能复用旧请求；网络并发有界。

## 项目服务与持久化接缝

- `Project.agentStatus()` 经同一用量服务保存本次 queried 结果，追加 `usage_config`（规范化配置）供页面使用；不要把历史塞入大型状态响应。查询失败时 account 可附带 `last_success:{checked_at,balance}`，主 balance 仍保留当前失败状态，前端必须明确标旧及旧时间。来源身份按 provider 的 custom 定义摘要（或 builtin-v1）隔离，不因 interval/retention 改动分割曲线。
- 用户专属 RPC：`agent.usage.config {}`、`agent.usage.configure {config}`、`agent.usage.history {provider?,account_key?,days?}`。前两者返回规范化配置；days 允许 1/7/30/90（缺省 7）。所有接口均禁止 Agent token 访问。
- HTTP：GET `/api/agent/usage/config`、GET `/api/agent/usage/history?provider=&account_key=&days=`；POST `/api/action` 允许 `agent.usage.configure`。保持项目身份路由、Origin、登录与 no-store 边界。
- history 返回 `{version:1,from,to,retention_days,series,truncated}`。series 每项 `{id,provider,account_key,kind,label,unit,window_seconds,points,sample_count}`；point `{at,remaining,total,used,used_percent,status,reset_at,error_code}`，按时间升序。id 必须稳定隔离配置版本/指标，不能仅按 label 合并。
- 历史读取最多 40 条 series、每 series 最多 500 点，同时受总计 680 KB 预算约束。超过时按所选完整时间范围分桶，选择首尾、极值及代表性失败/重置点，明确 truncated；前端仅绘制观测点，不把采样压缩后的缺失记录伪装成连续消耗。sample_count 保留真实样本数量。保存每次真实查询（single-flight 同次只存一次）；失败保存安全分类；失败时展示最后成功值必须带其旧时间。
- 历史存在主项目 SQLite 技术附属表，不创建新的业务实体；Store mixin 承担 SQL，查询按 provider/account/time 建索引。保留期清理不重写其他旧数据。
- 后台采样使用轻量 discoverAgentUsage，不探测模型、不启动 Agent；默认关闭，显式启用后按配置间隔单飞执行，重启恢复未来采样但不补发停机缺失点，shutdown 停止计时并等待在途写入，禁用后不再重排。

## 页面接缝

`render-agent-status.js` 保留现有安装/账号/模型/资源；新增配置与历史曲线区域，可拆为 `render-agent-usage.js` 与专用 CSS。

- 从 status.usage_config 获取配置（老响应缺失或实时状态失败时独立读取 config API），保存完整 config 经 action API；实时查询失败不封闭本地历史入口。表单配置 provider 选择、后台开关、间隔、保留期及自定义 HTTP/字段映射，不能只有裸 JSON 编辑器。
- 曲线可选 24 小时/7 天/30 天/90 天、账号/指标，按时间轴展示剩余量，金额/百分比不能同轴混画；SVG/DOM 安全文本，无新依赖，提供数据表/空态/未知/失败/截断/重置提示。
- 进入页面与手动刷新触发 status 查询；查看历史/切换范围只读缓存，不产生远端查询。加载/保存/迟到响应均守页面身份；刷新不重复提交、配置表单未保存编辑不能被异步历史响应覆盖。
- 查询按钮不标 agent-call（不启动模型），但需帮助解释网络请求和缓存；后台开关说明关页仍采样、daemon 停止留空。

## Codex 追加完善接缝

- 仅 selected 内置 Codex、已知官方目的地且凭证为 OAuth 时允许自动刷新；custom HTTP 不触发刷新，其他服务商认证不变。
- `usage-auth-codex.js` 实现原 `auth.json` 的 refresh token 兼容读写，使用固定 `https://auth.openai.com/oauth/token` public-client 请求，不能读取或调用 Pi 运行时代码，不能执行登录工具、密钥命令或启动模型。
- 刷新文件写入必须协调原存储 `.lock` 目录协议（参考已安装 Pi 的 proper-lockfile 行为但零运行时依赖）；锁持有时每秒 heartbeat，锁忙有界失败，不能强制移除外部锁或抢占 stale 锁。重新读取安全 owner-only 文件，校验凭证未变和锁所有权后原子更新 Codex 条目，保留其他服务商及未知字段；失败不改凭证、响应和错误原文不回传。
- 在多个项目 daemon 共享凭证时，刷新 single-flight 需跨进程文件锁；拿锁后重读，若其他调用已刷新，复用最新有效凭证，不二次刷新。过期以时间判断，本轮不因 403 或 429 强制刷新 / 重试。
- 额度 items 新增可空 `used_percent`，百分比不代替接口实际原始数值。Codex 的 `used/remaining/total` 在 `%` 单位下只表达归一化百分比，不伪造绝对订阅限额；后端解析真实 `limit_window_seconds`，界面提供可读窗口名。
- error_code 增加独立 `timeout`、`rate_limited`，429/超时不归为授权失败，失败无自动无限重试。认证可使用安全分类 `auth_locked/auth_changed/refresh_failed`；历史白名单与 UI 文案同步。`agent_usage_points` 仅新增 nullable REAL `used_percent` 列，旧观测保留 null，不重写或由本地 token 用量补值。
- 父 Task 负责 `usage-query.js`、界面/历史增量字段、相关独立解析测试和文档；认证 child 负责新 `usage-auth-codex.js`、`status.js/status-accounts.js/usage-query-run.js` 接入和独立认证 mock 测试，可修正原 usage-query 测试中的过期行为断言。

## 并行文件边界

- Provider：`src/agent/status*.js`（不改 status-command/status-pi 非必要部分）、新增 `src/agent/usage-query*.js`；`test/agent/status.test.js` 与新增 provider 测试。
- Runtime：`src/agent/usage-settings.js`、`src/core/agent-usage.js`（可新增）、`src/core/project/agents.js`、必要 base/lifecycle 接缝、persistence、RPC registry/handlers、Web server API；新增独立设置/存储/后台采样/API 测试。不改 Web assets 或 status provider 实现。
- Web：`src/ui/web/assets/render-agent-status.js`、新增 usage UI/CSS、现有 status CSS/index.html 如必要，DOM 测试与 dom-world fixture。不改 server/RPC/backend。
- 跨模块修改同步本章和 Runtime/Web/CLI-RPC 模块表；端到端组合测试位于 `test/project/agent-usage-provider.test.js`。

[返回模块地图](modules.md#agent-状态只读查询接缝)
