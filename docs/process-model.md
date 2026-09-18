# Process 模型

## 实体和接口

Process = 持久化 metadata + 变量 + Context + Agent + 生命周期。字段包括 pid、parent_pid、original_parent_pid、children（反查）、type、status、created_at、updated_at、name、goal、template 快照、variables（值 + 模板声明）。

`ProcessManager.load(pid)` 返回轻量句柄 `Process`，提供 `getParent()`、`getChildren()`、`createChild(template, {name, goal})`、`await call(prompt)`、`inspect()`。读取总是从 Repository 获取当前状态。每个 Process，包括 PID 0，都可以调用 Agent。

`ProcessManager` 的方法名与 JSON-RPC 方法名几乎一一对应（`updateState` ↔ `process.update_state`）；线协议字段保持 snake_case，JS 内部使用 camelCase。

PID 0 固定名 lush、类型 service、没有父节点，使用内置 lush-root template，daemon 可用时为 running。禁止用户 stop/kill/complete/reclaim/delete/purge PID 0；其生命周期由 daemon 管理。

## 生命周期

```text
Service: created -> running -> stopped / failed
                             stopped / failed -> running (start)
Task:    created -> running -> completed / failed / cancelled -> reclaimed
```

- spawn 通过 template 原子创建并启动，事件中同时记录 created 和 running。
- start：启动 created；重新启动 stopped/failed Service；running 上幂等。终态 Task 不可复活。
- stop：仅 Service；停止目标，不级联终止子节点。
- kill：Service -> stopped；活动 Task -> cancelled。已终止节点幂等。
- complete：仅 running Task，由 Agent 显式声明；可保存 result 到 state。
- fail：Core 提供的显式失败操作；provider 调用失败只使 invocation failed，不会自动使 Process failed。
- reclaim：仅 completed/failed/cancelled Task -> reclaimed，保留 metadata、Context、消息和事件。
- delete：硬删除已结束（非 created/running）的进程，见下节「删除（delete / purge）」。
- purge：先按 kill 的规则终止（Service -> stopped，Task -> cancelled，并中断进行中的调用），再执行 delete。
- call / attach：只接受 running Process。call 成功不代表任务完成。历史通过 inspect / history 读取，不重新调用已结束任务。

用户或 Agent 只能修改结构化 Context state，不能随意覆写 pid、parent、type、status；生命周期必须通过专门 Core 操作验证。

## 孤儿收养（用户确认）

父节点进入终态（Service stopped/failed；Task completed/failed/cancelled）时，将其 **created/running 的直接子节点** 的 parent_pid 改为 0。保留 original_parent_pid 和 reparent 事件。已结束子节点仍属于原父节点。孙节点不变。子节点自己的状态、Agent 调用不受影响。

因此 task -> service 完全允许；Task 完成后，该 Service 能持续存在，由 PID 0 收养。restart 已停止的 Service 不自动取回已被收养的子节点。收养之后 PID 0 还要按配置的上限与闲置超时监督孤儿池——默认与上面这段历史行为完全一致（`adopt` + 不限 + 不超时），显式配置后才启用，见下节「PID 0 的孤儿监督」。

这个收养动作本身也是可配置的：`LUSH_ORPHAN_ADOPT` 的 `adopt`（本节行为，默认）/ `none`（不收养、不终止，子节点留在终态父节点下）/ `terminate`（活动直接子节点随父一起冻结，不收养）三选一，详见下节。

stop/kill 会中断目标正在运行的 Agent 调用（abort 该 PID 的 AbortController），但不会中断被收养子节点独立的调用。嵌套 process.call 的等待者被取消时，子 invocation 继续运行（JS 中取消等待者只是停止 await，不传播到被等待的 promise），历史可通过 inspect 查询。

## PID 0 的孤儿监督

收养不是终点：PID 0 还负责把孤儿池维持在配置的规模与新鲜度之内。**默认不启用**（`adopt` + 不限 + 不超时），此时监督只读、什么都不回收，行为与引入它之前完全一致；只有显式配置了上限或 TTL 才会动手。

**孤儿**是被 PID 0 收养的进程：`parent_pid = 0` 且 `pid > 0` 且 `original_parent_pid` 非空且非 0。PID 0 自己 `spawn` 的孩子（`original_parent_pid = 0`）不算孤儿，永远不被监督。**活动孤儿**是其中 status 为 created / running 的那些，监督只冻结它们；已被冻结的终态孤儿仍留在读模型里可查。

### 配置（daemon 启动时读环境变量，切换需重启）

| 环境变量 | 取值 | 默认 | 含义 |
| --- | --- | --- | --- |
| `LUSH_ORPHAN_ADOPT` | `adopt` \| `none` \| `terminate` | `adopt` | 父节点进入终态时，活动直接子节点怎么办 |
| `LUSH_ORPHAN_LIMIT` | 整数 ≥ 0 | `0`（不限） | PID 0 下活动孤儿的上限，超出时从最旧开始冻结 |
| `LUSH_ORPHAN_TTL` | 秒数 ≥ 0（可小数） | `0`（不启用） | 闲置超过该秒数的孤儿被冻结 |
| `LUSH_ORPHAN_SWEEP` | 整数秒 ≥ 0 | `30` | daemon 定时扫一次；`0` = 不起定时器（仍可手动 `--sweep`） |

三个 `adopt` 模式的语义：

- `adopt`（默认，即上节「孤儿收养」的行为）：活动直接子节点 reparent 给 PID 0（`parent_pid = 0`，保留 `original_parent_pid`，记 `reparented` 事件）。
- `none`：不收养、也不终止。子节点留在终态父节点下（`parent_pid` 不变）。这类子节点**不是孤儿**，PID 0 不监督。
- `terminate`：活动直接子节点随父一起冻结（Service → stopped，Task → cancelled），不收养。与 stop/kill 一致只处理直接子节点，但每个被冻结的子节点自身再走同一策略，因此实际沿活动链一路冻结。

非法值在 daemon 启动时直接报错并点名变量（例如 `invalid LUSH_ORPHAN_ADOPT: maybe (choose adopt, none, terminate)`）。

### 回收语义

- **回收是冻结，不是删除**：Service → `stopped`，Task → `cancelled`；metadata、Context、消息、调用与事件全部保留。物理删除仍只有 `delete` / `purge`（见下节）。
- **busy 永不回收**：该 PID 有正在跑的 agent 调用时（`lush process agents list` 能看到），它不会被冻结，只会出现在本轮报告的 `deferred` 里；上限超出时若只剩 busy 的孤儿，监督就此停止，不硬来。
- **闲置（idle）**：`last_activity_at = max(updated_at, 最近一条 message 的时间, 最近一次调用的开始/结束时间)`，`idle_seconds` 是它到现在的秒数，TTL 用这个值判断。
- **顺序：先 TTL，后上限**。TTL 冻结闲置 ≥ `LUSH_ORPHAN_TTL` 且非 busy 的孤儿；然后只要活动孤儿数 > `LUSH_ORPHAN_LIMIT`，就从最旧（`last_activity_at` 升序，其次 pid 升序）的非 busy 孤儿开始冻结。每冻结一个都**重查一次孤儿池**——冻结一个父节点会把它自己的活动子节点交成 PID 0 的新孤儿，这些新的孤儿在同一轮里继续按策略处理。
- **收养触发的即时上限**：收养发生且 `limit > 0` 时，事务后立刻跑一次监督（trigger 为 `adoption`，带重入保护，一轮里只跑一个）。也就是说，完成 / 停止一个父节点、把它的子节点交给 PID 0 时，如果配了上限，PID 0 会当场冻结最旧的孤儿——这是「上限」语义的一部分，不是意外。
- **定时器**：只有 `limit > 0 || ttl > 0` 且 `sweep > 0` 时，daemon 才按 `LUSH_ORPHAN_SWEEP` 秒起一个 `unref` 的定时器（不会拖住 daemon 退出）；关闭 daemon 时先清掉它，再关数据库。默认策略下没有定时器。
- **持久痕迹**：被监督冻结的进程，其 `transition` 事件里带 `cause`：`orphan_ttl`（闲置超时）或 `orphan_limit`（超上限）。`terminate` 模式下被父节点连带的子节点，`cause` 是 `parent_terminated`。事件 data 仍是 `{ from, to }`，只在有 cause 时多一个字段。
- **PID 0 自己不变**：PID 0 自己的 transition（daemon 关闭路径）绝不收养、也绝不停子节点；`purge --recursive` 传 `adopt: false`，同样不收养、不级联。

### 读模型与命令

`process.orphans`（CLI `lush process orphans`）是只读的读模型：给出 `policy`（`adopt` / `limit` / `ttl_seconds` / `sweep_seconds`）、`active_count`、`busy_count`、`over_limit`（`limit > 0` 时 `max(0, active_count - limit)`，否则 0），以及每个孤儿的 `pid` / `name` / `type` / `status` / `template` / `original_parent_pid` / 时间戳 / `idle_seconds` / `busy`——含已被冻结的历史行。

`process.orphan_sweep`（CLI `lush process orphans --sweep`）立刻执行一轮监督并返回报告：`trigger`（`manual` / `timer` / `adoption`）、`skipped`（重入时 true）、`checked`（本轮读到的孤儿行数，含已冻结的历史行）、`active_before` / `active_after`、`evicted[]`（pid、name、type、from、to、reason、idle_seconds）、`deferred[]`（busy 的 pid 与 reason）、`limit`、`ttl_seconds`。`just orphans` / `just orphans sweep` 是同一组命令的 Justfile 包装。

`system.status` 也带上当前的 `orphan_policy`（与上面同形的嵌套对象）与 `orphans_active`（标量）——`lush daemon status` 的文本里直接能看到 `orphans_active`。改配置要重启 daemon：这四个变量只在启动时读一次。

### 与删除的边界

`delete` / `purge` 硬删除一个进程后，曾由它创建、后来被 PID 0 收养的幸存节点，其 `original_parent_pid` 会被改挂 0（NOT NULL 外键不允许行活过它指向的 pid），并各记一条 `parent_deleted` 事件。因此**这些节点不再算孤儿**（`original_parent_pid = 0` 不满足孤儿定义），PID 0 不再监督它们——它们仍留在 PID 0 名下，只能手动处理（stop / kill / delete）。

## 删除（delete / purge）

`reclaim` 是归档（保留一切），`delete` / `purge` 是**唯一的物理删除路径**：把该 PID 的 `processes`、`contexts`、`messages`、`agent_calls`、`process_events` 行在**同一个事务**里一起删掉，之后 list / tree / inspect / history / session 都不再有它（-32004）。删除不可逆，且只能由 CLI / RPC 发起：内置运行时的 agent 工具集里没有删除工具，`process_delete` / `process_purge` 不存在。

| 命令 | 接受的进程 | 行为 |
| --- | --- | --- |
| `process delete PID`（RPC `process.delete`） | 已结束：stopped / failed Service，completed / failed / cancelled / reclaimed Task | 直接删除；running/created 被拒绝（-32010），提示先 stop/kill 或改用 purge |
| `process purge PID`（RPC `process.purge`） | 任何非 PID 0 的进程 | 先终止再删除：Service -> stopped、Task -> cancelled，并中断它正在跑的 Agent 调用；回包 `terminated` 列出被终止的 PID |

规则与边界：

- PID 0 永远拒绝（-32010），两种命令都是。
- **子进程**：默认拒绝（子进程的 `parent_pid` 会指向已不存在的行）。`recursive: true` / `--recursive` 时，**同一事务**内从叶子往上删整棵子树；`delete --recursive` 要求子树里每个节点都已结束，`purge --recursive` 会把子树里所有活动节点依次终止（`adopt: false`，不写「收养给 PID 0」这种马上又要删掉的行）。
- **残留引用**：被 `delete` 的进程可能仍是某些进程的 `original_parent_pid`（它创建过、后来被 PID 0 收养的节点）。`original_parent_pid` 是 NOT NULL 的外键，行不能活过它指向的 pid，因此这些幸存节点被改挂到 PID 0（与它们此时 `parent_pid` 的取值一致），并各自记一条 `parent_deleted` 事件（含被删 pid 的名字、模板与状态）。
- **审计痕迹**：删除根节点的父进程（若还在）会记一条 `child_deleted` 事件，`data` 为 `{ pid, name, template, status, deleted }`，`deleted` 是这次实际消失的全部 PID（升序）。被删节点自己的事件随它一起消失——留痕只有这一条。
- **回包**：`{ pid, status, deleted, terminated, rows }`。`status` 是根节点删除前的状态，`terminated`（purge 用）与 `deleted` 都是升序 PID 列表，`rows` 是按表统计的删除行数（`processes` / `contexts` / `agent_calls` / `messages` / `process_events`）。
- **交互式调用**：被 `call --interactive` 的终端持有的 pi 不在 daemon 手里，purge 只把那次调用标记为 interrupted 并删掉记录；终端里的 pi 进程要自己退出，或用 `process agents kill` 终止。
- **运行期 agent 记录**：daemon 内存里的已结束 agent 条目（`process agents list --all`）可能指向已被删除的 PID，此时它的 `name` 为 null，而不是让整次查询失败。

## ProcessTemplate

JSON 文件字段固定为八项，缺一或多一都报错：

```json
{
  "name": "coding-task",
  "type": "task",
  "singleton": false,
  "description": "完成编码目标",
  "spawn_prompt": "创建编码任务：process_spawn {template: \"coding-task\", name: <任务短名，必填>, goal: <编码目标，必填>}。",
  "system_prompt": "你是编码任务 Agent。只有完成目标时才调用 process.complete。",
  "child_templates": ["generic-task", "research-task", "generic-service"],
  "variables": {
    "immutable": {
      "repo": { "required": true, "description": "代码仓库根目录（绝对路径，同时是 agent 的 cwd）" }
    },
    "mutable": {
      "branch": { "default": "main", "description": "当前工作分支，可用 update-vars 修改" }
    }
  }
}
```

- `name`：模板名，也是 `process.spawn` / `lush process spawn` 的 template 参数。
- `type`：`task` 或 `service`，决定新 Process 的类型和可用生命周期。
- `singleton`：`true` 时，同一个父 PID 下最多只能有一个活动（created/running）实例；该实例停止、结束或 reclaim 后名额释放。不同父 PID 互不影响；`generic-*` 这类通用模板应为 `false`。
- `description`：一句话说明用途，出现在创建方的 `available_child_templates` 中。
- `spawn_prompt`：告诉创建方「如何创建这个模板、需要哪些变量」的 prompt，随 Context 一起注入创建方 Agent（`available_child_templates[].spawn_prompt`）。它只描述创建契约（必填变量、`--vars` 用法），不参与被创建实例自身的 Call；哪些变量创建后仍可改，由模板的 `variables` 声明决定。
- `system_prompt`：实例创建时快照进它自己的 Context，成为之后每次 `call` 的系统提示词。
- `child_templates`：该模板实例初始化后允许创建的子模板列表。
- `variables`：该模板实例的变量声明，分 `immutable` / `mutable` 两个区间（两个键都可省略，省略即该区为空）。每个变量的字段固定为 `description`（必填，说明这个变量是什么）、`required`（可选布尔，缺省 false）、`default`（可选 JSON 值），以及可选的格式约束 `pattern`（正则表达式）、`max_length`（正整数）、`single_line`（布尔）；`required: true` 与 `default` 同时出现、同名变量出现在两个区、mutable 区声明 `path` 或 `name`，都报错。约束字段本身也在加载时校验（正则要能编译、`max_length` 是正整数、`single_line` 是布尔），且 `default` 必须满足自己声明的约束——模板自相矛盾在 daemon 启动时就报错，而不是等到第一次 spawn。校验细节与存储位置见下方「变量（variables）」。

注入创建方 Agent 的 `available_child_templates` 只列**此刻真能创建成功**的模板：按创建时快照的 `child_templates` 过滤权限、排除 `lush-root`，并剔除 `singleton: true` 且本 PID 下已有活动实例的模板（否则调用方只会白撞一次 `process.spawn` 的拒绝）。它是派生视图，不代替权限本身：完整白名单仍在 `child_templates`，被占位的那个实例就在 `children` 里。

限制针对 template 名称，而非 task/service。`["*"]` 表示允许全部已加载模板；`[]` 禁止创建子节点。父节点必须 running。自身模板快照中的 `child_templates` 决定后续创建权限，外部文件修改不会悄悄改变已有进程能力。变量值（`state.params` 与 `state.vars`）属于 Context state，但只有变量的写入路径能改它；其余 state 由 agent 自己维护。子节点 goal 由创建参数指定，未指定时使用名称；模板本身不携带初始 Context，新实例的 artifacts、references 一律从空开始，state 里只有它的变量（immutable → `state.params`，mutable → `state.vars`）。ContextBuilder 提供父节点摘要。

模板快照是创建时的完整副本（含 `singleton`、`spawn_prompt`、`variables`），外部改模板文件不会改变已有 Process。`singleton` 与 `type` 按当前已加载模板判定；例外是从快照读回的那两个字段：daemon 启动时会把旧快照中缺失的 `child_templates` 与 `variables` 从同名已加载模板回填一次（幂等，记 template_backfilled 事件，不改其他字段），同名模板已不存在时跳过并记日志。旧快照里遗留的 `process_type`、`allowed_child_templates`、`agent_command`、`initial_context` 键不再被读取。

仓库顶层 `templates/` 内置 `lush-root.json`（PID 0 专用，任何节点都不能用它 spawn 子进程，即使 `child_templates` 含 `*`）以及 `generic-service`、`generic-task`、`research-task`、`project-manager`、`project`、`dev-task` 示例。其余模板需自行编写，放入 `templates/` 或 `$LUSH_HOME/templates/`；用户目录模板不能覆盖仓库模板名称；loader 检查 `type`、`singleton`、必填字段和列表中的模板引用。

`dev-task`（`project` 的子模板、task、非单例、`child_templates: []`）把一项开发任务描述成三个正式字段，都是它自己声明、受校验、可渲染的变量：`name`（不可留空的英文标识符 `^[A-Za-z][A-Za-z0-9_-]*$`、≤64、不含空格；它同时就是这个进程的进程名，用来命名相关的 worktree / 分支）、`title`（不可留空的一行摘要 ≤200，`process list` / `inspect` 显示的就是它）、`detail`（任务详情正文，可多行、可以为空 ≤20000，为空时以 title 为准）。`goal` 仍然是「要实现什么」的简述，`detail` 是它的展开；`name` / `title` 缺失或格式不合规时创建直接失败（-32602），报错引述该变量的声明。工作参数（仓库路径、分支）仍然由任务自己向父进程取（`project` 的 `path` / `branch`），所以 `dev-task` 不声明 `path`。想给子进程带信息，可以直接像 `project` 那样声明变量，也可以像 `dev-task` 这样让子进程自己去父节点取（更灵活，但子进程必须真的去取）。

### 变量（variables）

模板用 `variables` 给出实例的初始变量，创建进程时必须按它提供值：`process.spawn` 的 `variables` 参数 / `lush process spawn ... --vars '<json>'`（旧写法 `args` / `--args` 仍接受，等价但已不建议使用）。校验全部由 Core 执行：

- 只接受模板声明过的变量名：写了 `variables` 没声明的名字直接报错（-32602），不静默丢弃。
- `required: true` 的变量必须提供，否则报 `template <name> requires variables.<key>`（并附上该变量的 `description`）；带 `default` 的变量可以省略，省略时用默认值。
- 值必须满足该变量声明的格式约束：`pattern`（匹配整个值，等价于在两边加 `^(?:` 与 `)$`）、`max_length`、`single_line`（不允许换行与控制字符）。声明了任一约束的变量必须是字符串；没声明约束的变量仍然接受任意有限 JSON（历史行为不变）。报错引述违反的那条约束与变量的 `description`，例如 `template dev-task variable name value "fix login" does not match /^[A-Za-z][A-Za-z0-9_-]*$/ — ...`。
- 值可以是任意有限 JSON（不做类型标注）；`path` 例外，见下。
- `variables` 必须是 JSON 对象（`{}` 或省略等于不提供任何变量）。

变量按声明所在的区间存储，也在同一区间读取：

| 区间 | 含义 | 存储 | 创建后 |
| --- | --- | --- | --- |
| `immutable` | 模板的初始变量，代表进程身份（如 `project` 的 `path`） | `state.params` | 固定，不能改 |
| `mutable` | 会随工作推进变化的状态（如 `project` 的 `branch`） | `state.vars` | 可用 `process.update_vars` 改 |

`process inspect PID` 与 `process tree` 会给出变量的当前值：`variables.immutable`、`variables.mutable`，以及 `variables.declarations`（两个区间各自的变量声明：`description` / `required` / `default`）。声明取自创建时的模板快照，因此事后修改模板文件不会把已有进程的不可变变量变成可变。进程本身、创建它的一方都是靠这份声明知道「有哪些变量、哪些能改」：`spawn_prompt` 只负责讲清创建契约（必须给什么），模板没有声明为 mutable 的变量就不应该被修改，agent 也不应该去猜。

`process.update_vars`（CLI `lush process update-vars PID --vars '<json>'`，内置运行时的工具 `process_update_vars`）只把值 shallow-merge 进 mutable 区：

- 未在 mutable 区声明的名字被拒绝：immutable 变量报 `variable <key> is immutable in template <name>`，模板没声明的名字报 `does not declare variable`（都是 -32602）；值同样要满足该变量声明的格式约束。
- patch 必须是非空 JSON 对象；只接受 running 进程（与 `update_state` 一致）；写入记 `vars_updated` 事件。
- `update_state` 不能写 `state.params` / `state.vars`（报错并指向 `update_vars`），所以「不可变」不是靠调用方自觉。

`path` 是所有模板共用的工作目录约定：只要模板声明了 `path`，它的值必须是**已存在的绝对目录**，并且会作为该进程 agent 的 cwd（pi 的 `cwd`，其他后端同理）；没声明 `path` 时 cwd 是 `$LUSH_HOME`。因为 cwd 从 `state.params.path` 读出，`path` 只能声明在 immutable 区；缺失、不是绝对路径、不存在或不是目录时 spawn 直接报错（-32602）。

### 保留变量名

四个变量名有超出「模板自己要用一个值」的含义，谁声明它们就自动获得这些语义（与 `path` 的工作目录约定同一机制）：

| 变量名 | 含义 | 谁读它 |
| --- | --- | --- |
| `path` | agent 工作目录（`state.params.path` → cwd） | Runtime（见上） |
| `name` | 进程名 | Core：`process.spawn` 的 `name` 参数与它**是同一个值** |
| `title` | 任务的一句话摘要 | CLI：`process list` / `tree` / `inspect` |
| `detail` | 任务的详情正文 | CLI：`inspect`（分节渲染，超长截断） |

- `name`：声明它的模板（内置的 `dev-task`）把进程名交给这条声明管：`process_spawn` 的 `name` 参数（CLI `--name`）会填进这个变量，直接给 `variables.name` 也行，两边给出不同值时**拒绝创建**（同一个名字不给两个值）；格式约束（`pattern` / `max_length`）写在声明里，所以「name 必须是工作区 / 分支名能用的英文标识符」由模板自带、由 Core 执行。`name` 只能声明在 immutable 区——进程名是创建那一刻的身份。没声明 `name` 的模板行为不变：进程名仍是自由文本，省略时用模板名。
- `title` / `detail`：默认不参与任何语义，只在模板声明它们时才被渲染（`dev-task` 声明）。`process list` 末尾多一列 TITLE（`-` 表示没有），`process tree` 在进程名后打印 `title=...`（`name` 变量因为与进程名重复而不打印，`detail` 是多行正文所以不进树），`inspect` 把 `title` 作为一行、`detail` 作为独立分节（文本截断，`--json` 是完整的）。模板没声明、或旧数据没有这两个值时，渲染退回原样，不报错。

仓库内置模板里，`project` 就是这样声明的：immutable `path`（required）+ mutable `branch`（default `main`），创建时必须给出 `path`，否则报 `template project requires variables.path`。

## Agent 后端

Process 的 agent 由 daemon 的 `LUSH_PROVIDER` 决定，模板只描述身份与能力（`system_prompt` / `spawn_prompt` / `child_templates`），不绑定具体模型：

- `pi`（默认）：每次 call 起一个 `pi --print` 子进程，每个 PID 一个 pi session。模板 `system_prompt` 通过 `--system-prompt` 替换 pi 默认提示词，随后追加共享的 Lush 说明层（`src/agent/guide.js`）和 `LUSH_CONTEXT` 数据。pi 用自己的 read/bash/edit/write 工具，并通过 bash 调用 `lush` CLI 操作进程。取消调用会杀掉子进程。
- `mock` / `openai`：Lush 内置运行时，agent 直接拿到 `process_*` 工具，共享说明层切换到 tools 版本，模板 `system_prompt` 作为第一条 system message。

两种形态共用同一份 Lush 语义：一次 call 不等于 Task 完成，只有 Task 能 complete，singleton 限制、`child_templates` 白名单、变量必填/不可变校验与 `path` 工作目录都由 Core 强制执行，与 agent 后端无关。

## Agent 和 Context

Context 持久化保存 system_prompt、state、artifacts、references、messages。父信息和 children summary 构建时从当前树获取（不是可能过期的持久副本）。Agent 工具 `process.self/parent/children/inspect` 可按需查详情。

Process 不持有供应商 SDK；Runtime 根据配置使用 Agent 后端：内置 Provider 是 `{ name, contextMode:'tools', async call(messages, tools, signal, invocation) }`，外部后端（`pi`）是 `{ name, contextMode:'cli', async call(messages, tools, signal, invocation) }`，只用 `invocation`（pid、prompt、system_prompt、guide、context、cwd）。所有后端共用一个实例（pi 每个 PID 用自己的 session 目录），调用消息和状态严格按 PID 分离，后续可按模板选择后端。祖先调用链通过 `AsyncLocalStorage` 传播。
