---
name: lush-delegation
description: Lush 子 Worker 创建、独立分工与非阻塞协调。能力已开启且当前为 order/child Agent，需要创建新子 Worker 前加载。
---

# Lush 子 Worker 委派

仅在当前 invocation 的能力快照开启 `delegation` 且身份适用时使用。

在创建新子 Worker 前，通过 daemon 固定的 CLI 读取完整指南：

```bash
lushw skills show delegation
```

复用 Lush 已有 Worker/worktree/调度及父交付队列，不另建子进程调度器。派出后结束本轮，禁止等待或轮询。既有后代的检查、消息与交付义务属于必需核心，不因本模块关闭消失。不另找 `lushw` 版本，不扩大权限。
