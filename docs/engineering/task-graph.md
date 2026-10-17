# Worker 图与输入规则（增量实现）

Worker 图是 `#worker-graph` / `worker.graph` / `/api/worker-graph` 的有界读面：节点是 Worker（含 main、owner、旧Worker），边来自当前 `parent_id`；当前 version 2 父自有交付队列不创建 merge Worker、不改源 Worker 的 `parent_id`，父子边始终表达委派关系；排队、源侧修复和落地待验收的 Worker 都留在直接父 Worker 下，不靠展示层抬升。旧 version 2 在途重挂仅凭明确预约／审计恢复原父，历史身份与事件保留，不猜父关系。落地不自动归档。卡片显示目标摘要、Agent 类型、分支合并状态（`integration`：待合并 / 已合并 / 合并中等，与Worker详情同源，做成首行标签）、工作/静息与冻结原因、结果预览、计划进度、子 Worker 数、分支/worktree、当前 HEAD、已提交与未提交诊断、交付预约与就地待决；指令交付操作复用Worker详情，普通问答/计划审批使用 `task-graph-parts.js` 的就地处理按钮，问卷跳到Worker详情按完整选项作答。点标题看完整Worker详情；历史独立解分歧 Worker 用父子边挂在负责集成的活动 Worker 下，另以「正在解决 Worker #ID」链接被修复的历史 Worker，不能把后者的终态/父子身份改掉。每批最多返回 200 条，并受真实 JSON UTF-8 字节预算限制；可继续加载全部匹配 Worker，优先返回分支所有者和活动 Worker。画成卡片的只有自己拥有分支/worktree 的 main / owner / 指令 / child，以及**旧 version 2 的历史 merge 队列身份**：已有 `task_kind='merge'` 卡片与类型过滤保留，摘要明确标为历史；空闲记录仍可查看，父 Worker 分支归档后随父归档、默认隐藏，可通过「显示已归档」查看。新请求由父自有队列的 runtime 串行处理，不额外调用父 Agent；按持久入队顺序、代码依赖优先，取得父执行位后才固定父基线。源侧修复期间保留父执行位，挂起释放，恢复重新排队并固定新基线；完整协议见[分支合并](merge.md)。被状态筛选或归档筛掉的父节点不制造孤儿：还在图上的子 Worker 按「最近的可见祖先」上浮，找不到可见祖先时顶成根；当前请求始终保留原父关系；历史在途请求由 runtime 受检恢复，不依赖展示层猜测。只有真的找不到父节点（被截断的那页或数据缺失）才画为根并说明。诊断/正文未知时明示不可用或截断，不能当作零。旧「分支与合并」视图与 `/api/graph` HTTP 路由已删除，旧 `#graph` 回概览；完整谱系与本地未绑定分支绑定保留在 CLI / RPC。Worker 卡片增加真实 Git 父分支、当前检出、领先/落后与一致/分歧/缺失等精简诊断，边仍只表示 Worker 父子关系。历史分支引用保留快照，但 Web 定位入口明确报已移除；Worker 图不新增语义引用，仍可通用选区引用。分支已由用户显式归档的 Worker 默认不画在图上，表头提供「显示已归档（N）」开关，只在当前页面临时显示、不写库、不改Worker状态，重开页面仍默认隐藏；只有无独立分支的历史内部 merge 队列继承直接父 Worker 的归档事实（读模型的 `archived`，父节点被截断时也有效，兼容已归档的历史父 Worker，不写新状态）；其它未归档子 Worker 会顶成根，不会仅因父 Worker 归档而消失。表头的状态计数同时就是筛选开关：点某个状态就隐藏 / 恢复该状态的 Worker，偏好按项目存在 `lush.taskGraph.hiddenStatuses`（`prefs.js` 管理的受管键，会被「恢复默认设置」清空），默认全部显示；筛选与归档开关一样只改这一页的显示，不写库、不改Worker状态。

交付后的 Worker 显示指令「待验收」/ child「待父确认」（`awaiting_acceptance`），使用独立状态色与筛选/计数，不当作已完成。Worker 图与详情通过 `render-iteration.js` 共用单一「验收」、历史继续开发、同步父分支和紫色 Agent 解决同步冲突；追加输入继续当前 Worker，验收表示无异议并安全归档回收开发资源，脏现场阻止，保留运行历史。acceptance_recovery:true 表示持久审计确认有未完成验收，可显示显式续办候选，不按目录缺失猜测；部分回收不得被普通已归档过滤隐藏。已完成回收不重建。详见[持续迭代](task-iteration.md)。

## 阅读工作树

W263／D611 将页面展示名统一为「工作树」；内部 Worker 实体及 `#worker-graph`／RPC／HTTP 身份不更名。

页面表头只保留标题、当前 Worker 数量与状态计数、待决数量、筛选／展示模式和刷新操作，以及采样时间／加载状态。连线、排序与交付机制等读一遍即可理解的固定说明留在文档，不常驻主要使用页面；截断、读取失败等影响当前判断的信息仍就地显示。

- 树中连线表示委派层级；筛选或隐藏节点后，布局可能跳过中间节点。
- 卡片箭头表示真实合并目标，不以可见布局祖先替代真实父 Worker。
- 新式合并由父 Worker 的 runtime 串行处理，不额外调用父 Agent；分歧由源 Worker 处理，完整流程见[分支合并](merge.md)。
- 根节点与各层节点按自身关注度排列，同档新建在前；这不是执行次序，代码依赖仍优先。具体规则见[展示排序](#合并关系展示排序与动效)。

## 渐进加载与重开缓存

首次打开先通过 `worker.graph {details:false}` / `/api/worker-graph?details=0` 读取 Worker 结构、状态、待决与交付摘要，成功后立即显示卡片，再后台单飞读取 `details:true` 的同筛选批次。摘要不执行 Git 或会话扫描，未知字段不冒充零；Git 与用量尚未补齐时明确显示加载状态。默认 RPC 与 HTTP 无参数仍取完整字段、包含归档记录，但同样分页，不回退无限制完整图。

### 字节分页与服务端筛选

`worker.graph` 接受 `details:boolean`（默认 true）、`hidden_statuses:string[]`（默认 []）、`include_archived:boolean`（默认 true，Web 显式传 false）、`scope:"all"|"tree"`（默认 all，Web 显式 tree）和不透明 `cursor:string`。tree 仅分页读取 main/owner/order/历史 say/child/历史 merge，all 保留非 management 的历史 RPC/CLI 节点兼容；种类范围不能由归档开关暗中推断。HTTP 同名参数：布尔为 `0/1`，状态数组为 JSON 查询字符串（如 `hidden_statuses=%5B%22completed%22%5D`）；未知、多次出现或非法参数拒绝。每批至多 200 节点，整个响应序列化后严格低于 900000 字节，为 1 MiB RPC 帧预留 envelope 空间，Unicode 和转义按真实字节计算；单节点过大降为身份/状态/布局摘要，带 `node_truncated:true`、`details_unavailable:true` 与有界 `details_unavailable_reason`，不冒充完整或零用量，游标仍继续推进。记录本身不截断、不写库。

响应保留 `nodes/edges/total/truncated/details_pending`，新增 `cursor:string|null`、`has_more:boolean`、`matched_total:number`、`counts:{[status]:number}`、`archived_count:number`。`total` 仍是全库 Worker 行数；`matched_total` 为实际按 scope、状态与归档筛选匹配的节点总数：tree 只计可绘制种类，all 兼容保留历史非 management 行。`counts` 是可绘制种类（main/owner/order/历史 say/child/历史 merge）应用归档开关、但尚未排除隐藏状态的完整计数（含已知状态的零项），状态开关不能因隐藏而消失；`archived_count` 为同一完整可绘制范围的已回收历史数，不受状态/归档开关影响。未完成验收的恢复记录不按归档隐藏。`has_more` 表示可以继续读取，`truncated` 表示本批仍有后续或含异常巨型节点的降级摘要。

真实 `parent_id` 不变；`layout_parent_id` 由轻量父关系求最近满足筛选的祖先，可以指向另一页的 Worker；不存在/成环时 null。`edges` 仍仅包含本批两端都出现的真实父子边，不把布局祖先冒充真实父。隐藏节点不发送正文，也不执行其 Git 诊断/会话正文读取；必要全量轻量父关系、运行区间与 SQL 队列聚合仍用于准确计数。完整字段先按结构摘要的真实字节选批，只有本批候选才执行 Git/会话重型读取，不读取整个匹配范围；已知巨型结构节点直接降级、不扫描其正文。诊断补充后再按完整序列化字节收口，正文膨胀可能使少量已读候选顺延至下一批，游标仅按实际返回节点推进。隐藏及批外后代的用量只复用签名有效的紧凑缓存，缓存缺失/过期时可见祖先 `subtree.incomplete=true`，费用/token 明示未知；运行时长仍来自全量轻量调用记录。

游标分别绑定 canonical 项目身份、details、scope、归档与排序后的状态筛选，以及全量轻量结构版本（ID/父关系/状态/种类/归档）。新增、删除、状态、父关系或归档变化以稳定错误前缀 `Worker graph cursor stale; refresh from first page` 拒绝旧游标，避免 offset 漂移造成漏节点/重复节点；非法格式/范围及项目/筛选不符另行严格拒绝，不冒充结构过期。普通正文或进度更新不使游标失效。页间不是事务级正文快照；客户端只对结构过期最多自动从首批重开一次，不能换筛选继续旧游标，也不能无限重试。

树末端显示已加载数量、加载状态与下一批占位符；用户向下滚动接近末端时单飞续读，也可手动加载或重试。首次可见或折叠后的短树不自动连续读完整历史；离页断开观察器并取消在途读取。状态与已回收历史开关前移服务端，改变筛选即重置分页，不加载隐藏正文；计数来自全量轻量读面。摘要与详情的字节边界可能不同，保留尚未补齐的摘要节点，但只沿详情游标续读。

同项目离页往返先同步显示最近缓存；缓存超过 3 秒或仍未补齐时后台更新，并显示采样时间/更新状态。刷新只重新采样首批，保留滚动加载的历史并标为旧采样/待更新；不能声称已核验整个加载范围。缓存按项目、筛选、页面及 boot 身份隔离，删除过滤、编辑、选区、弹层与阅读位置保护继续生效；迟到响应不得重画其它页面或写入已重置缓存。结构过期清除旧结构并至多自动重开一次，连续过期后停止，手动重试才能开启新链；普通分页失败保留已加载内容与游标供重试。不误报整个项目离线，概览轮询不等待重型图读取。

累计用量使用项目 `.lush/usage-index.sqlite` 中可重建的每会话文件紧凑摘要，不保存正文、凭证或请求行，不改历史事实。索引版本与项目身份严格隔离；旧版本、损坏记录或缓存文件可由原会话重建，不能冒充完整统计。daemon 启动自动后台补齐全部旧会话，单飞逐文件流式处理，每 8 个来源让出事件循环；此后每 5 秒检查来源签名，仅解析新增／变化文件、清除删除文件的摘要。后台与图中的本批读取共享每文件单飞；关闭停止新文件准入，排空在途读取后关闭缓存库，单文件错误隔离，不新增用户配置、模型或外网调用。签名包含 dev/ino/size/mtime/ctime，解析后复核签名；变化文件目前仍完整流式解析，不声称字节级尾部增量。内存紧凑缓存仍有界 4096 项、与统计页面的 128 文件正文行缓存分离；重启的有效持久摘要不重解析所有旧会话。

图分页、迟到响应和资源缓存组合不再保留专用回归；当前只保留代表性页面主流程，覆盖取舍见[贡献指南](../contributing/README.md#覆盖取舍)。修改这些行为时须补做受影响的真实 RPC／HTTP 与 DOM 验证。

## 展示模式

默认使用极简模式：等高双行展示标题、状态、待决与进度/合并摘要，操作收进省略号菜单。顶部「详情模式」默认未勾选，主动勾选后展开目标、结果、进度、分支诊断与操作，取消勾选回到极简。模式偏好按项目保存在当前客户端，保留已有显式选择；无偏好、坏值或恢复默认设置时使用极简。两种模式共用折叠、筛选与归档显示，切换不丢弃未提交的待决答复，不改变 Worker 事实。

## 累计资源消耗

`worker.graph` 节点的 `resources:{own,subtree}` 两项均为 `{input,output,cost,run_ms,unknown_tokens,unknown_cost,known_tokens,known_cost,pending_files,incomplete,running}`；读取失败为 null，无请求的已知数值为零，缺证据明示未知。`known_tokens`／`known_cost` 为非负整数，分别计已进入有效摘要且具备有效 token／费用值的 usage 请求数，不是 token／美元数；未知费用不使已知 token 变未知。没有有效费用来源时 `known_cost=0`，不能因内部 cost=0 就展示已确认的 $0。`pending_files` 为非负整数，计尚未补齐／签名失效／无法读取的会话来源文件数；大于零必须 `incomplete=true`。这些计数与已知数值可在 own/subtree 求和；非法／半行记录仍置 incomplete，只有 Codex 线程元数据不制造请求数或费用。输出不重复加 reasoning，显式属于其它 Worker 的 fork 上下文不重复计费。运行时长显示为 `1 d 2 h 3 m 4 s` 一类单位序列，从最高非零单位到秒保留中间零，零为 `0 s`，不加“运行”前缀。

两种模式的卡片均显示 `1 h 1 m 0 s ↑121k ↓18k $2.24` 一类摘要，整组排在合并状态标签之前：极简模式在第二行、详情模式在首行状态标签之后。运行时间为各轮 Agent 调用的累计时长（不含等待），输入绿色（含缓存读取与写入），输出红色，美元估算为主题正文色。展开显示 Worker 自身累计消耗；收拢显示其与全部后代的合计并加粗，包含隐藏、归档和当前批次外的后代，不按已加载卡片估算；隐藏或批外后代的摘要缺失／过期时，保留其它有效来源的已知小计与证据计数，并明示 pending／不完整；图请求不读取这些会话正文。后台独立补齐后刷新祖先即可获得合计，不必逐页访问历史卡片。范围内存在正在运行的 Worker 时轻微闪烁，静息、排队、暂停或停止不闪烁；减少动效设置关闭动画。费用与时长是会话/调用记录的估算，不等于实际账单；token 与费用分别判断完整性。不完整但有相应 known 请求计数时展示「已知」小计并提示「统计不完整」；没有有效已知证据或只有线程元数据的 Codex 消耗显示 `—`，不冒充零。完整且无请求的摘要仍可展示零。悬停、聚焦或长按可查看口径。

## 合并关系、展示排序与动效

卡片中的合并关系只认持久预约 `version=2,kind=merge,queue_protocol=1` 且预约父 ID 与真实 `parent_id` 一致。executing 显示「合并中」、resolving 显示「分歧处理中」，轻微呼吸点表达处理阶段，不代表源 Agent 正在运行；requested 显示静态「已请求等待合并」。pending/自动合并开关不算已请求；suspended 为静态「交付挂起」，blocked 为静态「落地待核验」（仍占执行位，但不冒充推进中）；integrated 沿用已合并结果。历史协议不推断当前执行位，Git 分歧不冒充合并分歧处理。

父卡片 `merge_queue` 摘要来自完整直接子Worker的 SQL 聚合，不随图的 200 节点限制、状态筛选或折叠漏计；每阶段最多列 3 个可点编号，多余明确提示。子卡片显示「→ 真实父Worker / 目标分支 · 阶段」，布局跳过隐藏中间节点不会改变交付目标。两种模式都可读，极简仍为 68px 双行，第二行优先合并关系，过长时可聚焦并横向滚动；完整进度和诊断在详情。

根节点与每层可见兄弟均按**自身**关注度分档，不继承后代优先级，父子层级不打平。顺序为：executing/resolving（合并中/分歧处理中）→ requested（等待合并）→ 待处理问题 → running → waiting → queued → paused → awaiting_acceptance（待验收/待父确认）→ 未知状态 → completed → cancelled。待处理问题包括 open 待决、awaiting、blocked/suspended 当前请求、failed、integration=conflict，以及历史 completed 且 integration=pending/review 的待人工交付；仅持久请求可进入前两档，普通 Agent 运行或 Git 分歧不会冒充合并阶段。布局跳过隐藏祖先时，同层仍按节点自身阶段排列，预约校验与箭头继续使用真实父 ID。

同档按 `created_at` 倒序，新建的在前；毫秒数与日期字符串均可解析，缺失/坏值按 0，时间相同按内部 ID 倒序兜底，不用 `updated_at`。普通进度、结果、消息更新不会让同档换位；阶段、待决或可见节点变化可重排。这不是严格队列序号，runtime 仍以入队顺序和代码依赖决定实际执行。仅同一可见结构下真实重排对卡片播放 250ms FLIP，连线不动；不自动滚向被提升的Worker。保留阅读锚点、滚动与焦点，首次加载、普通刷新、筛选、折叠、模式切换/尺寸变化不播放；有编辑草稿/选区/弹层/未结束动效时暂缓刷新，下次轮询再更新。遵循系统与应用减少动效设置。

`merge_queue:{counts,total,items,truncated,limit_per_status:3}` 只统计完整 tasks 中真实直接子、父身份匹配的当前协议预约。counts 精确列 executing/resolving/requested/suspended/blocked 五阶段，items 为每阶段至多 3 个 `{id,status}`（ID 倒序）；pending、历史协议、integrated 不计入。无活动请求返回零计数空列表。SQL 聚合／窗口有界返回，不读正文、不改变调度，truncated 明示关联项未列全。旧服务缺字段时显示摘要不可用，不以局部节点伪造全量。

## Worker 作为主要对象

卡片用状态配色一眼区分「在跑」与「停下来」：running 有活动色的呼吸外环，其余按真实状态各给一边框色（排队 / 在等 / 待你决定 / 已完成 / 失败 / 已取消），只有既非活动又无明确终结语义的才落到中性 idle；表头汇总行用同一套状态色把各状态计数排成兼作说明的图例。

`worker.graph` 只读投影每条 Worker 自己分支下的指令子分支数（`branch_info.subtree_order`）与仍在跑的合并运行（`branch_info.merge_run`），作为交付诊断；旧 `branch.orchestrate_plan` / `branch.orchestrate` 一键编排入口已下线，卡片不再提供。归档按钮如今也进 Worker 图与 Worker 详情：读模型给 `branch_info.archivable` / `subtree_branches`（详情给 `branch_archive`），两处入口共用同一 `branch.archive`（归档一条＝归档它整棵子树，删 worktree 与本地 ref，保留 Worker／消息／事件／会话，不是删除 Worker）；完整 Git 谱系用 CLI 查询。精简关系字段 `branch_info.parent/current/relation` 见 [Worker RPC 参考](../reference/rpc/tasks.md)；Squash 后真实 Git 分歧不否认 `integration=merged`。

## 新 Worker 的输入处理

新指令创建时，从其父分支**已提交的 fork commit** 读取 `.lush-task/input.mjs`（若存在），冻结为 `<project>/.lush/task-rules/task-<id>.mjs`。子 Worker 继承直接父 Worker 的固定快照；没有规则就使用内置默认规则。不会读取之后修改的 worktree 文件，也不会自动覆盖已创建 Worker 的规则。归档分支不会删除此快照。文件上限 16 KiB；提交的规则太大时拒绝创建新指令，不静默忽略。

程序是可信的仓库代码，**以 daemon 用户权限执行**，可访问磁盘/网络；仅从执行环境里去掉 Agent token / LUSH_* 凭证，不能把它当作安全沙箱。输入通过 stdin 的一行 JSON：`{version:1,task:{id,status,task_kind,branch},input:"..."}`；stdout 应输出一份 JSON：`{"delivery":"message"}` 或 `{"delivery":"interrupt"}`。例如：

```js
const { input } = await Bun.stdin.json();
console.log(JSON.stringify({ delivery: input.startsWith('稍后') ? 'message' : 'interrupt' }));
```

提交到指令 / child Worker 的用户消息执行一次固定规则（限时 1s、stdout/stderr 最多 16 KiB），不传一次性 Agent 凭证。冻结期间先由 Worker 持久暂存输入，不执行规则、不抢占源侧修复；规则延期到整体解冻且 Agent 实际退出后的投递安全点。执行前持久记录规则领取，重启发现已领取但结果未知时只回退路由、不重放可信规则的未知副作用。接收与实际投递边界见[追加消息](../reference/rpc/tasks.md#追加消息的准入与失败处理)。规则返回 `message` 时只写入收件箱、轮末交付；返回 `interrupt` 时先写入收件箱，再请求**有安全边界的后端**在安全点软抢占；不支持安全抢占的后端轮末交付，**绝不硬杀**。规则失败或输出无效：记录 `task.input_routed` 错误并回退 `interrupt`，输入仍持久化、不丢失。Agent 发来的消息不执行用户输入规则。无规则的新指令保持现有安全抢占行为。

## 读面边界

本次读面与规则不改写旧数据：历史 Intent / Plan / Candidate 与旧 planner / scheduler 的行、会话与工作区保留在磁盘上，但不再有公开入口，也不会被新版本自动启动或重放。规则目前只作用于指令 / child Worker 的用户消息；`order.submit` 创建时的初始 goal、notice 答复与非 指令/child Worker 不走这条固定规则。当前可调用面见[核心 API 收敛](core-api.md)。
