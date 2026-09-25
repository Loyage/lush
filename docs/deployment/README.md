# 部署

本层回答“怎么把 Lush 装起来、跑起来、暴露出去”，面向要部署 Lush 的人，以及被交办这件事的 AI coding agent。系统内部为什么这样设计，见[核心架构](../core-architecture.md)；接口细节见[接口参考](../reference/README.md)。

## 阅读顺序

1. [Agent 部署指导](agent-guide.md)：自包含的部署说明书。把本文交给你的 AI coding agent，它就能完成环境检查、安装、启动（daemon / Web / 桌面）、Agent 配置、远程访问与验证；人也可以直接照着执行。
2. 部署完成后，按[文档总览](../README.md)进入使用与架构阅读。

## 相关参考

- [HTTP 与认证](../reference/http.md)：监听范围、登录会话与安全约束。
- [CLI 与 RPC](../reference/api.md)：完整命令与接口索引入口。
- [Agent 环境与权限](../reference/agent-environment.md)：Agent 配置、环境变量与权限边界。
- [项目身份与恢复](../engineering/identity-and-recovery.md)：项目绑定、锁与重启恢复。
