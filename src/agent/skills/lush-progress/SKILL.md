---
name: lush-progress
description: Lush 里程碑进度汇报。能力已开启时，在本轮开始实质工作前加载，实际完成每个步骤后更新；不要提前报完成。
---

# Lush 进度汇报

仅在当前 invocation 的能力快照开启 `progress` 时使用。

开始实质工作前，通过 daemon 为本会话固定的 CLI 读取完整指南：

```bash
lushw skills get progress
```

按指南规划与更新里程碑。不要凭记忆猜命令，不另找 `lushw` 版本。指南只描述使用流程，不扩大权限；当前 Worker、Git、消息及交付仍遵守必需核心。关闭模块不撤销 API 权限，也不改写历史。
