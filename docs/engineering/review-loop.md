# 交付与验收

本章面向维护交付链路的开发者，区分当前 say 的合并预约、直接父 AP 的集成与用户对 main/owner 的批准。

> 连续阅读：[架构总览](../core-architecture.md) → [执行模型](execution-model.md) → **交付与验收** → [工程索引](architecture.md)

## 从子 AP 到父分支

子 AP 的结果和固定提交先成为持久信号；父 Agent 检查子 AP 状态、自己的工作区及 Git 提交，再显式 `ap.integrate` 快进到父分支。兄弟 AP 或父 Agent 先提交会使旧子提交不再能快进，此时从子侧派解分歧 AP 吸收固定父 tip，测试后确认同时包含两个固定提交的新提交。不得自动在父分支造合并提交或重写子分支。

## say 的合并预约

- **合并请求**：待 say 静息、后代结算、工作区干净且可快进后冻结源 commit 与直接父基线，向父 AP 投递一次请求。请求会锁住父分支的 Lush 写入，直到集成或用户撤销；撤销不删除 AP、分支或提交。

直接父是 say 时，仅运行中的直接父 Agent 能确认请求并快进；父是 main/owner 时，只有用户能按固定 commit 与 baseline 批准。批准前会复核 Git ref、工作区及后代；请求后父 Agent 自行提交或外部 Git 操作仍可能令基线漂移，须复查诊断并在源侧处理或撤销。已在父分支内的固定提交可以幂等关闭请求。详细状态与命令见[AP RPC](../reference/rpc/ap.md)。

## 状态不互相代替

`waiting` 表示暂时没有 invocation，`completed` 表示 AP 已结算，`integration` 表示代码进入了直接父分支；即使进入直接父分支，也未必进入 main。失败工作区、审计事件与消息不会因 AP 结算自动清除。用户可查[分支与回收](branch-first.md)及[工作区回收](cleanup.md)。

---

[← 上一篇：执行模型](execution-model.md) · [下一篇：工程架构索引 →](architecture.md)
