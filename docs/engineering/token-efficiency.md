# Token 效率与用量归因

本文面向维护 runtime、Agent 和 CLI/Web 的开发者，说明如何减少重复上下文与无效 invocation，而不牺牲原始证据、隔离工作区和人工合并批准。模块接口见[模块地图](modules.md)，执行记录的阅读取舍见[设计理念](../design/agent-process.md)。

## 启动上下文

`src/core/project/context.js` 按任务因果关系组装上下文，不注入全项目 `recent_tasks`。

- 普通任务携带父任务摘要、最多 50 个直接子任务摘要、依赖、所属输入的用户引用、未决 notice；未读消息单独送达。
- goal / error 摘要分别至多 500 / 1000 字符；仅依赖附带至多 1500 字符的结果，避免重复子任务成功收据。
- 截断明确标记。需要原文时按 task ID inspect / transcript，不能把截断当作不存在。
- planner、verifier、merger、showcase、explainer 保留各自专用上下文。explainer 仍不获得任意项目上下文、任务凭证或工具。
- 启动文件使用多行 JSON，去除 token hash 与重复的完整 prompt 配置；当前任务上一轮结果限 2000 字符并标记。
- Pi 使用 `@task-N-input.md` 直接附带输入文件，不必再消耗一次模型响应去 read；原始文件仍保留在 sessions。

内置 prompt 要求按需读取、缩小搜索范围并排除生成物；成功测试只报告命令、范围、计数和日志路径，失败保留相关错误。它们是模型指导，不是删除工具输出或日志的硬过滤器。

## 当前 say 与旧快速路由

当前 `say` 一条输入直接创建 Task，不经过 planner 或快速路由；Agent 自行判断亲做还是派子任务。旧 `input.submit` / 批量 `draft.commit` 才按运行设置里的前缀表跳过规划模型、创建 worker/research 根任务及零 invocation 的 planner 占位；规则见[旧输入和规划](inputs-and-planning.md)。旧 planner 的 prompt 鼓励轻量规划，不重复执行者的代码调研。

## 父任务合并唤醒

普通成功子任务的结算消息仍立即落库，但父任务在还有非终态直接子任务时不因此再调用模型。最后一个子任务终态后，一次性投递未读收据。

- runtime 写入 `child.completed` 事件，并记录对应 message ID；只有这类认证收据允许延后。
- 显式用户/agent 消息、失败与取消结算仍及时变成可调度；正在运行的 invocation 不被强行插入消息。
- 不能按消息正文猜测是否为成功收据，否则显式求助可能丢失。
- park / invocation finally / 异常处理 / daemon recover 使用同一判断，既防止空转，也避免父任务尚未清理时的 lost wakeup。
- planner 的 Work DAG 仍由确定性的 `compilePlans()` 编译，不恢复旧 scheduler 模型调用。

## Pi 可选软预算

项目默认和角色 profile 可配置 `soft_budget: { responses?, tokens? }`。默认未设置；空对象等同关闭。CLI 示例：

```bash
bun run lush agent set worker --budget-responses 30 --budget-tokens 200000
bun run lush agent set worker --budget-responses off --budget-tokens off
```

`responses` 为 1..10000 的整数，`tokens` 为 1..1000000000 的整数。角色 profile 沿用已有的整份覆盖语义；Web 设置中也可填写或清空这两项。配置只影响之后的 invocation。

`src/agent/pi-runtime.js` 是显式加载的本地 Pi extension，无第三方运行时依赖：

1. 每个 invocation 重新计数；session_start 记录 task / run / role 身份。
2. message_end 统计 assistant 响应数及已知 token（包含缓存读取/写入，不重复叠加 reasoning）。缺失用量单独计数，不假称为零成本。
3. 任一阈值达到后，仅在下一次自然模型请求的 context hook 中注入一次收尾提醒，并记录 `lush.soft_budget` 事件供审计和执行记录查看。
4. 若本轮已结束，不为提醒制造新请求；不改模型、不拦工具、不强停、不削弱测试要求。

Codex 没有等价 hook，启用时明确拒绝。explainer 不继承默认预算，也不允许显式启用，以保留它的最小无扩展边界。预算不替代已有 invocation 次数限制和超时；也不是严格 token 上限或费用承诺。

## 归因与历史兼容

`usage-statistics.js` 仍只读扫描会话，`usage-attribution.js` 在相同时间筛选范围内汇总 role / task / invocation：

- 新普通 Pi 记录使用 `lush.invocation` custom entry（无扩展 explainer 仍走时间匹配）；Codex 的规范化 usage 行携带 `lush` 身份。
- 历史记录先由文件名关联 task，再用唯一匹配的 `agent_runs` 时间区间归因 invocation。无时间、区间重叠或记录被删除时明确归入 unknown，不猜测。
- 新身份记录在数据库 task 被删除后仍可归因；旧记录未保存的身份不能补造。数据库归因每次重算，不随文件解析缓存固定。
- 分开统计输入、输出、缓存读取/写入、总 token、估算 USD、未知 token 和未知费用；缓存 token 不按非缓存输入价格计费。
- task / invocation 表各最多 100 组，按估算费用、token 降序，返回总组数及截断标记；总量和角色表不受展示上限影响。
- task 状态和 integration 同时显示，completed 不等于 merged；零调用的 planner 不产生虚构 usage 行。

这些统计用于发现高成本环节，不是自动评判失败任务没有价值，也不证明直接执行或某个模型必然更便宜。原始会话不被迁移、裁剪或覆盖。

## 紧凑读写面与回归

`task list --brief` 默认 30 条、最多 200 条摘要，按 task ID 升序，返回 `has_more / next_after`；继续读取用 `--after`。普通列表与 RPC 返回不变。`progress` 默认短确认，`--json` 保留完整对象。`doctor` 默认身份摘要，`--verbose` 保留完整 daemon 状态。

回归入口：`test/project/token-efficiency.test.js`、`test/soft-budget.test.js`、`test/usage-attribution.test.js`、`test/token-cli.test.js`、`test/web/dom-token-efficiency.test.js`。测试只操作临时项目及受控进程，不启动真实模型。改动生效仍需重启所选项目 daemon 和已运行的 Web；不要在有活动任务时为了测试重启用户项目。
