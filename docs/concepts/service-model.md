# Service 与 Task 模型

> 概念层：Lush 里有什么、它们的不变量是什么。接口细节见 [reference/](../reference/)（命令、RPC、模板字段），模块划分见 [engineering/architecture.md](../engineering/architecture.md)。

Lush 里只有两类东西：

- **Service** 是被动的节点：身份（模板的 `system_prompt`）、父子关系、变量、持久 state、权限（能创建哪些子模板）。它自己**不会运行任何 agent**，平时只保存状态；节点本身也没有「完成」这回事。
- **Task** 是一次工作，挂在某个 service 上。只有 task 有自己的 agent、自己的会话、自己的 result。用户在一个 service 上 `call` 就创建了一个 **根 task**；这个 task 的 agent 要干活，就向自己的**下游**（子 service）派**子 task**，于是形成一棵 task 树——`lush task tree` 看到的就是「一件事如何在服务之间协作做完」。

```text
lush call 2 '实现登录'         → task #1 挂在 implement-login[2]
  task #1 的 agent（在 [2]）派活
    └── task #2 挂在 dev-task[3]        （[3] 是 [2] 的子服务）
          └── task #3 挂在 worktree-service[4] （真正动手改代码的叶子）
```

## Service（被动节点）

字段：`sid`、`parent_sid`、`original_parent_sid`、`children`（反查）、`status`、`name`、`goal`、`template` 快照、`variables`（值 + 模板声明）、`context`（system_prompt / state / artifacts / references）。

- `ServiceManager.load(sid)` 返回轻量句柄 `Service`：`inspect()`、`getParent()`、`getChildren()`、`createChild(template, {...})`、`call(goal)`（= 在它上面开一个根 task）。
- 生命周期只有三态：

```text
created → active ⇄ stopped
```

  - `construct` 原子创建并进入 `active`（`created` → `active` 记在同一事务里）。
  - `stop`：置为 `stopped`。它的**活动子节点**交给 SID 0 收养（`parent_sid = 0`，保留 `original_parent_sid`）。同一个节点上还有活动 task 时 `stop` 会被拒绝（提示先 `task cancel`）——停止一个节点不能悄悄杀掉正在跑的 agent。
  - `start`：`stopped` / `created` → `active`；重启不会自动取回已被收养的子节点。
  - `delete` / `purge` 见下节「删除」。
- **权限**：创建子服务的模板必须来自该服务创建时快照的 `child_templates`（`*` 表示全部）。这是唯一的能力边界，和 task 无关。
- **SID 0**（`lush-root`，`singleton`）是入口、路由器与孤儿管理者；它只能创建 `project-manager`，不能 stop / delete / purge，其生命周期由 daemon 管理。

## Task（工作单元）

字段：`id`、`sid`（挂载的 service）、`parent_task_id`、`root_task_id`、`goal`、`status`、`result`、`error`、`state`（这一次工作的草稿）、`created_at` / `started_at` / `finished_at`。

```text
created → running ⇄ waiting → completed / failed / cancelled
```

- `created`：行已建、agent 还没开始（交互式交接会停在这里）。
- `running`：它的 agent 正在跑（一次 invocation）。
- `waiting`：task 已让出本次运行，agent 不在跑——它在等子 task 或等输入（父 / 子 task 的消息）；有东西进收件箱时被唤醒。
- `completed` / `failed` / `cancelled`：终态。

规则（这些规则保证 task 树始终是一棵可观察的树）：

1. **一个 service 同时只有一个活动 task**：service 是单线程的工作台。下游正忙时 `task_construct` 会被拒绝；先结束本轮等它（子结算会唤醒你），或换一个下游节点。
2. **子 task 只能挂在自己的直接子 service 上**：task 树因此永远沿 service 树向下生长，不会成环；消息也只能走直接父子边，所以通话关系同样不会成环。
3. **终态 task 没有活动子 task**：`complete` 要求子 task 都已结束且收件箱没有未读消息（否则报错）；`fail` / `cancel` 会把整棵子树一起取消。
4. **阻塞在 task 上，不在 agent 里**：agent 的工具里没有“等待”原语。结束一輪 invocation 后，task 层决定“投递队列里 的输入 / park 等输入 / 完成”。
5. 需要新的下游节点时先 `service_construct`（受 `child_templates` 限制）建子服务，再向它派 task。

### agent 与 task

- 每个 task 有**自己的 agent 会话**：`agent_calls` / `messages` 都带 `task_id`，pi 的 session-id 是 `lush-task-<id>`（外部 agent 的环境里有 `LUSH_SID` 与 `LUSH_TASK_ID`）。
- 运行期 agent 的编号是 `TASK.N`（N 是本次 daemon 内该 task 的第几个 agent），见 `lush task agents list|show|kill`。`kill` 会取消它服务的 task——被强杀的 agent 没有答案可记。
- 一个 task 最多被 invoke `LUSH_TASK_CALLS` 次（默认 12）：首次运行 + 每次被唤醒（子 task 结算、收到消息）。超了就把 task 记为 `failed`，避免无限自旋。
- 一輪 invocation 结束后 task 层按顺序判断：收件箱有未读输入 → 合成一条 user 消息（`[Lush] 你有新的输入：…`）重新 invoke；无输入但有活动子 task → 置 `waiting`、等输入再唤醒；都没 → 本次回答就是 result。park 期间不吃调用超时。
- 收件箱（`task_inbox`）里的输入只有两种：直接父 / 子 task 发来的消息（`task_message`），或“某个子 task 已结算”的报告；**都不打断正在跑的 invocation**，在两次 invocation 之间才交给 agent。
- provider 失败、调用超时、轮数用尽 → task `failed`（`error` 里是原因）；daemon 重启时未结束的 task 记为 `failed`（`error = daemon restarted`），不会自动重放。

### 任务之间：持续通话（task_inbox）

`task_construct` 只能派一次性 goal；之后的交流走收件箱：

- **只走 task 树的直接边**：一个 task 只能给它的直接父 task 或它的直接子 task 发消息（`task_message`），和“只能向下游、直接子 service”同一条边界。
- **异步、入队**：消息先落到接收方的 `task_inbox` 行（`delivered_at IS NULL`），在它两次 agent invocation 之间才交给它的 agent——正在跑的 invocation 不会被打断。接收方停在 `waiting` 时会被立即唤醒。
- **子 settlement 也是输入**：子 task 进入终态时，task 层向父 task 的收件箱写一条 `child_settled`，父被唤醒并带上子 task 的状态与 result。所以“父等子、子报父”和“父子互发消息”是同一条队列、同一套唤醒语义。
- **完成要求收件箱已清空**：有未读输入时 `task_complete` 会被拒绝；结束本轮，输入会在下一次 invocation 前交给你。
- 读模型：`lush task inbox TASK_ID`（/ RPC `task.inbox`）；发：`task_message` 工具 或 `lush task message TASK_ID --body '...'`（RPC `task.message`）。
- 代价：`waiting` 只由“有活动子 task 或收到输入”触发，一个既无子 task 又无输入的任务会直接完成；它不提供“原地等回信”的阻塞原语（需要回信就保持有未结束的子 task / 依赖用户 notice）。

### Notice（task 找人的渠道）

Task 的下游是子 service，但有些事情没有下游——自己处理不了、只有人能决定，或结果必须交给用户。这时 agent 用 `notice` 上报：

- 一条 notice 记录**汇报者身份**（`task_id` + 它所在 service）、`kind`（`report` / `decision` / `blocked`）、`title` / `body`，以及它声明要用户填的 `fields` 表单；用户填的那份存在 `answer` 里。
- `wait: true`（默认）时上报的 task 进入 **`waiting`**（暂停调用超时），直到用户 `answer` 或 `dismiss`，填好的值作为 `notice` 工具的返回值交给 agent；`wait: false` 只登记不阻塞，适合不需回复的结果汇报。
- notice **不超时**：无人处理就一直 `open`，直到用户处理，或上报它的 task 被 cancel / fail（那时未决 notice 会被一并 `dismiss`，note 里写清原因）。已 `completed` 的 task 的未决 notice 保留，因为那是留给人读的结果。
- 用户侧的入口是 `lush notice list|show|answer|dismiss`、Web UI 的 Notice 页与 `just notices`；agent 侧分两条路：内置运行时（mock / openai）用 `notice` 工具，外部 agent（pi）用 `lush notice post`（RPC `notice.post`），两者都默认阻塞到用户结算并把结果交回 agent。

## 相关文档

每个 task 有自己的 agent 后端与 Context；见 [agents.md](./agents.md)。
孤儿收养、监督与删除见 [lifecycle-and-orphans.md](./lifecycle-and-orphans.md)；命令总览见 [reference/cli.md](../reference/cli.md)。
