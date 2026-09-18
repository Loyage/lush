# 生命周期与孤儿监督

> 概念层：一个节点的寿命怎么走完，以及它结束后留下的人归谁管。

## 孤儿收养

一个 service 进入终态（`stopped`）时，它的 **created / active 直接子节点**的 `parent_sid` 改成 0，保留 `original_parent_sid` 并记 `reparented` 事件。已结束的子节点仍属于原父节点，孙节点不变。收养后 SID 0 按下面的策略监督它们。

收养本身可配置（`LUSH_ORPHAN_ADOPT`）：

- `adopt`（默认）：如上收养。
- `none`：不收养也不终止，子节点留在终态父节点下（这类节点不是孤儿，SID 0 不监督）。
- `terminate`：活动直接子节点随父一起冻结（一律 → `stopped`），不收养；每个被冻结的子节点再走同一策略，于是沿活动链一路冻结。

## SID 0 的孤儿监督

孤儿 = `parent_sid = 0 AND sid > 0 AND original_parent_sid NOT IN (NULL, 0)`。

| 环境变量 | 取值 | 默认 | 含义 |
| --- | --- | --- | --- |
| `LUSH_ORPHAN_ADOPT` | `adopt` / `none` / `terminate` | `adopt` | 父节点终态时对活动直接子节点的处理 |
| `LUSH_ORPHAN_LIMIT` | 整数 ≥ 0 | `0`（不限） | SID 0 下活动孤儿的上限，超出时从最旧开始冻结 |
| `LUSH_ORPHAN_TTL` | 秒数 ≥ 0（可小数） | `0`（不启用） | 闲置超过该秒数的孤儿被冻结 |
| `LUSH_ORPHAN_SWEEP` | 整数秒 ≥ 0 | `30` | daemon 定时跑一轮；`0` = 不起定时器 |

- **回收是冻结，不是删除**：孤儿一律 → `stopped`，它手上的活动 task 会被**取消**（节点都停了，agent 不该继续跑）。metadata、Context、task、消息、调用与事件全部保留。
- **busy 永不回收**：该 SID 有正在跑的 agent 时不会被冻结，只出现在本轮报告的 `deferred` 里。
- **闲置**：`last_activity_at = max(updated_at, 最近一条 message 的时间, 最近一次调用的开始/结束)`。
- **顺序**：先 TTL，后上限；每冻结一个都重查孤儿池（冻结父节点会把它自己的子节点交成新孤儿）。收养发生且 `limit > 0` 时事务后立刻跑一轮（`trigger = adoption`）。
- **痕迹**：被冻结的孤儿其 `transition` 事件带 `cause`（`orphan_ttl` / `orphan_limit`）；`terminate` 模式下被父节点连带的子节点 `cause` 是 `parent_terminated`。
- 父服务被 `delete` 后，幸存节点的 `original_parent_sid` 改挂 0，因此不再算孤儿、不再被监督。

## 删除

`reclaim` 不存在了：**删除就是唯一的物理删除路径**。

| 命令 | 接受的节点 | 行为 |
| --- | --- | --- |
| `service delete SID [--recursive]` | `stopped` 且没有活动 task 的服务 | 删掉该 SID 的 `services`、`contexts`、挂载在它上面的 `tasks`（含 `task_events`）、`messages`、`agent_calls`、`service_events`；`active` / `created` 或还有活动 task 时拒绝（-32010），提示先 stop / cancel，或改用 purge |
| `service purge SID [--recursive]` | 任何非 SID 0 的服务 | 先取消子树里活动的 task（中断 agent），把活动服务置为 `stopped`，再按 delete 的规则删除；回包 `cancelled` / `terminated` / `deleted` / `rows` |
| `task delete TASK_ID [--recursive]` | 已结束的 task | 删除 task 行与它的事件；`agent_calls` / `messages` 保留（`task_id` 置 NULL，作为 service 的历史）。有活动 task 时拒绝，有子 task 时要求 `--recursive` |

- SID 0 永远拒绝（-32010）。
- 有子服务时没有 `--recursive` 会拒绝；`purge --recursive` 不收养（整棵子树都要没了）。
- 子 task 若挂在别的服务上（父 task 被删），会变成根 task 继续存在。
- 删除根节点的父服务（若还在）会记一条 `child_deleted` 事件；被删节点自己的事件随它消失。
