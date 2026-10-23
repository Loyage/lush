# 运行诊断分析读面

本章是「模型和来源 → 运行诊断」的使用与数据契约。项目 daemon 拥有运行元数据；Host 只读派生，不保存跨项目权威事实。原无参数 `system.diagnostics` 与 `/api/host/diagnostics` [卡片协议](dashboard-panel.md#运行诊断卡)不变，不应把卡片的按墙钟 token/s 称为模型吐字速度。

## 页面使用

从「模型和来源」第三页签进入，默认近 24 小时分析全部已报告数据；也可从模型／来源行的「运行诊断」带入具体绑定，或从全局总览诊断卡的「分析」打开完整页。卡片「快照」仅展示原 1／5 分钟和 10 分钟趋势，不是完整分析页。

选择近 1h／24h／7d／30d，或最近 30 天内的本地时间起止，按「应用筛选」提交；「重读」保留选择。来源和具体模型候选包含本地登记、已读历史及深链已选值，未知项为 `@unknown`，不会静默改选第一项。项目选项使用 Host 的真实登记 ID，不启动离线后台。筛选编辑会取消旧请求，旧结果保留时明确标出原范围；失败不伪装成空结果。离页／切页签取消自有请求并释放页面模块，没有自动联网额度刷新。

页面深链为 `#model-sources-diagnostics`，可携带 `?period=7d&connection_id=...&model=...&project_id=...`（值使用 URL 编码）；自定义范围为 `period=custom&from=<UTC ISO>&to=<UTC ISO>`。根工作台使用 Host 聚合；显式 `/p/<id>/` 下同一诊断深链使用项目读面，不附加 Host 项目筛选。返回模型／来源页签不改变原默认入口；再次切到诊断保留当前筛选。

图表和速度比较默认展开；现在的额度缓存、明细与计算口径使用共享模块按需展开。覆盖提示始终显示，图表不能证明未采集部分为零。键盘左右键／Home／End 切换三个页签，筛选表单可按 Enter 应用；窄屏保留可见操作、换行筛选与卡片明细。

## 入口与参数

- 用户专属 RPC `system.diagnostics.query {from?,to?,connection_id?,model?}`；普通开发 Agent、Valet 不能调用，也没有新增 Agent 工具。
- 项目 GET `/api/diagnostics/query`（全局工作台为 `/p/<project-id>/api/diagnostics/query`）。
- Host 根 GET `/api/host/diagnostics/query`，另接受 `project_id`。仅已登记、授权项目；不存在的项目 ID 拒绝。离线 daemon 不启动，不调用 `openRoute`。
- 两条 HTTP 均沿用登录、Origin 和 no-store。拒绝重复、未知参数、无效类型和范围，不接收路径、token 或任意 RPC。
- `from/to` 为 UTC ISO 字符串，秒或三位毫秒精度。默认 `to=now`、`from=to-24h`；`from < to <= now`、跨度最多 30 天、起点在最近 30 天内（起点容许 5 秒 Host→项目传输偏差；真实存储清理不延长）。不是任意历史检索。
- 来源按冻结 `connection_id` 精确过滤，模型按实际 `provider/physical-model-id` 精确过滤，均区分大小写。`@unknown` 选择未知来源／模型；省略表示全部。历史失效来源仍可用 ID 查询，不依赖当前登记。模型注册名称不能用作过滤值。
- `src/core/diagnostics-query.js` 导出 `DIAGNOSTICS_PARAMS`、`diagnosticsQuery`、`diagnosticsSearch`、`diagnosticsRequest`、聚合纯函数；RPC 与两种 HTTP 共用校验来源。Host 先冻结起止再传给所有项目，不分别取各项目的默认现在。

## 返回结构与单位

```js
{
  version: 1, generated_at, retention_days: 30,
  range: {from, to, bucket_ms, connection_id: null|string, model: null|string, project_id?: null|string},
  summary, buckets: [{at, ...metrics}], groups: [{connection_id, model, ...metrics}],
  coverage, quota: {series, current, current_status, truncated,
    attribution: 'observed_change_not_lush_consumption', model_filter_applied: false},
  projects: [{id, name, state, generated_at, error?}]
}
```

项目 `projects=[]`；Host 的 state 为 `online|offline|unavailable|unsupported`，错误是固定安全码，离线／旧版本不补零。所有时间为 UTC ISO；区间为 `[from,to)`，响应按**结束时间**入桶。桶起点 UTC 对齐：跨度不超过 1h 用 1min 桶，不超过 24h 用 1h 桶，不超过 7d 用 6h 桶，其他用 1d 桶；头尾只用与查询区间相交的有效秒数计算流量。桶按时间升序，groups 按请求数降序、来源＋模型稳定次序；最多 128 组，超限标 truncated，summary 仍包括读取到的全部组。来源和模型未知为 null，不拿当前配置猜历史。

每份 metrics（summary、bucket、group 同形）：

| 字段 | 含义 |
| --- | --- |
| requests | 已采集的 assistant 响应数，不是 Worker 数；含工具调用响应、失败响应 |
| input_tokens / output_tokens | 已知 token 小计；输入含 cacheRead/cacheWrite，输出不再次叠加 reasoning |
| estimated_cost_usd | Pi 报告的估算 USD 小计，非扣款、套餐折算或账单 |
| unknown_usage / unknown_cost | 用量／估价缺失的响应数，不是推测的缺失 token／金额 |
| input_per_second / output_per_second | 已知 token 小计 ÷ 所选墙钟秒数，即流量，不是输出速度 |
| text_samples / text_chars / text_ms | 有效文本响应数、计入速度的 Unicode 码点数、对应可证明的连续文本 delta 间隔毫秒总和 |
| text_chars_per_second | `sum(text_chars) / sum(text_ms) * 1000`；无有效分母为 null |
| response_samples / response_tokens / response_ms | 同时有有效响应计时和输出 token 的样本数、这些样本的输出 token 和响应毫秒总和 |
| response_tokens_per_second | `sum(response_tokens) / sum(response_ms) * 1000`；无有效分母为 null |
| wait_samples / wait_ms / wait_mean_ms | 从请求开始到首个文本／思考／工具参数 delta 的样本数、毫秒总和、算术平均毫秒 |
| ttft_samples / ttft_ms / ttft_mean_ms | 从请求开始到首个**文本** delta 的样本数、毫秒总和、算术平均毫秒；没有文本不贡献样本 |

计时使用单调时钟；请求从 `before_provider_request` 到对应 `message_end`，包含网络等待、思考及工具参数生成，但不含工具执行、Worker 空闲或用户等待。多个请求无法唯一对应一个响应、错误／取消、缺事件、超长或异常时间不提供可靠速度。实际模型来自结束消息，不从登记名称推断；与托管固定模型不一致时来源置为未知。

纯文本速度仅使用同一连续文本段内相邻 text_delta 的间隔，思考／工具事件断开文本段。每段首个 chunk 没有可证明的生成耗时，因此其字符不进入速度分子；至少两次有正间隔 delta 才有效。它是**可观测文本生成片段的速度估计**，不是全响应字符数或网络逐字节速度。只有一个 chunk、仅思考／工具、未接入后端的文本速度为 null。不同响应／项目一律合并分子和分母，不能平均已有速率。

`coverage`：

- `samples/runs` 为纳入的响应／调用数；`unknown_runs` 包括缺失、未结束、未支持后端、零响应及旧元数据缺口，缺历史归属时保守保留在过滤后的覆盖提示中。
- `dropped_samples` 是采集限额／异常导致的丢弃数。`truncated` 为响应、调用、分组或项目读预算不足。
- `usage_complete` 仅指已知流量／估价覆盖；`complete` 还要求响应效率计时完整。它们**不**表示额度历史连续或文本样本全部可测。
- `response_samples/text_samples`、`response_coverage/text_coverage` 分别给计时样本数及占已采集响应比例（0–1，无响应为 null）；工具专用响应也在比例分母内。比例不包含未知调用中无法知道的响应数，必须同时显示 unknown_runs 和 dropped_samples。
- `legacy_backfill:false`：本版不自动回放旧会话。原始用量／卡片仍可查，分析页旧计时与未采集用量保持 unknown，不会因刷新变成完整零值。
- Host 另有 `projects_total/projects_reporting`；缺项目、缺调用或截断时，小计及墙钟流量都是已知下界，不能把 0 显示为确认零消耗；速度只代表有效样本，不是速度下界。缺口不能定位到精确桶时，所有桶／组都应继承全局覆盖警告。

## 额度：观测变化而非独占消耗

`quota.series` 只读已有安全额度历史，不触发联网。按 connection、provider、匿名 account_key/source_key、资源 kind/scope/指标、unit、窗口长度和模型范围隔离；series `id` 是既有稳定哈希。Host 为每条 series/current 加 `project_id`，不合并相同共享账号的项目观测，也不把它分摊给模型。

series 字段为 `{id,connection_id,provider,account_key,source_key,kind,scope,label,unit,window_seconds,models,sample_count,sample_count_lower_bound,sampled,points}`。`sample_count_lower_bound:true` 表示有更多点未读。每点 `{at,remaining,total,used,used_percent,status,reset_at,error_code,source,reset,remaining_change}`：未知数值 null；`remaining_change` 是相邻完整成功采样的 **本次 remaining - 上次 remaining**，不是 Lush 消耗。失败、重置时间变化、剩余量增加、总额变化或降采样时差额 null。`reset:true` 表示可能的重置／充值／窗口变化证据，不断言服务商确已恢复。外部消费仍可造成下降，不混加币种、账号、百分比或套餐窗口。

`quota.current` 是现在的设备缓存，与查询区间无关：`{connection_id,label,observation,last_success}`，观测及旧成功字段沿用[连接契约](agent-connections.md)。当前读取失败为 `current_status:unavailable`，Host 部分失败为 partial；没有历史不伪造曲线。删除来源保留历史但不再有当前缓存条目。模型过滤不缩窄额度曲线（`model_filter_applied:false`），来源过滤仍适用；页面须说明这些是来源共享资源，不能暗示模型独占。

## 持久化、预算与取消

Pi 扩展只被动观察已有调用，无网络、后台计时器或额外模型探测。每 invocation 私有临时目录最多 1024 行／1MiB，落盘只含白名单计时／用量／实际模型，绝不含文本、思考、工具参数、headers、凭证或原始响应。Provider 退出（含失败）后由 daemon 校验吸收，按 run_id＋sequence 幂等，正常回收临时目录。fork 复制的上下文不是新采集事件，不重计费用。

独立 `diagnostic_runs/diagnostic_samples` 只保留最近 30 天；启动、采集及每小时维护清理，停止时清 timer 并等待已开始的临时目录清理。临时目录清理最多检查 4096 个会话目录项，只删除过期、私有、固定命名的诊断目录；遇到异常保留，下一次维护可重试。原始 run、会话和既有额度历史不删除、不改写。崩溃未完成导入保持 unknown，不根据临时文件或现有配置自动重放。

单项目查询最多读取 20000 响应／4096 调用；额度最多 24 系列，每系列索引尾读 1024 点、返回最多 96 点，优先保留失败／重置边界，再均匀抽样；截断显式告知，不承诺代表未读历史。最终响应 UTF-8 控制在 850KB 内，预算不足先截额度集合。查询不扫描会话正文、不持久缓存查询结果。

Host 最多 128 项目、并发 4、单项目 1.5s、总预算 6s，同时最多 4 次分析查询；范围固定、严格白名单投影、只读已有 socket。HTTP 取消向 RPC socket／Host fanout 传播，所有 timer/listener 在 finally 释放；取消不会中断已经开始的项目同步 SQLite 查询，但该查询有上述固定读取预算，没有后台延续任务。取消不影响正在运行的模型调用。旧卡片自己的缓存／单飞生命周期不变。
