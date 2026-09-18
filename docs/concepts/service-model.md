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

  - `spawn` 原子创建并进入 `active`（`created` → `active` 记在同一事务里）。
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
- `waiting`：agent 正在等自己的子 task（`task_wait`，或先回答后被自动唤醒）。
- `completed` / `failed` / `cancelled`：终态。

规则（这些规则保证 task 树始终是一棵可观察的树）：

1. **一个 service 同时只有一个活动 task**：service 是单线程的工作台。下游正忙时 `task_spawn` 会被拒绝；先 `task_wait` 它，或换一个下游节点。
2. **子 task 只能挂在自己的直接子 service 上**：task 树因此永远沿 service 树向下生长，不会成环，`task_wait` 也不可能死锁。
3. **终态 task 没有活动子 task**：`complete` 要求子 task 都已结束（否则报错，让你先 wait / cancel）；`fail` / `cancel` 会把整棵子树一起取消。
4. **`task_wait` 只接受自己树里的 task**（自己的子 task 或它们的后代），不能等自己。
5. 需要新的下游节点时先 `service_spawn`（受 `child_templates` 限制）建子服务，再向它派 task。

### agent 与 task

- 每个 task 有**自己的 agent 会话**：`agent_calls` / `messages` 都带 `task_id`，pi 的 session-id 是 `lush-task-<id>`（外部 agent 的环境里有 `LUSH_SID` 与 `LUSH_TASK_ID`）。
- 运行期 agent 的编号是 `TASK.N`（N 是本次 daemon 内该 task 的第几个 agent），见 `lush task agents list|show|kill`。`kill` 会取消它服务的 task——被强杀的 agent 没有答案可记。
- 一个 task 最多被 invoke `LUSH_TASK_CALLS` 次（默认 12）：首次运行 + 每次「子 task 结束后被唤醒」。超了就把 task 记为 `failed`，避免无限自旋。
- 如果 agent 先给出了回答、但子 task 还在跑，运行期把 task 置为 `waiting`，等子 task 结束再用一条 `[Lush] 你的子 task 已经结束：…` 的消息唤醒它继续收尾（这条消息是 task 自己对话里的一条 user message）。等子 task 期间不吃调用超时。
- provider 失败、调用超时、轮数用尽 → task `failed`（`error` 里是原因）；daemon 重启时未结束的 task 记为 `failed`（`error = daemon restarted`），不会自动重放。

## 相关文档

每个 task 有自己的 agent 后端与 Context；见 [agents.md](./agents.md)。
孤儿收养、监督与删除见 [lifecycle-and-orphans.md](./lifecycle-and-orphans.md)；命令总览见 [reference/cli.md](../reference/cli.md)。
