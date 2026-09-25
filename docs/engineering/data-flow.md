# 数据流与组件边界

本文面向修改 runtime 接缝的开发者；各文件职责和导出签名见[模块地图](modules.md)。

```text
CLI / Web → RPC（身份、参数、权限） → Project（Input / Task / 消息 / 生命周期）
                                         ├→ Store（SQLite 业务与审计事实）
                                         ├→ Dispatcher → provider（每次调用记录 Run）
                                         ├→ Workspaces（串行 Git 写入、谱系与工作区）
                                         └→ 只读投影 → CLI / Web
```

新 say 直接关联 Input 与 Task，引用作为 Input/Draft 附件持久化；下一轮 Agent 读取引用快照与可解析的当前状态，不在正文中插隐藏标记。子任务信号先写 Message/Event 再唤醒父 Task，父 Agent 显式确认固定子提交；合并预约与 main/owner 的用户批准分开处理。

SQLite 是 Input、Task、Message、Notice、Event 及 Run/Artifact 等结构化事实来源；Git ref/worktree 是代码事实来源，不能仅凭数据库标记断言某提交已落地。UI 不直接操作数据库或 Git。旧客户端另走 Plan Compiler、私有集成与 Candidate 链，见[旧协议意图层](intent-layer.md)。
