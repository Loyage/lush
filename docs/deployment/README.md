# 部署

本层回答“部署在哪里、为什么这样选、怎么配置和验证”。每个场景都有两份配套文档：用户版解释设计、原因和取舍；Agent 版提供环境检查、配置步骤、排错与交付要求。系统内部设计见[核心架构](../core-architecture.md)，接口见[参考索引](../reference/README.md)。

## 按场景选择

| 场景 | 给用户读 | 交给 Agent 配置 |
|---|---|---|
| macOS / Linux 本机后台 | [本机部署](local-deployment.md) | [本机 Agent 指导](agent-guide.md) |
| 跨设备访问后台：SSH / 认证 HTTPS | [远程 Host](remote-host.md) | [Host Agent 指导](remote-host-agent.md) |
| SSH-only Linux：桌面首次部署与接入 | [桌面 SSH 部署](ssh-desktop.md) | [SSH Agent 指导](ssh-desktop-agent.md) |
| Electron 连接远程项目 | [桌面远程连接](remote-desktop.md) | [桌面连接 Agent 指导](remote-desktop-agent.md) |
| macOS 桌面安装包：本地与远程 | [macOS 客户端](macos-client.md) | [桌面构建与开发准备](desktop-build-agent.md) |
| Windows 浏览器 / 安装包客户端 | [Windows 客户端](windows-client.md) | [Windows 客户端 Agent 指导](windows-client-agent.md)（含维护者构建） |
| Windows 同机运行 Linux 后台 | [WSL2 方案](windows-wsl2.md) | [WSL2 Agent 指导](windows-wsl2-agent.md) |

## 阅读与委托顺序

1. 先读用户版，选择后台位置、界面和访问方式。
2. 把对应 Agent 指导和目标机器、已有项目 / 工具、所选模型交给部署 Agent。没有明确的选择时，应先问用户，不默认开公网或迁移项目。
3. 组合场景按后台到客户端顺序配置，例如“本机 Linux 后台 → 远程 Host → Windows 客户端”。已有后台只补客户端，不重新安装一套。
4. 验收分别记录后台状态、客户端访问和真实模型调用；模拟测试不等于目标平台实测，付费调用需另获同意。

WSL2 使用 Linux 后台，不提供 Windows 原生 daemon。Windows 安装包只有连接壳，不自动管理 WSL。认证字段与模板集中在 Host Agent 指导维护，其它教程通过链接引用。

## 相关参考

- [HTTP 与认证](../reference/http.md)：监听、会话与安全约束。
- [CLI 与 RPC](../reference/api.md)：命令与接口入口。
- [Agent 环境与权限](../reference/agent-environment.md)：配置、环境变量与权限边界。
- [项目身份与恢复](../engineering/identity-and-recovery.md)：绑定、锁与重启恢复。
- [文档总览](../README.md)：部署后继续了解使用与架构。
