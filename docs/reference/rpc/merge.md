# 合并与交付队列

本节管 `task.ladder`、`task.merge` 与 `task.merge_many`：按目标分支组织待交付变更、冲突后的 resolver、合并冻结及 `superseded`。

| CLI | RPC | 参数 |
|---|---|---|
| `task ladder` | `task.ladder` | `{}` |
| `task merge ID` | `task.merge` | `{id}` |
| `task merge ID...` | `task.merge_many` | `{ids}` |

## 交付队列

`task.ladder` 保留兼容字段 `nodes`，并返回：

```text
{
  current_branch,
  groups: [{
    target_branch,
    current,
    ready,
    items: [{
      id, source_task_id, phase, ready, selectable, blockers,
      branch, target_branch, deps, level, covered_by
    }]
  }]
}
```

`id` 始终是原 worker；`source_task_id` 是本次真正要落地的 task。普通变更二者相同；冲突已解决时，`source_task_id` 是 resolver。阶段为 `awaiting_review` / `review_required` / `conflict_decision` / `resolving` / `resolution_ready` / `resolution_stale`。最后一种表示目标分支已经前进，旧 resolver 无法快进落地，必须明确废弃后重开。`ready` 表示单项此刻可落地；只有 code 上游 blocker、且上游也在同目标分支队列时，`selectable` 仍为 true，界面会自动把完整栈加入批次。其它 `blockers` 都会禁选。

`order` 只约束任务执行，不参与交付顺序。只有 `code` 表示下游分支基于上游提交，因此必须先落地上游。

## 单任务批准

`task.merge` 是用户明确批准合并的入口。三种正常返回：

- `{merge:{status:'merged', included_task_ids?}}`：普通变更落地；
- `{merge:{status:'resolved', resolved_task_id, included_task_ids?}}`：resolver 落地，原任务同时完成；
- `{merge:{status:'conflict', files, resolution_task_id, notice_id, superseded_task_id}}`：主树已 abort，等待是否解冲突。

每次成功后，运行时会把同目标分支上已随本次提交进入目标分支的其它普通 worker 标成 `merged`，记录 `merge.included`，并通过 `included_task_ids` 返回。

## 冲突处理

真 merge 发生内容冲突时，运行时读取冲突文件并 `merge --abort`。abort 成功后原任务进入 `integration=conflict`，同步创建 `role=merger` 的 resolver 并发 notice；resolver 初始为 `awaiting`，答复 notice 才开工，忽略则取消并解除冻结。

resolver 以目标分支当前顶端为基线，把原任务已审阅的 `head_commit` 并进来、解决冲突、提交并测试。resolver 完成且目标分支仍是其祖先时，继续对原任务调用 `task.merge` 会自动落地 resolver；也可以直接传 resolver id。落地必须确认其提交包含原提交，并只用 `--ff-only`。成功后原任务与 resolver 一起标成 `merged`。

原任务有活动 resolver 时不能重试。resolver 已完成但因目标分支被外部 Git 推走而无法快进时，交付阶段变为 `resolution_stale`；这时显式批准原任务表示废弃旧结果并开新一轮，旧 resolver 标为 `superseded`，分支和目录保留。

`integration=conflict` 是按 `target_branch` 派生的冻结锁。同目标分支上的其它合并被拒；不同目标分支互不影响。

## 批量交付

`task.merge_many` 同样限用户，一次最多 50 项。它在写主树之前完成结构预检：

- 全部条目必须是完成且待交付的任务，主树与每个任务 worktree 必须干净，审阅提交不能漂移；
- 一批只能指向一个目标分支，并且当前必须检出该分支；
- 集合外的 `code` 上游必须已经进入目标分支；
- 原任务有活动 resolver 时拒绝；已有完成 resolver 时自动把实际来源映射为它。

顺序只看选中集合内的 `code` 边，并列按 id。执行仍逐项调用同一套单任务守卫；运行期遇到第一个冲突或错误即停止，之后条目为 `skipped`，此前成功的不会回滚。

返回 `{target_branch, merges, merged, stopped}`。每项包含 `{id, source_task_id?, status, integration, error?, resolution_task_id?, included?}`，其中 `id` 是用户选择的稳定原任务 id。

清理见 [磁盘回收与清空](maintenance.md)。
