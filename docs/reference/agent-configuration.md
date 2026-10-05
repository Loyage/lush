# Agent 配置、来源与运行设置

本文面向用户，说明如何在当前项目管理账号/API、模型目录、扩展与 Skills，以及给 Worker 选择 Lush 配置或 Pi 默认配置。实现边界见[双模式契约](../engineering/agent-configuration-v2.md)。

## 三个入口

- **模型来源**：一个账号/API Key 一个连接。两个 Codex 账号分别添加和登录，分别显示套餐窗口；不能只按模型名判断用了哪个账号。
- **Agent 配置**：项目默认运行方式、来源与模型、思考深度、工作指令及插件/Skills；安装资源与启用资源分开。
- **Worker 运行设置**：创建指令时可选编辑；未编辑沿用项目默认。子 Worker 冻结继承父有效设置。暂停后调整、失败重试均可选完整运行设置。

默认 **Lush 配置**，必须绑定托管来源。**Pi 默认配置**是显式选择，使用执行机器的用户 Pi 配置（通常 `~/.pi/agent`，不是浏览器所在电脑），不注入 Lush 的账号/模型/思考深度/用户资源设置。Lush 必需的任务协议和执行记录仍保留；两种模式使用隔离会话，不自动批准未受信项目。

新式 Worker 的运行覆盖跨失败、重试、交付和验收保留。仅显式清除/更换覆盖才改变；改变设置只影响后续调用，不热切换当前调用。暂存条目只保存想法，不保存运行设置；发射创建后可以在详情调整。

## 来源、模型和额度 CLI

以下命令连接当前所选项目；其他项目必须显式 `--project PATH`。

```bash
bun run lush --json agent sources list
bun run lush --json agent sources show ID
bun run lush --json agent sources models ID
bun run lush agent sources models ID --refresh
bun run lush agent sources refresh ID
bun run lush --json agent resources
```

`list/show/models/resources` 只读本地缓存。`models --refresh` 联网更新模型目录，`sources refresh` 联网查询额度；两者都不发付费模型探测。自动目录同步在 daemon 中低频执行，新增/登录成功后延迟调度。没有列表适配器时使用本地元数据或手动范围，明确未验证；模型目录不保证账号当前有额度或请求一定成功。

`agent resources --json` 的结构化数据供后续管家使用：连接、支持后端、模型目录、额度及观测时间。不返回凭证。现金、Key 预算和套餐窗口不能互相当作同一“余额”；失败/未知不是零，旧值须看时间。当前没有自动换账号或自动降级。

账号录入推荐使用 Web「模型来源」。CLI 可用 `agent sources save --file PATH`，文件为 owner-only（例如 `chmod 600`）JSON，形状为 `{connection,credential?}`，具体字段见[连接契约](../engineering/agent-connections.md)。不要把 Key 填进命令行。设备码登录：`agent sources login ID`，用户完成授权后显式 `login ID --poll LOGIN_ID`；CLI 不自动等待或轮询。备用回调流程见 `lush help` 与[设备码契约](../engineering/codex-device-login.md)。

## 选择配置模式

```bash
bun run lush agent set default --config-mode pi
bun run lush agent set default --config-mode lush --connection UUID --model PROVIDER/MODEL
bun run lush order '目标' --profile-file /private/worker-profile.json
```

`--config-mode pi` 会清掉托管运行选项，不可同时指定来源或模型。Worker profile 文件必须是 owner-only 的小型普通 JSON 文件，不接受链接。最小 Pi 默认配置为 `{"agent":"pi","config_mode":"pi"}`；Lush 配置沿用完整 Agent profile，见[接口契约](../engineering/agent-configuration-v2.md)。只有 Pi 支持该双模式，Codex CLI 仍使用自身认证；隔离的无工具 Agent 不允许 Pi 默认模式。

## 插件与 Skills

```bash
bun run lush --json agent packages list
bun run lush agent packages install 'npm:@example/pi-tools@1.2.3'
bun run lush agent packages install ./trusted-local-package
bun run lush agent packages update PACKAGE_ID
bun run lush agent packages remove PACKAGE_ID
```

只管理当前项目私有 Lush Pi 目录，不更改用户默认 Pi。远端 npm 要求精确版本，Git 要求显式 ref；Git tag/branch 可能被远端移动，追求可复现时使用完整 commit。更新始终显式操作。已安装的扩展/Skills 在 Lush 配置和 Worker 表单中勾选启用；安装不自动启用、不调用 Agent。

扩展及安装器可能执行代码，Skills 可能引导模型执行命令。私有文件权限和独立配置不是沙箱，请只安装信任的资源。真实账号登录、模型请求及第三方网络包安装仍需在自己的环境显式验收。

[返回文档入口](../README.md)
