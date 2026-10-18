# 一次性整合与历史归并接口

本篇是一次性整合的 RPC、CLI／HTTP 参数及读面唯一参考，并保留历史归并查询契约。当前安全边界见[实施接缝](../../engineering/merge-convergence-implementation.md)，产品取舍见[一次性整合](../../design/merge-convergence.md)。接口不替代真实直接父、调用退出、写门或精确落地核验。

## 权限与参数

本篇分支操作 RPC **全部用户专属**，包括读取。新操作见[一次性整合](#一次性整合)；以下为历史兼容入口。Agent token 不得读取配置、修改开关或重试，不提供任意 cwd、project、ref、Shell 或 profile 参数。

| RPC | 参数 | 返回 |
|---|---|---|
| `branch.convergence_list` | 无 | `{version:1,items,count,truncated,defaults}` |
| `branch.convergence` | `{branch}` | 单分支策略 |
| `branch.convergence_set` | `{branch,mounted?,enabled,validation?,expected_revision}` | 退休错误，不写入 |
| `branch.convergence_defaults` | 无 | 历史默认，只读 |
| `branch.convergence_defaults_set` | `{mounted,enabled,scope?,expected_revision}` | 退休错误，不写入 |
| `branch.convergence_runs` | `{branch,before?,limit?}` | `{version:1,branch,items,next_before,has_more}` |
| `branch.convergence_retry` | `{id,expected_revision}` | 更新后的单个运行摘要 |

- `branch` 为精确本地分支名（最多512字符），须有活动 main/owner/order/child 所有者；拒绝 SHA、tag 和 ref 表达式，不隐式解析 `HEAD`。
- 退休 setter 的 mounted／enabled 仍必须是 JSON 布尔值，不接受字符串或整数；分支省略 mounted 按旧参数校验为 true，未挂载不能启用。历史默认可能保留 mounted=false、enabled=true，但不再应用于新创建。
- 退休 setter 的旧 scope 为 `main|all|user|none`，显式 scope 仍校验 mounted === (scope !== 'none')；参数合法也只会返回退休错误，不再影响未来创建。
- 旧 validation 参数仍校验为省略／null／严格 `{command_id,command_version?}`，UUID 与可选正安全整数版本；不重新保存，不预授权未来执行。
- `expected_revision` 必须为最近读面的非空、不透明 revision（最多256字符）；不可自行拼接、跨分支复用或自动改用新值。过期时拒绝并重新读取。
- runs 的 `before` 可省略/null，否则为正安全整数运行 ID；`limit` 可省略（20），否则为整数1..50。RPC 数值字段不接受数字字符串。
- 旧 retry 的 id 必须为正安全整数，不接受 W 编号或字符串，只处理旧运行；one_shot 必须用 branch.integrate_retry。landing/blocked 未知现场不得盲重放。

## 一次性整合

| RPC | 严格参数 | 返回 |
|---|---|---|
| `branch.integrate_plan` | `{branch}` | 只读计划 |
| `branch.integrate_start` | `{branch,expected_revision}` | 操作对象 |
| `branch.integration` | `{id}` | 操作对象，完整成员 |
| `branch.integrate_cancel` | `{id,expected_revision}` | 操作对象 |
| `branch.integrate_retry` | `{id,expected_revision}` | 操作对象 |

全部用户专属，包括读取；普通开发、integration token 均不得调用。branch 是精确本地分支名（最多512字符），要求唯一活动 main／owner／order／child 所有者，拒绝 SHA、tag、ref 表达式、任意路径。id 为正安全整数操作 ID，不接受数字字符串或 W 编号。expected_revision 是最近计划／操作读面给出的非空不透明字符串（最多256字符），不可拼接或自动刷新后重发；未知参数拒绝，不提供任意 cwd、ref、Shell、profile。

计划返回：

```js
{
  version:1, branch, target:{id,worker_number:null,branch}, revision,
  members:[{id,worker_number:null,title,source_commit,base_commit}],
  excluded:[{id,worker_number:null,reason}], count,
  active:null, // 或有界操作摘要
  ready:true, reason:null
}
```

members 是当前全部可准入、具有同一真实直接父的来源，不截为八项。脏、未读／暂存输入、待决、活动后代、已固定普通尝试／未知落地等列入 excluded；无来源或目标受阻时 ready=false。读取不领取、不写 Git、不启动 Agent。start 在写门内重新预检并原子固定完整集合，revision／refs／来源状态变化则拒绝；相同开始 revision 重发返回原操作，避免 ACK 丢失后重复创建。后来完成的来源不加入已开始操作。

操作对象：

```js
{
  version:1, id, revision, target_branch, state,
  worker:null, // 或 {id,worker_number:null,status}
  member_count, members:[{id,worker_number:null,title,source_commit,base_commit}],
  members_truncated:false, baseline, commit:null,
  candidate_commit:null, error:null, generation,
  target:{id,worker_number:null,branch}, previous_baseline:null, created_at, updated_at
}
```

state 为 preparing／resolving／awaiting／ready／landing／integrated／failed／blocked／withdrawn（持久模型另保留 stale 兼容状态）。commit 仅在 integrated 时为最终 Squash；candidate_commit 不能当作已落地。worker.status 来自真实 Worker，awaiting_acceptance 不代表操作 integrated。编号只取返回的 worker_number，缺号回退 #内部ID；不从操作 ID 推 W 编号。

`branch.integration` 返回完整 members；`worker.inspect.merge_operation` 与 `worker.graph.nodes[].merge_operation` 对真实目标、整合 Worker 及所属来源复用同一摘要，默认 null，关联多轮或多种关系时按操作 ID 取最新操作；摘要不改变目标或来源本身的合并／验收状态。摘要最多16名成员，member_count 为完整计数，members_truncated 明示；plan.active 同样有界，不能据摘要重建领取集合。旧历史查询另有八成员摘要上限，不限制新操作集合。

非空操作始终创建一个私有整合 Worker，即使无冲突也调用 Agent；费用与时间由用户启动承担。失败／待决不部分落地。retry 仅接受 failed／awaiting 且无真实调用／准备作业仍在退出、无未知落地的操作，复用身份／私有产物，追加新 generation 并重新适配与验证。待决须先处理；旧 revision、token 或返回不能推进新尝试。

cancel 只在发布开始前使整组失效并请求停止，返回可能仍为 awaiting（取消中）；实际退出后才 withdrawn 并释放来源。原普通请求恢复为 suspended，需显式重新请求，不自动写目标。landing／已有发布收据不允许取消或盲重试；取消不撤销已落地代码。新计划可再次开始已安全取消的集合，旧开始 revision 仍只定位旧操作。源 refs／真实父关系不变，来源验收独立，未知副作用不重放。

## 单分支策略

此节及旧策略表仅为历史兼容。策略返回 `{version:1,branch,owner_id,owner_worker_number,mounted,enabled,validation,revision,retired:true,editable:false,reason,counts}`；counts 仍按完整持久状态统计。未配置分支 mounted=false、enabled=false；main 初始化不再安装策略。旧缺 mounted 视为已挂载，保留原值／引用，不迁移或覆盖历史。

默认返回 `{version:1,mounted,enabled,scope,revision,retired:true,editable:false,reason}`；未配置为 mounted=false、scope=none、enabled=false。旧缺 scope 按 mounted 读为 all／none，历史默认不再应用于新 Worker。list 最多500个活动所有者、main 优先，超限明示；list.defaults 与独立读取同源。读取不写配置或启动 Agent。

branch.convergence_set 与 branch.convergence_defaults_set 仍识别旧严格参数，但始终明确拒绝退休写入，不保存同值或沿用旧 revision 假成功。新普通单项／自动合并无视历史 enabled，始终 serial。旧 v1/v2/v3 不转换；历史 Agent 模式不造命令证据，旧 command 模式继续隔离验证与精确候选门，缺损模式／引用不能转免验证。快捷指令实际版本规则见[契约](../../engineering/shortcut-commands.md#定义与版本)。

## 运行摘要

runs 按持久整数 ID 降序分页；`next_before` 用于后续页，`has_more` 表示还有历史。每项含：

```js
{
  id, revision, parent_id, target_branch, state,
  baseline: null, commit: null, member_count,
  members: [{id,worker_number:null,title,delivery_id,source_commit}],
  members_truncated: false,
  validation: null, // 或 {state,command_id:null,command_version:null,command_name,started_at,finished_at,error:null}
  integration_worker: null, // 或 {id,worker_number:null,status}
  error: null, created_at, updated_at
}
```

历史查询每项最多8名成员，member_count 为完整计数，超限显式 members_truncated；读取到新操作时也只是八项摘要，不限制实际集合。state 为 preparing/resolving/awaiting/validating/ready/landing/integrated/failed/blocked/withdrawn/stale。未真实落地不能仅凭准备完成展示已合并。成员链接使用真实整数 ID；显示只用返回的 worker_number，没有编号才回退 #ID。

运行摘要的 `validation.command_id` 来自实际执行结果或保存的引用，无法确认时为 null；`command_version` 仅表示实际执行结果记录的版本，未执行或旧结果缺少版本证据时为 null，不用配置中的旧版本或当前目录版本补造。二者是运行证据读面，不是预授权；旧证据不迁移、不改写，未来执行的版本固定见[快捷指令契约](../../engineering/shortcut-commands.md#定义与版本)。

返回值不包含完整 profile、环境、token、原始 Shell 输出或内部堆栈。运行错误不会触发接口层自动重试或回退到其它分支。

## 项目交付视图（D642）

此节保留旧链接／诊断兼容，不再提供独立当前交付导航或持续配置；新操作 UI 使用 merge_operation。底层完整计数通过统一成员视图涵盖新旧记录，八项 sources 摘要不代表新操作八项容量。

`worker.delivery_graph {history?:boolean,cursor?:string,limit?:number}` / `GET /api/worker-delivery-graph` 是**用户专属只读**入口，不增加 CLI 写动作或模型工具。拒绝 Agent token（包括整合与管理身份）、未知字段；HTTP 沿用登录、Origin、no-store 与固定项目路由，不启动停止的 daemon。`history` 默认 false，RPC 只接受布尔，HTTP 用 `0/1`；`limit` 默认20、整数1..50（HTTP 为正整数字面量）；`cursor` 为非空不透明字符串、最多1024字符。HTTP 重复、未知或非法参数拒绝，读取不在 `/api/action` 白名单。

响应：

```js
{
  version:1, history:false,
  items: [/* 以下三类有界条目 */],
  counts: {active,history,attention,batches,intents,serial,targets,by_stage:{},sources_by_stage:{}},
  matched_total, cursor:null, has_more:false, truncated:false
}
```

默认只取当前活动与异常，异常优先；`history:true` 单独分页成功落地历史，不把 withdrawn/stale/failed 当成功。counts 是全项目完整持久事实统计，不受分页或 history 筛选影响：active/history 统计条目，batches/intents/serial 统计种类，by_stage 统计各阶段条目，sources_by_stage 统计各阶段来源**成员记录次数**（不是去重 Worker 或去重 delivery_id），targets 统计已知真实目标身份及一个缺失身份组。批次成员计数用全库 SQL，不从返回的 sources/nodes 数量推算。v3 以 delivery_runs/members/nodes 和当前 reservation 为准；v2 当前预约与未固定的有效意图保留，历史以持久 `task.merge_integrated` 收据补充已消耗的 v2 预约，且排除 v3 的同名事件，不用上一轮合并冒充本轮。旧缺证据不补造历史。

`counts.attention` 是完整活动交付条目中需要处理的数量，按 item key 去重，不受 history、分页、成员或最多32项 helper 投影影响。每项 `attention:boolean` 使用相同判定，活动列表按 attention=true 优先排序：stage 为 invalid/failed/blocked/awaiting/stale，或批次当前 generation 关联的真实整合 Worker 为 awaiting/paused/failed/cancelled，或当前 helper 缺失、类型/真实 parent 不符，均计入。多 helper、多来源只计一个批次；正在 resolving 却无当前 helper、需要 helper 的 resolving/awaiting 节点无身份、run 的 helper 指针完全缺少节点归属，也按身份不可核对提示。已知旧 generation 的 current=false helper 不污染本代计数，成功 integrated 历史始终 false。awaiting_acceptance/completed 不因自身状态计入，也不代表批次已合并。此判定及完整等待原因使用无上限的轻量 SQL 聚合，不从有界 helper 卡片推算；因此被截断的异常 helper 仍能使条目 attention=true，并给出真实待决/失败/暂停/身份诊断。attention 改变会使排序结构游标过期，避免跨页漏项。

每条都有稳定 `key/kind/stage/target/locator/attention`：

- `kind:'batch'`、`key:'batch:<run_id>'`：真实 `run_id/generation`、baseline/commit、created_at/updated_at、安全 error、waiting_reason/blocked_code、integration_workers、sources，以及 member_count/members_truncated。`nodes` 只返回当前 generation 的 `{id,key,node_key,state,helper_id,locator}`，带 node_count/nodes_truncated；previous_generation_node_count 明示旧代节点数，绝不把旧代 helper 当当前整合身份。当前 sources 最多8、nodes/helper 引用最多32，超限明示。历史重试 generation 仍使用同一批次 key。
- `kind:'serial'`、`key:'serial:<worker_id>:<delivery_id>'`：v2 单源或尚未形成批次的固定交付；成功收据另带 commit/created_at 与 event_id 定位。v3 缺失批次也明确显示，不凭空创建批次。
- `kind:'intent'`、`key:'intent:<worker_id>'`：尚无 delivery_id 的有效意图，或损坏/未知预约诊断；不是已固定交付。损坏显示 stage=invalid，不静默丢弃。

`target` 是 `{id,worker_number,status,title,missing,branch,identity_mismatch,locator:{worker_id}}`，id 是批次或固定预约的真实目标；未固定意图才用真实 parent_id。branch 是保存的目标名，缺失为 null，不做 Git 查询，也不改投当前所有者。来源项为 `{id,worker_number,status,title,missing,parent_id,delivery_summary}`；parent_id 始终来源真实父身份，不是可视分组，不把整合 Worker 变成来源父节点。编号只用明确 worker_number，缺号回退 #ID。

`worker.inspect.delivery_summary` 与 `worker.graph.nodes[].delivery_summary` 复用来源相同投影，无当前预约时为 null：

```js
{
  key,kind:'source',version,delivery_id,run_id,generation,attempt_id,
  stage,attention,reservation_status,current,identity_mismatch,reservation_version_unknown,reservation_truncated,
  target,source_commit,waiting_reason,blocked_code,
  integration_workers:{items,total,truncated},
  input_queue:{buffered,reason},
  locator:{worker_id,run_id,generation,delivery_id,attempt_id,event_id?}
}
```

current 表示成员仍与当前预约的批次/代/交付身份匹配；成功 v2 历史收据固定 false，新增一轮 pending 不借旧收据显示已交付。历史卡片的 input_queue 仍是来源**现在**的输入暂存事实，不是过去一轮的输入快照。不存在来源时 buffered=null，明确未知，不冒充零。输入只含条数与同源等待原因，不含正文；已保存不表示 Agent 已收到。blocked_code/waiting_reason 区分来源尚未静息、子成果/代码依赖、未固定意图、等待组批、整合准入/排队/运行/待决/失败/已交付但未落地、落地安全点与未知落地；等待原因未保存时明确未知，不造队列名次或预计时间。

integration_workers.items 为 `{id,worker_number,status,title,missing,identity_mismatch,node_id,node_key,node_state,generation,current,locator}`；status 来自真实整合 Worker 行，不从节点状态猜。历史已删除为 status=null/missing=true，保留持久快照编号；generation/current 来自节点归属，run 仍引用旧代退出中的 helper 时明确 current=false，不用旧代状态解释本代整合；类型或真实 parent 不匹配明确标 identity_mismatch。整合 Worker 的 awaiting_acceptance/completed **不代表**批次 integrated，只有运行持久落地状态才是已合并。

每页最多50条且整个响应真实 JSON UTF-8 字节严格小于900000（包括转义），超预算停止并从实际返回条目续读。单项异常过大降为身份/stage/locator 与 item_truncated/unavailable_reason；字节预算、成员、节点或 helper 截断都会反映 truncated。游标绑定 canonical 项目、history 与完整轻量交付结构；状态/代/成员关联等结构变化以 `Worker delivery graph cursor stale; refresh from first page` 拒绝，客户端从首批显式刷新；跨项目/筛选、非法格式另行拒绝。页间正文、helper 与输入状态不是事务快照；每页内部一致。文本预览有界，预约超过65536字符时 reservation_truncated 明示无法完整核对，不冒充损坏或修改原记录；SHA/编号白名单、未知 error 用固定安全说明；不读取完整 profile/env/token/Prompt/Shell 输出，不暴露原始错误堆栈。全程只读 SQLite/运行态，无 Git 查询/写入、Agent 调度或历史迁移。

## 专用整合 Worker 的 RPC 能力

Runtime 内部创建的 `task_kind='integration'` 使用 invocation 临时 token；Dispatcher 从成功认证的 Store Worker 事实识别类型，不能靠 Prompt、角色名称或调用参数取得开发 Agent 权限。`src/rpc/registry.js` 的 `INTEGRATION_METHODS` 是默认拒绝的窄白名单：

- 自身提问／汇报：`context.notice`、`context.progress_plan/complete`（兼容底层 `notice.post`、`progress.plan/complete`）。Notice 只能写 token 所属 Worker；进度不接受目标 Worker ID。
- 只读：自身／直接父的 `context.inspect/history/transcript`、自身 `context.notices`，以及受目标准入检查的 `worker.lookup/inspect/diff/history/history_page/transcript`。除自身和直接父外，额外目标必须命中服务端重新核验的持久固定整合成员，不能按任意 ID、目标子树或角色名放行；context 的 child 关系仍只认真实直接 child。项目状态、全项目 Worker／branch／graph／Notice 枚举均不可用。

其它方法一律拒绝，包括 `worker.spawn/integrate/resolve_child_divergence/message/auto_title/accept`、所有策略／合并／验收 mutation、管理工具，以及全部 `branch.convergence*`、`branch.integrate_*` 和 `branch.integration`。新增公开 RPC 不自动扩展整合权限；现有 USER_ONLY / AGENT_ONLY 校验仍先执行，普通开发查询边界见[双入口契约](../api.md#开发与管理双入口)，管理代理仍独立审核。过期、停驻、中断或已结束 invocation 的 token 不能使用这些允许的方法。

此 RPC 门不是 OS 沙箱，不防止同系统用户的任意本机命令；工作区、固定输入、执行 Prompt 与生命周期隔离由 Runtime 提供。

## CLI

```bash
bun run lush branch integrate plan main
bun run lush branch integrate start main --revision PLAN_REV
bun run lush branch integrate show 9
bun run lush branch integrate cancel 9 --revision OP_REV
bun run lush branch integrate retry 9 --revision OP_REV
# 历史兼容
bun run lush branch convergence list
bun run lush branch convergence show main
bun run lush branch convergence defaults show
bun run lush branch convergence runs main --before 15 --limit 20
bun run lush branch convergence retry 8 --revision RUN_REV
```

支持通用 --project PATH／--json。未知、重复、缺值或不适用选项拒绝；先读 plan／show 的 revision，不能自动刷新后重发。操作 ID 是整数，不是 Worker 编号。start／retry 可能调用 Agent 并产生费用；CLI 本地也拒绝带 Agent token 的客户端，包括读取。旧 convergence mount/on/off/remove/defaults set 只保留明确退休错误，不再保存配置；CLI 不接受旧 --command／--version，历史验证引用只在后端协议兼容。

## HTTP

- `GET /api/branch-integrate-plan?branch=main` 对应 branch.integrate_plan；branch 必填。
- `GET /api/branch-integration?id=9` 对应 branch.integration；id 必须为正整数字面量及安全整数。
- 新写入口为当前项目 POST /api/action 的 branch.integrate_start／branch.integrate_cancel／branch.integrate_retry。envelope 严格为 `{method,params}`，params 必须为对象，拒绝 query、多余字段和任何 `_token`。
- 旧 GET /api/branch-convergence[?branch=...]、/api/branch-convergence/defaults、/api/branch-convergence/runs 保留历史读取；runs 的 branch 必填，before 为正整数、limit 默认20／最多50。
- 旧 action branch.convergence_set／branch.convergence_defaults_set 明确报退休，branch.convergence_retry 只恢复合法旧在途，不用于新操作。

GET 拒绝未知或重复查询字段；读取 RPC 不在 action 白名单，也无 GET 修改入口。全部复用登录、Origin、no-store 和项目绑定；全局 Host 必须使用 `/p/<project-id>` 前缀，未知身份不回退，读写均不通过此入口拉起已停止 daemon。详见[Web 路由](../web-routes.md)。
