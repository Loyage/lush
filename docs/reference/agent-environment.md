# Agent 环境与权限

本节管 pi 从 daemon 启动时拿到的环境变量与 capability、用户专属操作与信任边界，以及 `system.status` 里的 agent / 合并字段。

| CLI | RPC | 参数 |
|---|---|---|
| `lush status` | `system.status` | `{}` |
| `lush daemon stop` | `system.stop` | `{}` |
| `lush agent prompt ROLE` | 本地命令 | 按片段查看最终 prompt；`--json` 返回组成与来源 |
| `lush agent env ROLE` | 本地命令 | 查看 env 文件与已加载变量名（不显示值） |
| `lush agent init [ROLE] [--local]` | 本地命令 | 创建共享或本机 prompt 补充文件 |

pi 从 daemon 启动时获得：

- `LUSH_PROJECT` / `LUSH_HOME`：固定所属项目，即使 cwd 是隔离 worktree。
- `LUSH_TASK_ID`：自己的任务。
- `LUSH_AGENT_TOKEN`：当前 invocation 的临时 capability。同一 task 每次唤醒重新签发，daemon 只存 SHA-256，invocation 结束或 daemon 重启后即失效；泄漏的旧 token 不能被下一轮使用。
- `PATH` 前置 daemon 所属 checkout 的 `bin/`。

daemon 的环境先整体继承给 agent；随后每次 invocation 热加载 `.lush/agent/agent.env`，再加载 `.lush/agent/<role>.env`。后者覆盖前者；若自定义 `PATH`，Lush 的 `bin/` 仍会再次前置。文件使用字面量 `NAME=value`，支持引号与 `export` 前缀，不做 shell 展开。所有 `LUSH_*` 变量保留给 runtime，配置时会拒绝。env 值可能含密钥，因此只允许放在已忽略的本机 `.lush/agent/`，`agent env` 也只报告变量名。

角色 system prompt 每轮同样重新组合。内置 `PROMPT_PARTS` 按 `ROLE_PROMPT_PARTS[role]` 选择，随后依次追加可提交的 `.lush-agent/common.md`、`.lush-agent/<role>.md`，以及本机 `.lush/agent/common.md`、`.lush/agent/<role>.md`。planner 只带选择委派角色所需的短目录，不带其它角色的完整执行说明。pi 仍加载 `AGENTS.md` 作为仓库约定；两者职责不同。

CLI 会把 token 放入 RPC params 的 `_token`；daemon 按 hash 反查所属 task，并要求该 task 仍是活动 invocation（在 `running` 中且未被 abort），否则报 invalid or expired agent token。agent spawn 的 parent / notice 的 task 缺省为自己的 task，不能伪造其他父任务；message 只能沿直接父子边。

`system.status` 里 `agents` 只列运行中的 agent，另有 `agents_total`（每个活动 task 一个 agent）与 `agents_idle`（已 park、未在跑的，含尚未首次唤醒的）。`pending_merges` 以原 worker 为稳定项统计 `integration=pending/review/conflict`，不把它的 resolver 再重复计数；完整交付阶段、实际 `source_task_id` 与 blockers 见 `task.ladder.groups`。`merge_freeze` 列出正被未解决冲突冻结的目标分支。agent 身份本身（id / 唤醒次数 / 上次动手时间）可以跨唤醒读取，但它不是可寻址的执行句柄：用户操作一律按 task ID 进行。

以下操作限用户：system.stop、input.submit、task.cancel/retry/merge/cleanup/clear、notice.answer/dismiss。CLI 另禁止 agent 启动 daemon、Web 或阻塞等待。

本地用户可以不带 token 调用 RPC，这是明确的信任边界，不是多用户 ACL。能执行任意本机命令的恶意 agent 也能绕过环境约定；需要真正沙箱时应另加 OS 隔离。
