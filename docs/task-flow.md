# 从输入到交付：分支优先流程

这份文档按使用顺序解释 Lush 当前的行动任务流程。核心区别仍然是：**task completed 只表示 agent 交付了提交；branch integrated 才表示代码已经逐层进入父分支。**

## 1. 提交输入

```bash
lush say '实现搜索页面' --branch release/next
# 或
lush draft commit --branch release/next
```

省略 `--branch` 时使用项目当前检出分支。runtime 立即：

1. 从指定本地分支的已提交 tip 创建 `lush/<hash>/input-<id>`；
2. 检出到 `.lush/worktrees/input-<id>`；
3. 保存原话并创建根 planner；
4. 让 planner 在输入 worktree 中解析。

所以父分支之后前进、主工作树切换或有未提交修改，都不会改变这条输入看到的代码。未提交修改不会被复制进输入分支。

`input flow explain` 只产生答案 / research；`develop` 才产生修改代码的任务。

## 2. 拆解与任务分支

planner 写 spec，scheduler 把 spec 编成 task：

- 无依赖 worker：从输入提交时冻结的 commit 创建，direct parent 是输入分支；
- `code` 依赖：从上游任务 reviewed commit 创建，direct parent 是上游任务分支；
- `order` 依赖：只等待上游终态，代码仍从输入冻结起点创建；
- research / coordinator：不产生可交付分支；
- verifier：使用 detached 对照检出，只读。

每个 worker 在自己的 worktree 修改、测试、提交。工作区不干净或没有提交时不能正常完成。

## 3. 看分支图

Web 的“分支图”是主要交付界面。CLI 可辅助查看：

```bash
lush branch tree --verbose
lush branch show TASK_ID
```

任务树回答“谁在做什么”；分支图回答“哪份代码从哪里分出、现在能否进入父分支”。

每条 `parent → child` 连线显示：

- **可 fast-forward**：parent 是 child 的祖先；
- **已分歧**：两边都有独有提交；
- **已进入父分支**：child 已经是 parent 的祖先；
- **缺失 / 未知**：ref 不在或没有可信 recorded parent。

连线还显示 child 相对 parent 的 ahead / behind。一条分支有未收拢的直接子分支时，图会列出 blockers。

## 4. 从叶子逐层合并

用户只能把子分支合回它的 recorded direct parent：

```bash
lush branch merge lush/<hash>/107-more-cases
```

正常顺序：

```text
最深 code 下游
  → 上游任务分支
  → 输入分支
  → 提交输入时指定的用户分支
```

只有 fast-forward 才会落地。parent 已被 worktree 检出时要求它干净，并用 `git merge --ff-only` 同步工作目录；没有 worktree 时用 compare-and-swap 原子推进 ref。

`task merge ID` 是兼容入口，也遵守相同的 direct-parent / ff-only 规则。

## 5. 父子分歧

并行 sibling 都从同一输入 commit 出发。第一个 sibling 合入输入分支后，第二个通常会与输入分支分歧。这不是异常，也不会在父分支直接制造 merge commit。

在图上点“在子分支解决分歧”，或：

```bash
lush branch sync CHILD
```

runtime 从 child tip 创建 merger 子分支。merger 把冻结的 parent commit 合入子侧，解决冲突、提交并测试。完成后：

1. merger 分支 fast-forward 回 child；
2. child fast-forward 到 parent。

如果 parent 在此期间再次前进，child 会再次显示已分歧；重新同步即可。没有任何步骤 rebase 或重写已审阅历史。

## 6. 审阅与验证

```bash
lush task inspect ID
lush task verify ID
```

`tasks.head_commit` 是 agent 最初交付时审阅过的 commit。任务分支之后可能聚合直接子分支而前进；向上合并前 runtime 必须证明 branch tip 仍包含 reviewed commit。

verifier 比较任务 worktree 与其直接目标分支的当前 tip，输出自包含报告。它不修改代码。

## 7. 完成、合并与清理

- `completed + pending`：agent 已交付，分支尚未进入直接父分支；
- `completed + merged`：该任务分支已进入直接父分支；
- 输入分支最终进入用户分支后，这条输入的整棵代码树才算交付完成。

清理：

```bash
lush task cleanup ID
lush task clear
```

不 force。任务分支 tip 必须仍包含 reviewed commit，且整个 tip 已进入 target；输入分支已推进时也必须先进入其 parent。脏 worktree、未交付 commit 或外部改动都会让 runtime 保留现场并说明原因。

## 8. 安全边界

- 用户明确批准每次分支落地；agent 不能调用 `branch.merge/sync` 或 `task.merge`。
- 所有 runtime Git 写操作串行、无 shell 插值。
- 外部编辑器 / Git 进程不受 Lush 锁控制；compare-and-swap 与每次重新校验负责避免静默覆盖。
- 分支谱系在创建时写入，merge 不改 parent；unknown parent 只读，不可用于写操作。

深入阅读：[分支优先架构](engineering/branch-first.md) · [输入和规划](engineering/inputs-and-planning.md) · [分支合并](engineering/merge.md) · [分支谱系](engineering/branch-genealogy.md)
