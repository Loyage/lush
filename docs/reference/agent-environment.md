# Agent 环境与权限

本节规定 invocation 环境、临时凭证、进度与信任边界；技术配置设备唯一，Worker 显式参数及项目事实仍隔离。配置模式与资源见[配置参考](agent-configuration.md)。

| CLI | RPC | 参数 |
|---|---|---|
| `lush status` | `system.status` | `{}` |
| `lush agent show` | `agent.config` | `{}` |
| `lushw skills list/get ID` | 本地只读命令 | 读取内置公开指南，不读设备私密设置，不需 daemon |
| `lush agent models pi|codex` | `agent.models` | `{agent}` |
| `lush agent set/reset …` | `agent.configure` | `{config}`（用户专属） |
| `lush agent prompt ROLE` | 本地命令 | 按片段查看最终 Prompt 与来源 |
| `lush agent network show/set --file PATH/reset` | `agent.network` / `agent.network.configure` | `{}` / `{config}`（用户专属，代理认证只写；[网络契约](../engineering/outbound-network.md)） |
| `lush agent env ROLE` | 本地命令 | 查看 env 文件与变量名（值隐藏） |
| Web「Agent 配置 → 高级项 → 环境变量」 | `agent.environment` / `agent.environment.configure` | `{target}` / `{target,values}`（读写都限用户） |
| `lush agent init [ROLE] [--local]` | 本地命令 | 创建共享或本机 Prompt 补充文件 |
| `lush config [show]` | `system.status`（读 `settings`） | `{}` |
| `lush config set call-timeout|worker-call-limit|max-depth N` | `system.configure` | `{settings}`，只带要改的键（用户专属） |
| `lush config reset [call-timeout|worker-call-limit|max-depth|all]` | `system.configure` | `{settings}`，被重置的键传 `null`（用户专属） |
| `lush daemon stop` | `system.stop` | `{}` |
| `lushw self auto-title '标题'` | `context.auto_title` | `{title}`（Agent-only，当前 order/child 首次生成自身自动标题） |
| `lushw self progress plan KEY[:LABEL]...` | `context.progress_plan` | `{steps:[{key,label}]}`（agent-only） |
| `lushw self progress complete KEY` | `context.progress_complete` | `{step}`（agent-only） |

设备运行设置存在 `<deviceHome>/settings.json`（version 1，权限 `600`）：环境变量 `LUSH_CALL_TIMEOUT` / `LUSH_TASK_CALLS` / `LUSH_MAX_DEPTH` 只是各自的默认值，被文件里显式覆盖的键取代，范围分别是 1..86400、1..1000、1..64；写盘后同步内存并重新准入，下一次调度 / 调用 / 拆解立即生效，不需要重启 daemon。命令面用连字符（`call-timeout` / `worker-call-limit` / `max-depth`），设置文件与 RPC 里是下划线（`call_timeout` / `task_call_limit` / `max_depth`）；`worker-call-limit` 特别映射到保留的 `task_call_limit`，并非 `worker_call_limit`，旧 CLI 名不留别名。见[更名边界](../engineering/core-api.md#worker-更名与兼容边界)。

W210／D492 已移除 Worker 并发槽：旧盘上 `concurrency`／`control_concurrency` 留存但不生效，旧 `LUSH_CONCURRENCY`／`LUSH_CONTROL_CONCURRENCY` 忽略；公开配置写入拒绝这些键，状态与时间线不再投影并发额度。依赖、冻结、维护及同 Worker 的真实退出屏障仍限制准入。

全局设置 → 系统 →「Agent 能力」提供四项设备级开关：`progress_reporting`、`worker_delegation`、`worker_auto_title`、`context_retrieval`，均默认开启，经用户专属 `system.configure {settings:{KEY:boolean}}` partial patch 保存，`null` 恢复默认。后续调用与内置配置预览只提供已开启能力的薄入口及按需指南；关闭状态明确告知 Agent 不主动使用。Pi 两模式和 Codex 共用入口，角色适用范围与[能力指南](../agent-capabilities.md)一致。开关不撤销 API 权限，不中断当前调用或已有 child，核心安全、后代收尾及最低验证责任保留；自定义 Prompt / 补充和已有会话原文不改写。关闭进度还沿用隐藏进度区块及规划历史的行为，已有记录不删除。保存设置本身不要求重启。

Pi / Codex 每次 invocation 都从 daemon 获得：

- `LUSH_PROJECT` / `LUSH_HOME`：固定所属项目，即使 cwd 是隔离 worktree。
- `LUSH_TASK_ID`：与当前 Agent 直接绑定的 Worker。这里的“自己的Worker”不是 `tasks.parent_id` 指向的父Worker。
- `LUSH_AGENT_TOKEN`：当前 invocation 的临时 capability。同一 Worker 每次唤醒重新签发，daemon 只存 SHA-256，invocation 结束或 daemon 重启后即失效；泄漏的旧 token 不能被下一轮使用。
- `PATH` 前置 daemon 所属 checkout 的 `bin/`。

Lush 模式环境按 daemon → 设备[网络设置](../engineering/outbound-network.md) → 设备 common env → 角色 env → Worker profile env 叠加；自定义 PATH 仍前置固定 Lush bin。env 为字面量 NAME=value，支持引号／export，不展开 Shell，所有 LUSH_* 拒绝覆盖。Lush Pi 去掉 ambient 模型认证、固定私有快照 PI_CODING_AGENT_DIR；Pi 默认模式与隔离角色不混入 Lush 工作配置，见[双模式](../engineering/agent-configuration-v2.md)。Codex CLI 自身认证不变。

CLI agent env 只显示变量名，Web 授权编辑默认遮罩；保存排序并规范化双引号，不保留注释／顺序，空表删除文件。owner-only 原子写入，下一次调用生效，不热改当前调用。设备归属见[工作台配置](../engineering/user-workspace.md#设备配置分区)。

CLI 会把 token 放入 RPC params 的 `_token`；daemon 按 hash 反查所属 Worker，并要求该 Worker 仍是活动 invocation（在 `running` 中且未被 abort），否则报 invalid or expired agent token。开发 CLI 的 `context.*` 从真实 token 定位自身，不能靠 `LUSH_TASK_ID`、cwd 或伪造目标选择其他 Worker；派工和 Notice 不接受父／目标 ID，消息只能沿直接父子边。后端同样拒绝普通 Worker 的项目枚举与无关目标查询，精确范围和分页投影见[双入口契约](api.md#开发与管理双入口)。Valet 的已审核跨树操作须经可信管理代理，不把其身份或目录作为开发父分支，见[Valet 契约](../engineering/hook-signals-management.md)。CLI `self progress` 默认只输出短确认，`--json` 保留完整进度对象；底层进度写入语义不变。进度接口不接受 Worker ID，始终写 token 所属 Worker：`self progress plan` 同一次工作整表替换时保留同 key 的完成态与既有计时，`self progress complete` 只完成当前计划中已存在的 key。runtime 自动记录当前步骤的 `started_at`，顺序完成时写入 `completed_at` / `duration_ms`，并开始下一条待办的计时。

开启自动标题能力后，内置开发 Agent 短入口要求按需读取命名指南，在理解目标后、结束本轮或提问／派工前，若自身 order/child 的 auto_title 为空，调用 `lushw self auto-title '标题'`，简短概括实际主题，不照抄输入首行。标题为非空单行最多 60 字符；接口不接受 ID、仅首次成功写入，此后返回已有标题，不允许覆盖或清空；用户手动 display_title 始终优先，用户 rename 权限不变。不为标题额外派工或调用模型；analysis 不含此命名片段；Valet 通过专用管理提示词使用已授权的自身标题能力，不加载开发 Skill，自定义替代 Prompt 及模型漏读指南可能影响执行。关闭该能力不清除已有标题；未生成时使用目标兜底，旧记录不批量回填。

步骤实际增删、改名、换序时，Runtime 自动把被替换计划完整状态及冻结计时保存为 `progress.archived` Event。当前调用实际收到普通用户追加输入后首次 plan 会归档旧计划并重置同 key 的完成态与计时（即使步骤同形）；随后同形重复 plan 不增加历史。Notice 答案、Agent/子 Worker 消息、等待后继续调用和本轮尚未收到的新输入不重置。不要为历史额外汇报步骤或把旧步骤重复塞入新计划；历史只在详情和 `worker.progress_history {id,before?,limit?}` 只读分页出现，列表、图和调用启动进度只有当前计划。关闭进度汇报时历史也隐藏，但不删除。完整字段见[Worker 规划历史](rpc/tasks.md#规划历史)。

越序完成时，runtime 自动推进到完成步骤之后的未跳过待办，不增加开始命令。被越过的 pending 步骤标记 `unconfirmed:true`，详情显示「未确认完成」，不计入完成数，也不再作为当前执行步骤；它们与越序完成步骤标记 `timing_unknown:true`，用时为 null /「用时未知」，不伪造 0 秒或猜测分配漏报区间。之后正常完成的步骤恢复正常计时。补报被跳过步骤只更新完成度，未知耗时仍未知，不倒退当前步骤或重置它的开始时间；同 key 的重报计划保留漏报标记和当前计时。所有后续步骤完成后仍有漏报项时显示「仍有步骤未确认完成」，而非「计划已全部完成」。在收到越序完成汇报之前，runtime 无法知道已经切换步骤，仍按已知当前步骤显示。旧记录不迁移，也不能据完成时间准确还原遗漏的阶段边界。

存储在库里的已知 `duration_ms` 是墙钟；Worker详情 / Worker树 / 分支图在有 `agent_runs` 时另行投影：Agent 步骤只算真正 running 的调用时长，waiting / awaiting / queued 的静息等待单列成一条 `kind:'wait'` 条目（`wait_ms` / `waiting_since` / `reason`）插在已完成与当前步骤之间，不计入计划完成度，也不占用 Agent 的工作用时。`self progress plan` / `complete` 仍只读写 Agent 自己汇报的步骤，等待行由 runtime 生成，不需要 Agent 汇报。

profile、角色兼容、资源安装／启用与双模式统一见[配置契约](../engineering/agent-configuration-v2.md)。Lush 配置和私有补充只从设备读取，项目 AGENTS.md／`.lush-agent/` 保留项目上下文；旧项目私有文件不回退。Prompt 组合、覆盖内置提示的风险与显式资源见[配置参考](agent-configuration.md)，软预算见[Token 效率](../engineering/token-efficiency.md#pi-可选软预算)。下一次 invocation 重读，Run 固化实际 backend／model／thinking，不改历史。

Lush Prompt 顺序为内置组合（非空 default_prompt 则替换）→ 项目 `.lush-agent/common.md`／角色 .md → 设备 `agent/common.md`／角色 .md → append_prompt；旧 prompt 字段只按 append_prompt 读取。`agent prompt ROLE` 展示最终链及来源。替换内置 Prompt 可能失去协作和交付指引，Web 必须警告并确认；这不取消 RPC／runtime 安全门。退休无工具角色保留历史隔离，不用有开发权限的 Codex 降级运行；管理角色另见[隔离契约](../engineering/hook-signals-management.md)。

Worker 待开始或暂停时的「调整运行设置」与失败/取消后的「检查后重试」共用Worker级参数面板。打开时先通过用户专属 `worker.run_settings` 读取已有 Worker Profile（读取失败不回退默认），未修改项保留；配置模式、后端、来源、模型和思考深度直接展示，Prompt、扩展、Skills、预算和环境变量放在默认折叠的高级设置。自动读取现有模型来源及已选来源的本地模型目录缓存，无需先点「读取项目连接」；不联网查询、不自动替换所选来源或模型，读取失败仍可编辑并手动重读。面板同时自动加载角色当前生效的默认 Profile，以及公共和角色环境文件（同名变量依次由公共、角色、Profile 覆盖；不读取 daemon 的整份进程环境）。「加载默认参数」会丢弃表单改动，恢复打开面板时读到的全部默认值，包括模型、思考深度、Prompt、扩展、Skills、软预算和环境变量；该按钮本身不保存也不启动 Agent。环境变量编辑器按 `NAME=value` 分行，含换行、首尾空白或开头双引号的值用 JSON 字符串保留原值。确认后仅保存Worker级 Profile，不写项目配置或环境文件；暂停Worker还需点「开始/继续」才启动 Agent。

Worker 详情统一使用「调整运行设置」选择模型来源，不再提供重复的「切换模型来源」按钮。仅暂停或请求中断的 order/child 可保存；只换来源或模型时保留其他已有覆盖，下一次配置摘要与当前调用实际绑定分开显示。Pi 默认模式可在同一面板切回 Lush；Codex CLI 仍不支持托管连接，不放宽后端能力。

`agent.models` 对 Pi 只用独立配置的 auth-free、禁网络 SDK 元数据（`source=local`），没有元数据声明或 SDK 时返回未验证预设及 `warning`，不执行 `pi --list-models` 或读取外部认证。Codex 仍按需调用 `codex debug models`。配置页的 Pi 模型选择只用当前来源；目录、预设和手填模型都不保证上游请求可用。

`system.status` 的 `agent_config` 返回规范化配置、每类角色的 resolved profile 与 Web 可用选项；`settings` 是运行设置的读写镜像（读自 `system.status`，写走用户专属的 `system.configure`）：`{file, call_timeout:{value,default,overridden}, task_call_limit:{value,default,overridden}, max_depth:{value,default,overridden}, progress_reporting:{value,default:true,overridden}, worker_delegation:{value,default:true,overridden}, worker_auto_title:{value,default:true,overridden}, context_retrieval:{value,default:true,overridden}}`，顶层 `call_timeout` / `task_call_limit` / `max_depth` 仍是生效值，环境变量只提供默认值。`agents` 只列运行中的 agent，并显示该次实际 backend / model / thinking，另有 `agents_total`（每个活动 Worker 一个 Agent）与 `agents_idle`（已 park、未在跑的，含尚未首次唤醒的）。`pending_merges` 以原 worker 为稳定项统计 `integration=pending/review/conflict`，不把它的 resolver 再重复计数；完整交付阶段、实际 `source_task_id` 与 blockers 由内部 `ladder().groups` 读模型投影；旧 `task.ladder` 已下线，不是公开 RPC。`merge_freeze` 列出正被未解决冲突冻结的目标分支。agent 身份本身（id / 唤醒次数 / 上次动手时间）可以跨唤醒读取，但它不是可寻址的执行句柄：用户操作一律按 Worker ID 进行。

精确用户／Agent 权限以 `src/rpc/registry.js` 和[分项接口](rpc/README.md)为准，不在此复制名单。技术配置即使只读、未给 scope 也限用户；env 可含明文密钥，不接受 Agent token。CLI 另禁止 Agent 启动 daemon／Web 或阻塞等待。

专用整合 Worker（`task_kind='integration'`）另有默认拒绝的 RPC 窄白名单，只允许自身／直接父及持久固定整合成员的受检只读和自身 Notice／进度，不能项目枚举、派工、发消息、交付、验收或修改归并策略。身份取自有效 invocation 对应的 Store 事实，不依赖 Prompt；普通开发 Agent 的亲缘与写入安全门、管理 Agent 的独立受控代理保持。精确能力见[分支归并接口](rpc/convergence.md#专用整合-worker-的-rpc-能力)。

本地用户可以不带 token 调用 RPC，这是明确的信任边界，不是多用户 ACL。能执行任意本机命令的恶意 agent 也能绕过环境约定；需要真正沙箱时应另加 OS 隔离。
