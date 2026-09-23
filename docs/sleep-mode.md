# 我去睡觉了

本模式用于你长时间离开界面、希望已有开发任务继续推进的场景。入口在 **设置 → 我去睡觉了**；实现与权限接缝见[模块地图](engineering/modules.md#我去睡觉了接缝)。模式属于当前项目，由 daemon 执行，不依赖浏览器保持打开。

## 开启与关闭

开启前选择：

- **全通过／推荐**：直接批准计划、选择每道题唯一标注「（推荐）」或 `(Recommended)` 的选项，不为确定性选择花模型 token。没有明确推荐项、推荐项冲突或必须自由回答时，由管家 Agent 推断并记录理由。
- **参考以往选择**：管家读取最近 20 条已回答 Notice 的有界摘要，区分用户亲自回答与管家代理回答，结合任务目标作出选择。历史不全或不足时是推断，不是已确认偏好。
- **整个项目 token 预算**：可填 1–1,000,000,000 的整数，留空不限额。包括普通开发、规划、介绍、管家等所有 Agent 在模式期间新增的输入、输出及缓存 token。
- **是否处理已有 Notice**：默认不勾选，只处理开启后发布的事项；勾选后也处理之前留下的未处理事项与信息提醒。
- **是否允许自动合并**：默认不勾选。勾选后，对于交付信息 Notice 对应的已完成、待合并任务，管家可调用现有安全合并入口。它不凭文本猜 Git 命令，不收拢没有 Notice 的任意分支，不跳过依赖、工作区安全或 Candidate 验收门。

点击「阅读风险并开启」，核对模式、预算、权限范围，并在警告框再次明确确认才会正式开启。可能的后果包括错误回答、错误审批、偏好误判、持续消耗 token，以及获授权时修改目标分支。

开启后左栏常驻状态及 **立即关闭睡觉模式** 按钮；关闭不需要再次确认。关闭后不再执行新决定，会停止未完成的管家调用，但不会撤销已提交的答案、已经开始的 Git 操作或停止所有普通开发调用。

横幅在开启或预算暂停时同时显示本次值守的进度：**已处理** 是本次会话内已经给出结果（有 `sleep.choice.finished`）的 Notice 条数，包含纯信息提醒的已阅；**由管家作出选择** 是其中 `decision.action` 属于 `approve` / `reject` / `answer` / `dismiss` / `merge` 的条数，纯 `acknowledge` 不计入。计数随轮询实时增长，按会话归零（关闭后再开启是新会话），预算暂停后保留。

CLI 同样可以控制（操作别的项目时加 `--project PATH`）：

```bash
bun run lush sleep on --mode recommended --budget 200000 --existing no --merge no --confirm
bun run lush sleep on --mode preferences --budget 200000 --existing yes --merge yes --confirm
bun run lush sleep status
bun run lush sleep off
bun run lush sleep choices
bun run lush sleep choices --before 123
```

不带 `--confirm` 时只显示风险并拒绝开启；已有事项与合并权限必须分别写明 yes/no。所有 sleep RPC 都限用户，普通开发 Agent 不能开启或改写授权。

## 预算与暂停

预算每秒检查，并在新调度和执行管家选择前复查。它读取已经落盘的项目会话用量，不是供应商的硬限额：尚未返回的请求、用量写入延迟、扫描耗时都可能造成超额，无法承诺恰好在某个 token 停止。

到限后关闭管家、暂停新调度、中止活动 invocation，保留所有工作区和排队任务。中止任务标为失败，错误中解释预算原因，不自动重放未知副作用。活动父任务被中止时，其子任务仍遵循既有取消级联。可见的用量缺失、损坏或读取故障会保守暂停；并非所有供应商的未报告消耗都能被检测。

关闭模式不会解除预算暂停。回来后检查现场，再通过左栏「恢复排队任务」或以下命令恢复：

```bash
bun run lush sleep resume
```

恢复只启动原本排队的任务，不重新开启睡觉模式；已失败／取消的任务仍需人工检查后显式 retry。

## 回看管家选择

**待我处理 → 管家选择** 独立于普通 Notice 状态筛选，提供分页历史。每条包含原 Notice 快照、当时的选项、模式、选择／答复、理由、执行状态及失败／中断说明。它们不是用户亲自确认的决定。

纯信息提醒记录「已阅」或授权后的合并尝试，不伪造用户回答。模型输出无效、事项已被用户处理、权限已关闭或预算暂停时不会强行执行；失败也会留档。为了避免循环消耗，一条已认领事项不自动重试，需回来后人工处理。

授权、预算和暂停状态写入项目 SQLite 的 meta；选择意图及结果使用既有 Event，不引入业务表。daemon 重启保留模式及累计用量，但中断的选择不自动重放，结果未知的 Git 操作标明需要人工检查。源任务删除不删除独立选择快照；显式清空整个项目仍会清除全部 Event，须先关闭睡觉模式并等待管家操作结束。

## 模型与隔离

管家是专用 `butler` 角色：无开发 Input、无 worktree、无工具、扩展、Skills、上下文文件发现或 RPC 凭证。可在 Agent 设置中配置其 Pi 模型；不支持将 Codex 的开发权限用于管家。普通开发任务仍可使用 Pi 或 Codex。

Agent 仅输出严格校验的结构化建议，由运行时重新检查授权、预算及 Notice 现状后执行。重启或关闭后的迟到结果不会覆盖用户答案；已经开始的 Git 操作可能完成，执行结果会保留。

## 接口

| RPC | 参数 |
|---|---|
| `sleep.start` | `{options:{mode,budget_tokens,include_existing,allow_merge},confirmed:true}` |
| `sleep.stop` | `{}` |
| `sleep.resume` | `{}` |
| `sleep.status` | `{}` |
| `sleep.choices` | `{before?:正整数,limit?:1..50}`，默认 30 |

`sleep.status`（以及镜像到 `system.status.sleep` / `system.summary.sleep`）在授权、预算与暂停状态外，返回本次会话的进度字段 `handled`（已处理的 Notice 条数）与 `decisions`（其中作出实质选择的条数）。两者只由既有 `sleep.choice.started` / `sleep.choice.finished` 事件按当前 `session` 汇总，不新增 Event、表或列。

Web 读取 `GET /api/sleep` 与 `GET /api/sleep/choices?before=ID&limit=30`；变更经既有认证及同源保护的 `POST /api/action`。状态也镜像到 `system.status.sleep` / `system.summary.sleep`。选择页返回 `{choices,cursor,has_more}`，有字节上限但不丢续页游标。
