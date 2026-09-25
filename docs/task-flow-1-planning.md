# 历史流程：提交 Intent 与编译 Plan

本章覆盖一条需求进入 Lush 后的前半程：固定代码基线、保存用户原话，并把结构化 Plan 确定性编译为 Work DAG。

> 本章仅适用于旧 `input.submit` / 批量 `draft.commit` 和存量任务；当前 say 见[当前流程](task-flow.md)。

> 历史流程：**提交与规划** → [集成与候选](task-flow-2-integration.md) → [验收与回收](task-flow-3-delivery.md)

## 提交 Intent

```bash
lush say '实现搜索页面' --branch release/next
# 或
lush draft commit --branch release/next
```

省略 `--branch` 时使用项目当前检出分支。runtime 立即：

1. 从指定本地分支的已提交 tip 创建 `lush/<hash>/input-<id>`（私有 Intent 集成分支）；
2. 检出到 `.lush/worktrees/input-<id>`；
3. 保存原话并创建根 planner；
4. 让 planner 在该 worktree 中解析。

父分支之后前进、主工作树切换或有未提交修改，都不会改变这条输入看到的代码。未提交修改不会被复制进集成分支。

能直接回答的输入不派生任务；需要只读调研时写 research spec，改代码的工作才建 worktree / 分支。

## Plan 编译

planner 只写结构化 Plan（`lush spec add`）。它结束一轮后，runtime 在事务里直接把 spec 编译成根 WorkItem 与依赖边：

- 无依赖 worker：从 Intent 冻结的 commit 创建，direct parent 是 Intent 集成分支；
- `code` 依赖：从上游 reviewed commit 创建，direct parent 是上游任务分支；
- `order` 依赖：只等上游终态，代码仍从冻结起点开始；
- research / coordinator：不产生可交付分支；
- verifier：只读对照，不产生可交付分支。

**没有 scheduler agent**：机械的 ID 翻译与建依赖由代码完成，不消耗模型调用，也不存在全项目串行批次。planner 使用独立 control lane，不会被长 worker 饿死。

每个 worker 在自己的 worktree 修改、测试、提交。工作区不干净或没有提交时不能正常完成。

---

[返回当前流程](task-flow.md) · [下一篇：集成与候选 →](task-flow-2-integration.md)
