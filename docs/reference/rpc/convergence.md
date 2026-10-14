# 分支归并接口

本篇说明按目标分支保存的归并策略、运行历史与显式重试。实现接缝见[首版实施契约](../../engineering/merge-convergence-implementation.md)；产品取舍见[归并合并方案](../../design/merge-convergence.md)。接口入口不替代 Runtime 的授权、分支所有者、写门或落地核验。

## 权限与参数

以下 RPC **全部用户专属**，包括读取；Agent token 不得读取策略、修改开关或重试。所有请求拒绝未知字段，不提供任意 cwd、project、ref、Shell 或 profile 参数。

| RPC | 参数 | 返回 |
|---|---|---|
| `branch.convergence_list` | 无 | `{version:1,items,count,truncated,defaults}` |
| `branch.convergence` | `{branch}` | 单分支策略 |
| `branch.convergence_set` | `{branch,mounted?,enabled,validation?,expected_revision}` | 保存后的单分支策略 |
| `branch.convergence_defaults` | 无 | 项目新 Worker 默认 |
| `branch.convergence_defaults_set` | `{mounted,enabled,scope?,expected_revision}` | 保存后的项目默认 |
| `branch.convergence_runs` | `{branch,before?,limit?}` | `{version:1,branch,items,next_before,has_more}` |
| `branch.convergence_retry` | `{id,expected_revision}` | 更新后的单个运行摘要 |

- `branch` 为精确本地分支名（最多512字符），须有活动 main/owner/order/child 所有者；拒绝 SHA、tag 和 ref 表达式，不隐式解析 `HEAD`。
- `mounted` 与 `enabled` 必须为 JSON 布尔值，不接受字符串或整数替代。分支 setter 省略 mounted 时兼容为 true；未挂载不能启用。项目 defaults 两字段均必填，mounted:false 可记住 enabled:true，但不执行。
- defaults 可选 `scope` 为 `main|all|user|none`；显式 scope 要求 mounted === (scope !== 'none')。省略兼容旧 API/CLI：mounted:true 对应 all，false 对应 none。scope 只影响未来真实创建，不修改 main 初始化或现有实例，revision 仍必须核验。
- `validation` 可省略（保留历史引用），或显式 null／严格 `{command_id,command_version?}`：command_id 为 UUID；旧可选 command_version 为正安全整数，仅兼容，不预授权或固定未来版本。保存引用不执行命令；开启仍不要求验证指令存在，新固定 Agent 模式不使用该引用。
- `expected_revision` 必须为最近读面的非空、不透明 revision（最多256字符）；不可自行拼接、跨分支复用或自动改用新值。过期时拒绝并重新读取。
- runs 的 `before` 可省略/null，否则为正安全整数运行 ID；`limit` 可省略（20），否则为整数1..50。RPC 数值字段不接受数字字符串。
- retry 的 `id` 必须为正安全整数，不接受 W 编号或字符串。landing/blocked 的未知现场不得盲重放；是否可恢复由 Runtime 核验。

## 单分支策略

```js
{
  version: 1, branch, owner_id, owner_worker_number: null,
  mounted: false, enabled: false,
  validation: null, // 仅历史兼容：或 {command_id,command_version?,name}，无 authorized
  revision, editable: true, reason: null,
  counts: {
    preparing:0, resolving:0, awaiting:0, validating:0,
    ready:0, landing:0, failed:0, blocked:0
  }
}
```

main 在初始化时一次性挂载且关闭；其他未配置 Worker 未挂载。项目页与 Worker 详情「自动化」修改同一实际策略；已有保存的旧策略视为已挂载，保留启停和引用。移除保留墓碑、历史且不重装。main 开启只影响之后交付到 main 的新固定成果，不提高来源 Worker 自动合并／验收级别；关闭／移除不撤销已固定批次。

未配置分支读取不写默认行、不启动 Agent 或运行命令。revision 在未配置时也稳定。counts 来源于完整持久活动事实，不从分页列表或 Worker 图推算。list 最多500个活动所有者分支，main优先，其他稳定按名称排序，超限显式 truncated。

项目默认读面为 `{version:1,mounted,enabled,scope,revision,editable,reason}`，新项目初始 mounted:true、scope:user、enabled:false，实际新 order 挂载关闭、新 child 不挂载；main 初始化仍一次挂载关闭。只在之后实际创建 order／child 时按 scope 冻结，不从父继承、不回写已有；旧保存默认缺少 scope 按原 mounted 读为 all/none，保留原 enabled、不改写。未默认挂载时可以记住开启偏好，实际未挂载实例仍关闭。list.defaults与独立默认读取同源，default revision不能用于分支setter。

新固定预约明确 `verification_mode:'agent', validation:null`，不执行组合验证命令、不制造通过证据；验证由开发／整合Agent负责，顶层全量责任不变。旧 command 模式保留隔离验证与精确候选证据门；新旧模式不混批。快捷指令授权字段不再阻塞，未来验证执行跟随最新定义；实际执行开始固定版本，已开始运行的证据不得被目录编辑改写，见[快捷指令契约](../../engineering/shortcut-commands.md#定义与版本)。缺失或损坏旧验证引用不能转成免命令验证，unknown 不重放。

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

成员每项最多8个，超限显式 `members_truncated`。state 为 preparing/resolving/awaiting/validating/ready/landing/integrated/failed/blocked/withdrawn/stale。未真实落地不能仅凭准备完成展示已合并。成员链接使用真实整数 ID；显示只用返回的 worker_number，没有编号才回退 #ID。

运行摘要的 `validation.command_id` 来自实际执行结果或保存的引用，无法确认时为 null；`command_version` 仅表示实际执行结果记录的版本，未执行或旧结果缺少版本证据时为 null，不用配置中的旧版本或当前目录版本补造。二者是运行证据读面，不是预授权；旧证据不迁移、不改写，未来执行的版本固定见[快捷指令契约](../../engineering/shortcut-commands.md#定义与版本)。

返回值不包含完整 profile、环境、token、原始 Shell 输出或内部堆栈。运行错误不会触发接口层自动重试或回退到其它分支。

## 项目交付视图（D642）

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

- 自身提问／汇报：`notice.post`、`progress.plan`、`progress.complete`。Notice 只能写 token 所属 Worker；进度不接受目标 Worker ID。
- 只读：`system.status/summary`、`worker.lookup/inspect/diff/history/history_page/transcript`、`branch.tree/show`、`graph.get`、`notice.list/page`。

其它方法一律拒绝，包括 `worker.spawn/integrate/resolve_child_divergence/message/auto_title/accept`、所有策略／合并／验收 mutation、管理工具，以及全部 `branch.convergence*`。新增公开 RPC 不自动扩展整合权限；现有 USER_ONLY / AGENT_ONLY 校验仍先执行，普通开发 Agent 和管理 Agent 权限不变。过期、停驻、中断或已结束 invocation 的 token 不能使用这些允许的方法。

此 RPC 门不是 OS 沙箱，不防止同系统用户的任意本机命令；工作区、固定输入、执行 Prompt 与生命周期隔离由 Runtime 提供。

## CLI

```bash
bun run lush branch convergence list
bun run lush branch convergence show main
bun run lush branch convergence mount main --revision REV
bun run lush branch convergence on main --revision REV
bun run lush branch convergence off main --revision REV
bun run lush branch convergence remove main --revision REV
bun run lush branch convergence defaults show
bun run lush branch convergence defaults set --mounted true --enabled false --scope user --revision DEFAULT_REV
bun run lush branch convergence runs main --before 15 --limit 20
bun run lush branch convergence retry 9 --revision RUN_REV
```

支持通用 `--project PATH` / `--json`，输出沿用现有 JSON 约定。命令选项仅对对应子命令有效，未知、重复或缺值选项拒绝。on无需command/version；可选 `--command UUID` 可单独保存引用，旧 `--version N` 仅兼容，不固定未来版本或表示执行验证。mount为未挂载目标提供关闭挂载，保留已有挂载的启用状态；remove移除未来挂载但不删历史；off关闭且保持挂载状态／引用。先读取当前策略或defaults获取各自revision，写入竞态拒绝，不静默刷新revision。

开启／重试可能调用专用整合 Agent 并产生费用。CLI 同样在本地拒绝 Agent 客户端，包括读取命令。

## HTTP

- `GET /api/branch-convergence` 返回 list；加单个 `branch` 查询返回该策略。
- `GET /api/branch-convergence/defaults` 无查询参数，返回项目默认。
- `GET /api/branch-convergence/runs?branch=main&before=15&limit=20` 返回运行分页；branch 必填，数字查询须为正整数字面量，limit最多50。
- 修改只经 `POST /api/action` 的 `branch.convergence_set`／`branch.convergence_defaults_set`／`branch.convergence_retry`；JSON envelope 仅 `{method,params}`，params 必须为对象，禁止 query、多余字段及任何 `_token` 值。

GET 拒绝未知或重复查询字段；读取 RPC 不在 action 白名单，也无 GET 修改入口。全部复用登录、Origin、no-store 和项目绑定；全局 Host 必须使用 `/p/<project-id>` 前缀，未知身份不回退，读写均不通过此入口拉起已停止 daemon。详见[Web 路由](../web-routes.md)。
