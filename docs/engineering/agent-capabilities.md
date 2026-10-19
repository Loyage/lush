# Agent 内置能力与按需指南契约

目标见[设计理念](../design/agent-capabilities.md)。本章记录内置能力的跨模块契约及兼容边界；精确实现以源码和测试为准。

## 模块与设备设置

| 模块 ID | 设置键 | 范围 |
|---|---|---|
| `progress` | `progress_reporting` | 里程碑计划及完成上报；沿用旧开关 |
| `delegation` | `worker_delegation` | 创建 child、分工及非阻塞协调指南 |
| `auto-title` | `worker_auto_title` | 当前 order/child 的一次性自动标题 |
| `context` | `context_retrieval` | 有界 Worker 摘要、历史与执行记录检索指南 |
| `result-notice` | `result_notice` | 任务仅分析或用户明确要求完成提醒时，主动发布非阻塞结果告知 |

能力设置键均为布尔值，默认 true；null 清除覆盖恢复默认。沿用 `RuntimeSettings` version 1、设备唯一根、私有校验、共享写锁及原子发布。现有 system.settings/configure 和 Host runtime 接口承载，不新增配置 RPC，不赋予 Agent 配置权限。读取设置不启动项目；后续调用读取权威值，当前调用快照不热切换。

开关只控制注入和主动使用，不添加 RPC 操作禁用门。进度已有隐藏历史／读面兼容保留；其他开关不隐藏或删除已有 Worker、标题和历史。结果告知不改变 runtime 自动提醒；两者可各发一条，设备提醒渠道偏好仍独立生效。核心仍允许为既有后代收尾所必需的检查与合法消息。

## Agent 与 CLI 接缝

- `src/agent/capabilities.js` 维护固定注册表、设置解析、角色／task_kind 适用范围、薄入口及内置 Skill 路径；不读凭证，不创建文件，不执行插件代码。导出 `AGENT_CAPABILITIES`、`resolveAgentCapabilities(config,role,taskKind?,settings?)`、`capabilityPromptPart(entries)`、`listCapabilityGuides()`、`capabilityGuide(id)` 与 `capabilitySource(id)`；只投影固定公开元数据、指南或入口与指南原文，不返回实际启用状态。
- `src/agent/skills/lush-<ID>/SKILL.md` 为标准 Skill 入口，frontmatter 声明名称与使用时机；详细指南作为该目录的固定随代码资源，CLI 从白名单 ID 读取。具体目录以注册表为准，auto-title 可使用 `lush-auto-title`。
- `lushw skills list` 列出随当前 CLI 发布的内置指南；`lushw skills show ID` 输出该模块指南。支持 `--json`、严格参数和未知 ID 拒绝，不接受文件路径，不读取设备私密配置或返回实际启用状态，不联网／安装／写盘／执行模型，无项目及 daemon 离线可用。
- `agentPrompt` 注入固定 CLI 的真实 `catalog_version`、少量领域索引、按需 help/search/workflow 入口，以及适用模块的短入口与明确关闭状态，而非整篇指南。同版本静态用法可复用，不要求每次执行前先查帮助；版本变化或迁移提示只使相关知识失效，不重发写入，实时权限与 revision 不作静态缓存。避免在 agent、common_cli 等剩余段落继续重复要求关闭模块的主动操作；安全、生命周期、最低验证责任与结构化决策保留。替代／追加 Prompt 与旧会话不自动重写，明确关闭不是权限隔离。
- Pi 显式加载本 invocation 已启用的内置 Skill 路径，包含 Lush 与 Pi 默认模式，不动用户 Pi 配置。内置模块与显式第三方 resources 区分；manager、explainer、butler 不加载开发插件。Codex 使用相同入口及 CLI 指南，不声称支持 Pi 扩展。
- `result-notice` 按实际任务目标识别纯分析（含普通 order/child 与只读 analysis），或用户明确要求完成提醒；结果实际就绪后主动调用 `lushw self notice notify`（`context.notice`）的 info 模式。普通进度、等待与中途安全停止不触发；不以问卷代替告知，不把告知当合并或验收，失败／未知不得伪报送达。完整流程由固定指南维护，发布参数见 [Notice 契约](../reference/rpc/notices.md)。
- 同一 invocation 的入口和资源参数来自同一设置快照，避免两次读取跨设置更新造成不一致。`agentPrompt` 返回 `capabilities` 安全状态及 `builtin_skills` 路径快照，provider 不再重读开关。`builtInPrompt(role,{progressReporting?,capabilities?,taskKind?})` 为配置预览使用同一注册表。原 `PROMPT_PARTS` 为兼容保留导出，实际注入不使用长进度／标题片段。

## 工作台 Skills 页面

用户工作台侧栏的 `#skills` 独立页面管理 Lush 内置 Skills，系统设置只保留跳转入口，不重复维护开关。默认卡片展示用途、已确认状态与直接保存开关；“使用说明”按需展开适用时机及关闭影响。窄屏单列，保留旧进度输入标识兼容，不安装或管理第三方 Skills。每卡另有默认折叠的“查看 Skill 原文（只读）”，展开才读取随当前 Host 发布的完整 `SKILL.md` 及 `guide.md`，按纯文本展示、可选择复制、不提供编辑或正文保存；关闭的 Skill 也可阅读，内容不是已有 Worker 的调用快照。读取失败可显式重试，离页或重新读取设置后旧响应不能覆盖新页面。

Host 的现有 runtime 读模型与 configure ACK 附加 `builtin_skills`，由 `listCapabilityGuides()` 同源投影公开元数据（含 trigger/effect，不含磁盘路径），前端不另存能力或设置键清单。用户专属根 `GET /api/host/skills?id=<模块ID>` 只接受注册表白名单 ID，返回 `{version:1,id,name,title,entry,guide}`；每个文件最多 65536 UTF-8 字节、原样保留，不接受路径、token、未知／重复参数或写方法，不读取设备配置、启动项目或执行内容。缺少元数据／布尔状态时提示更新 Host，不猜测开启状态。通过 Host settingsClient 保存设备 partial patch，无项目及项目离线可配置；保存中单飞，失败恢复上次确认状态并要求重新读取核对，迟到回复不抢回页面。统一说明后续调用生效、当前调用及已有子 Worker 不受影响、不是权限隔离，保存不立即调用 Agent。
