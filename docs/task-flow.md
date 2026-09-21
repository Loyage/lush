# 从 Intent 到可验收结果

这份文档按使用顺序解释 Lush 的主流程：**用户目标 → structured Plan → 并行 Work → 结构化 Artifact → Review Candidate → 用户验收**。视觉版与设计原则见[核心架构 HTML](core-architecture.html)。

核心区别：**task completed 只表示 agent 交付了提交；Candidate ready 才表示出现了一份用户可以验收的固定结果。**

## 1. 提交 Intent

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

`input flow explain` 只产生答案 / research；`develop` 才产生修改代码的工作。

## 2. Plan 编译

planner 只写结构化 Plan（`lush spec add`）。它结束一轮后，runtime 在事务里直接把 spec 编译成根 WorkItem 与依赖边：

- 无依赖 worker：从 Intent 冻结的 commit 创建，direct parent 是 Intent 集成分支；
- `code` 依赖：从上游 reviewed commit 创建，direct parent 是上游任务分支；
- `order` 依赖：只等上游终态，代码仍从冻结起点开始；
- research / coordinator：不产生可交付分支；
- verifier：只读对照，不产生可交付分支。

**没有 scheduler agent**：机械的 ID 翻译与建依赖由代码完成，不消耗模型调用，也不存在全项目串行批次。planner 使用独立 control lane，不会被长 worker 饿死。

每个 worker 在自己的 worktree 修改、测试、提交。工作区不干净或没有提交时不能正常完成。

## 3. 自动中间集成

Plan 编译出的工作完成后，Integration Service 在**私有 Intent 分支内部**自动收敛：

```text
最深 code 下游 → 上游任务分支 → Intent 集成分支
```

并行 sibling 与集成分支分歧时，runtime 自动创建 child-side merger：把冻结的父 commit 合入子侧、解决冲突并测试，再逐层 fast-forward。**目标分支始终不动。**

## 4. Review Candidate

内部工作全部收敛后，runtime：

1. 固定 Intent 集成分支的精确 commit；
2. 固定目标分支的 baseline commit；
3. 创建一版状态为 `pending` 的 Review Candidate，但不自动验收；
4. 用户显式执行 `lush candidate verify ID`（或在 Web 点击“开始验收”）后，派只读 verifier 在两边运行同一验收场景；
5. 把自包含 HTML 报告写到 `.lush/verify/<verifier-id>/report.html`。

报告成功后 Candidate 进入 `ready`。查看：

```bash
lush candidate list --input 1
lush candidate verify 2                  # 用户显式启动验收
lush candidate inspect 2
lush task inspect <report_task_id>       # 报告路径与结论
```

Web 的 Intent 工作台把候选版本、状态与「打开结果」直接画在目标行上。

## 5. 用户验收

```bash
lush candidate accept 2                  # 接受这版固定 commit 并合入目标分支
lush candidate changes 2 '按钮再明显一点'  # 要求修改：保留旧版本，在同一 Intent 下启动增量规划
lush candidate reject 2 --reason '方向不对' # 放弃这版结果
```

`accept` 会再次校验当前集成分支 tip 仍等于被审阅 commit；不等时报错并要求生成新版本，绝不夹带用户没看过的内容。校验通过后按 direct-parent / ff-only 规则合入目标分支。

`changes` 把旧版本标为 `changes_requested`，新 planner 拿到反馈后写增量 Plan，产出 Candidate v2；旧 commit 与旧报告都保留。

## 6. 分支诊断（高级）

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

## 7. 审阅与证据

```bash
lush task inspect ID      # 结果、Run 历史、Artifacts、依赖、工作区
lush task diff ID         # 当前改动
lush task transcript ID   # agent 的思考、工具调用与输出（追溯用）
lush task usage ID        # 模型、上下文占用与累计花费
lush task verify ID       # 兼容的单 worker 对照检验
```

`tasks.head_commit` 是 agent 最初交付时审阅过的 commit。每次 provider invocation 另有一条 `agent_runs` 记录，成功输出形成 `run.result` Artifact。

## 8. 完成、清理与归档

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

## 9. 安全边界

- 用户明确批准最终落地；agent 不能调用 `candidate.*`、`branch.merge/sync/archive` 或 `task.merge`。
- 所有 runtime Git 写操作串行、无 shell 插值。
- 外部编辑器 / Git 进程不受 Lush 锁控制；compare-and-swap 与每次重新校验负责避免静默覆盖。
- 分支谱系在创建时写入，merge 不改 parent；unknown parent 只读，不可用于写操作。
- Candidate 绑定不可变 commit，因此 branch 漂移不会复用旧批准。

深入阅读：[核心架构](core-architecture.html) · [Intent 与 Plan 编译](engineering/intent-layer.md) · [Review Candidate](reference/rpc/candidates.md) · [分支优先的 Git 子系统](engineering/branch-first.md) · [Git 边界](engineering/git-boundary.md)
