# Agent 配置、来源与运行设置

本文面向用户，说明如何在全局工作台管理设备共享的账号/API、模型目录、扩展与 Skills，以及给 Worker 选择 Lush 配置或 Pi 默认配置。实现边界见[双模式契约](../engineering/agent-configuration-v2.md)。

## 三个入口

- **模型来源**：一个账号/API Key 一个连接。两个 Codex 账号分别添加和登录，分别显示套餐窗口；不能只按模型名判断用了哪个账号。
- **Agent 配置**：设备默认运行方式、来源与模型、思考深度、工作指令及第三方插件/Skills；安装资源与启用资源分开。
- **Worker 运行设置**：创建指令时可选编辑；未编辑沿用设备默认。子 Worker 冻结继承父有效设置。暂停后调整、失败重试均可选完整运行设置。

默认 **Lush 配置**，必须绑定托管来源。**Pi 默认配置**是显式选择，使用执行机器的用户 Pi 配置（通常 `~/.pi/agent`，不是浏览器所在电脑），不注入 Lush 的账号/模型/思考深度/用户资源设置。Lush 必需的任务协议和执行记录仍保留；两种模式使用隔离会话，不自动批准未受信项目。

新式 Worker 的运行覆盖跨失败、重试、交付和验收保留。仅显式 `worker.clear_override {id}`（Web「清除运行覆盖」/CLI `worker config reset ID`）或重新保存完整覆盖才改变；改变设置只影响后续调用，不热切换当前调用。暂存条目只保存想法，不保存运行设置；发射创建后可以在详情调整。

## 来源、模型和额度 CLI

以下命令连接当前所选项目；其他项目必须显式 `--project PATH`。

```bash
bun run lush --json agent source list
bun run lush --json agent source show ID
bun run lush --json agent source models list ID
bun run lush agent source models refresh ID
bun run lush agent source refresh ID
bun run lush --json agent model choices
```

source list/show、source models list 与 model choices 只读本地缓存。独立写入口 source models refresh 联网更新模型目录，source refresh 联网查询额度；两者都不发付费模型探测。自动目录同步在 daemon 中低频执行，新增/登录成功后延迟调度。没有列表适配器时使用本地元数据或手动范围，明确未验证；模型目录不保证账号当前有额度或请求一定成功。

`agent model choices --json` 的版本化外壳 data 供后续管家使用：连接、支持后端、模型目录、额度及观测时间。不返回凭证。现金、Key 预算和套餐窗口不能互相当作同一“余额”；失败/未知不是零，旧值须看时间。当前没有自动换账号或自动降级。

账号录入和设备码／回调登录使用现有 Web「模型来源」，不再提供 source save／login CLI。不要把 Key 填进命令行。后台凭证与显式授权流程不变，见[连接契约](../engineering/agent-connections.md)和[设备码契约](../engineering/codex-device-login.md)。

## 选择配置模式

推荐通过已有 Agent 配置和 Worker 运行设置表单选择模式。CLI 只保留 `config agent replace --data JSON` 提交完整显式设备配置，以及 `worker config set ID --data JSON` 提交完整 Worker 覆盖；不再提供细项 config agent set／reset 或本地 profile 文件参数。order／input draft submit 的 `--data JSON` 直接承载原 profile，追加仍禁止覆盖；不要在 argv 中提供秘密。

最小 Pi 默认 Profile 为 `{"agent":"pi","config_mode":"pi"}`，不能混入托管来源／模型等选项；它是 Profile，不是完整设备配置。完整设备配置形状及角色见对应叶帮助和[接口契约](../engineering/agent-configuration-v2.md)，不能从安全摘要补造私有设置。只有 Pi 支持该双模式，Codex CLI 仍使用自身认证；隔离的无工具 Agent 不允许 Pi 默认模式。

## Lush 内置能力

全局「设置 → 系统 → Agent 能力」可选择进度、子 Worker 委派、自动标题和上下文检索。采用薄 Skill 入口和按需 `lushw skills show ID` 指南，设置只影响后续注入与主动使用，不撤销 API 权限或中断已有 child。Pi 两模式与 Codex 的接入、旧进度兼容及限制见[Agent 能力开关](../agent-capabilities.md)。

## 第三方插件与 Skills

安装库使用已有用户设置／RPC 管理，不再提供 agent package CLI。只管理设备私有 Lush Pi 安装库，不更改用户默认 Pi。远端 npm 要求精确版本，Git 要求显式 ref；Git tag/branch 可能被远端移动，追求可复现时使用完整 commit。更新始终显式操作。已安装的扩展/Skills 在 Lush 配置和 Worker 表单中勾选启用；安装不自动启用、不调用 Agent。

扩展及安装器可能执行代码，Skills 可能引导模型执行命令。私有文件权限和独立配置不是沙箱，请只安装信任的资源。真实账号登录、模型请求及第三方网络包安装仍需在自己的环境显式验收。

[返回文档入口](../README.md)
