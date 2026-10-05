# Agent 环境与权限

本节管 Pi / Codex 从 daemon 拿到的环境变量与 capability、项目级 Agent 配置与运行设置、用户专属操作与信任边界，以及 `system.status` 里的 agent / 合并字段。

| CLI | RPC | 参数 |
|---|---|---|
| `lush status` | `system.status` | `{}` |
| `lush agent show` | `agent.config` | `{}` |
| `lush agent models pi|codex` | `agent.models` | `{agent}` |
| `lush agent set/reset …` | `agent.configure` | `{config}`（用户专属） |
| `lush agent prompt ROLE` | 本地命令 | 按片段查看最终 Prompt 与来源 |
| `lush agent network show/set --file PATH/reset` | `agent.network` / `agent.network.configure` | `{}` / `{config}`（用户专属，代理认证只写；[网络契约](../engineering/outbound-network.md)） |
| `lush agent env ROLE` | 本地命令 | 查看 env 文件与变量名（值隐藏） |
| Web「Agent 管理 → 设置 → 环境变量」 | `agent.environment` / `agent.environment.configure` | `{target}` / `{target,values}`（读写都限用户） |
| `lush agent init [ROLE] [--local]` | 本地命令 | 创建共享或本机 Prompt 补充文件 |
| `lush config [show]` | `system.status`（读 `settings`） | `{}` |
| `lush config set concurrency|control-concurrency|call-timeout|worker-call-limit|max-depth N` | `system.configure` | `{settings}`，只带要改的键（用户专属） |
| `lush config reset [concurrency|control-concurrency|call-timeout|worker-call-limit|max-depth|all]` | `system.configure` | `{settings}`，被重置的键传 `null`（用户专属） |
| `lush daemon stop` | `system.stop` | `{}` |
| `lush progress plan KEY[:LABEL]...` | `progress.plan` | `{steps:[{key,label}]}`（agent-only） |
| `lush progress complete KEY` | `progress.complete` | `{step}`（agent-only） |

项目级运行设置存在 `.lush/settings.json`（version 1，权限 `600`）：环境变量 `LUSH_CONCURRENCY` / `LUSH_CONTROL_CONCURRENCY` / `LUSH_CALL_TIMEOUT` / `LUSH_TASK_CALLS` / `LUSH_MAX_DEPTH` 只是各自的默认值，被文件里显式覆盖的键取代，范围分别是 1..64、1..16、1..86400、1..1000、1..64；写盘后同步内存并重新准入，下一次调度 / 调用 / 拆解立即生效，不需要重启 daemon。命令面用连字符（`control-concurrency` / `call-timeout` / `worker-call-limit` / `max-depth`），设置文件与 RPC 里是下划线（`control_concurrency` / `call_timeout` / `task_call_limit` / `max_depth`）；`worker-call-limit` 特别映射到保留的 `task_call_limit`，并非 `worker_call_limit`，旧 CLI 名不留别名。见[更名边界](../engineering/core-api.md#worker-更名与兼容边界)。

Pi / Codex 每次 invocation 都从 daemon 获得：

- `LUSH_PROJECT` / `LUSH_HOME`：固定所属项目，即使 cwd 是隔离 worktree。
- `LUSH_TASK_ID`：与当前 Agent 直接绑定的 Worker。这里的“自己的Worker”不是 `tasks.parent_id` 指向的父Worker。
- `LUSH_AGENT_TOKEN`：当前 invocation 的临时 capability。同一 Worker 每次唤醒重新签发，daemon 只存 SHA-256，invocation 结束或 daemon 重启后即失效；泄漏的旧 token 不能被下一轮使用。
- `PATH` 前置 daemon 所属 checkout 的 `bin/`。

daemon 环境先整体继承给 Agent，再叠加项目[出站网络设置](../engineering/outbound-network.md)；每次 invocation 随后加载 `.lush/agent/agent.env`，再加载 `.lush/agent/<role>.env`。角色文件覆盖公共文件；自定义 `PATH` 时 Lush `bin/` 仍会前置。env 使用字面量 `NAME=value`，支持引号和 `export` 前缀，不做 shell 展开。所有 `LUSH_*` 保留给 runtime 并拒绝覆盖。`agent env` 只报告变量名，不暴露值。Web 的 Agent 页可按需把某一个公共/角色文件读入键值表：值默认遮罩、可逐项显示；保存会按变量名排序并规范化为双引号格式，因此原文件注释与排序不会保留。空表会删除对应文件。文件写入使用原子替换、权限 `600`，目录权限 `700`；下一次 invocation 直接生效，无需重启。

CLI 会把 token 放入 RPC params 的 `_token`；daemon 按 hash 反查所属 Worker，并要求该 Worker 仍是活动 invocation（在 `running` 中且未被 abort），否则报 invalid or expired agent token。`worker.spawn` 的 `parent` / `notice.post` 的 `task` 缺省为自己的 Worker，不能伪造其他父Worker；message 只能沿直接父子边。CLI progress 默认只输出短确认，`--json` 保留完整进度对象；RPC 返回不变。进度接口不接受 Worker ID，始终写 token 所属 Worker：`progress plan` 整表替换时保留同 key 的完成态与既有计时，`progress complete` 只完成当前计划中已存在的 key。runtime 自动记录当前步骤的 `started_at`，顺序完成时写入 `completed_at` / `duration_ms`，并开始下一条待办的计时。

越序完成时，runtime 自动推进到完成步骤之后的未跳过待办，不增加开始命令。被越过的 pending 步骤标记 `unconfirmed:true`，详情显示「未确认完成」，不计入完成数，也不再作为当前执行步骤；它们与越序完成步骤标记 `timing_unknown:true`，用时为 null /「用时未知」，不伪造 0 秒或猜测分配漏报区间。之后正常完成的步骤恢复正常计时。补报被跳过步骤只更新完成度，未知耗时仍未知，不倒退当前步骤或重置它的开始时间；同 key 的重报计划保留漏报标记和当前计时。所有后续步骤完成后仍有漏报项时显示「仍有步骤未确认完成」，而非「计划已全部完成」。在收到越序完成汇报之前，runtime 无法知道已经切换步骤，仍按已知当前步骤显示。旧记录不迁移，也不能据完成时间准确还原遗漏的阶段边界。

存储在库里的已知 `duration_ms` 是墙钟；Worker详情 / Worker树 / 分支图在有 `agent_runs` 时另行投影：Agent 步骤只算真正 running 的调用时长，waiting / awaiting / queued 的静息等待单列成一条 `kind:'wait'` 条目（`wait_ms` / `waiting_since` / `reason`）插在已完成与当前步骤之间，不计入计划完成度，也不占用 Agent 的工作用时。`progress plan` / `complete` 仍只读写 Agent 自己汇报的步骤，等待行由 runtime 生成，不需要 Agent 汇报。

项目级配置固定为 `.lush/agent.json`，含一个 `default` 与 planner / coordinator / worker / research / verifier / merger / explainer / butler 八类角色覆盖（旧 showcase 配置只兼容读取并忽略，不再开放该角色）。每份 profile 是 `{agent, model, thinking, default_prompt, append_prompt, extensions, skills, soft_budget?, connection_id?}`。`connection_id` 是可选的项目托管账号 UUID，仅支持 Pi 的固定物理 `provider/model`；CLI 用 `--connection UUID|off`，下一次 invocation 冻结账号并通过私有临时认证目录绑定，不把秘密放入参数，不自动路由或付费降级；完整边界见[账号资源连接器](../engineering/agent-connections.md)。可选软预算默认关闭，仅普通 Pi 支持；CLI 用 `--budget-responses N|off` / `--budget-tokens N|off`，完整语义见[软预算](../engineering/token-efficiency.md#pi-可选软预算)。`default_prompt` 为空时，`PROMPT_PARTS` 按 role 组合内置规则；非空时完整替换内置组合，可能让 Agent 失去Worker API、权限边界、协作和交付协议，因此 Web 保存前会明确警告并再次确认。随后依次追加可提交的 `.lush-agent/common.md` / `<role>.md`、本机 `.lush/agent/common.md` / `<role>.md`，最后追加 `append_prompt`。`lush agent prompt ROLE` 展示这条最终链路及每段来源。`extensions` / `skills` 是从已安装 Pi 资源中选择的路径，只给普通 Pi invocation 显式加载，Codex 不使用；[专用解释 Agent](../engineering/transcript-reader.md)与管家等专用角色禁用工具、扩展、Skills 和自动上下文读取，目前仅支持 Pi（或离线 Mock），不以 Codex 开发权限降级运行。旧版 `prompt` 字段继续按 `append_prompt` 读取。daemon 在每次 invocation 开始前重读文件，所以运行中的调用不变，下一次调用立即生效。每条 `agent_runs` 固化当次实际的 provider / model / thinking，后续改配置不改历史。

Worker 待开始或暂停时的「调整运行设置」与失败/取消后的「检查后重试」共用Worker级参数面板。打开时自动加载角色当前生效的默认 Profile，以及公共和角色环境文件（同名变量依次由公共、角色、Profile 覆盖；不读取 daemon 的整份进程环境）。「加载默认参数」会丢弃表单改动，恢复打开面板时读到的全部默认值，包括模型、思考深度、Prompt、扩展、Skills、软预算和环境变量；该按钮本身不保存也不启动 Agent。环境变量编辑器按 `NAME=value` 分行，含换行、首尾空白或开头双引号的值用 JSON 字符串保留原值。确认后仅保存Worker级 Profile，不写项目配置或环境文件；暂停Worker还需点「开始/继续」才启动 Agent。

`agent.models` 按需调用本机 CLI：Pi 使用 `pi --list-models`，Codex 使用 `codex debug models`。接口只返回筛选后的模型元数据，不暴露 CLI 的原始目录；读取失败时返回内置预设与 `warning`，模型 ID 仍可手工输入。

`system.status` 的 `agent_config` 返回规范化配置、每类角色的 resolved profile 与 Web 可用选项；`settings` 是运行设置的读写镜像（读自 `system.status`，写走用户专属的 `system.configure`）：`{file, concurrency:{value,default,overridden}, control_concurrency:{value,default,overridden}, call_timeout:{value,default,overridden}, task_call_limit:{value,default,overridden}, max_depth:{value,default,overridden}}`，顶层 `concurrency` / `control_concurrency` / `call_timeout` / `task_call_limit` / `max_depth` 仍是生效值，环境变量只提供默认值。`agents` 只列运行中的 agent，并显示该次实际 backend / model / thinking，另有 `agents_total`（每个活动 Worker 一个 Agent）与 `agents_idle`（已 park、未在跑的，含尚未首次唤醒的）。`pending_merges` 以原 worker 为稳定项统计 `integration=pending/review/conflict`，不把它的 resolver 再重复计数；完整交付阶段、实际 `source_task_id` 与 blockers 由内部 `ladder().groups` 读模型投影；旧 `task.ladder` 已下线，不是公开 RPC。`merge_freeze` 列出正被未解决冲突冻结的目标分支。agent 身份本身（id / 唤醒次数 / 上次动手时间）可以跨唤醒读取，但它不是可寻址的执行句柄：用户操作一律按 Worker ID 进行。

以下操作限用户：system.stop、system.configure、agent.configure、agent.environment、agent.environment.configure、agent.network、agent.network.configure、agent.connections.*（包括读取、查询与登录）、order.submit、worker.transcript_latest / transcript_page / transcript_step / transcript_search、worker.auto_merge / reserve / unreserve / resolve / resolve_divergence / approve_merge / cancel / retry / cleanup、notice.answer / dismiss、branch.bind / archive。`agent.environment` 虽是读取接口，但会返回明文密钥，因此同样拒绝 agent token。CLI 另禁止 agent 启动 daemon、Web 或阻塞等待。

本地用户可以不带 token 调用 RPC，这是明确的信任边界，不是多用户 ACL。能执行任意本机命令的恶意 agent 也能绕过环境约定；需要真正沙箱时应另加 OS 隔离。
