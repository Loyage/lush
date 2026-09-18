# Lush 文档

Lush 把 AI 工作组织成**被动的 Process 节点**与**会干活的 Task**。文档按三层组织，从「为什么」到「精确的接口面」再到「怎么改它」：

| 层 | 目录 | 回答什么 | 什么时候读 |
| --- | --- | --- | --- |
| 概念 | [`concepts/`](./concepts/) | Lush 里有什么、不变量是什么 | 想知道「为什么这样设计」「什么可以什么不可以」 |
| 参考 | [`reference/`](./reference/) | 命令、RPC 方法、模板字段的精确形状 | 想查某个命令 / 字段 / 错误码 |
| 工程 | [`engineering/`](./engineering/) | 模块边界、实现约束、版本对齐 | 想改代码，或排查「改完不生效」 |
| 历史 | [`log/`](./log/) | 每一轮工作做了什么、验收了什么 | 想知道某个设计是什么时候、为什么来的 |

## 概念层

- [Process 与 Task 模型](./concepts/process-model.md)：两类实体、生命周期三态、task 树的四条规则、agent 与 task 的关系。
- [生命周期与孤儿监督](./concepts/lifecycle-and-orphans.md)：节点结束、子节点收养、PID 0 的回收策略、删除。
- [Agent 后端与 Context](./concepts/agents.md)：谁在替 task 干活，每次 invocation 看到什么。

## 参考层

- [CLI 与 Justfile](./reference/cli.md)：命令树、命令总览、开发用 Justfile、`--interactive` / `--dry-run`。
- [RPC 协议](./reference/rpc.md)：传输、方法表、错误码、Agent Tools、身份字段。
- [模板（ProcessTemplate）](./reference/templates.md)：字段契约、保留变量名、目录摆放、随仓库发布的模板。
- [Agent profile、session 与内置后端](./reference/agents.md)：profile 文件与选择优先级、session 在哪、`mock` / `openai`。

## 工程层

- [总体架构](./engineering/architecture.md)：模块边界、调用数据流、持久化、源码的分层布局。
- [daemon 与 CLI 的版本对齐](./engineering/identity.md)：为什么「我敲的命令」和「应答我的 daemon」可能不是同一份代码。

## 历史层

- [开发日志](./log/)：TODO / Doing / 按阶段归档的 Done 条目。

## 约定

- 文档只描述**当前**代码的行为。被推翻的旧结论留在 `log/` 里，不回头改写。
- 命令、RPC 方法、模板字段这类「接口面」只在 `reference/` 里写一遍，别处引用而不是复制。
- 改代码后要重启 daemon 才生效，且要重启**正确的那个**：见 [engineering/identity.md](./engineering/identity.md) 与仓库根目录 [AGENTS.md](../AGENTS.md)。
