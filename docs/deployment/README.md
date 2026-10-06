# 部署

本层回答“部署在哪里、为什么这样选、怎么配置和验证”。每个场景都有两份配套文档：用户版解释设计、原因和取舍；Agent 版提供环境检查、配置步骤、排错与交付要求。系统内部设计见[核心架构](../core-architecture.md)，接口见[参考索引](../reference/README.md)。

## 按场景选择

| 场景 | 给用户读 | 交给 Agent 配置 |
|---|---|---|
| macOS / Linux 本机后台 | [本机部署](local-deployment.md) | [本机 Agent 指导](agent-guide.md) |
| 服务器自行运行 Host：SSH 转发 / IP端口 / 域名 | [远程 Host](remote-host.md) | [Host Agent 指导](remote-host-agent.md) |
| Windows 同机运行 Linux 后台 | [WSL2 方案](windows-wsl2.md) | [WSL2 Agent 指导](windows-wsl2-agent.md) |

## 阅读与委托顺序

1. 先读用户版，选择后台位置、界面和访问方式。
2. 把对应 Agent 指导和目标机器、已有项目 / 工具、所选模型交给部署 Agent。没有明确的选择时，应先问用户，不默认开公网或迁移项目。
3. 组合场景按后台到客户端顺序配置，例如“服务器 Linux 后台 → 用户配置网络 → Windows 浏览器”。已有后台只补客户端，不重新安装一套。
4. 验收分别记录后台状态、客户端访问和真实模型调用；模拟测试不等于目标平台实测，付费调用需另获同意。

Lush 仅提供 Web UI，无桌面安装包或内置 SSH 部署。WSL2 使用 Linux 后台，不提供 Windows 原生 daemon。SSH、转发、IP/端口、域名与网络配置均由用户管理；Host 允许 HTTP，但明文风险应明确提示，推荐 HTTPS 或自建 SSH 隧道。认证字段与模板集中在 Host Agent 指导维护。

## 相关参考

- [HTTP 与认证](../reference/http.md)：监听、会话与安全约束。
- [CLI 与 RPC](../reference/api.md)：命令与接口入口。
- [Agent 环境与权限](../reference/agent-environment.md)：配置、环境变量与权限边界。
- [项目身份与恢复](../engineering/identity-and-recovery.md)：绑定、锁与重启恢复。
- [文档总览](../README.md)：部署后继续了解使用与架构。
