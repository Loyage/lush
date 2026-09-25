# 分支优先架构

Git 分支与 worktree 承载代码事实，Task / Agent 承载执行与交付确认。本章的「一条输入的分支流」及 `input.submit`、planner、worker 示例只描述旧协议；新 say 直接拥有输入分支，子提交由父 Agent 确认，main/owner 需用户批准，见[当前流程](../task-flow.md)和[Task RPC](../reference/rpc/tasks.md)。

## 旧输入链的核心不变量

1. 用户提交输入时显式选择一个本地父分支；省略时使用项目当前检出分支。
2. runtime 立即从父分支已提交的顶端创建 `lush/<project>/input-<id>` 与独立 worktree。planner 在这个 worktree 中解析输入，因此之后父分支前进、其它 worktree 有未提交内容，都不会改变它看到的代码。
3. 普通 worker 分支是输入分支的直接子分支；`code` 下游是上游任务分支的直接子分支。任务的 `target_branch` 永远等于谱系中的直接父分支。
4. 用户只允许把子分支合回它的**直接父分支**。结果逐层收敛：任务 → 输入分支 → 用户最初选择的分支。
5. 父分支只接受 fast-forward。runtime 不在父分支上创建 no-ff merge commit，也不在父分支的 worktree 留冲突中间态。
6. 父子已经分歧时，用户在分支图选择“在子分支解决分歧”。runtime 从子分支顶端创建一个 merger 子分支，让它合入冻结的父分支 commit、解决冲突并测试。之后 merger → child、child → parent 都是 fast-forward。
7. 一条分支还有未收拢的直接子分支，或仍有会在它下面产码但尚未建分支的活动 task 时，不能提前合入父分支。这样不会把并行工作的某一部分静默遗漏。
8. `branches.parent` 与 `created_from_commit` 只在创建时写入；merge 不改谱系。分支当前能否 FF 由 Git commit 图实时计算，不持久化猜测。

## 旧协议：一条输入的分支流

```text
main（用户选择）
└── input-42                         planner cwd / 聚合分支
    ├── 101-api                     worker
    ├── 102-ui                      worker
    └── 103-tests                   worker
        └── 107-more-cases          code 下游
```

落地顺序从叶子向根：`107 → 103 → input-42`，其它兄弟分别进入 `input-42`，最后 `input-42 → main`。

## 连线状态

分支图对每条 `parent → child` fork 连线实时给出：

- `fast_forward`：parent 是 child 的祖先，可直接把 child 合回 parent；
- `diverged`：两边都有独有提交，必须先在子侧同步；
- `integrated`：child 已经是 parent 的祖先（或顶端相同），成果已进入父分支；
- `missing`：至少一个 ref 不存在；
- `unknown`：没有可信的 recorded parent，禁止写操作。

`ahead` / `behind` 以 child 相对 parent 计算。连线还列出 child 尚未收拢的直接子分支；有 blocker 时即使 commit 图本可 FF，也不能向上落地。

Web 分支图把 `integrated` 再拆成两种读得出来的情形：`behind=0` 是「与父分支一致」，`behind>0` 是「落后父分支 N」——后者可以直接快进跟上，所以 `branch.catchup BRANCH`（分支图上的「让子分支跟上父分支」）把 parent 已有的提交快速前进进 child。它只推进 child，不产生 merge commit，也不动父分支；child 有独有提交（`fast_forward`）或已经分歧时拒绝，分别该走 `branch.merge` 与 `branch.sync`。

## 分歧收敛

```text
P: A──P1
    \
C:   C1
```

`branch sync C` 创建：

```text
P: A──P1
    \   \
C:   C1  \
      \   S (merge P1 into child-side branch, test here)
```

用户批准后：

1. `S → C` fast-forward；
2. `C → P` fast-forward。

不 rebase，因此不重写已经审阅的提交；不在 P 上 no-ff，因此最终落地树就是 merger 测试过的树。

## Task 与 Branch 的边界

- Task：goal、role、agent session、消息、notice、执行状态、结果与审计事件。
- Branch：父分支、fork commit、worktree、当前 tip、ahead/behind、是否可合并、是否已进入父分支。
- `tasks.head_commit` 仍表示 agent 交付时审阅过的提交。分支之后可能通过子分支聚合而前进；向上合并前必须证明 branch tip 仍包含该 reviewed commit。
- 旧输入分支没有 Task owner，通过 `inputs.anchor_branch` 关联根 planner；新 say 的输入分支直接由 Task 拥有。兼容字段仍叫 `anchor_*`。

## 接口

```text
input.submit { content, branch? }
draft.commit { ids?, branch? }
branch.merge  { branch }   # direct child -> parent, ff-only
branch.sync   { branch }   # 仅 diverged 时创建子侧 merger
branch.merge_all { branch }   # 一键合并：叶子到根自动收拢整棵后代子树（用户确认一次）
branch.merge_cancel { branch }  # 取消一键合并并释放冻结
branch.archive { branch, discard? }  # 用户显式归档一整棵子树：允许未合并，删每条的 worktree 与本地 ref，保留记录、任务、事件与会话
```

CLI：

```bash
lush say '实现搜索' --branch release/next
lush draft commit --branch release/next
lush branch merge lush/.../101-api
lush branch sync lush/.../input-42
lush branch merge-all main       # 一键合并 main 的全部后代分支（确认一次后全自动）
lush branch merge-cancel main    # 取消并释放冻结
lush branch archive lush/.../101-api   # 归档这棵子树：worktree 与 ref 删掉，记录、任务与会话留在库里
```

一键合并与解冲突期间的冻结语义（目标分支及其全部后代，冲突时再加父分支）见[分支合并](merge.md#一键合并)。

相关：[分支谱系](branch-genealogy.md) · [输入和规划](inputs-and-planning.md) · [Git 边界](git-boundary.md) · [批准合并](merge.md)
