# Agent 环境与权限

本节管 Pi / Codex 从 daemon 拿到的环境变量与 capability、项目级 Agent 配置与运行设置、用户专属操作与信任边界，以及 `system.status` 里的 agent / 合并字段。

| CLI | RPC | 参数 |
|---|---|---|
| `lush status` | `system.status` | `{}` |
| `lush agent show` | `agent.config` | `{}` |
| `lush agent models pi|codex` | `agent.models` | `{agent}` |
| `lush agent set/reset …` | `agent.configure` | `{config}`（用户专属） |
| `lush agent prompt ROLE` | 本地命令 | 按片段查看最终 Prompt 与来源 |
| `lush agent env ROLE` | 本地命令 | 查看 env 文件与变量名（值隐藏） |
| Web「设置 → Agent → 环境变量」 | `agent.environment` / `agent.environment.configure` | `{target}` / `{target,values}`（读写都限用户） |
| `lush agent init [ROLE] [--local]` | 本地命令 | 创建共享或本机 Prompt 补充文件 |
| `lush config [show]` | `system.status`（读 `settings`） | `{}` |
| `lush config set concurrency|control-concurrency|call-timeout|task-call-limit|max-depth N` | `system.configure` | `{settings}`，只带要改的键（用户专属） |
| `lush config reset [concurrency|control-concurrency|call-timeout|task-call-limit|max-depth|all]` | `system.configure` | `{settings}`，被重置的键传 `null`（用户专属） |
| `lush daemon stop` | `system.stop` | `{}` |
| `lush progress plan KEY[:LABEL]...` | `progress.plan` | `{steps:[{key,label}]}`（agent-only） |
| `lush progress complete KEY` | `progress.complete` | `{step}`（agent-only） |

项目级运行设置存在 `.lush/settings.json`（version 1，权限 `600`）：环境变量 `LUSH_CONCURRENCY` / `LUSH_CONTROL_CONCURRENCY` / `LUSH_CALL_TIMEOUT` / `LUSH_TASK_CALLS` / `LUSH_MAX_DEPTH` 只是各自的默认值，被文件里显式覆盖的键取代，范围分别是 1..64、1..16、1..86400、1..1000、1..64；写盘后同步内存并重新准入，下一次调度 / 调用 / 拆解立即生效，不需要重启 daemon。命令面用连字符（`control-concurrency` / `call-timeout` / `task-call-limit` / `max-depth`），设置文件与 RPC 里是下划线（`control_concurrency` / `call_timeout` / `task_call_limit` / `max_depth`）。

Pi / Codex 每次 invocation 都从 daemon 获得：

- `LUSH_PROJECT` / `LUSH_HOME`：固定所属项目，即使 cwd 是隔离 worktree。
- `LUSH_TASK_ID`：与当前 agent 直接绑定的 task。这里的“自己的任务”不是 `tasks.parent_id` 指向的父任务。
- `LUSH_AGENT_TOKEN`：当前 invocation 的临时 capability。同一 task 每次唤醒重新签发，daemon 只存 SHA-256，invocation 结束或 daemon 重启后即失效；泄漏的旧 token 不能被下一轮使用。
- `PATH` 前置 daemon 所属 checkout 的 `bin/`。

daemon 环境先整体继承给 Agent；每次 invocation 随后加载 `.lush/agent/agent.env`，再加载 `.lush/agent/<role>.env`。角色文件覆盖公共文件；自定义 `PATH` 时 Lush `bin/` 仍会前置。env 使用字面量 `NAME=value`，支持引号和 `export` 前缀，不做 shell 展开。所有 `LUSH_*` 保留给 runtime 并拒绝覆盖。`agent env` 只报告变量名，不暴露值。Web 的 Agent 页可按需把某一个公共/角色文件读入键值表：值默认遮罩、可逐项显示；保存会按变量名排序并规范化为双引号格式，因此原文件注释与排序不会保留。空表会删除对应文件。文件写入使用原子替换、权限 `600`，目录权限 `700`；下一次 invocation 直接生效，无需重启。

CLI 会把 token 放入 RPC params 的 `_token`；daemon 按 hash 反查所属 task，并要求该 task 仍是活动 invocation（在 `running` 中且未被 abort），否则报 invalid or expired agent token。agent spawn 的 parent / notice 的 task 缺省为自己的 task，不能伪造其他父任务；message 只能沿直接父子边。CLI progress 默认只输出短确认，`--json` 保留完整进度对象；RPC 返回不变。进度接口不接受 task ID，始终写 token 所属 task：`progress plan` 整表替换时保留同 key 的完成态与既有计时，`progress complete` 只完成当前计划中已存在的 key。runtime 自动记录当前步骤的 `started_at`，完成时写入 `completed_at` / `duration_ms`，并开始下一条待办的计时。存储在库里的 `duration_ms` 是墙钟；任务详情 / 任务树 / 分支图在有 `agent_runs` 时另行投影：Agent 步骤只算真正 running 的调用时长，waiting / awaiting / queued 的静息等待单列成一条 `kind:'wait'` 条目（`wait_ms` / `waiting_since` / `reason`）插在已完成与当前步骤之间，不计入计划完成度，也不占用 Agent 的工作用时。`progress plan` / `complete` 仍只读写 Agent 自己汇报的步骤，等待行由 runtime 生成，不需要 Agent 汇报。

项目级配置固定为 `.lush/agent.json`，含一个 `default` 与 planner / coordinator / worker / research / verifier / merger / showcase / explainer / butler 九类角色覆盖。每份 profile 是 `{agent, model, thinking, default_prompt, append_prompt, extensions, skills, soft_budget?}`。可选软预算默认关闭，仅普通 Pi 支持；CLI 用 `--budget-responses N|off` / `--budget-tokens N|off`，完整语义见[软预算](../engineering/token-efficiency.md#pi-可选软预算)。`default_prompt` 为空时，`PROMPT_PARTS` 按 role 组合内置规则；非空时完整替换内置组合，可能让 Agent 失去任务 API、权限边界、协作和交付协议，因此 Web 保存前会明确警告并再次确认。随后依次追加可提交的 `.lush-agent/common.md` / `<role>.md`、本机 `.lush/agent/common.md` / `<role>.md`，最后追加 `append_prompt`。`lush agent prompt ROLE` 展示这条最终链路及每段来源。`extensions` / `skills` 是从已安装 Pi 资源中选择的路径，只给普通 Pi invocation 显式加载，Codex 不使用；[专用解释 Agent](../engineering/transcript-reader.md)与[托管模式管家](../sleep-mode.md)禁用工具、扩展、Skills 和自动上下文读取，目前仅支持 Pi（或离线 Mock），不以 Codex 开发权限降级运行。旧版 `prompt` 字段继续按 `append_prompt` 读取。daemon 在每次 invocation 开始前重读文件，所以运行中的调用不变，下一次调用立即生效。每条 `agent_runs` 固化当次实际的 provider / model / thinking，后续改配置不改历史。

`agent.models` 按需调用本机 CLI：Pi 使用 `pi --list-models`，Codex 使用 `codex debug models`。接口只返回筛选后的模型元数据，不暴露 CLI 的原始目录；读取失败时返回内置预设与 `warning`，模型 ID 仍可手工输入。

`system.status` 的 `agent_config` 返回规范化配置、每类角色的 resolved profile 与 Web 可用选项；`settings` 是运行设置的读写镜像（读自 `system.status`，写走用户专属的 `system.configure`）：`{file, concurrency:{value,default,overridden}, control_concurrency:{value,default,overridden}, call_timeout:{value,default,overridden}, task_call_limit:{value,default,overridden}, max_depth:{value,default,overridden}}`，顶层 `concurrency` / `control_concurrency` / `call_timeout` / `task_call_limit` / `max_depth` 仍是生效值，环境变量只提供默认值。`agents` 只列运行中的 agent，并显示该次实际 backend / model / thinking，另有 `agents_total`（每个活动 task 一个 agent）与 `agents_idle`（已 park、未在跑的，含尚未首次唤醒的）。`pending_merges` 以原 worker 为稳定项统计 `integration=pending/review/conflict`，不把它的 resolver 再重复计数；完整交付阶段、实际 `source_task_id` 与 blockers 见 `task.ladder.groups`。`merge_freeze` 列出正被未解决冲突冻结的目标分支。agent 身份本身（id / 唤醒次数 / 上次动手时间）可以跨唤醒读取，但它不是可寻址的执行句柄：用户操作一律按 task ID 进行。

以下操作限用户：system.stop、system.configure、agent.configure、agent.environment、agent.environment.configure、input.submit、task.cancel/retry/merge/cleanup/clear、branch.import/merge/sync/archive、notice.answer/dismiss。`agent.environment` 虽是读取接口，但会返回明文密钥，因此同样拒绝 agent token。CLI 另禁止 agent 启动 daemon、Web 或阻塞等待。

本地用户可以不带 token 调用 RPC，这是明确的信任边界，不是多用户 ACL。能执行任意本机命令的恶意 agent 也能绕过环境约定；需要真正沙箱时应另加 OS 隔离。
