# Process 与 Task 模型

Lush 里只有两类东西：

- **Process** 是被动的节点：身份（模板的 `system_prompt`）、父子关系、变量、持久 state、权限（能创建哪些子模板）。它自己**不会运行任何 agent**，平时只保存状态；节点本身也没有「完成」这回事。
- **Task** 是一次工作，挂在某个 process 上。只有 task 有自己的 agent、自己的会话、自己的 result。用户在一个 process 上 `call` 就创建了一个 **根 task**；这个 task 的 agent 要干活，就向自己的**下游**（子 process）派**子 task**，于是形成一棵 task 树——`lush task tree` 看到的就是「一件事如何在进程之间协作做完」。

```text
lush call 2 '实现登录'         → task #1 挂在 implement-login[2]
  task #1 的 agent（在 [2]）派活
    └── task #2 挂在 dev-task[3]        （[3] 是 [2] 的子进程）
          └── task #3 挂在 worktree-service[4] （真正动手改代码的叶子）
```

## Process（被动节点）

字段：`pid`、`parent_pid`、`original_parent_pid`、`children`（反查）、`status`、`name`、`goal`、`template` 快照、`variables`（值 + 模板声明）、`context`（system_prompt / state / artifacts / references）。

- `ProcessManager.load(pid)` 返回轻量句柄 `Process`：`inspect()`、`getParent()`、`getChildren()`、`createChild(template, {...})`、`call(goal)`（= 在它上面开一个根 task）。
- 生命周期只有三态：

```text
created → active ⇄ stopped
```

  - `spawn` 原子创建并进入 `active`（`created` → `active` 记在同一事务里）。
  - `stop`：置为 `stopped`。它的**活动子节点**交给 PID 0 收养（`parent_pid = 0`，保留 `original_parent_pid`）。同一个节点上还有活动 task 时 `stop` 会被拒绝（提示先 `task cancel`）——停止一个节点不能悄悄杀掉正在跑的 agent。
  - `start`：`stopped` / `created` → `active`；重启不会自动取回已被收养的子节点。
  - `delete` / `purge` 见下节「删除」。
- **权限**：创建子进程的模板必须来自该进程创建时快照的 `child_templates`（`*` 表示全部）。这是唯一的能力边界，和 task 无关。
- **PID 0**（`lush-root`，`singleton`）是入口、路由器与孤儿管理者；它只能创建 `project-manager`，不能 stop / delete / purge，其生命周期由 daemon 管理。

## Task（工作单元）

字段：`id`、`pid`（挂载的 process）、`parent_task_id`、`root_task_id`、`goal`、`status`、`result`、`error`、`state`（这一次工作的草稿）、`created_at` / `started_at` / `finished_at`。

```text
created → running ⇄ waiting → completed / failed / cancelled
```

- `created`：行已建、agent 还没开始（交互式交接会停在这里）。
- `running`：它的 agent 正在跑（一次 invocation）。
- `waiting`：agent 正在等自己的子 task（`task_wait`，或先回答后被自动唤醒）。
- `completed` / `failed` / `cancelled`：终态。

规则（这些规则保证 task 树始终是一棵可观察的树）：

1. **一个 process 同时只有一个活动 task**：process 是单线程的工作台。下游正忙时 `task_spawn` 会被拒绝；先 `task_wait` 它，或换一个下游节点。
2. **子 task 只能挂在自己的直接子 process 上**：task 树因此永远沿 process 树向下生长，不会成环，`task_wait` 也不可能死锁。
3. **终态 task 没有活动子 task**：`complete` 要求子 task 都已结束（否则报错，让你先 wait / cancel）；`fail` / `cancel` 会把整棵子树一起取消。
4. **`task_wait` 只接受自己树里的 task**（自己的子 task 或它们的后代），不能等自己。
5. 需要新的下游节点时先 `process_spawn`（受 `child_templates` 限制）建子进程，再向它派 task。

### agent 与 task

- 每个 task 有**自己的 agent 会话**：`agent_calls` / `messages` 都带 `task_id`，pi 的 session-id 是 `lush-task-<id>`（外部 agent 的环境里有 `LUSH_PID` 与 `LUSH_TASK_ID`）。
- 运行期 agent 的编号是 `TASK.N`（N 是本次 daemon 内该 task 的第几个 agent），见 `lush task agents list|show|kill`。`kill` 会取消它服务的 task——被强杀的 agent 没有答案可记。
- 一个 task 最多被 invoke `LUSH_TASK_CALLS` 次（默认 12）：首次运行 + 每次「子 task 结束后被唤醒」。超了就把 task 记为 `failed`，避免无限自旋。
- 如果 agent 先给出了回答、但子 task 还在跑，运行期把 task 置为 `waiting`，等子 task 结束再用一条 `[Lush] 你的子 task 已经结束：…` 的消息唤醒它继续收尾（这条消息是 task 自己对话里的一条 user message）。等子 task 期间不吃调用超时。
- provider 失败、调用超时、轮数用尽 → task `failed`（`error` 里是原因）；daemon 重启时未结束的 task 记为 `failed`（`error = daemon restarted`），不会自动重放。

### 读模型与命令

| 命令（RPC） | 说明 |
| --- | --- |
| `lush call PID '<目标>' [--detach] [--interactive] [--dry-run]`（RPC `call` / `call.describe`） | 在 PID 上开一个根 task 并阻塞到它（及其整棵子树）结束；`--detach` 立刻返回 task 快照，`--interactive` 把它的 agent 交给你的终端 |
| `lush task list [--pid P] [--status S] [--roots\|--children] [--limit N]`（RPC `task.list`） | task 列表（ID / PID / 父 task / status / goal / result） |
| `lush task tree TASK_ID`（RPC `task.tree`） | 整棵协作树：每个节点一行 `#id process[pid] status · goal → result` |
| `lush task inspect TASK_ID`（RPC `task.inspect`） | task + 所在 process + 父 task + 直接子 task + 最近调用与事件 |
| `lush task result TASK_ID`（RPC `task.result`） | 结论（未结束时 `finished: false`） |
| `lush task wait TASK_ID`（RPC `task.wait`） | 阻塞到该 task 进入终态 |
| `lush task cancel TASK_ID`（RPC `task.cancel`） | 取消 task 及其整棵子树（中断正在跑的 agent） |
| `lush task complete TASK_ID [--result JSON]`（RPC `task.complete`） | 目标达成时结束 task 并写入 result |
| `lush task spawn PID --goal G [--parent-task-id T]`（RPC `task.spawn`） | 直接派一个 task（agent 的工具 `task_spawn` 的命令行等价物） |
| `lush task update-state TASK_ID --patch JSON`（RPC `task.update_state`） | 合并这个 task 的草稿 state |
| `lush task history TASK_ID [--after ID] [--limit N]`（RPC `task.history`） | 该 task 自己的对话 |
| `lush task session TASK_ID [--open]`（RPC `task.session`） | 该 task agent 的磁盘会话；`--open` / `lush task attach` 进入 pi TUI |
| `lush task delete TASK_ID [--recursive]`（RPC `task.delete`） | 删除已结束的 task 记录（call 行与消息保留为 process 的历史） |
| `lush task agents list\|show\|kill`（RPC `task.agents_*`） | 运行期 agent（`TASK.N`） |

## 孤儿收养

一个 process 进入终态（`stopped`）时，它的 **created / active 直接子节点**的 `parent_pid` 改成 0，保留 `original_parent_pid` 并记 `reparented` 事件。已结束的子节点仍属于原父节点，孙节点不变。收养后 PID 0 按下面的策略监督它们。

收养本身可配置（`LUSH_ORPHAN_ADOPT`）：

- `adopt`（默认）：如上收养。
- `none`：不收养也不终止，子节点留在终态父节点下（这类节点不是孤儿，PID 0 不监督）。
- `terminate`：活动直接子节点随父一起冻结（一律 → `stopped`），不收养；每个被冻结的子节点再走同一策略，于是沿活动链一路冻结。

## PID 0 的孤儿监督

孤儿 = `parent_pid = 0 AND pid > 0 AND original_parent_pid NOT IN (NULL, 0)`。

| 环境变量 | 取值 | 默认 | 含义 |
| --- | --- | --- | --- |
| `LUSH_ORPHAN_ADOPT` | `adopt` / `none` / `terminate` | `adopt` | 父节点终态时对活动直接子节点的处理 |
| `LUSH_ORPHAN_LIMIT` | 整数 ≥ 0 | `0`（不限） | PID 0 下活动孤儿的上限，超出时从最旧开始冻结 |
| `LUSH_ORPHAN_TTL` | 秒数 ≥ 0（可小数） | `0`（不启用） | 闲置超过该秒数的孤儿被冻结 |
| `LUSH_ORPHAN_SWEEP` | 整数秒 ≥ 0 | `30` | daemon 定时跑一轮；`0` = 不起定时器 |

- **回收是冻结，不是删除**：孤儿一律 → `stopped`，它手上的活动 task 会被**取消**（节点都停了，agent 不该继续跑）。metadata、Context、task、消息、调用与事件全部保留。
- **busy 永不回收**：该 PID 有正在跑的 agent 时不会被冻结，只出现在本轮报告的 `deferred` 里。
- **闲置**：`last_activity_at = max(updated_at, 最近一条 message 的时间, 最近一次调用的开始/结束)`。
- **顺序**：先 TTL，后上限；每冻结一个都重查孤儿池（冻结父节点会把它自己的子节点交成新孤儿）。收养发生且 `limit > 0` 时事务后立刻跑一轮（`trigger = adoption`）。
- **痕迹**：被冻结的孤儿其 `transition` 事件带 `cause`（`orphan_ttl` / `orphan_limit`）；`terminate` 模式下被父节点连带的子节点 `cause` 是 `parent_terminated`。
- 父进程被 `delete` 后，幸存节点的 `original_parent_pid` 改挂 0，因此不再算孤儿、不再被监督。

## 删除

`reclaim` 不存在了：**删除就是唯一的物理删除路径**。

| 命令 | 接受的节点 | 行为 |
| --- | --- | --- |
| `process delete PID [--recursive]` | `stopped` 且没有活动 task 的进程 | 删掉该 PID 的 `processes`、`contexts`、挂载在它上面的 `tasks`（含 `task_events`）、`messages`、`agent_calls`、`process_events`；`active` / `created` 或还有活动 task 时拒绝（-32010），提示先 stop / cancel，或改用 purge |
| `process purge PID [--recursive]` | 任何非 PID 0 的进程 | 先取消子树里活动的 task（中断 agent），把活动进程置为 `stopped`，再按 delete 的规则删除；回包 `cancelled` / `terminated` / `deleted` / `rows` |
| `task delete TASK_ID [--recursive]` | 已结束的 task | 删除 task 行与它的事件；`agent_calls` / `messages` 保留（`task_id` 置 NULL，作为 process 的历史）。有活动 task 时拒绝，有子 task 时要求 `--recursive` |

- PID 0 永远拒绝（-32010）。
- 有子进程时没有 `--recursive` 会拒绝；`purge --recursive` 不收养（整棵子树都要没了）。
- 子 task 若挂在别的进程上（父 task 被删），会变成根 task 继续存在。
- 删除根节点的父进程（若还在）会记一条 `child_deleted` 事件；被删节点自己的事件随它消失。

## ProcessTemplate

模板描述**一种进程**（被动节点）。JSON 文件字段固定为七项，缺一或多一都报错：

```json
{
  "name": "coding-node",
  "singleton": false,
  "description": "完成编码目标的节点",
  "spawn_prompt": "创建编码节点：process_spawn {template: \"coding-node\", name: <短名，必填>, goal: <目标，可选>}；建完用 task spawn 把活派给它。",
  "system_prompt": "你是编码节点。收到 task 后先用真实命令把事情做完，再 task_complete 写清改了什么、怎么验证的。",
  "child_templates": ["generic-task", "generic-service"],
  "variables": {
    "immutable": {
      "repo": { "required": true, "description": "代码仓库根目录（绝对路径，同时是 task 的 cwd）" }
    },
    "mutable": {
      "branch": { "default": "main", "description": "当前工作分支，可用 update-vars 修改" }
    }
  }
}
```

- `name`：模板名，也是 `process.spawn` / `lush process spawn` 的 template 参数。
- `singleton`：`true` 时同一个父 PID 下最多一个活动实例；实例停止后名额释放。
- `description`：一句话用途，出现在创建方的 `available_child_templates`。
- `spawn_prompt`：告诉创建方「怎么创建这个模板、需要哪些变量」，随 Context 注入创建方 agent。
- `system_prompt`：实例创建时快照进它自己的 Context，成为它上面每个 task 的 agent 的第一条 system message。
- `child_templates`：该实例允许创建的子模板（相对自己文件的路径，或模板名；`*` 表示全部）。
- `variables`：变量声明，分 `immutable` / `mutable`；每个变量有 `description`（必填）与可选 `required` / `default` / `pattern` / `max_length` / `single_line`。

模板按层级顺序加载（能创建某个模板的模板排在它前面），`available_child_templates` 也是这个顺序。`$LUSH_HOME/templates/**/*.json` 可以加用户模板，重启后生效。

### 保留变量名

| 名字 | 含义 |
| --- | --- |
| `path` | 工作目录：必须存在、必须是绝对路径、只能 immutable；它同时是该节点上所有 task 的 cwd |
| `name` | 进程名：`--name` 与 `variables.name` 是同一个值，格式按声明校验 |
| `title` / `detail` | 节点的一行摘要与详情正文，`process list` / `tree` / `inspect` 会渲染 |

## Agent 后端

Task 的 agent 由这个 process 选中的 agent profile 决定（`process spawn --agent`、模板的可选 `agent` 字段、环境变量、内置 `default`，依次生效）：

- `pi`（默认）：每次 invocation 起一个 `pi --print` 子进程，session-id 是 `lush-task-<id>`。pi 用 read / bash / edit / write 自己的工具，并通过 bash 调 `lush` CLI 操作 Lush（`LUSH_PID` / `LUSH_TASK_ID` 告诉它自己是谁）。取消 invocation 会杀掉子进程。
- `mock` / `openai`：内置运行时，agent 直接拿到 `task_*` / `process_*` 工具，共享说明层切到 tools 版本。

共享说明层（`src/agent/guide.js`）和后端无关：它告诉每个 agent「你是某个 task 的 agent，process 是被动节点；向下游派 task，用 task_wait 收集，子 task 未结束不能 complete；先判断这活归谁再动手」。tools 与 cli 两种模式共用同一份「通用规则」文本。

## Agent 和 Context

Context 持久化保存 system_prompt、state、artifacts、references、messages（按 task 划分）。每次 invocation 的 `LUSH_CONTEXT` 数据里既有 `process`（身份、变量、子进程、可创建模板），也有 `task`（自己的 id / goal / status / result / 父 task）与 `children`（进程）。父信息和 children 每次构建时从当前树读取，不是持久副本。
