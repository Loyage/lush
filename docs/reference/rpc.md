# RPC 与 CLI

## 传输

Unix Domain Socket：`$LUSH_HOME/lush.sock`。每行一个 UTF-8 JSON-RPC 2.0 对象，以 LF 分隔。最大帧 1 MiB；不支持 batch；支持无 id 的 notification（执行但不回复），CLI 始终使用 request。同一连接逐条处理，不同连接并发。响应 id 与请求一致。拒绝 NaN / Infinity。

```json
{"jsonrpc":"2.0","id":1,"method":"service.call","params":{"sid":2,"prompt":"当前目标是什么？"}}
{"jsonrpc":"2.0","id":1,"result":{"sid":2,"call_id":1,"output":"..."}}
```

错误：`{"jsonrpc":"2.0","id":1,"error":{"code":-32004,"message":"service not found: 99"}}`。

| code | 含义 |
|---|---|
| -32700 | JSON parse error |
| -32600 | invalid request / batch / frame |
| -32601 | method not found |
| -32602 | invalid params |
| -32603 | unexpected internal error（详情只写 daemon log） |
| -32004 | service/template not found |
| -32009 | lifecycle conflict / busy / call cycle |
| -32010 | template policy denied |
| -32020 | provider / invocation error |
| -32021 | invocation interrupted |

## 方法

所有 params 为具名 object，无未知字段。SID 为非负 integer（不接受 boolean）。

| RPC | params | result |
|---|---|---|
| system.status | {} | daemon_pid, root_sid, provider, service_count, active_calls, notices_open（还没被回答 / 忽略的 notice 数）, home, socket, code_dir, version, fingerprint, started_at, uptime_seconds, orphan_policy（嵌套：adopt / limit / ttl_seconds / sweep_seconds）, orphans_active（标量，SID 0 当前活动孤儿数） |
| system.shutdown | {} | stopping |
| call | sid, goal, detach?, interactive? | 在 SID 上开一个根 task：不等待时（detach）立刻返回 task 快照；默认阻塞到该 task 进入终态再返回 `task.inspect` 形状的快照（若期间被 purge 掉则返回 `status: "removed"` 的最小快照）；interactive=true 时返回交互式 argv（见 `call.end`） |
| call.describe | sid, prompt | 预览 task 的首次调用（dry run）：dry_run、agent、profile、prompt、command/argv/cwd/env；不建 task、不写记录 |
| call.end | task_id, call_id, status, output?, error? | 结算 `call --interactive` 打开的调用：task_id、call_id、settled、status；succeeded 会把 task 记为 completed，failed 记为 failed |
| call.os_pid | task_id, call_id, os_pid | 终端上报它自己起的 pi 服务：recorded=true 表示已挂到该 agent 上 |
| service.list | {} | metadata 数组，每行带 variables（immutable / mutable 当前值 + declarations 变量声明） |
| service.tree | agents? | metadata 数组（客户端格式化树），行内带与 service.list 同形的 variables；agents 默认 true，为每行附上运行期活跃度：provider、running（个数）、agents[]（id=`TASK.N` / task_id / call_id / interactive / os_pid / started_at / elapsed_ms）；agents=false 时不再带 agent 字段（variables 仍在） |
| service.inspect | sid | metadata（含 variables 值与声明、`agent_profile`、`recent_tasks`）、Context metadata、Agent 状态（status / provider / profile）、近期调用与事件 |
| service.parent | sid | parent metadata 或 null |
| service.children | sid | children metadata 数组 |
| service.view | sid, sections? | 只含被请求 section 的视图：description、parent、children、call_prompt、available_child_templates |
| service.orphans | {} | SID 0 孤儿池的读模型（不落库、不改状态）：`policy`（adopt / limit / ttl_seconds / sweep_seconds）、`active_count`、`busy_count`、`over_limit`、`orphans[]`（sid、name、status、template、original_parent_sid、created_at、updated_at、last_activity_at、idle_seconds、busy；含已被冻结的终态行） |
| service.orphan_sweep | {} | 立刻执行一轮孤儿监督并返回报告：`trigger`、`skipped`、`checked`、`active_before` / `active_after`、`evicted[]`（sid、name、from、to、reason、idle_seconds）、`deferred[]`、`limit`、`ttl_seconds`；两个方法都不接受参数，未知字段报 -32602 |
| service.spawn | parent_sid, template, name?, goal?, variables?, agent? | 新 Service metadata（创建只建节点，不跑 agent）；variables 按模板声明校验后按区间存入 state（immutable → state.params，mutable → state.vars），未声明、缺失必填、不满足声明的格式（pattern / max_length / single_line）或非法 `path` 报 -32602；声明了保留变量 `name` 的模板（dev-task）用 name 参数当服务名，两边不一致同样报 -32602；agent 为该节点上的 task 选用的 agent profile 名，需存在且合法，否则报 -32004 / -32602，选中后写入 state.agent |
| service.start / service.stop | sid | 更新后的 metadata；stop 在有活动 task 时报 -32010（先取消 task），节点或它的活动直接子节点按 `LUSH_ORPHAN_ADOPT` 处理 |
| service.delete | sid, recursive? | 硬删除：`sid, status, deleted, cancelled, terminated, rows`；active/created 或还有活动 task 报 -32010，有子服务且未 recursive 报 -32010，SID 0 报 -32010 |
| service.purge | sid, recursive? | 同 delete，但先取消活动 task、停止活动节点再删；`cancelled` 列出被取消的 task，`terminated` 列出被停止的 SID |
| service.update_state | sid, patch | 更新后 state（顶层 merge）；写 state.params / state.vars 报 -32602 |
| service.update_vars | sid, patch | 更新后的 mutable 变量对象；非 mutable 或未声明的名字、不满足声明格式的值报 -32602 |
| task.list | sid?, status?, roots?, limit? | task 数组（id、sid、parent_task_id、root_task_id、status、goal、result、error、state、时间戳）；`roots` 为 `roots` / `children` |
| task.tree | task_id | 该 task 及其整棵子树（每个节点带 `service_name`） |
| task.inspect | task_id | task + 所在 service + 父 task + 直接子 task + 最近 10 次调用 + 事件 + 最近 10 条 inbox 输入（`recent_inbox`）+ message 数 |
| task.result | task_id | id、sid、status、finished、result、error |
| task.wait | task_id | 阻塞到该 task 进入终态，返回 `task.inspect` 形状 |
| task.cancel | task_id | 取消该 task 及其整棵子树（中断正在跑的 agent），返回更新后的 task |
| task.complete | task_id, result? | 目标达成时结束 task 并写入 result（有活动子 task、或收件箱有未读消息时报 -32010） |
| task.spawn | sid, goal, parent_task_id? | 新建并启动一个 task（`parent_task_id` 给定时必须挂在父 task 所在 service 的直接子 service 上；不给定时建的是根 task，CLI 的 `task spawn` 会缺省填 `$LUSH_TASK_ID`）；返回 task 快照。不等待，子 task 结算时以收件箱输入唤醒父 task |
| task.message | from_task_id, to_task_id, body | 给直接父 / 直接子 task 发一条消息（入队，不打断对方）：返回新建的 `task_inbox` 行；非直接父子 / 接收方已终态报 -32010 |
| task.inbox | task_id, after=0, limit=50 | 该 task 收到的输入（`kind` 为 message / child_settled，`delivered_at` 说明是否已交给 agent），按 id 升序 |

inbox 是“父子持续通话”的存储：`task_message` / `task.message` 只往直接父 / 子 task 投递，消息与“某个子 task 已结算”的报告进同一个队列；**只在接收方两次 agent invocation 之间交给它**，不会打断正在跑的工作，对方处于 `waiting` 时会被立即唤醒。`task.inspect` 里的 `recent_inbox` 是最近 10 条（新的在前）。
| task.update_state | task_id, patch | 合并后的 task.state（顶层 merge） |
| task.history | task_id, after=0, limit=100 | 按 id 升序 messages、next_after（只含该 task 自己的对话） |
| task.delete | task_id, recursive? | 删除已结束的 task 行与它的事件：`task_id, status, deleted, rows`；有活动 task 报 -32010，有子 task 且未 recursive 报 -32010。call 行与消息保留（task_id 置 NULL） |
| task.agents_list | task_id?, sid?, all? | 运行期 agent 数组（id=`TASK.N`、task_id、sid、name、provider、status、call_id、os_pid、interactive、cancellable、started_at、ended_at、elapsed_ms、error）；all=true 附上本次 daemon 内存里已结束的条目（上限 32） |
| task.agents_show | id | 单个 agent + 它服务的 task 的 session + 对应的持久 call 行 |
| task.agents_kill | id | 结束该 agent 的这次调用（interrupted）并取消它服务的 task，返回该 agent 的视图与 outcome（`killed` / `gone` / `no_pid`） |
| task.session | task_id | 该 task agent 的 session：task_id、sid、name、task_status、session_dir、session_id（`lush-task-<id>`）、files、file、argv/command、browse_command、cwd、env、busy、`profile`；内置运行时全为 null |
| notice.list | status?, task_id?, sid?, limit? | notice 数组（id、sid、task_id、kind、title、body、fields、wait、status、answer、note、created_at、answered_at、updated_at，加连接出的 `service_name` / `service_template` / `task_goal` / `task_status`）；status 为 open / answered / dismissed，默认按 id 倒序取 200 条 |
| notice.inspect | notice_id | 同上形状的单条 notice |
| notice.post | task_id, title, kind?, body?, fields?, wait? | agent 侧上报：以 task_id 为汇报者建一条 notice；wait（默认 true）时这个 RPC 一直挂着，直到用户 answer / dismiss，返回结算后的 notice（answer / note 已填），wait=false 立即返回 open 的 notice。汇报者 task 不存在报 -32004，fields / title / kind 不合法报 -32602 |
| notice.answer | notice_id, answer | 按 notice 声明的 fields 校验 answer 后置为 answered，唤醒等待的 task：返回更新后的 notice（answer 已填、answered_at 已记） |
| notice.dismiss | notice_id, reason? | 置为 dismissed（不填 answer），唤醒等待的 task：返回更新后的 notice，reason 存入 `note` |

inspect 的 Context 包含 system_prompt、state、artifacts、references、message_count（变量就在 state 的两个区间里，`state.agent` 是创建时选中的 agent profile 名，`update_state` 不能写它）；调用和事件各取最近 20 条，`recent_tasks` 取最近 10 个 task，避免无界响应。完整消息使用 `task.history` 分页读取（对话按 task 划分，不是按 SID）。元数据含 template 的完整创建时快照，以及由快照与 state 拼出的 `variables`：`immutable` / `mutable`（当前值）与 `declarations`（两个区间各自的 `description` / `required` / `default` / 可选的 `pattern` / `max_length` / `single_line`）。`title` / `detail`（保留变量名）在 `--json` 里原样给出，文本输出只做摘要与截断。

## agent profile（不走 RPC）

`lush agent list|inspect|add|edit|delete|default|path` 只读写 `$LUSH_HOME/agents/<name>.json`，**不经过 socket**，daemon 未运行时也能用（与 `lush daemon` 一样是纯客户端命令）。因此它没有对应的 RPC 方法。daemon 侧在每次 call / dry-run / session 时按服务的 `state.agent` 读盘解析（见 `src/agent/catalog.js`），所以改 profile 不需要重启 daemon。

一次 call 的 agent 由三层决定，逐字段叠加：

1. 服务显式选择（`service.spawn` 的 `agent` / 模板的可选 `agent` 字段，写入 state）；
2. 环境变量 `LUSH_PROVIDER` / `LUSH_PI_COMMAND` / `LUSH_PI_PROVIDER` / `LUSH_PI_MODEL`；
3. 内置 `default`（provider pi + `--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files`）。

服务选中的 profile 声明了哪个字段，哪个字段就优先于环境变量；未声明的字段照旧回落到环境变量与内置 fallback。内置运行时的 provider（mock / openai）没有 argv 预览。

孤儿监督（RPC `service.orphans` / `service.orphan_sweep`，读模型与策略细节见 [concepts/lifecycle-and-orphans.md](../concepts/lifecycle-and-orphans.md) 的「SID 0 的孤儿监督」）的策略来自 daemon 启动时的环境变量，改配置要重启 daemon；默认 `adopt` + 不限 + 不超时，此时 `orphan_sweep` 什么也不会冻结。回收是冻结而非删除（一律 → stopped，记录全留）；有 agent 调用在跑的孤儿（`busy`）永不被冻结，只在报告的 `deferred` 里出现。被监督冻结的服务，其 `transition` 事件 data 仍为 `{ from, to }`，额外带 `cause`：`orphan_ttl`（闲置超时）或 `orphan_limit`（超上限）；`adopt: terminate` 模式下被父节点连带的子节点 `cause` 是 `parent_terminated`。事件随服务一起用 inspect 读取。

### 身份：daemon 跑的是哪份代码

`system.status` 里的 `home` / `socket` 描述状态在哪（`LUSH_HOME`），`code_dir` / `version` / `fingerprint` / `started_at` 描述**回答你的是哪份代码**：daemon 启动时把 `src/agent/guide.js`、`src/cli/tree/`（CLI 声明树）与 `templates/**/*.json` 及其 `@` 引用的 `templates/**/*.md` 提示词文件（递归，含嵌套子目录）读入内存（`src/identity.js` 的指纹覆盖这几处），之后不再重读。`code_dir` 不同 = 另一个 checkout；`fingerprint` 不同 = 同一 checkout 的旧服务。CLI 每次命令都会先读一次 status 并在不一致时于 stderr 告警（`cli.code_match` 是同一判断的布尔形式）。

service.view 是「查看」的统一读模型，把「这个节点是什么 / 能建什么 / 在它上面开 task 用什么提示词」和父子关系合并到一次读取：

| section | 结果字段 | 内容 |
|---|---|---|
| description | description | 该节点模板的 description（能力边界陈述）；读当前加载的模板定义，模板文件已不在时回落创建时快照，null 表示两者都没有 |
| parent | parent | 当前父节点完整 metadata；无父节点时为 null（例如 SID 0） |
| children | children | 直接子节点完整 metadata 数组 |
| prompt | call_prompt | 该 Service 模板 system_prompt 的快照（它上面 task 的 agent 收到的提示词） |
| templates | available_child_templates | 该节点现在还能创建的子模板，按层级顺序，每项 name / singleton / description / spawn_prompt；权限来自创建时快照，已被占用的 singleton 不出现（与 agent Context 里的同名列表是同一个函数） |

sections 省略时返回全部五项；必须是非空、无重复、只含上述名称的字符串数组（否则 -32602）。返回字段顺序固定为 sid、description、parent、children、call_prompt、available_child_templates，只包含被请求的 section。未知 SID 与其他方法一样返回 -32004。view 是只读操作，不改变状态、不创建调用记录。Agent 侧的等价能力仍是个体工具 service_self / service_parent / service_children；`templates` 与它自己 Context 里的 `available_child_templates` 是同一份数据。

旧版本写入、快照里没有 `child_templates` 的 Service，会在 daemon 启动时从同名已加载模板回填一次（见 [concepts/lifecycle-and-orphans.md](../concepts/lifecycle-and-orphans.md)）。SID 0 是唯一的例外：daemon 每次启动用当前加载的 `lush-root` **整份替换**它的快照（`replaceSnapshot`，逐字段比较、有差异才写并记 `template_refreshed`），所以收窄 / 放宽根权限靠改模板 + 重启生效（见 [concepts/lifecycle-and-orphans.md](../concepts/lifecycle-and-orphans.md)）。

## Agent Tools

Provider tool 名称采用 OpenAI-compatible 安全字符：`service_self`、`service_spawn` 等；Runtime 映射成以下 Core 操作。Mock `/tool service.spawn {...}` 也接受逻辑点号名称。这些工具只属于 Lush 内置运行时（`mock` / `openai`）；`LUSH_PROVIDER=pi` 时 pi 没有它们，改用 bash 运行 `lush` CLI（上方同名命令）。`dry_run` 只在 RPC / CLI 上暴露，Agent 工具暂未开放；`service.call_begin` / `service.call_end`（`call --interactive`）也一样：进入 TUI 是给人用的，Agent 自己发调用一律用普通 `call`。

| Tool | 参数 | 语义 |
|---|---|---|
| task_self | {} | 自己这个 task（goal / status / result / 子 task）+ 所在 service |
| task_children | {} | 自己派出去的子 task |
| task_spawn | sid, goal | 向下游派活：在直接子 service 上创建一个立刻开始跑的子 task；下游正忙时报 -32010。不等待：子 task 结算时你会被唤醒并拿到结果 |
| task_message | task_id, body | 给直接父 task 或直接子 task 发一条消息：入队，不打断对方正在跑的工作；对方停在 waiting 时会被立即唤醒 |
| task_cancel | task_id | 取消一个子 task（连带它的子树） |
| task_complete | result? | 结束自己（有活动子 task 或收件箱有未读消息时报 -32010） |
| task_update_state | patch | 合并自己 task 的草稿 state |
| service_self | {} | 自己所在的被动节点（变量、state、子服务） |
| service_parent | {} | 当前所在节点的父节点 |
| service_children | {} | 当前所在节点的直接子节点 |
| service_inspect | sid | inspect 指定节点 |
| service_spawn | template, name?, goal?, variables? | 创建子服务（受 child_templates 限制）；建完再用 task_spawn 把活派给它 |
| service_update_state | patch | 修改所在节点的长期 state（不能写变量） |
| service_update_vars | patch | 只能改该节点模板声明为 mutable 的变量 |
| notice | title, kind?, body?, fields?, wait? | 向用户上报：kind 为 report / decision / blocked；`fields` 声明要用户填的表单（name / label / type=text\|textarea\|choice\|boolean / required / options / default）；默认（wait=true）阻塞到用户 answer / dismiss，把 `{status, answer}` 作为工具结果返回，wait=false 只登记、立即返回 |

工具错误作为带 code/message 的 tool result 回给 Agent；Provider 可以修正。未知工具拒绝。内置运行时不允许 Agent 伪造当前 SID（工具参数里没有 sid）；pi 后端的安全边界更弱：它能读写磁盘、执行命令，并通过 bash 调用 `lush` CLI，因此 `LUSH_SID` 只是便利信息，不是权限凭据。complete 后本轮可返回最终文本，但后续副作用工具被拒绝。

`notice` 也一样分两条路：内置运行时（mock / openai）用 `notice` 工具，外部 agent（pi，默认后端）用 `lush notice post --title ... [--fields JSON]`（RPC `notice.post`，汇报者取 `$LUSH_TASK_ID`）—— pi 没有 Lush 工具，这是它上报的唯一通路。两者语义一致：默认阻塞到用户结算，把 `{ status, answer }` / 结算后的 notice 交回 agent。

## CLI

命令分三层：顶层 → 命令组 → 命令 → 参数。每一层都提供 help（`help` 子命令、`-h`、`--help`），帮助文本与下面的命令表来自同一张声明（`src/cli/tree/` 的命令声明），不会与解析器脱节；`--json help [command]` 返回结构化的命令树。

```text
lush help [command [subcommand]]        # 顶层与任意一层的覆盖范围、子命令、参数

lush daemon start|stop|restart|status
lush call SID GOAL [--detach] [--interactive] [--dry-run]   # 入口：在 service 上开一个根 task

lush task list|tree|inspect|result|wait|spawn|cancel|complete|delete|history|session|attach|update-state|agents
lush service list|tree|inspect|children|spawn|start|stop|delete|purge|update-state|update-vars|orphans

lush service inspect SID [--with description,parent,children,prompt,templates]
lush service spawn PARENT TEMPLATE [--name NAME] [--goal GOAL] [--title TEXT] [--detail TEXT] [--vars JSON]   # --args 是 --vars 的旧写法
lush service children SID
lush service start|stop SID
lush service delete|purge SID [--recursive]
lush service update-state SID --patch JSON
lush service update-vars SID --vars JSON
lush service orphans [--sweep]   # 孤儿池读模型；--sweep 立刻按 TTL / 上限回收一次
lush service tree [--no-agents]

lush call SID GOAL --interactive        # 在本终端用 pi TUI 做这个 task（简写 -i）
lush task list [--sid SID] [--status S] [--roots|--children]
lush task tree TASK_ID
lush task inspect|result|wait|cancel TASK_ID
lush task complete TASK_ID [--result JSON]
lush task spawn SID --goal GOAL [--parent-task-id TASK_ID]
lush task message TASK_ID --body TEXT [--from TASK_ID]   # agent 侧给直接父 / 子 task 传话（入队）
lush task inbox TASK_ID [--after ID] [--limit N]          # 该 task 收到的输入（消息 / 子结算）
lush task update-state TASK_ID --patch JSON
lush task history TASK_ID [--after ID] [--limit N]
lush task delete TASK_ID [--recursive]
lush task session TASK_ID [--open]      # --open 与 attach 等价：进入该 task 的 pi TUI
lush task attach TASK_ID
lush task agents list [--task-id TASK_ID] [--sid SID] [--all]
lush task agents show AGENT_ID
lush task agents kill AGENT_ID

lush notice list [--status open|answered|dismissed] [--task TASK_ID] [--sid SID]
lush notice show NOTICE_ID
lush notice post --title T [--kind K] [--body B] [--fields JSON] [--task TASK_ID] [--no-wait]  # agent 侧上报；默认阻塞到答复
lush notice answer NOTICE_ID --set K=V [--set K=V ...]   # 或 --text TEXT / --answer JSON
lush notice dismiss NOTICE_ID [--reason TEXT]
```

`--goal` / `--vars`（旧写法 `--args`）/ `--patch` / `--result` 接收文本或 JSON 字面量，JSON 非法时报 usage 错误（退出码 2）。`--title` / `--detail` 是模板那两个变量的简写，和 `--vars` 合并、同名不能两边都给。用法错误（解析失败，或 Core 报 -32602 的参数值错误，如变量缺失、格式不符）一律以退出码 2 结束，其他错误是 1。`service update-state` / `task update-state` 把 patch 顶层 shallow-merge 到该节点 / 该 task 的 state（CLI 命令名带连字符，RPC 方法分别是 `service.update_state` / `task.update_state`），但 `state.params` / `state.vars` 归变量系统所有，改可变变量用 `update-vars`（RPC `service.update_vars`）。

`delete` / `purge`（RPC `service.delete` / `service.purge`，可选 `recursive: true` / `--recursive`）是节点的物理删除路径：同一个事务里删掉该 SID 的 `services`、`contexts`、挂载在它上面的 `tasks`（含 `task_events`）、`messages`、`agent_calls` 与 `service_events` 行，之后任何查询都是 -32004。`delete` 只接受 `stopped` 且没有活动 task 的服务；`purge` 先取消活动 task、停止活动节点再删（回包 `cancelled` / `terminated` 分别列出被取消的 task 与被停止的 SID）。两者都拒绝 SID 0（-32010）；有子服务时默认拒绝，`recursive` 时从叶子往上删整棵子树（`purge --recursive` 不把子节点收养给 SID 0）。由于 `original_parent_sid` 是 NOT NULL 外键，被删 SID 曾创建、后来被收养的幸存节点会改挂 SID 0 并各记一条 `parent_deleted` 事件；删除根节点的父服务会记一条 `child_deleted` 事件。子 task 若挂在别的服务上，会变成根 task 继续存在。`task delete`（RPC `task.delete`）只删 task 行与它的事件，call 行与消息作为 service 的历史保留（`task_id` 置 NULL）。内置运行时的 Agent 工具集里没有任何删除工具。

`call --dry-run`（RPC `call.describe`）不创建 task、不调用 agent：不写 agent_calls / messages，不标记 busy，只把本来要执行的调用描述出来。外部后端（pi）返回 `executable` / `argv` / `command`（可直接粘贴的 shell 行）/ `cwd` / `env` / `path_prefix`；内置运行时没有外部命令，返回 `command: null` 和 `messages`（本来会发给模型的条数）。文本输出就是那行可执行命令（含 `cd <cwd>` 与 `LUSH_HOME` / `LUSH_SID` / `LUSH_TASK_ID` / `PATH`）；`--json` 返回结构化字段。节点仍需是 active（此时还没有 task，session-id 打印为 `lush-task-preview`）。

`call --interactive`（CLI 简写 `-i`；不能和 `--dry-run`、`--detach`、`--json` 同时用）把这次 task 交给调用方的终端：`call` RPC 先建一个 **created** 状态的 task（不启动它），返回**不带 `--print`** 的交互式 argv——同一个 pi session、同一个 cwd、同一套身份提示词，GOAL 作为 TUI 的首条消息；CLI 用 `stdio: inherit` 前台运行它（spawn 而非 spawnSync，好让运行期就知道 OS PID），起手用 `call.os_pid` 把该 pi 的 OS PID 报给 daemon（于是 `task agents show/kill` 能指到它），退出后调 `call.end` 报回 succeeded / failed：succeeded 把 task 记为 completed，failed 记为 failed。回包的 `settled: false` 表示 daemon 已经先结算了（timeout、cancel、daemon 退出），此时终端里的 pi 与调用记录无关。只有外部 agent（pi）能这样交接：内置运行时的 agent 在 Lush 服务内，没有可进入的终端，`--interactive` 报错。`task agents kill` 能杀掉这个 pi（daemon 按上报的 OS PID SIGKILL）并取消它服务的 task；`task cancel` 只把这次调用标成 interrupted，真正关掉 pi 的是你的终端或上面的 agents kill；调用方被 SIGKILL 时，daemon 在 `LUSH_CALL_TIMEOUT` 后把 task 记为 failed 并释放。文本层面这次调用只留下 user message（回复在 pi 会话里）。

`task session`（RPC `task.session`）是只读查询，任何状态都可查：给出该 task 的 agent 的 session-dir、session-id（`lush-task-<id>`）、磁盘上的 session 文件（`<timestamp>_lush-task-<id>.jsonl`，没有则为 null）、cwd 与 busy。`argv` / `command` 是带着 Lush 身份（模板 system_prompt + 说明层 + `LUSH_CONTEXT`）的交互式命令（无 `--print`），`--open` 就是直接用它把终端交给 pi；`browse_command` 是不带身份的短命令（只有 `--session-dir` / `--session-id`，用 pi 默认提示词浏览）。内置运行时 `session_dir` 等字段为 null，文本输出提示 `runs in-service`；`--open` 会报错，且 `--open` 不能与 `--json` 同时用（CLI 报 usage 错误）。

agent 有两个互不相同的视图，都不落库也不共用 sid 空间：

- **运行期 agent**（`task.agents_list` / `_show` / `_kill`，CLI `lush task agents …`）：id 形如 `TASK.N`（N 在本次 daemon 内按 task 单调递增），字段有 `task_id`、`sid`、`name`、`provider`、`status`（只有 `running` 是活的）、`call_id`、`os_pid`（daemon 起的 pi 由 `invocation.on_spawn` 报回，`--interactive` 的由终端调 `call.os_pid` 上报）、`interactive`、`cancellable`（interactive 且尚未上报 os_pid 时为 false）、`started_at`/`ended_at`/`elapsed_ms`、`error`。`agents_list` 默认只返回活着的；`all: true` 再附上本次 daemon 内存里保留的已结束条目（上限 32，daemon 退出即清空）。`agents_kill` 结束这一次调用（记为 interrupted）**并取消它服务的 task**——被强杀的 agent 没有答案可记。返回值的 `outcome` 说明 OS 侧：`killed`（SIGKILL 送达）、`gone`（sid 已不存在）、`no_pid`（服务内 provider，或 interactive 且终端尚未上报 os_pid）；`killed` / `gone` 的 interactive 调用由 daemon 当场记为 interrupted，不再等终端回报或超时，`no_pid` 的只标记取消、等终端回报或超时。
- **`service.tree` 的 `agent` 字段**（默认带；`agents: false` 去掉，CLI `--no-agents`）：只回答「此刻谁在干活」——`provider`、`running`（个数）、`agents[]`（每个的 id / task_id / call_id / interactive / os_pid / started_at / elapsed_ms）。由 `AgentRuntime.agentSummary` 生成，不建 Context、不拼 argv、不读磁盘与历史，因此 N 个服务只付 N 次内存查询；没有 agent 在跑的服务返回 `running: 0`。
- **磁盘上的 transcript** 是 `task.session`（session_dir / session_id / files / file / argv / browse_command / cwd / busy）：按 task 命名，同一次唤醒追加同一个文件。

`call.os_pid` 是 `call --interactive` 专用的补充：终端在 spawn 出 pi 之后立刻上报 `{ task_id, call_id, os_pid }`，daemon 才知道那个跑在别人终端里的服务叫什么、怎么杀；调用已经结算时返回 `recorded: false` 而不是报错。`task agents_*` 与 `call.os_pid` 都只在 RPC / CLI 上暴露，Agent 工具里没有（agent 不该杀自己）。

`--json` 为全局标志，可放在命令之前或命令末尾（`lush --json service list` / `lush service list --json`），输出机器可读 result，是唯一稳定的机器接口。**默认（不加 `--json`）输出给人看**：`service list` / `task list` / agents list 是对齐的表格，`service tree` 是带 agent 活跃度的服务树（服务名后跟变量当前值，`~` 表示可变；保留名 `name` 与 `detail` 不进树），`task tree` 是带缩进的协作树，orphans 是策略行 + 孤儿表（`--sweep` 时是本轮报告），daemon status 是 `key value` 行，inspect / agents show / update-state 是分节的 `key value` 与嵌套块（`title` 占一行、`detail` 独占一个分节，超长截断），history 按消息分块（头部 `#id role · 本地时间 · call`，正文原样换行，末尾给出 `next --after`），生命周期命令打印 `stopped sid 1 · worker · stopped` / `completed task #3` 这样的一行摘要，`call` 打印 `task #1 name[sid] completed` 加 result，delete / purge 打印删了什么，spawn 打印 SID。文本格式可以随时改，需要稳定字段时用 `--json`。错误写 stderr，用法错误退出码 2（缺参数、未知命令/选项，以及 Core 的 -32602 参数值错误），其他错误退出码 1。

`inspect` 不带 `--with` 时保持完整 inspect 输出；带 `--with` 时改调 service.view，只返回所选 section（逗号分隔，可多次使用，重复的 section 在客户端去重；RPC 层仍拒绝重复）。未知 section 在 CLI 报 usage 错误（退出码 2），在 RPC 报 -32602。

`lush task attach TASK_ID`（= `lush task session TASK_ID --open`）把当前终端交给这个 task 的 pi 会话，用来边看边接管它；退出 TUI 回到 shell，不改变 task 状态。要中断它在 daemon 里的调用，用 `lush task cancel TASK_ID` 或 `lush task agents kill TASK_ID.N`。

daemon start 后台用 `process.execPath` 启动 `src/daemon/main.js`（detached，日志 `$LUSH_HOME/daemon.log`）并等待 RPC ready。已启动时幂等。daemon stop 发 system.shutdown 并等待锁释放。daemon restart 先 stop 再 start（daemon 没在运行时等价于一次 start），返回新 daemon 的状态并多一个 `restarted` / `was_running`；因为 `start` 幂等，只有先等旧 daemon 释放单实例锁，新 daemon 才能成为应答的那一份。根服务不能用 `lush service stop 0` 停止。启动参数来自环境：LUSH_HOME、LUSH_PROVIDER=pi|mock|openai（默认 pi）、LUSH_PI_COMMAND、LUSH_PI_PROVIDER、LUSH_PI_MODEL、LUSH_API_KEY、LUSH_BASE_URL、LUSH_MODEL、LUSH_CALL_TIMEOUT（默认 900 秒）、LUSH_MAX_ROUNDS（默认 12，仅内置运行时）、LUSH_ORPHAN_ADOPT / LUSH_ORPHAN_LIMIT / LUSH_ORPHAN_TTL / LUSH_ORPHAN_SWEEP（SID 0 的孤儿监督策略，默认 adopt / 0 / 0 / 30，非法值启动即报错）。客户端超时为调用超时 + 10 秒，可用 LUSH_RPC_TIMEOUT 覆盖。

默认的 pi 是「纯净化」的：daemon 启动时把内置 `default` profile 解析成 fallback provider（pi + `--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files`），所以 pi 不加载使用者的 extensions / skills / prompt templates / themes / AGENTS.md；`$LUSH_HOME/agents/default.json` 可逐字段覆盖它。所有 `$LUSH_HOME/agents/<name>.json` 都在**每次 call 时**读盘（不需要重启 daemon），只有 provider 是 `pi` 之外的后端或 `agent` 解析出错时才会以 -32602 / -32004 失败。环境变量与 profile 的优先级见上一节。

实现细节：Bun socket 单次 `write()` 只能接受有限字节，RPC 两端都用 `socket_io.js` 的写队列处理部分写与 drain；`system.shutdown` 的回复在拆连接之前写出，然后才唤醒 daemon 拆除流程。
