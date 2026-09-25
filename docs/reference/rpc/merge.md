# 任务交付兼容接口

本节仅描述旧 planner/worker 协议的兼容交付：`branch.merge` / `branch.sync` 和 Web 分支图，以及 `task.merge` / `task.merge_many`。`say.submit` 创建的 `task_kind='say'` / `'child'` 分支拒绝这些旧合并入口；新子代码由运行中的直接父 Agent 用 `task.integrate` 固定提交确认。新 say 的合并预约会冻结源 commit 与父 baseline、向直接父发请求，并在此期间把父分支锁住（同一父分支只接受一个未集成请求）；父为 main/owner 时由用户用 `task.approve_merge` 按固定值批准快进（见[任务接口](tasks.md)），不经过以下旧接口。

| CLI | RPC | 参数 | 权限 |
|---|---|---|---|
| `task ladder` | `task.ladder` | `{}` | 只读 |
| `task merge ID` | `task.merge` | `{id}` | 用户专属 |
| `task merge ID...` | `task.merge_many` | `{ids}` | 用户专属 |

## 旧协议的输入任务

任务分支的 `target_branch` 等于谱系 direct parent：普通 worker → 输入分支，code 下游 → 上游任务分支，branch-sync merger → 待同步 child。

`task.merge` 对旧协议的输入执行与 `branch.merge` 相同的 ff-only 门槛。父子分歧时返回：

```json
{
  "merge": {
    "status": "diverged",
    "parent": "lush/.../input-3",
    "child": "lush/.../7-api",
    "sync_task_id": 12
  }
}
```

兼容入口会直接创建子侧 sync task；分支图则把“合入父分支”和“在子分支解决分歧”显示为两个明确动作。

## 批量

`task.merge_many` 最多 50 个 task，要求相同 direct parent，预检后逐项处理。由于第一个 sibling 会推进 parent，后续独立 sibling 可能变成 diverged；批次在首个分歧或错误处停止，已落地项不回滚。新的推荐操作是分支图逐条收敛。

## 旧任务迁移

升级前已有任务可能记录了 `谱系 parent = 输入锚点`、但 `target_branch = main`。这类不满足 direct-parent 的 legacy task 继续按旧 target 语义执行，避免升级后无法交付；新输入不会再产生这种形状。

详见：[分支合并](../../engineering/merge.md) · [分支 RPC](branches.md)。
