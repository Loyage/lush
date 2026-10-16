# Run、invocation 与多级协作

本文说明每次 provider 调用与持久 Worker 的边界。新指令与历史遗留 Worker 共用同一套 Run 记录；旧 WorkItem 只是兼容读模型。

## Worker 与 Run

每次真实 provider 调用都会先写 `agent_runs`：

```text
WorkItem #42
├── Run #80（failed）
├── Run #81（completed，等待用户答复）
└── Run #85（completed，最终结果）
```

Worker 的累计 calls / wakes 继续用于兼容读模型，Run 保存每次调用自己的 attempt、provider、时间、result 与 error。成功输出同时形成 `run.result` Artifact。

## 一次 invocation

1. Dispatcher 按Worker就绪状态与相应 lane 的容量选择 queued Worker。
2. `running` Map 占位，签发本次 invocation token，创建 `agent_runs` 行。
3. 准备 cwd：指令 / child 使用独立 worktree；解分歧 Worker 使用从固定提交拉起的独立 worktree；旧记录里可能还有输入 worktree 或对照检出。
4. 读取启动时未消费消息、相关工作与 Artifact 上下文；对带 Input 的普通Worker读取其引用快照并按稳定目标解析本轮最新状态，组成 `referenced_context`。provider 按 role 组合命名 Prompt 片段，叠加 `agent.json`、项目/本机补充并热加载公共/角色 env 后启动 Pi 或 Codex。共享 runtime 片段明确 cwd（专属 worktree）是唯一可写副本：禁止 `cd` 到 canonical 项目目录或在 main/父分支上直接提交，并在提交前核对当前分支；越界提交仍由调度器的目标分支防护事后判失败（见[模块](modules.md)）。
5. 成功返回后消费启动时消息，保存 Worker 兼容 result、结束 Run、写 Artifact。
6. 判定未读消息、Decision、活动子Worker与工作区提交，进入 queued / awaiting / waiting / completed。
7. 释放 token 和槽，再检查一次收件箱避免 lost wake-up。

失败或取消会结束对应 Run；崩溃恢复不重放未知副作用。

结构化问卷是正常返回之外的主动暂停路径：`notice.post` 带 `questions` 时，同一事务保存 notice、消费本轮已交付消息、记一条 `invocation.completed {suspended:true}` 并设置 awaiting；提交后中止进程组。本轮不执行 worker finish、不标失败。调度器的 `questionPending` 闸门阻止普通消息和子Worker结果提前唤醒；答复/忽略落收件箱后，在旧 invocation 清理完毕时重新排队，防止 lost-wakeup。已暂停 Worker 在关闭/重启时保留 awaiting，而不是把主动暂停当异常失败。详见[待决问题](../reference/rpc/notices.md)。

waiting / awaiting / paused 不占 agent 槽，也不运行 sleep/poll 子进程。最终输出是 Worker result；不提供可被 agent 提前调用的 complete 命令。

## 生命周期观察事件（version 1）

新写入的 `invocation.started` 带精确 `run_id` 和兼容累计 `call`；主动问卷暂停的 `invocation.completed` 也带本次 `run_id`。`started` 仅证明已进入启动准备，实际输入交付仍以同 Run 的 `invocation.inputs_delivered` 为准，不把准备失败说成模型已收到输入。

`invocation.started.input_sources` 是本次所选消息批次的有界来源快照（最多 50 项），`source_scope:'delivered_batch'`，不是唯一唤醒者或调用原因。`message_ids` 仍列出所选消息，`input_sources_truncated` 明示超过来源快照上限。每项包含：

```js
{ message_id: 12, source: 'user', // user | worker | system | unknown
  sender_id: null, sender_worker_number: null,
  notice_id: 3, notice_kind: 'questionnaire', evidence_event_id: 45 }
```

只有同 Worker、精确 `message_id` 的运行事实才能证明来源：普通 `message` 事件的匹配 sender／显式 `user_append:true`，或匹配 Message 类型与 key 的 `task.signal`、精确 child 收据。typed runtime 信号归 `system`，不把 child 自动成功收据冒充 child Agent 亲自发言。`notice.answered` 新增同事务写入的 `message_id` 与 `notice_kind`；通过同 Worker 的 Notice 行和明确 `answer_source:user|lush` 证明用户／系统答复。未知来源保留 `unknown`，`evidence_event_id` 缺省；sender 为空、正文像 JSON、时间相邻均不构成证明，不能从一批交付消息猜唯一发起者。Worker 编号仅用真实持久字段，不从内部 ID 推算。

新建以及 `Store.update` 的状态／调用／集成事实变化，在同一事务记录 `worker.phase_changed`，不影响调度与准入。事件字段：

```js
{ version: 1, from: 'running', to: 'waiting_children',
  from_status: 'running', to_status: 'waiting', reason: 'children_unsettled',
  child_ids: [8], children: [{ id: 8, worker_number: 'W3-1' }],
  notice_ids: [], notices: [], run_id: 22 }
```

`from/to` 是观察阶段，不替代 Worker status；首次创建 `from:'unknown'`。阶段／reason 的固定对应：

| 阶段 | reason／已知边界 |
|---|---|
| `queued` | `admission_unknown`，不推断容量、冻结或哪一个具体门 |
| `running` | `invocation`，Run 已持久创建；不等于 Provider 已交付输入 |
| `waiting_notice` | `questionnaire`（有问卷）或 `notice`，保留当时 open Notice 的 ID/kind |
| `waiting_children` | `children_unsettled`，保留当时未结算直接 child 的 ID/真实编号 |
| `idle` | `unknown`，waiting 且没有已知 Notice/未结算 child；可能仍有交付预约，不宣称交付就绪或必在等用户 |
| `awaiting_acceptance` / `paused` / `completed` / `failed` / `cancelled` | reason 与阶段同名，仅表示真实行状态，不代替验收／交付证明 |
| `unknown` | `unknown`，不足以分类（如 awaiting 但没有已知等待对象） |

等待对象由转换事务内的真实行快照确定，不用后来的 child／Notice 状态倒推。child 结算复用 `isSettled`：终态，或满足既有集成条件的 awaiting_acceptance；不能把所有 awaiting_acceptance 当结算。child 状态／integration 写入和新 child 创建也在同事务刷新等待中的直接父观察；Notice 打开／答复同样刷新。相同 status 的等待对象或 reason 变化可产生新边界，完全相同的观察只写一次；普通 result、心跳、配置、预约写入和历史读取不制造边界。预约不在观察层解析，不变更消息消费、冻结或交付行为。

`run_id` 通过同 Worker 当前 calls 对应的持久 Run 精确关联；无此行则为 null，不按相邻时间猜测。事件时间只定义本次观察边界，不能推算首条事件之前的阶段起点。历史缺少事件／来源的区间保持未知，不迁移、不回填。`history_page`／`reading_page` 沿用现有安全、有界事件投影；大量来源或等待对象可能触发 `event_metadata_bounded`，完整安全正文仍可经既有 `reading_record` 续读，不能把有界缺项当作没有等待对象。只记录身份、枚举与对象快照，不复制配置、Prompt 或凭证。

## 两条 admission lane

- control：planner 和兼容历史 scheduler，容量默认 `LUSH_CONTROL_CONCURRENCY`（2）；
- execution：worker / coordinator / research / verifier / merger，容量默认 `LUSH_CONCURRENCY`（8）。

两条 lane 独立计数。容量是可在运行时改写的项目级设置（`<home>/settings.json` 覆盖环境默认值，Web「设置 → 系统」与 `lush config` 可改）；写盘后同步内存并重新 pump，下一次调度立即按新生效值准入，不需要重启 daemon。waiting / awaiting / paused / 依赖未满足的 queued 不占槽。

## 协作与集成

新指令 / child Agent 可以派子Worker；普通成功收据在本波直接子Worker全部终态后合并唤醒，失败、取消和显式消息仍及时可调度，详见[合并唤醒](token-efficiency.md#父Worker合并唤醒)。Agent 派出的 child 在创建时默认预约合入直接父 Worker；轮末安全结束、消息已处理、后代已结算且工作区干净后，runtime 在真实安全点固定源提交并交给父 Worker 自有队列串行 Squash，不创建 merge Worker、不改父子关系，不额外调用父 Agent 或要求手动集成。干净且无新提交的 child 直接交付结果、进入 awaiting_acceptance 等父确认。成功收据等本波子Worker全部结算再唤醒父 Agent，避免父 Agent 与队列争用分支。用户直接创建的指令仍由用户决定何时预约合并（含进入 main/owner）；取得父执行位后才固定父基线；分歧退回原 Worker 合入固定父提交、保留原源提交并测试，修复期间保留父执行位。挂起释放，恢复重新排队并固定新基线。旧 version 1 请求继续保留原来的手动确认边界，旧 version 2 merge 身份与在途重挂仅按明确预约／审计兼容恢复；见[分支合并](merge.md)。
