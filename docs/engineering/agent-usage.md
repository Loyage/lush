# Agent 旧余额历史只读存档

本文固定旧额度查询退役后的项目服务与历史读取边界。用户决定 #255：Agent 配置仅诊断 Pi、Codex 软件本身；旧余额历史移到模型来源页作为只读存档，旧查询及后台采样停用，原配置、凭证及历史不删除。正式连接的余额、采样和历史继续按[账号资源连接器](agent-connections.md)运行。

## 当前边界

- `Project.agentStatus()` 直接调用软件诊断，不再经过旧用量服务，不读取 profile、账号、模型或认证。读模型见[模块地图](modules.md#agent-管理与状态查询接缝)。
- `AgentUsageService.start()` 不安排 timer、不读取诊断凭证、不查询、不按旧保留期清理；旧文件即使 `enabled:true`，重启也不得恢复采样。
- 旧 `query()` 和 `configure()` 明确返回退役错误；用户专属 `agent.usage.configure` 保留协议接缝但拒绝写入，不将它转为正式连接设置。
- `agent.usage.config` 仅作为旧配置只读兼容入口；不改写 `.lush/agent-usage.json`，新页面不调用它。
- 原 `.lush/pi/` 配置、认证与 `.lush/agent-usage.json` 不迁移、不删除。工作配置中的 Pi 基础设置及包管理仍由既有模块负责。
- 模型来源中的正式连接使用独立的 `agent.connections.*` 接口和存储，停用旧服务不得影响它们。

## 历史接口

用户专属 RPC：`agent.usage.history {provider?,account_key?,days?}`。HTTP：`GET /api/agent/usage/history?provider=&account_key=&days=`；days 为 1/7/30/90（缺省 7），保持登录、Origin、项目路由及 `no-store` 边界。

历史读取只从项目 SQLite 的旧用量附属表取得安全投影，不访问服务商、不读取认证、不新增样本、不启动 Agent。用户选定时间范围不再受旧保留天数裁切；也不得在读取时执行到期清理。损坏的旧查询配置不得阻止存档读取，更不得被默认值覆盖。

读模型仍为：

```js
{version:1,from,to,retention_days,series,truncated}
```

- `retention_days` 仅为兼容旧配置元数据，不代表存档正在执行该清理策略。
- series：`{id,provider,account_key,kind,label,unit,window_seconds,points,sample_count}`；point：`{at,remaining,total,used,used_percent,status,reset_at,error_code}`，按时间升序。
- 匿名账号、查询配置版本、指标、单位和窗口必须隔离；旧表没有 connection ID，不得按服务商名猜测归属或与正式连接曲线合并。
- 最多 40 条曲线、每条最多 500 点、总预算 680 KB；按所选完整范围有界抽样，超限明确 `truncated`，`sample_count` 保留真实样本数。失败/未知留缺口，缺少数值不得填零。
- 已删除连接的正式历史仍走 `agent.connections.history`，不与旧存档混为一个接口。

## 页面接缝

`render-model-sources.js` 在正式来源管理台之外提供按需打开的旧余额历史存档，`render-agent-usage.js` 导出 `createLegacyUsageHistory({ownsPage})` 和正式连接复用的 `renderUsageSeries(series,range,config)`。

- 首次打开模型来源只读连接与缓存，不请求旧 status、usage config 或旧历史。用户显式展开存档后才读取历史。
- 存档保留范围、账号、指标筛选、观测曲线与数据表；失败、空态、重置及截断明确提示，金额/百分比不混轴，未知不补零。
- 无旧查询、HTTP 映射、采样开关或保存设置入口；刷新历史仅重读本地缓存。
- 异步响应必须按页面身份及请求序列保护；离页、收起或更换范围后，不得把迟到响应伪装成当前结果。
- Agent 配置诊断页不组装历史组件，也不显示诊断账号、模型目录或资源发现列表。工作方式中的 Prompt、扩展/Skills 安装管理仍保留。

## Codex 追加完善接缝

旧 `usage-query*.js`、`usage-auth-codex.js` 等内部适配仍可用于独立兼容测试，正式连接也复用其中受控解析；它们不是重新开放旧查询的公开入口。其原 `auth.json` 锁协议、固定认证目的地、脱敏错误及有限请求边界继续保留；项目旧用量服务不得调用它们刷新认证或写入新观测。

正式托管 OAuth 刷新由连接管理器协调，Worker 快照只携带本次 access token，规则见[账号资源连接器](agent-connections.md)和[双模式运行](agent-configuration-v2.md)。软件诊断不能调用 SDK、登录、扩展或任何认证刷新。

## 验证与模块

- 软件诊断：`test/agent/status.test.js`，假 Pi/Codex 命令，检查路径、版本、安全错误、单飞及显式重查，不触碰真实认证。
- 退役服务与存档：`test/project/agent-usage*.test.js`、`test/web/agent-usage-api.test.js`，旧 enabled 配置重启不采样、不写配置或清理历史；旧配置损坏仍可读历史，写入口拒绝。
- 页面：`test/web/dom-agent-status.test.js`、`test/web/dom-agent-usage.test.js`，诊断无账号，旧存档按需本地读、离页响应隔离，正式连接历史保持可用。
- 原内部查询/认证适配的独立 mock 测试仍保留，不据此宣称旧产品功能仍开放。

细表见[Runtime](modules-runtime.md)、[Web](modules-web.md)、[CLI / RPC / 测试](modules-interfaces.md)；操作入口见[Agent 配置与模型来源](../reference/rpc/agents.md)。
