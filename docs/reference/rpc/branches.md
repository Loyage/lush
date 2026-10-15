# 分支谱系与收敛

当前公开的分支接口如下；`branch.import` / `branch.merge` / `branch.sync` / `branch.catchup` / `branch.summary` / 一键合并与合并编排已下线，不再有 RPC / CLI / Web 入口。

| CLI | RPC | 参数 | 权限 |
|---|---|---|---|
| 无 CLI 命令；保留旧读取协议 | `branch.history` | `{cursor?, limit?}`（默认 50，1..100） | 用户专属，只读 |
| 无 CLI 命令；保留旧固定图协议 | `branch.version_graph` | `{delivery?, cursor?, limit?}`（limit 默认 50，1..100；delivery 为成功交付 Event ID） | 用户专属，只读 |
| 无 CLI；Worker 详情按需读取 | `worker.version_graph` | `{id,delivery?,cursor?,limit?}`（默认30，1..100） | 用户专属，只读 |
| 无 CLI；保留旧交付轮次读面 | `worker.version_deliveries` | `{id,before?,limit?}`（默认30，1..100） | 用户专属，只读 |
| 无 CLI；节点详情 | `worker.version_commit` | `{id,snapshot,commit}`（完整 SHA） | 用户专属，只读 |
| 无 CLI；完整分支历程 | `worker.version_lineage` | `{id,cursor?,limit?}`（默认30，1..100） | 用户专属，只读 |
| 无 CLI；历程节点详情 | `worker.version_lineage_commit` | `{id,snapshot,commit}`（完整 SHA） | 用户专属，只读 |
| `branch tree [--verbose]` | `branch.tree` | `{}` | 用户与 agent，只读 |
| `branch show BRANCH\|TASK_ID` | `branch.show` | `{branch}` | 用户与 agent，只读 |
| `branch bind BRANCH COMMIT` | `branch.bind` | `{branch, commit}`（本地分支的固定 HEAD） | 用户专属 |
| `branch archive BRANCH [--discard] [--continue]` | `branch.archive` | `{branch, discard?, continue?}` | 用户专属 |
| `branch convergence list` | `branch.convergence_list` | `{}` | 用户专属，只读 |
| `branch convergence show BRANCH` | `branch.convergence` | `{branch}` | 用户专属，只读 |
| `branch integrate plan/start/show/cancel/retry` | 见[整合接口](convergence.md#一次性整合) | 参数仅在专篇维护 | 用户专属 |
| `branch convergence on/off BRANCH ...` | `branch.convergence_set` | 仅识别历史参数 | 用户专属，明确退休错误 |
| `branch convergence runs BRANCH ...` | `branch.convergence_runs` | `{branch,before?,limit?}` | 用户专属，只读 |
| `branch convergence retry RUN_ID --revision REV` | `branch.convergence_retry` | `{id,expected_revision}` | 用户专属 |

谱系是创建时显式写下的 `parent → child`，不是 commit graph 或Worker树。`branch.bind` 确认一条非 main 的本地分支及当前固定 HEAD，为它新建静息 `owner` 根 Worker；重复绑定、错误 HEAD、缺失 ref、相关旧Worker仍活动或已归档/删除的历史记录均拒绝。已有旧 Worker 与 `branches.task_id` 均不改写；`branch.tree/show` 当前所有者投影显示新 owner，但旧 Worker 仍可按 id 查看。只有绑定后，新指令才能挂到那条分支；owner 不接受任意消息或运行不受限 Agent。daemon 启动时已有本地 main ref 则自动确保同一个静息根；无 ref 时不会凭空造 main。

集中整合是显式用户操作，不是持续目标策略；旧配置只读、新写退休，普通单项／自动合并仍 serial，原在途协议不转换。精确参数、返回结构与 CLI／HTTP 以[整合接口](convergence.md)为准。

## branch.history

只读项目 `refs/heads/main` 的第一父链，最新提交在前。返回 `branch/tip/commits/cursor/has_more`；每项包含完整和短 SHA、父提交、摘要、作者名、提交时间、`association` 与关联的 Worker/原始 Input。页面展示与追溯边界见[版本迭代](../../engineering/version-history.md)。没有 main 时 `tip:null,commits:[]`，读取失败明确报错。

只匹配完整 SHA 的成功交付事件：`task.merge_integrated` 仅在事件明确提供整数 `parent_id` 且该父 Worker 属于 main 时关联。缺失、null、字符串、布尔值或浮点类型的父 ID 均保守未关联，不回退Worker当前目标。旧 `merged` 事件要求 `parent=main`，或明确 `legacy:true`、Worker 属于旧协议（`task_kind` 为空）且Worker固定目标为 main。新 指令/child 等不能借 legacy 标记回退目标。历史 no-ff 事件只有源 SHA 时，不猜为 main 的合并落点。不凭提交标题、当前 Worker HEAD 或时间猜测；无证据显示未关联，多次交付分别保留。

分页游标带本 daemon 实例的签名，固定首屏 main tip 和第一父链上的下一提交；main 前进或改写后仍读取该已取样历史，不混入新提交。daemon 重启、换项目/实例、修改游标或对象清理后须刷新，不能把任意 SHA 伪造成游标。请求不接受 branch/ref/cwd，HTTP 拒绝未知/重复查询字段。

Git 读取共享 15 秒截止时间，stdout 上限 4 MiB；每页最多 100 次提交，关联审计最多 1000 条，Worker 目标最多 16,384 字符、原始指令最多 131,072 字符，JSON 响应最多 512 KiB。超过界限明确报错，不静默截断；页总量超限时可降低 limit。

## branch.version_graph

`GET /api/version-graph` 使用同名参数，沿用固定项目路由与登录／Origin 边界。省略 `delivery` 返回 main 完整可达提交图，按拓扑顺序子先父后；指定正整数成功交付 Event ID 返回该轮固定源图，不读取当前 Worker 分支。`delivery` 不等于 Worker ID，也不等于 Event 正文中的预约 `delivery_id`。未知／重复查询字段拒绝，无 Agent、CLI 新命令或写操作。

返回 `{scope,branch,tip,base,worker,delivery,commits,cursor,has_more}`，其中 main 的 `base/worker/delivery` 为 null；无 main 时 tip 为 null、commits 为空。delivery 的 worker 为 `{id,worker_number,goal}`。commits 保留 history 的完整 SHA／真实 parents／摘要／作者／时间／association／tasks；tasks 另带 `delivery_id`、`delivery_available` 与 `delivery_unavailable_reason`。普通源提交可关联当前 Worker，但 `evidence:'delivery.source',delivery_id:null,delivery_available:false`，不得递归打开自己。真实子交付使用其成功 Event ID，与真实 Git parents 区分；完整展示契约见[版本迭代](../../engineering/version-history.md)。

当前固定源证据为 `task.merge_integrated` 的 `source_commit/commit`、整数 `parent_id` 与 `squash:true`。首轮用创建 base_commit，后轮用此前成功交付的固定源 SHA；此前成功事件缺少源 SHA 时不得跳过猜基线。固定父基线优先匹配成功 Event 的 attempt_id 与此前 `merge.baseline_fixed` 审计；普通单父 Squash 可从精确落点的第一父取得，无新落点的交付缺审计则不可追溯。读取验证基线是源祖先、源与落点树相等、审计与落点父一致，并排除开发基线与父基线的可达提交。父同步提交保留真实 parents，父侧已有功能不冒充本轮开发。

main 精确关联沿用 history 的目标校验；delivery 图只关联明确交付给该 Worker、且早于本次成功 Event 的记录，不按当前委派关系或标题猜归属。旧 `merged` 仍可精确关联，但其现存格式缺少可靠的固定源／父基线组合，返回不可下钻原因；对象缺失、错误 Event、基线不可信时请求明确失败，不回退当前 HEAD、reservation 或 iteration_base_commit。

签名游标固定图身份、tip、base、排除范围、拓扑偏移与 Event 高水位；main 前进后旧页不重复／漏页，显式刷新读取新图。换范围／项目／实例、修改游标或 daemon 重启均须刷新，旧 history 游标不能复用。Git 使用隔离配置／只读对象库，禁用替换、外部过滤、notes 与 lazy fetch；15 秒共享截止时间、4 MiB stdout、最多 4 个并发读取。每页上限 100 个提交／1000 条关联审计，Worker／Input 文本和 512 KiB 响应上限同 history，超限报错而不裁剪。

## Worker 详情版本读面

对应 `GET /api/worker/ID/version-lineage`、`version-lineage-commit`，并保留旧 `version-graph`、`version-deliveries`、`version-commit`。路径 ID 是内部整数，编号只作展示。全部用户专属、只读、no-store；不开放 Agent／管理代理、HTTP action 或 Git 写操作。HTTP 查询白名单直接复用 RPC registry，严格拒绝未知／重复字段，数值必须是无前导零的正整数；固定项目、登录、Origin／Host 边界与其它 Worker 读取相同。

### worker.version_lineage

读取 order／child 从**创建 base_commit** 引出以来的完整已提交来源链，不以最近交付源、iteration_base_commit、head_commit 或 reservation 作为总图基线，也不包含未提交工作区。branch 的归属、recorded parent 与创建基线必须和 Worker／真实直接父记录一致；父信息和编号只取持久记录。main／owner 没有独立的 recorded 引出范围，继续使用旧 graph 接口。

返回：

```text
{scope:'lineage',range:'first-parent',worker:{id,worker_number},branch,
 parent:{id,worker_number,branch},origin:{commit,short_commit,parents,subject,author,committed_at},
 tip:SHA,tip_evidence:'branch.ref'|'delivery.source',tip_delivery_id:EventID|null,
 snapshot:opaqueString,commits:[...紧凑节点...],deliveries:[...映射...],
 untraceable_deliveries:[...不可追溯映射...],cursor:opaqueString|null,has_more:boolean}
mapping = {delivery_id:成功EventID,source_commit:SHA|null,commit:父侧落点SHA|null,
           parent_id:integer|null,delivered_at,evidence,delivery_available,
           delivery_unavailable_reason:string|null}
```

可信范围采用固定 tip 沿 **first-parent** 到创建 origin 的来源链，origin 单独返回，不混在 commits。分页提交按拓扑新到旧；展示旧到新时客户端自行倒序，并标明分段。每节点保留全部**真实 parents**，同步 merge 自身保留，但第二父引入的父侧外部历史不枚举、不冒充本 Worker 的开发。创建 origin 必须确实在第一父来源链上，仅在第二父路径保留基线的改写明确拒绝。来源链核验有 10,000 个提交上限；超限明确报错，不静默截断为完整图。这是来源链，不承诺枚举所有第二父侧开发分支。

active 登记分支存在时只取样其精确 ref；分支回收、归档或 ref 缺失时，只用**最新一条**持久成功交付的可信固定源，不跳过坏最新证据、不猜 mutable 字段。固定源仍以创建 origin 为起点，保留此前多轮来源与同步提交。最新证据缺源／父侧凭据、对象不存在或核验失败时明确报错；已回收且只有无落点的结果交付同样明确不可恢复。不会从当前父 ref 推断历史引出点或枚举父侧 origin／落点之间的功能提交。

每页 `deliveries` 按成功 Event ID 倒序，关联该页所有 source SHA 的**全部**成功 Event；同 SHA 多次交付及共享 Squash 落点均保留，不能把交付映射画成 Git 父边。来源等于 origin 的无改动映射仅在首屏（或 origin 详情）返回。普通固定交付复用旧 source／landing 树、固定父基线、单父落点及归并精确成员收据核验；无新落点时固定 parent_base 可以等于 landing，不制造新提交或父边。`delivery_available:true` 在此接口表示该映射已经完成必要 Git 核验，而不是仅收据结构可读；对象后续清理仍可导致旧快照读取失败。

`untraceable_deliveries` 保留缺源／落点、父身份不符、旧 `merged` 或 source 不在第一父来源链的成功记录，不把它们藏在分页之外。`task.delivered` 且 `no_changes:true` 的结果交付也保留：该事件的 `commit` 仅是固定源，映射 `source_commit` 使用它、父侧 `commit:null`，没有可靠落点便提示不可追溯。结构正常但对象核验失败的映射仍保留在对应页 `deliveries`，availability 为 false。不可追溯列表每页重复，客户端以 Event ID 去重；没有证据的字段用 null，不从当前目标、标题或时间猜测。每个 Worker 在固定 Event 高水位以内最多读取 1,000 条成功记录（包含结果交付），超限整个请求失败；不会用 limit 丢掉同 SHA 的多 Event。

紧凑 commits 沿用下文 graph 的字段与精确子交付 associations，不读取 goal／原始 Input 正文；source 普通节点为 `worker.source`。origin 是父侧锚点而不是自身开发关联。父侧信息只提供 origin 与已核验的固定落点，外部历史由 UI 以省略边表达。

### worker.version_lineage_commit

只接受 lineage 的同 Worker 签名 snapshot 和完整 commit SHA。范围为来源链节点及独立 origin，非 commit、短 SHA、ref／路径表达式、第二父外部历史及其它快照均拒绝。返回格式沿用 `worker.version_commit`：`{worker,scope:'lineage',delivery:null,tip,base:originSHA,commit:{...含message及按需goal/input}}`，另带该节点的 `deliveries` 与有界 `untraceable_deliveries`；origin 的 `association:'unassociated',tasks:[]`。不读取 diff、配置或凭证。

lineage 的 snapshot／cursor 使用独立签名命名空间，固定 Worker、branch、parent 身份、origin、tip、tip 证据、第一父范围与 Event 高水位；cursor 另含拓扑偏移。不同页返回同一个 snapshot。分页／详情不重新取样可变 ref，不混入新成功事件；不可复用旧 graph／history 的 token，重启／项目或实例切换／篡改须显式刷新。共享隔离 reader 的最多4并发、每请求15秒 Git 截止、4 MiB stdout、512 KiB 响应及详情文本预算保持不变；超限完整报错。没有 Git／数据库写入，不迁移旧数据或改变旧 graph／deliveries／commit 的读语义。

### worker.version_graph

默认读取该 Worker **当前已提交开发快照**，不包含未提交工作区。main Worker 保留 main 完整可达图；order／child 的当前图从已登记、归属正确的真实分支 ref 取样，创建基线必须与分支登记一致，直接父身份必须与固定目标一致。开发范围首轮以创建 base_commit 为基线，后轮以最近成功交付的固定源提交为基线（因此交付后尚未新增开发时可为空）；不用 head_commit、iteration_base_commit 或 reservation 猜测。排除开发基线和本次固定父 ref 的全部可达历史，保留同步提交的真实 parents。创建基线、最近成功落点及已有同步／固定父基线审计必须仍在父 ref 历史中；父侧改写导致证据不一致明确失败，不能把父侧功能冒充本轮开发。

指定 `delivery` 只允许属于该 Worker 的成功 Event ID，固定图沿用 `branch.version_graph` 的源／落点／父基线／归并凭据验证。分支已回收或 ref 缺失时，默认范围可以使用**最近一条**成功事件的可靠固定交付，返回 `scope:'delivery'` 与实际 delivery；没有成功事件、最新成功缺证据或对象缺失时明确报错，不跳过坏证据、不猜 HEAD。未登记分支不作为可信当前图。owner 非 main 没有独立开发轮次时同样明确不可读，不擅自读取任意分支。

返回：

```text
{scope:'current'|'delivery'|'main', branch,
 worker:{id,worker_number}, delivery:EventID|null, tip:SHA|null, base:SHA|null,
 snapshot:opaqueString, commits:[...], cursor:opaqueString|null, has_more:boolean}
commit = {commit,short_commit,parents:[SHA],subject,author:{name},committed_at,
          association:'verified'|'unassociated',tasks:[... compact associations ...]}
association = {id,worker_number,task_kind,evidence,delivery_id:EventID|null,
               delivery_available:boolean,delivery_unavailable_reason:string|null}
```

首屏不读取／返回 Worker goal 或原始 Input 正文。`parents` 仅为真实 Git 边，tasks 仅为精确交付／源范围关联，不能把子 Worker 关联造为 Git 边。main 目标校验沿用旧图；其它范围只关联明确落在该 Worker 分支上的成功事件。所选固定交付仅关联早于该成功 Event 的子交付；当前图只关联取样 Event 高水位以内的记录。普通源节点用 `evidence:'worker.source'`（当前）或 `'delivery.source'`（固定交付）、`delivery_id:null,delivery_available:false`，可导航当前 Worker，但没有自己的下钻轮次。没有编号时客户端才回退 `#内部ID`，不得按内部 ID 推算 W 编号。

`delivery_available` 表示持久收据结构可追溯，不保证尚未读取的 Git 对象仍存在；展开该交付时仍须处理 Git 核验错误。对子交付的导航使用关联的 `id`，展示使用 `worker_number`；选择该子轮次时转到其 Worker 并传其 `delivery_id`。

### worker.version_deliveries

保留旧成功轮次读面：提交节点及 Git 父边由显式指定 Event 的 `worker.version_graph` 读取。新的完整分支历程使用 `worker.version_lineage`，不改变本接口或 graph 省略 delivery 的兼容读协议。

返回 `{id,deliveries,before,has_more}`。按成功 Event ID 倒序，每项为上述紧凑 association，另带 `delivered_at`（事件时间）、`source_commit:SHA|null`、`commit:SHA|null`。历史 `merged` 成功也保留，缺可靠固定源／父基线则提供不可读原因，不隐藏／伪造轮次；预约 delivery_id 不是轮次身份。

下一页传返回的 `before`；没有更多时为 null。固定 `before` 的 keyset 分页不混入较新的成功事件；刷新省略 before。每次最多读取 limit+1 条持久成功记录及其必要前轮／审计证据，不枚举 Git 或加载目标正文。

### worker.version_commit

`snapshot` 必须来自该 Worker 的 graph 响应，`commit` 必须是其中固定可达范围内的完整 SHA（不必已加载到本地页面）。返回 `{worker:{id,worker_number},scope,delivery,tip,base,commit:{...}}`；commit 保留紧凑节点全部字段，增加完整 `message`，tasks 按需增加 `goal` 与 `input:null|{id,content}`。不返回 Worker 配置／凭证、diff 或任意 Git 对象正文。不接受 ref、路径、短 SHA、revision 表达式；排除范围内、其它图／Worker 的对象和非 commit 对象均拒绝，即使同一对象库可找到它。

### 快照与生命周期

graph 的签名 cursor 固定 Worker、请求 delivery、实际选择轮次、tip、base、排除范围、拓扑偏移和 Event 高水位。下一页必须保留原请求 id／delivery（默认请求的归档 fallback 后仍**省略 delivery**）；切换 Worker／轮次需新请求，不混用 branch/history 游标。snapshot 固定同样身份但不含偏移，整幅图各页返回相同 snapshot，仅供 commit 读取，不能作 cursor。分页和节点详情不重新读取当前 ref，不因分支前进、回收或新增 Event 改变旧图；刷新省略 cursor，重新固定图。

签名只在当前项目／daemon 实例有效，重启、换实例／项目、篡改、scope 混用或对象清理均须显示错误，用户显式刷新；不会创建长期对象保留 pin。客户端应缓存已加载有界页／详情，切换范围、刷新及离开详情时取消或忽略迟到响应；后端不自动扫描完整图、轮询或展开子交付。

所有 Git 命令用共享隔离只读读取器，单次 graph 请求共享15秒截止，单次 commit 读取同为15秒；4 MiB stdout、最多4个并发读取，图／轮次每页上限100、关联审计最多1000条。详情 goal 上限16,384字符、Input／commit message各131,072字符，响应上限512 KiB；超限完整报错而不截断，可降低分页 limit。旧 `branch.version_graph`、`branch.history` 协议保持兼容，不迁移数据。

## branch.tree / branch.show

节点字段包括 branch、parent / parent_relation、created_from_commit、task、worktree、present、head_commit、current、status。分支删除后历史行保留；只有 ref 的旧分支显示 untracked；只被 parent 提及的名称显示 placeholder。`status` 有 `active` / `archived` / `deleted` 三个取值：归档与回收都不删行。

**归档的节点不画在树上**（记录仍在库里）：`branch.tree` 会跳过 `status=archived` 的节点，把它们还在的后代接到最近的可见祖先上（没有就升为根），不会连带藏掉活着的后代。要看某条归档分支本身用 `branch.show`（它读的是完整记录，不受这层裁剪影响）。

## branch.bind

用户选定本地 `BRANCH` 与当时的 `HEAD COMMIT` 后，`branch.bind` 为非 main 且尚无新 Worker 所有者的分支创建独立、永不执行不受限 provider 的静息 `task_kind='owner'` 根 Worker。它是新指令挂在非 main 分支上的唯一入口；无绑定的新指令直接拒绝，不会猜祖先。

## branch.archive

用户显式归档一条已登记分支：删掉它的 worktree 与本地 ref，但保留谱系行（`status` 标 `archived`，`deleted_at` 兼作归档时间）、Worker行、消息、事件与 pi 会话文件。它明知分支可能未合并也允许删，所以是用户专属写操作。参数 `discard`（布尔，缺省 `false`）：默认 worktree 脏时拒绝，只有 `discard:true` 才会连着未提交改动一起丢弃 worktree。

**归档的是一条子树**：传进来的 `branch` 是子树根，它的全部后代一起归档（已归档 / 回收过的后代跳过），不会留下一批「父分支已不在」的后代。

门槛：子树根必须已登记、不是 `archived` / `deleted`，当前检出分支不在子树里，且整棵子树都没有未终态Worker。`discard:false` 时，子树里任一脏 worktree 都会在动任何东西之前失败（不会留下归档了一半的子树）；`locked` / `prunable` / 已初始化 submodule 也在删除任何一条之前整树拒绝。

一条分支 settle 后立即回写 `branches.status` 与Worker的 `workspace`，因此第二遍删除里撞上未知失败（I/O、外部程序）时不会留下「库说还在、磁盘已经没了」：已删的逐条保留，失败项进 `failed`，没轮到处理的进 `remaining`，并写一条 `branch.archive` 事件记录 `targets/completed/failed`。

返图示例：

```json
{
  "branch": "lush/abc/7-api",
  "archived": true,
  "count": 2,
  "branches": [
    { "branch": "lush/abc/7-api", "worktree": "removed", "ref": "deleted", "tip": "...", "discarded": false },
    { "branch": "lush/abc/8-follow-up", "worktree": "removed", "ref": "deleted", "tip": "...", "discarded": false }
  ],
  "worktree": "removed",
  "ref": "deleted",
  "tip": "...",
  "discarded": false,
  "failed": [],
  "remaining": [],
  "tasks": [{ "id": 7, "status": "completed" }],
  "sessions": [".lush/sessions/...jsonl"]
}
```

顶层的 `worktree` / `ref` / `tip` / `discarded` 描述的是**子树根**（调用方问的那一条），整棵子树逐条看 `branches`；`count` 是这次归档了几条，`failed` 逐条给出 `{branch, reason, worktree, ref, tip}`，`remaining` 是没轮到处理的分支名。CLI 的 `lush branch archive BRANCH [--discard] [--continue]` 非 JSON 输出由 `printBranchArchive` 打印，每条分支一行，并在尾部列出 `failed` / `remaining`。

**显式续办 `continue:true`（`--continue`）**：上一次在子树中途失败后，根可能已经是 `archived`，但还有几条后代仍在磁盘上。此时传 `continue:true` 从 `branches.parent` 谱系重算剩余的活动后代并只归档这些；根已归档不是错误，不会重复删除，也不要求先重新归档根。没有剩余后代时明确返回 `no_remainder:true` 与 `count:0`，不报 `already archived`。根仍是 `active` 时 `continue:true` 被拒（正常归档即可）；重复调用幂等。

被归档分支名下的 Worker 记录仍可从 `branch show` / `branch.archive` 事件 / Worker详情查询；Worker 图默认隐藏，可显式显示。

## graph.get 的 fork 边

`graph.get` 作为只读 RPC 保留完整 Git 谱系；Web 已删除旧分支视图及 `/api/graph` HTTP 路由，Worker 卡片改用 [`worker.graph`](tasks.md) 的精简诊断。每个 branch 节点带 `origin` / `title` / `source_id` / `created_at`、汇总 `status` 与 `tasks` 计数，以及 `worktree` / `worktree_state` / `deleted`。**归档节点仍在 RPC 返回里**，其 `status='archived'`，带 `archived` / `archived_at`，对应 Worker 带 `archived:true`。Worker 节点还保留 `notice` / `notice_count` 的只读待决摘要。每条 fork edge 附加：

```json
{
  "kind": "fork",
  "from": "branch:main",
  "to": "branch:lush/abc/input-3",
  "status": "fast_forward",
  "ahead": 4,
  "behind": 0,
  "blockers": [],
  "can_merge": true,
  "can_sync": false,
  "can_catchup": false
}
```

`can_merge` / `can_sync` / `can_catchup` 是只读诊断字段，描述这条边当前是否可快进 / 需子侧收敛 / 可跟上父分支；新指令 / child 的代码落地不经过这些旧入口，而由运行中的直接父 Agent `worker.integrate` 或用户 `worker.approve_merge` 按固定提交推进。

Web 待决操作在 Worker 图、Worker 详情与「待我处理」进行，不再有分支图重拉或定位入口。

### branch 节点的 diagnostics

未归档分支另带 `diagnostics`（归档分支为 `null`）：

- `changes.status='ok'`：`base_commit` / `head_commit` 固定本次比较的两端，`files_total` / `added` / `deleted` / `binary_files` 是完整汇总；`files` 内各项为 `{path,added,deleted,previous_path?}`，二进制行数为 `null`。列表有界且由 `truncated` 标记，具体限额见[模块接缝](../../engineering/modules.md#分支诊断增量读面)。
- `changes.status='unavailable'`：`reason` 为 `missing_head` / `missing_baseline` / `read_failed`，不返回虚假的零计数。
- `latest_commit`：`{commit,committed_at,subject}`，时间为提交者时间、摘要最多 240 字符；读取失败或无 ref 时为 `null`。
- `working_tree.status`：`clean` / `dirty` 时带 `path` 与 `files_total` / `staged` / `unstaged` / `untracked` / `conflicts`；总数按文件去重，分类可重叠。`not_checked_out` 表示无实际检出，`unknown` 表示工作区读取失败或检出发生变化。

只读、不写库；每次重新读取工作区状态，固定提交的差异与摘要有界缓存。

相关：[分支优先架构](../../engineering/branch-first.md) · [分支合并](../../engineering/merge.md)。
