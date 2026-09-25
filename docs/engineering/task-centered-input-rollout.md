# Task 中心输入架构：实施与验收（分段实施中）

本文把[目标设计](task-centered-input-design.md)拆为可逐步验证的接缝；**未标完成的部分不是当前接口或功能承诺**。实施时先更新[模块地图](modules.md)及相应细表，再改源码和现行工程/接口文档；不得把待实施目标伪装成当前行为。

## 新旧协议并存

- 存储层以新增且有默认值的版本/模式标识区分旧 Task 与新 Task。打开旧库不得重写 Input、旧角色、Task、Candidate、事件、草稿或分支；旧记录继续按旧读模型展示并允许安全收尾。新 say 的 `inputs.task_id` 指向新 Task，旧 Input 的指针含义不变。
- main Task 仅在本地 `refs/heads/main` 存在、项目身份确认且绑定无歧义时幂等创建/恢复。绝不自动创建/重命名用户的 main ref，绝不重用历史 worker 充当 main。项目缺少 main 或旧分支未绑定时，给出明确的绑定/修复指引，而不是猜测父节点。新分支绑定与任务创建写入审计事件，并拒绝多个新 Task 同时声称拥有同一分支。
- 状态与预约使用新 Task 的附属持久字段，Event/Message 记录信号及回执；优先加列/索引而不迁移历史行。协议版本门把旧的 Plan Compiler、快速路由、自动 Intent Integration、Candidate 自动生成与新 Task 分开；旧项目已有 pending spec 和 Candidate 仍可走旧安全收尾流程。
- 新任务从旧任务分支发起前必须显式建立并确认分支所有者绑定；只读查看旧任务不因此改变。保留旧分支及 worktree 的安全门和审阅记录，不自动 reset/clean/删除失败工作区。

## 接口切换面

| 用户意图 | CLI 目标语义 | Web 目标语义 | 后端语义 |
|---|---|---|---|
| 缓存 | `draft add TEXT` | 「存草稿」 | 落草稿与引用，不触发 Git/Agent |
| 直接发送 | `say TEXT [--branch B]` | 「发送」且明确选父分支 | 一条 Input + 一个新 Task + 专属 worktree |
| 发指定草稿 | `say --draft ID [--branch B]` | 草稿行「发送」 | 草稿正文/引用原样成为一条 Input，回写 draft.input_id |
| 查看 | `draft list` / `task inspect ID` | 草稿与任务视图 | 分别显示未提交/运行/静息/待人决定/交付 |
| 预约 | 针对 say Task 设置/撤销 | 展示或合并的互斥控件 | 持久预约 + 结算后幂等调度 |

- `say --draft ID` 与 `say TEXT` 必须互斥；不存在、已发送或空草稿要报错而不能“再发一次”。Web 不再以 `draft.commit` 作为发送按钮内部路径。当前 `say.submit` 是新路径，旧 `draft.commit` / `input.submit` 明确留给历史客户端安全收尾，需在收口阶段审视是否进一步限用；已提交的旧记录不得受影响。
- RPC 输入提交、父 Task 绑定、子 Task 创建、预约与固定提交批准都需要方法白名单、入参校验与 user/agent 权限边界。Agent 只能派自己 Task 的子节点、写自己的进度和受限消息；不能冒用 `say`、绑定 main、替用户批准合并或使用上次 invocation 的 token。
- Web 新增调用 Agent 的发送/展示按钮必须符合[按钮提示规范](../design/ui-guidance.md)：`agent-call` 与 `agentHelp()`；禁用按钮的提示放 `.help-host`。草稿按钮不标成模型调用。输入框中的引用快照、分支显示、网络失败后的正文与草稿都要保留。

## 分阶段施工（每段可独立验收）

1. **事实与边界**：给现有测试建立旧协议兼容基线；列出所有 `planner`、`worker`、`research`、`input_routes` 和 `draft.commit` 的运行时读写点。更新模块地图，补版本化 Task/主分支绑定/预约/信号的存储规则与只读投影；用临时项目验证打开旧库不重写历史。
2. **统一发送**：实现 CLI/Web 的相同 say/draft 动作与一条草稿的一次性提交；先通过 Git 串行边界建分支/worktree，再原子写 Input、Task、草稿关联及引用，失败做安全补偿；一条消息立即发出，不等其它草稿。新任务不进入快速路由或 Plan Compiler。
3. **Task 驱动子任务**：实现基于 Task 的 spawn、分支谱系、固定起点与独立 worktree；用持久信号唤醒父 Task。增加多轮调用/静息、子任务汇总、父确认集成、冲突与重新进入调用的测试；不得复用现有 `task.spawn` 的旧 planner 禁止规则来推断新角色权限。
4. **安全抢占与恢复**：先实现落库、去重、无丢唤醒与自然轮末投递；再在有真实安全点的后端启用抢占（已完成：Pi 的 `turn_end` 边界，用户追加输入时触发）。把抢占与取消/超时分开记录（Run 状态 `preempted`）。daemon 重启仅恢复待投递信号/待处理预约，未知副作用的中断 Run 保留现场并要求复核，绝不自动重放。
5. **预约、main 与展示**：main Task 幂等初始化并按需处理请求；互斥预约及取消、展示子任务的开发完成阶段、请求后源 Task 可终结、固定 commit 用户批准及分支漂移拒绝；既有 showcase 资格与 ff-only Git 守卫复用，不复制第二套 Git 写实现。
6. **收口**：旧任务仍可查看/安全收尾，新任务默认只走新入口；删除新路径上的前缀配置 UI 与角色选择，保留旧历史读面（已完成：输入框不再高亮快速路由前缀、浏览器侧不再留第二份匹配实现；设置页的前缀编辑器已标注「仅旧提交路径」并保留旧前缀表、旧路由命中与旧任务读面；README、task-flow、core-architecture 与 CLI/RPC 参考已标明当前路径与历史链的区别）。最后全量测试通过。

## 当前进度

- 已完成：CLI/Web `say.submit`、单条草稿发送；新 Input 直连 `task_kind='say'` Task 及输入 worktree，不经过 planner/前缀；daemon 启动若已有本地 main 则幂等创建静息根（不启动 Agent、无 ref 不造）；新 agent 子任务独立 worktree，子任务结算使用事务内去重信号；运行中的直接父 Agent 可以确认固定子提交并 ff-only 集成（旧合并入口拒绝新 Task）；旧库加列与旧路径可并存。say Agent 正常返回后静息而不终结，消息到达可再唤醒；main/owner 根目前不进入不受限 provider 调用；旧/外部分支可由用户确认固定 HEAD 后显式创建独立 owner，旧历史不回写。新 say Task 可持久登记互斥的 `merge` / `showcase` 预约；merge 在静息且能快进时冻结两个 tip、发去重父信号并结算源 Task，直接父 say Agent 可确认集成，main/owner 只有用户批准固定 commit + baseline 后才能快进；**交付锁**：请求一发出就把父分支基线固定，`target_branch` 进入分支写冻结（`kind='delivery'`），同一父分支只允许一个未集成请求（其余保持 pending 并记 `parent_locked`），只有锁持有者能落地，解锁只有集成或用户显式撤销（`task.request_withdrawn`，不删分支与提交）；daemon 挡不住的父分支自行前进（父分支自己提交 / 外部 git）会被 `noteBranchAdvance` 等写成同一份 `parent_moved` 诊断，且固定提交已在父分支内时可幂等关闭；showcase 在安全准入后从固定快照创建原 say 的展示子 Task（原 say 保持静息、预约为 started），子任务成功/失败/取消后先结算自身，再结算原 say；重启补偿只读取已持久化事实。
- 未完成：无。阶段 1-6 的接缝均已落地；后续若发现新的崩溃窗口或 Git 异常组合，按同一套「读事实→写诊断→幂等收尾」补。预约 pending 的阶段性阻塞原因现已落库，同类 `task.reserve` 幂等复查，Web 两处有明确「复查预约」入口；不自动轮询外部文件变动。已发出请求的复查另有 `recheckRequestedMerge`：`requested` 预约按当前 Git 事实重写 `source_moved` / `contained` / `parent_moved` 诊断，仍可快进时清掉过期原因；daemon 重启后逐条复查，Web 给只读「复查请求」。用户选择源侧解分歧：pending merge 与父分支分歧时可派一个以固定源 tip 为基线、吸收固定父 tip 的独立 child；父 say Agent 必须确认包含两个 tip 的固定子提交，之后才重查预约，main 仍由用户固定提交批准。失败/不合格 child 保留现场，不自动重放；用户检查后显式归档旧分支（脏 worktree 另需明确 `--discard`），才能重派独立 child。未集成的终态 child 若分支仍 active 返回 `needs_review`；旧 Task、事件与会话保留，纯 Git blocker 不因失败被暗中豁免。非 say 子任务的分歧也已有收敛路径：兄弟子任务先落地或父分支自己提交后，执行中的直接父 Agent 用 `task resolve-child-divergence CHILD_ID` 从固定子提交拉起同构的解分歧子 Task，合入父分支新提交、测试，再由 `task.integrate` 确认（同时校验两个固定提交，成功后一并结算被修子任务）；同样不重写原子分支、不在父分支上造 merge commit，父分支有交付锁时先拒。main/owner 的受限按需分析已落地：用户 `task analyze ID '问题'` 在分支所有者下建 `task_kind='analysis'` 子 Task，工作区是分支提交的分离检出（与 verifier 同一套路，调用结束即回收），**不建分支**、不记 head_commit/integration，提示词换成只读组合（不写 ref、不派工、不合并、结论带证据），工具不限；答案成为 result 并另落一条 info 提醒。Web Task 详情与分支图的预约/固定提交审批控件已接入并复用安全确认；用户已确认展示失败后提交新 say，不重开已结算父子树。不要把当前的 `completed` 当成已合并。

## 最小回归矩阵

- **输入**：CLI/Web 直接发送和指定草稿发送等价；发送中的 Web 刷新、重复提交、失败回滚、引用保留；批量历史草稿不被无意提交；父分支脏、游离 HEAD、ref 缺失、无绑定、同名分支。
- **Task/Agent**：多个子任务并行，父 Agent 退出即释放槽；成功/失败/取消各只送一次信号；父 Task 收到一部分结果不重复派工；父 invocation 结束与子信号同时发生仍必定唤醒；旧 token 失效，旧/新协议隔离。
- **Git**：子分支在父 tip 前进时不会直接污染父分支；父确认后才集成；分歧、脏 worktree、缺失 ref、部分 Git 成功及崩溃都可诊断且不覆盖用户提交；main 只有用户批准固定 commit 后才可能前进。
- **抢占**：信号先落库；工具进行中不强杀冒充安全点；可安全抢占时不将 Task 错误结算为失败；不能抢占的后端延后投递；SIGKILL/daemon 崩溃不自动重放未知副作用。
- **预约**：两个预约互斥且跨重启保持；展示 Task 是活动子节点时 say Task 非终态；展示失败有可见结果；合并请求只能发直接父 Task，一次结算只发一次；批准前后 commit 变动必须拒绝旧批准。
- **遗留**：原有 Input/Plan/Candidate、已提交草稿关联、旧路由事件均可读；未结束的旧任务与预约按原安全规则收尾；只在测试用临时项目启动 daemon，绝不操纵用户正在开发的项目。

## 实施前必须验证的技术风险

- 当前 `src/agent/provider.js` 的 AbortSignal 直接杀进程组，不能以进程退出码推断某个文件操作已原子完成。已落实的结论：Pi 的扩展有 `turn_end`（本轮工具都结束）可用作可证实的安全点，`tool_call` 不行（同一条 assistant message 的工具调用可并行）；Codex 没有等价接缝，所以只延后到轮末投递而不假装抢占。安全边界只覆盖 Agent 的工具循环，后台孙进程仍在 invocation 结束时回收；取消与超时仍走硬杀并如实标成 cancelled / failed。
- 当前 `src/core/project/scheduling.js` 的正常返回会尝试自动 finish，`lifecycle.js` 禁止终态有活动后代；展示和持久 main 必须按新协议显式分流，不得放宽旧任务的不变量。
- 输入锚点与 SQLite 事务不能覆盖同一个原子边界；崩溃窗口需要可检查、幂等的补偿记录，尤其不能在失败时删除有用户/Agent 未提交改动的 worktree。
- 参考的 pi-orca/agents 采用持久 agent 与完成队列，pi-subagents 采用后台子会话；Lush 只借鉴可观察的生命周期/通知模式，不把它们的状态文件或等待式工具调用当成 Task 的事实来源。
