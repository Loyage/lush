# 计划审批闸门（可选）

本文件管 `plan.propose` / `plan.approve` / `plan.reject` 的全部规则与权限。

planner 判断「影响面大（改架构/公共接口/数据模型/现有行为）」「与已有任务或设计冲突」「没把握完全读懂意图」之一时，可以在写完之后 `plan.propose`（`lush plan propose '标题' --body '…'`）：把 `plan_gate` 置为 `proposed` 并在自己身上开一条 `kind='plan'` 的 notice。`nextSpecPlanner()` 跳过 `proposed` 的条目，所以这一批 spec 会一直待在队列里，直到：

- **批准**（`plan.approve` / Web「批准并开发」）：闸门置 `approved`，notice 关掉，planner 本轮就此结束（计划已定），下一次 `pump` 把这批交给 scheduler。
- **驳回**（`plan.reject` + 理由）：闸门置 `rejected`，本轮 pending spec 全部标 `dropped`，理由作为消息送进 planner 收件箱并唤醒它重拆；下一轮 invocation 开头清掉闸门（要不要再申请批准由它自己判）。

`plan.propose` 是 agent（planner）专属，`plan.approve` / `plan.reject` 是用户专属；plan notice 不能用 `notice.answer` 回答（会报错并指向这两个命令），否则就绕过了闸门。不申请批准的拆解照旧直接进 scheduler。
