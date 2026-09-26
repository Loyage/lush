# Task 图与输入规则（增量实现）

Task 图是 `#task-graph` / `task.graph` / `/api/task-graph` 的有界读面：节点是 Task（含 main、owner、旧任务），边是不可变的 `parent_id`。卡片显示目标摘要、Agent 类型、分支合并状态（`integration`：待合并 / 已合并 / 合并中等，与任务详情同源，做成首行标签）、工作/静息与冻结原因、结果预览、计划进度、子 Task 数、分支/worktree、当前 HEAD、已提交与未提交诊断、交付预约与就地待决；say 交付操作复用任务详情，普通问答/计划审批复用分支图同一处理按钮，问卷跳到任务详情按完整选项作答。点标题看完整任务详情；解分歧 Task 用父子边挂在负责集成的活动 Task 下，另以「正在解决 Task #ID」链接被修复的历史 Task，不能把后者的终态/父子身份改掉。最多返回 200 条，优先保留分支所有者和活动任务；找不到父节点时画为根并说明截断。诊断/正文未知时明示不可用或截断，不能当作零。旧 `#graph` / `graph.get` 完整保留 Git 谱系、诊断、归档与合并操作，两种图不共用边的语义。

## Task 作为主要对象

卡片用状态配色一眼区分「在跑」与「停下来」：running 有活动色的呼吸外环，其余按真实状态各给一边框色（排队 / 在等 / 待你决定 / 已完成 / 失败 / 已取消），只有既非活动又无明确终结语义的才落到中性 idle；表头汇总行用同一套状态色把各状态计数排成兼作说明的图例。

合并编排已集成到 Task 卡片上：`task.graph` 只读投影每条 Task 自己分支下的 say 子分支数（`branch_info.subtree_say`）与仍在跑的合并运行（`branch_info.merge_run`）。有子 say 分支的 Task（含 main / owner）卡片给「编排合并全部子 Task」入口，点击先拉同一份只读 `branch.orchestrate_plan`，在确认框里列出固定提交、动作与阻塞，确认后调 `branch.orchestrate`；运行中改显进度与「取消合并编排」。目标就是这条 Task 自己的分支，复用分支图同一套 runtime 与冻结语义，前端不另算一套合并规则。delivery 冻结（有待集成的合并请求）正是编排要收拢的对象，不挡入口；别的 merger / 一键合并造成的冻结才禁用并写明原因。分支归档仍在原分支图。

## 新 Task 的输入处理

新 say 创建时，从其父分支**已提交的 fork commit** 读取 `.lush-task/input.mjs`（若存在），冻结为 `<project>/.lush/task-rules/task-<id>.mjs`。子 Task 继承直接父 Task 的固定快照；没有规则就使用内置默认规则。不会读取之后修改的 worktree 文件，也不会自动覆盖已创建 Task 的规则。归档分支不会删除此快照。文件上限 16 KiB；提交的规则太大时拒绝创建新 say，不静默忽略。

程序是可信的仓库代码，**以 daemon 用户权限执行**，可访问磁盘/网络；仅从执行环境里去掉 Agent token / LUSH_* 凭证，不能把它当作安全沙箱。输入通过 stdin 的一行 JSON：`{version:1,task:{id,status,task_kind,branch},input:"..."}`；stdout 应输出一份 JSON：`{"delivery":"message"}` 或 `{"delivery":"interrupt"}`。例如：

```js
const { input } = await Bun.stdin.json();
console.log(JSON.stringify({ delivery: input.startsWith('稍后') ? 'message' : 'interrupt' }));
```

每次提交到 say / child Task 的用户消息执行一次固定规则（限时 1s、stdout/stderr 最多 16 KiB），不传一次性 Agent 凭证。规则返回 `message` 时只写入收件箱、轮末交付；返回 `interrupt` 时先写入收件箱，再请求**有安全边界的后端**在安全点软抢占；不支持安全抢占的后端轮末交付，**绝不硬杀**。规则失败或输出无效：记录 `task.input_routed` 错误并回退 `interrupt`，输入仍持久化、不丢失。Agent 发来的消息不执行用户输入规则。无规则的新 say 保持现有安全抢占行为。

## 尚未完成的整体迁移

本次新增的读面与规则不改变旧 `input.submit` / `draft.commit`、旧 planner/scheduler 的调用与旧任务的写入能力；旧数据目前**还未变成只读**。规则也尚未作用于 `say.submit` 创建时的初始 goal、notice 答复与非 say/child Task。若要满足“唯一 Task 调度入口，旧数据只读”，必须在用户入口、RPC 权限、恢复与调度器中一起做版本分流，并为旧数据提供不改写原记录的读取/退出方式；不能只隐藏旧 Web 控件就称为重构完成。
