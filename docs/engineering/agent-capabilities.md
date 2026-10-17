# Agent 内置能力与按需指南契约

目标见[设计理念](../design/agent-capabilities.md)。本章记录内置能力的跨模块契约及兼容边界；精确实现以源码和测试为准。

## 模块与设备设置

| 模块 ID | 设置键 | 范围 |
|---|---|---|
| `progress` | `progress_reporting` | 里程碑计划及完成上报；沿用旧开关 |
| `delegation` | `worker_delegation` | 创建 child、分工及非阻塞协调指南 |
| `auto-title` | `worker_auto_title` | 当前 order/child 的一次性自动标题 |
| `context` | `context_retrieval` | 有界 Worker 摘要、历史与执行记录检索指南 |

三个新增设置键均为布尔值，默认 true；null 清除覆盖恢复默认。沿用 `RuntimeSettings` version 1、设备唯一根、私有校验、共享写锁及原子发布。现有 system.settings/configure 和 Host runtime 接口承载，不新增配置 RPC，不赋予 Agent 配置权限。读取设置不启动项目；后续调用读取权威值，当前调用快照不热切换。

开关只控制注入和主动使用，不添加 RPC 操作禁用门。进度已有隐藏历史／读面兼容保留；其他三个开关不隐藏或删除已有 Worker、标题和历史。核心仍允许为既有后代收尾所必需的检查与合法消息。

## Agent 与 CLI 接缝

- `src/agent/capabilities.js` 维护四项固定注册表、设置解析、角色／task_kind 适用范围、薄入口及内置 Skill 路径；不读凭证，不创建文件，不执行插件代码。导出 `AGENT_CAPABILITIES`、`resolveAgentCapabilities(config,role,taskKind?,settings?)`、`capabilityPromptPart(entries)`、`listCapabilityGuides()` 与 `capabilityGuide(id)`；后两者仅提供固定公开指南，不返回实际启用状态。
- `src/agent/skills/lush-<ID>/SKILL.md` 为标准 Skill 入口，frontmatter 声明名称与使用时机；详细指南作为该目录的固定随代码资源，CLI 从白名单 ID 读取。具体目录以注册表为准，auto-title 可使用 `lush-auto-title`。
- `lushw skills list` 列出随当前 CLI 发布的四项指南；`lushw skills get ID` 输出该模块指南。支持 `--json`、严格参数和未知 ID 拒绝，不接受文件路径，不读取设备私密配置或返回实际启用状态，不联网／安装／写盘／执行模型，无项目及 daemon 离线可用。
- `agentPrompt` 注入适用模块的短入口与明确关闭状态，而非整篇指南。避免在 agent、common_cli 等剩余段落继续重复要求关闭模块的主动操作；安全、生命周期、最低验证责任与结构化决策保留。替代／追加 Prompt 与旧会话不自动重写，明确关闭不是权限隔离。
- Pi 显式加载本 invocation 已启用的内置 Skill 路径，包含 Lush 与 Pi 默认模式，不动用户 Pi 配置。内置模块与显式第三方 resources 区分；manager、explainer、butler 不加载开发插件。Codex 使用相同入口及 CLI 指南，不声称支持 Pi 扩展。
- 同一 invocation 的入口和资源参数来自同一设置快照，避免两次读取跨设置更新造成不一致。`agentPrompt` 返回 `capabilities` 安全状态及 `builtin_skills` 路径快照，provider 不再重读开关。`builtInPrompt(role,{progressReporting?,capabilities?,taskKind?})` 为配置预览使用同一注册表。原 `PROMPT_PARTS` 为兼容保留导出，实际注入不使用长进度／标题片段。

## 全局设置界面

全局设置的系统页提供一个“Agent 能力”分组，四个独立开关。保持旧进度输入标识兼容；每项解释能力及后续调用生效，整体说明已有子 Worker 和当前调用不受影响、不是权限隔离。通过 Host settingsClient 保存 partial patch，无项目及离线可配置，失败恢复真实已保存状态，迟到回复不抢回页面，不把保存配置标成立即调用 Agent。
