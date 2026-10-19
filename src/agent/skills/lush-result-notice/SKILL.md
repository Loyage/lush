---
name: lush-result-notice
description: 任务仅分析，或用户明确要求做好后告知时加载；结果实际就绪后、结束本轮前主动发布非阻塞 Notice，不能只写最终回答。
---

# Lush 结果告知

仅在当前 invocation 的 `result-notice` 能力开启且身份适用时使用。

自己的任务只是分析一个事情，或用户明确要求“做好了告诉我”等完成提醒时，必须通过 daemon 固定的开发 CLI 读取完整指南：

```bash
lushw skills get result-notice
```

实际完成后调用 `lushw self notice post`（默认 info），不要把告知发成待决问题；不能只依赖最终回答或 runtime 自动提醒。不扩大权限，不改变交付、合并或验收状态。
