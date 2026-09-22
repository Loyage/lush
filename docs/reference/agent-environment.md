# Agent 环境与权限

本节管 Pi / Codex 从 daemon 拿到的环境变量与 capability、项目级 Agent 配置、用户专属操作与信任边界，以及 `system.status` 里的 agent / 合并字段。

| CLI | RPC | 参数 |
|---|---|---|
| `lush status` | `system.status` | `{}` |
| `lush agent show` | `agent.config` | `{}` |
| `lush agent models pi|codex` | `agent.models` | `{agent}` |
| `lush agent set/reset …` | `agent.configure` | `{config}`（用户专属） |
| `lush daemon stop` | `system.stop` | `{}` |
| `lush progress plan KEY[:LABEL]...` | `progress.plan` | `{steps:[{key,label}]}`（agent-only） |
| `lush progress complete KEY` | `progress.complete` | `{step}`（agent-only） |

Pi / Codex 每次 invocation 都从 daemon 获得：

- `LUSH_PROJECT` / `LUSH_HOME`：固定所属项目，即使 cwd 是隔离 worktree。
- `LUSH_TASK_ID`：与当前 agent 直接绑定的 task。这里的“自己的任务”不是 `tasks.parent_id` 指向的父任务。
- `LUSH_AGENT_TOKEN`：当前 invocation 的临时 capability。同一 task 每次唤醒重新签发，daemon 只存 SHA-256，invocation 结束或 daemon 重启后即失效；泄漏的旧 token 不能被下一轮使用。
- `PATH` 前置 daemon 所属 checkout 的 `bin/`。

CLI 会把 token 放入 RPC params 的 `_token`；daemon 按 hash 反查所属 task，并要求该 task 仍是活动 invocation（在 `running` 中且未被 abort），否则报 invalid or expired agent token。agent spawn 的 parent / notice 的 task 缺省为自己的 task，不能伪造其他父任务；message 只能沿直接父子边。进度接口不接受 task ID，始终写 token 所属 task：`progress plan` 整表替换时保留同 key 的完成态与既有计时，`progress complete` 只完成当前计划中已存在的 key。runtime 自动记录当前步骤的 `started_at`，完成时写入 `completed_at` / `duration_ms`，并开始下一条待办的计时。

项目级配置固定为 `.lush/agent.json`，含一个 `default` 与 planner / coordinator / worker / research / verifier / merger 六类角色覆盖。每份 profile 是 `{agent, model, thinking, default_prompt, append_prompt, extensions, skills}`。`default_prompt` 为空时使用 Lush 内置规则；Web 会直接显示该内置全文并提供“恢复默认 Prompt”。非空时完整替换内置规则，可能让 Agent 失去任务 API、权限边界、协作和交付协议，因此 Web 保存前会明确警告并再次确认；`append_prompt` 追加在最终默认 Prompt 之后。`extensions` / `skills` 是从已安装 Pi 资源中选择的路径，只给 Pi invocation 显式加载，Codex 不使用。旧版 `prompt` 字段继续按 `append_prompt` 读取。daemon 在每次 invocation 开始前重读文件，所以运行中的调用不变，下一次调用立即生效。每条 `agent_runs` 固化当次实际的 provider / model / thinking，后续改配置不改历史。

`agent.models` 按需调用本机 CLI：Pi 使用 `pi --list-models`，Codex 使用 `codex debug models`。接口只返回筛选后的模型元数据，不暴露 CLI 的原始目录；读取失败时返回内置预设与 `warning`，模型 ID 仍可手工输入。

`system.status` 的 `agent_config` 返回规范化配置、每类角色的 resolved profile 与 Web 可用选项；`agents` 只列运行中的 agent，并显示该次实际 backend / model / thinking，另有 `agents_total`（每个活动 task 一个 agent）与 `agents_idle`（已 park、未在跑的，含尚未首次唤醒的）。`pending_merges` 以原 worker 为稳定项统计 `integration=pending/review/conflict`，不把它的 resolver 再重复计数；完整交付阶段、实际 `source_task_id` 与 blockers 见 `task.ladder.groups`。`merge_freeze` 列出正被未解决冲突冻结的目标分支。agent 身份本身（id / 唤醒次数 / 上次动手时间）可以跨唤醒读取，但它不是可寻址的执行句柄：用户操作一律按 task ID 进行。

以下操作限用户：system.stop、agent.configure、input.submit、task.cancel/retry/merge/cleanup/clear、branch.import/merge/sync/archive、notice.answer/dismiss。CLI 另禁止 agent 启动 daemon、Web 或阻塞等待。

本地用户可以不带 token 调用 RPC，这是明确的信任边界，不是多用户 ACL。能执行任意本机命令的恶意 agent 也能绕过环境约定；需要真正沙箱时应另加 OS 隔离。
