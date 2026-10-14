---
name: lush-auto-title
description: 为 Lush 当前 order/child 生成一次自动标题。能力已开启且 auto_title 为空时，理解目标后、结束本轮前加载；不单独调用模型。
---

# Lush 自动标题

仅在当前 invocation 的能力快照开启 `auto-title` 且身份适用时使用。

理解目标后、结束本轮前，通过 daemon 固定的 CLI 读取完整指南：

```bash
lushc skills get auto-title
```

按指南为自身命名，不接受目标 ID，不改用户标题、编号或原始输入。不要另开模型调用或子 Worker，不另找 `lushc` 版本。权限与生命周期以必需核心和真实接口返回为准。
