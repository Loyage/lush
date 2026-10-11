# Lush 进度汇报指南

只在本 invocation 的 `progress` 能力开启时主动使用。身份由本次有效 Agent token 决定，只汇报自身 Worker，不接受其他 Worker ID。开关不撤销 API 权限，不修改当前调用、已有计划或历史。

## 规划

理解本轮目标后、开始实质工作前，用 `lush progress plan KEY[:显示名]...` 汇报少量、有序、用户能理解的里程碑。稳定 key 只用小写英文、数字、下划线或短横线。

```bash
lush progress plan inspect:确认现状 implement:实现 test:测试 git_commit:提交
```

计划属于当前 Worker，不是旧 planner 的 Plan/spec。计划变化时重新提交整份计划，同 key 的已完成状态和计时会保留；当前调用实际收到新的普通用户追加输入时，新计划按新一轮工作重置，Notice 答复和子 Worker 信号不冒充新用户需求。

## 完成

每一步实际完成后调用：

```bash
lush progress complete inspect
```

可以与同一阶段的实际命令合并调用，不为状态维护增加额外往返。不要提前完成，失败步骤也不能标完成。选定的测试必须实际完整跑完，不能只看到启动输出就标完成。

漏报后越序完成会自动推进，但被跳过步骤仍是未确认完成、受影响耗时未知。补报只在确实完成时进行，不会恢复缺失的计时边界。

派完子 Worker 准备结束时，不要把“等待子 Worker”标完成；被唤醒并确认结算后再完成。等待时结束本轮让 runtime 释放调用位，不 sleep、wait、poll 或启动后台进程。

## 展示与权限

面向用户使用资料里明确的 worker_number，未知才回退 #内部ID，不从整数 ID 推算 W 编号。历史记录保留，关闭时读面隐藏不是删除。配置开关为用户专属，Agent 不改变全局设置。
