# Agent 后端与 Context

> 概念层：谁在替 task 干活，以及每一次 invocation 看到什么。

## Agent 后端

Task 的 agent 由这个 service 选中的 agent profile 决定（`service spawn --agent`、模板的可选 `agent` 字段、环境变量、内置 `default`，依次生效）：

- `pi`（默认）：每次 invocation 起一个 `pi --print` 子服务，session-id 是 `lush-task-<id>`。pi 用 read / bash / edit / write 自己的工具，并通过 bash 调 `lush` CLI 操作 Lush（`LUSH_SID` / `LUSH_TASK_ID` 告诉它自己是谁）。取消 invocation 会杀掉子服务。
- `mock` / `openai`：内置运行时，agent 直接拿到 `task_*` / `service_*` 工具，共享说明层切到 tools 版本。

共享说明层（`src/agent/guide.js`）和后端无关：它告诉每个 agent「你是某个 task 的 agent，service 是被动节点；向下游派 task，用 task_wait 收集，子 task 未结束不能 complete；先判断这活归谁再动手」。tools 与 cli 两种模式共用同一份「通用规则」文本。

## Agent 和 Context

Context 持久化保存 system_prompt、state、artifacts、references、messages（按 task 划分）。每次 invocation 的 `LUSH_CONTEXT` 数据里既有 `service`（身份、变量、子服务、可创建模板），也有 `task`（自己的 id / goal / status / result / 父 task）与 `children`（服务）。父信息和 children 每次构建时从当前树读取，不是持久副本。
