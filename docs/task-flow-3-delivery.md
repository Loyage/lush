# 验收、诊断与安全回收

本章从 Candidate ready 开始，覆盖最终接受、要求修改、分支诊断、证据查看和历史回收。

> 连续阅读：[流程总览](task-flow.md) → [提交与规划](task-flow-1-planning.md) → [集成与候选](task-flow-2-integration.md) → **验收与回收**

## 用户验收

```bash
lush candidate accept 2                  # 接受这版固定 commit 并合入目标分支
lush candidate changes 2 '按钮再明显一点'  # 要求修改：保留旧版本，在同一 Intent 下启动增量规划
lush candidate reject 2 --reason '方向不对' # 放弃这版结果
```

`accept` 会再次校验当前集成分支 tip 仍等于被审阅 commit；不等时报错并要求生成新版本，绝不夹带用户没看过的内容。校验通过并进入 `accepted` 后不支持取消接受，并发的 reject、changes 或 prepare 新版本会被拒绝；随后按 direct-parent / ff-only 规则合入目标分支，Git 失败才回到 `ready`。

`changes` 把旧版本标为 `changes_requested`，新 planner 拿到反馈后写增量 Plan，产出 Candidate v2；旧 commit 与旧报告都保留。

## 分支诊断（高级）

分支图仍是完整的 Git 诊断视图：fork 谱系、ahead/behind、可 fast-forward / 已分歧 / 已进入父分支 / ref 缺失，以及 worktree 状态。

```bash
lush branch tree --verbose
lush branch show TASK_ID
```

每条 `parent → child` 连线显示：

- **可 fast-forward**：parent 是 child 的祖先；
- **已分歧**：两边都有独有提交，需要在子侧同步；
- **已进入父分支**：child 已经是 parent 的祖先；
- **缺失 / 未知**：ref 不在或没有可信 recorded parent。

### 手工推进分支

```bash
lush branch merge CHILD      # 子分支 fast-forward 合入其 recorded direct parent
lush branch sync CHILD       # 分歧时创建 child-side merger
lush branch catchup CHILD    # 子分支没有独有提交时快进跟上父分支
```

正常状况下 Plan 编译出的工作已经自动收敛，这些命令用于诊断、恢复或手动干预。只有 fast-forward 会落地；parent 已检出时要求它干净，未检出时用 compare-and-swap 原子推进 ref。

`task merge ID` 是兼容入口，遵守同一套 direct-parent / ff-only 规则。

## 审阅与证据

```bash
lush task inspect ID      # 结果、Run 历史、Artifacts、依赖、工作区
lush task diff ID         # 当前改动
lush task transcript ID   # agent 的思考、工具调用与输出（追溯用）
lush task usage ID        # 模型、上下文占用与累计花费
lush task verify ID       # 兼容的单 worker 对照检验
```

`tasks.head_commit` 是 agent 最初交付时审阅过的 commit。每次 provider invocation 另有一条 `agent_runs` 记录，成功输出形成 `run.result` Artifact。

## 完成、清理与归档

- `completed + pending`：agent 已交付，分支尚未进入直接父分支；
- `completed + merged`：该任务分支已进入直接父分支（Plan 编译出的工作会自动到达这里）；
- Candidate `integrated`：整条 Intent 的结果已经进入用户目标分支。

```bash
lush task cleanup ID [--keep-branch]
lush task delete ID
lush task clear
```

`task delete ID` 删掉这条已结束任务与它的全部已结束后代的行（消息、事件、notice、spec 一并清），是唯一会丢任务历史的日常入口：子树里有活动任务、planner 还有未处理 spec、有 verifier / 候选指着它，或磁盘状态收不回来时拒绝，一行都不删。

不 force。任务分支 tip 必须仍包含 reviewed commit，且整个 tip 已进入 target；输入分支已推进时也必须先进入其 parent。脏 worktree、未交付 commit 或外部改动都会让 runtime 保留现场并说明原因。

不想再要某条分支的代码时用归档：

```bash
lush branch archive BRANCH [--discard]
```

归档明知可能未合并也允许删掉 worktree 与本地 ref（用户显式放弃），但保留分支记录（`status=archived`）、任务行、消息、事件与 `.lush/sessions/` 里的 pi 会话文件。**归档一条分支就是归档它整棵子树**，默认要求每条 worktree 都干净，`--discard` 才会连未提交改动一起丢。见[工作区与分支回收](engineering/cleanup.md)。

## 安全边界

- 用户明确批准最终落地；agent 不能调用 `candidate.*`、`branch.merge/sync/archive` 或 `task.merge`。
- 所有 runtime Git 写操作串行、无 shell 插值。
- 外部编辑器 / Git 进程不受 Lush 锁控制；compare-and-swap 与每次重新校验负责避免静默覆盖。
- 分支谱系在创建时写入，merge 不改 parent；unknown parent 只读，不可用于写操作。
- Candidate 绑定不可变 commit，因此 branch 漂移不会复用旧批准。


## 深入阅读

[核心架构](core-architecture.md) · [Intent 与 Plan 编译](engineering/intent-layer.md) · [Review Candidate API](reference/rpc/candidates.md) · [Git 边界](engineering/git-boundary.md)

---

[← 上一篇：集成与候选](task-flow-2-integration.md) · [下一条阅读线：核心架构 →](core-architecture.md)
