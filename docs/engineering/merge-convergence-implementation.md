# 分支归并首版实施接缝（W205）

本篇固定 A205-1、D482、D512 对应的首版接口与实现边界。**代码已实现，默认关闭；不代表运行中的 daemon/Host 已更新。** 总体取舍见[产品方案](../design/merge-convergence.md)，本篇的分支开关要求优先于原方案最终统一管线/不保留模式按钮的愿景。实际模块与导出见[Runtime 地图](merge-convergence-runtime.md)，公开操作见[接口参考](../reference/rpc/convergence.md)。

## 用户确认与首版边界

- 按真实目标分支持久保存开关，默认关闭，不继承；main 开启只影响交付到 main 的新固定请求，不提高任何 Worker 的自动合并/验收权限。
- 开关是用户专属策略，Agent 不得调整。只允许具有活动 main/owner/order/child 所有者的真实本地分支，不接受 SHA、tag 或 ref 表达式。
- 启用必须选择已授权项目快捷指令的精确版本作为最终验证；缺失/失败/超时/撤权/改版阻止发布。指令在登记过的隔离检出中运行，不在真实父目录，不携带 Agent token；不是操作系统沙箱。
- 首版包含固定成果两两归并、每批单父 Squash、最终验证、按需专用整合 Worker、无已知代码依赖的就绪成果绕过失败/待决组合。准备阶段不得污染源或父 ref。
- 原有在途 v1/v2 不转换；开启/关闭只改变之后真实安全点的新交付选择。已经固定的新协议继续收口，关闭不撤回、不自动重试未知副作用。
- 每目标发布门由新旧队列共用；准备、Agent 和验证不持有父写执行位。源请求冻结保留消息暂存、撤回和验收门。

## 首版实现与明确限制

- 事件驱动领取当前可用成果，立即固定 1..8 名成员及平衡两两拓扑；不等待凑满、不实现 200ms 形成窗口、动态扩批或阻塞批次内部自动拆分。无依赖的后续批次可先发布，依赖上游必须已落地。
- 项目最多 4 个非 Worker 的准备作业；按 W210／D492 不设置 Worker invocation 或整合身份的并发额度。同批节点按固定拓扑顺序计算。没有单父专用验证晋级槽，多批可并行验证，目标推进后重新适配、验证；不能承诺单次验证或固定加速。
- 自动父基线刷新最多 3 次，每节点最多 2 次整合尝试；显式重试固定新 generation 并重新核验来源与授权。未实现按金额预算、饥饿 SLA 或自动语义风险分类；无冲突路径依赖用户选择的验证命令，不能据此保证满足全部需求。
- 精确单父候选先生成再验证。Shell 上限 20 分钟、8 MiB 输出，丢弃原始输出，只保存安全结果；剥离 invocation/provider 环境，检查前后身份与清洁度并回收进程组。验证不在真实父目录，但不是沙箱；未提供原始验证日志下载。
- Git 必须支持实际调用的 `merge-tree --write-tree --merge-base`；不支持时该运行失败保留现场，不静默切回旧队列。未实现独立启动能力预检或自动降级检测；有在途 v3 时不得部署不识别 v3 的旧代码。
- 多源精确收据覆盖后续增量、父同步、交付投影、验收与删除；来源各自保留。发布未知保持目标写门，只精确核验，不盲重放 Git/Shell；中断验证/模型必须显式检查后重试，脏/未知资源保留。
- helper 的产物只推进固定节点，不走普通向上合并，不冒充成员 merged。全部关联来源安全验收后才受检回收辅助现场；独立来源删除保留共享批次快照与证据，部分回收可显式续办。
- 当前 UI 位于项目自动化页，展示分支开关、完整活动计数、分页成员/验证/辅助身份/提交与显式重试；不提供方案中的完整交付仪表盘、归并树交互、独立贡献撤销或抵消解释。
- 临时项目、受控 provider 与真实 Git/Shell 测试不证明真实模型整合质量、浏览器视觉或负载性能。最终组合验证范围由用户授权命令决定，不自动推断它是全量；开发交付仍由顶层 W205 完整运行项目全量。

## Project 对外方法（Runtime 提供）

以下方法返回安全 JSON，不包含完整 profile、环境、token、Shell 原始输出或内部错误堆栈；分区不得自行换签名。

```js
branchConvergence(branch)
branchConvergenceList()
setBranchConvergence(branch, enabled, validation, expectedRevision)
branchConvergenceRuns(branch, before = null, limit = 20)
retryBranchConvergence(id, expectedRevision)
```

`validation` 是 `null` 或严格白名单 `{command_id, command_version}`，指令 ID 为现有 UUID，版本为正整数。启用时必须为合法授权引用；关闭允许保留同一引用，不能顺手创建/授权快捷指令。setter 经 Project 写门、固定目标/所有者检查与 revision 乐观锁；成功保存后只驱动合法新调度，不修改既有固定请求。

单分支读面和 setter 返回同一结构：

```js
{
  version: 1, branch, owner_id, owner_worker_number: null,
  enabled: false,
  validation: null, // 或 {command_id,command_version,name,authorized}
  revision, // 非空、不透明；包含分支身份，未配置也返回稳定 revision
  editable: true, reason: null,
  counts: {preparing:0,resolving:0,awaiting:0,validating:0,ready:0,landing:0,failed:0,blocked:0}
}
```

`counts` 查询完整持久活动运行，不从分页成员/Worker 图节点推导；integrated/withdrawn/stale 不计入活动计数。只读未配置分支不写默认行、不执行命令、不启动 Agent。`authorized` 是当前授权事实，已存版本过期时 false，不能自动升级引用。

list 返回 `{version:1,items:[上述结构],count,truncated}`，最多 500 个有活动所有者的分支，main 优先，其他按名称稳定排序；未配置分支也展示默认关闭。非法单分支读取明确拒绝，列表不足部分显式 truncated。

runs 返回 `{version:1,branch,items,next_before,has_more}`，按持久整数运行 ID 降序，limit 1..50，before 为可空正整数游标。items 结构如下：

```js
{
  id, revision, parent_id, target_branch,
  state, // preparing|resolving|awaiting|validating|ready|landing|integrated|failed|blocked|withdrawn|stale
  baseline: null, commit: null, member_count,
  members: [{id,worker_number:null,title,delivery_id,source_commit}],
  members_truncated: false, // 每项最多 8 个，超限必须明示
  validation: null, // 或 {state,command_name,started_at,finished_at,error:null}
  integration_worker: null, // 或 {id,worker_number:null,status}
  error: null, created_at, updated_at
}
```

重试只允许精确 revision 的明确失败/可恢复待处理运行；必须拒绝 landing/blocked 的未知现场盲重放，重新核验命令授权及固定来源。返回更新后的该运行安全结构。原 `worker.unreserve` 处理新协议的成员撤回，不新增任意 ref 写操作。

## RPC、HTTP、CLI（接口分区提供）

新增 RPC 全部 USER_ONLY，参数严格白名单，Agent 无读配置/写策略或重试权限：

| RPC | 参数 | Project |
|---|---|---|
| `branch.convergence` | branch | branchConvergence |
| `branch.convergence_list` | 无 | branchConvergenceList |
| `branch.convergence_set` | branch,enabled,validation,expected_revision | setBranchConvergence |
| `branch.convergence_runs` | branch,before,limit | branchConvergenceRuns |
| `branch.convergence_retry` | id,expected_revision | retryBranchConvergence |

Web GET `/api/branch-convergence` 无 branch 查询时返回 list，有精确 branch 时返回单项；GET `/api/branch-convergence/runs?branch=...&before=...&limit=...` 返回 runs。mutation 仅走 `/api/action` 的上述 setter/retry 白名单，复用登录、Origin、项目固定路由、JSON 与用户权限。读取不拉起停止的 daemon，不接受任意路径。

CLI：`branch convergence list`、`show BRANCH`、`on BRANCH --command ID --version N --revision REV`、`off BRANCH --revision REV`、`runs BRANCH [--before N --limit N]`、`retry RUN_ID --revision REV`。on 不隐式授权；off 读取现有引用再保存，仍由 expected revision 防竞态；仅正确命令可接受这些选项，异常/JSON 输出延续现有 CLI 约定。

## Web 体验（UI 分区提供）

在项目自动化页添加独立「分支归并」区，不混进设备默认策略或 Worker 自动链。默认只读加载分支列表；选择分支后显示当前开关、目标、已授权快捷指令及精确版本、保存按钮和当前/历史批次。main 必须能直接选择，不依赖 Worker 图恰好载入它。

保存使用完整 `{branch,enabled,validation,expected_revision}`；开启前确认：每批一个提交、可能调用整合 Agent 产生费用、验证指令在隔离区执行但不是沙箱。纯读/配对无 Agent 标识，开启和可能重试整合的按钮使用 `agent-call`/`agentHelp`；禁用原因/破坏性后果符合 UI guidance。

成功 ACK 与后续刷新失败分开，失败保留分支、选项及正文；换分支/页面后的迟到响应不能覆盖新目标。命令仅从已有用户专属 hooks.list commands 的授权目录选择，不新增 Shell 输入或自动授权。命令已过期仍显示保存的版本与不可用原因，不静默替换为最新版。

批次展示成员真实 Worker 链接、阶段、失败/待决、验证状态、整合 Worker 链接和精确提交；分页与缺字段保守兼容。成员未进入真实父前不得展示已合并。只读刷新不执行动作。

## 内部 Runtime/Git 责任

Runtime 分区 owns `src/core/`、`src/persistence/`、`src/agent/` 与对应专项，不修改 RPC/CLI/server/assets。它可在自己的 child 中分拆 Git/纯规划/Store 等工作，传递最终全量由 W205 负责；内部导出由其协调固定，不改变上述公共面。

新预约必须显式新协议/version，与普通 v2 隔离。专用 `task_kind='integration'` 仅 runtime 内部工厂创建，具有登记私有 worktree、固定输入/节点/尝试与窄工具权限，不沿用旧 merge 身份，不重挂原 Worker。provider/scheduler/workspace/context/prompt/guard、消息、取消/恢复与资源生命周期必须共同适配，不能让 ensure 返回 canonical 项目目录。

整合身份按同一 invocation 快照注入可选 `progress/context` 指南，不适用委派和自动标题；关闭模块不改变核心验证或 RPC 权限。项目批量维护覆盖活动整合调用，完成信号等待真实退出及准备／发布作业收尾；继续只恢复原固定节点和身份，不开放普通 helper 暂停／运行配置接口。快捷指令的默认 Worker 不改变最终验证的隔离候选目录。

跨区安全接缝：Interface 在 Dispatcher 按有效 `actorTask.task_kind === 'integration'` 默认拒绝，只允许 `notice.post`（自身）、`progress.plan/complete`（自身）及现有安全只读 `system.status/summary`、`worker.lookup/inspect/diff/history/history_page/transcript`、`branch.tree/show`、`graph.get`、`notice.list/page`；原 USER_ONLY/AGENT_ONLY 门仍先执行，不开放 `branch.convergence*`。明确拒绝 `worker.spawn/integrate/resolve_child_divergence/message/auto_title` 等普通开发 mutation。不得只靠 Prompt 声明窄权限；Runtime 提供真实 helper 类型、一次性 invocation token 与固定 context，Interface 增加实际 actor 类型/过期 token/自身 Notice 与进度回归。确需其他只读 API 时先协调并更新白名单，不能用一个宽泛前缀放行。

多源落地树不等于单源树；同步基点、iteration 状态、squashedLanded、验收/删除/共享资源保护必须适配精确成员收据。Git/ref transaction、已准备未发布/已发布未结算恢复、原始消息及真实 Hook 来源都须实际回归。一个发布批次只触发一次父 merge_received，成员各自结算与通知，自动验收仍按原授权。

准备并行有界、每批最多 8 个，调度窗口短且单项不强等配对；长队列不建无界 worktree。命令/模型失败可见，无已知依赖运行可继续；错误无文本冲突不证明语义兼容，最终授权验证是硬门。

## 分区与测试责任

- Runtime：实现上述状态与行为；可委派内部子分区。专项必须覆盖真实临时 Git/SQLite、默认关闭旧路径、新批次、多轮同步、冲突整合、验证失败/撤权、冻结消息、取消、故障恢复及发布互斥。默认不跑全量，影响广泛或范围无法判断时说明并扩大。
- Interface：只改 RPC/CLI/Web server 与 API/CLI/HTTP tests、相应 reference 文档；用 Project stub 与真实协议验证，不替 Runtime 另写调度。
- UI：只改 assets 与 DOM tests、modules-web；默认关闭、main 可选、授权命令、保存/分页、迟到响应和 Agent 标识须完整运行专项。
- W205：检查所有 child 成果/实际交付，不提前验收；负责跨模块真实临时项目联调、最终代码树 `bun run test` 全量、文档与最终提交。子分区不得操作用户正在运行的队列或服务。
