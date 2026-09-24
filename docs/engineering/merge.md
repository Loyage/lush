# 分支合并与收敛

Lush 的合并单位是分支谱系中的一条 `direct child → parent` 边。Task 仍提供审阅结果和 agent 审计，但代码是否能落地由 Branch + Git commit graph 决定。

## 唯一正常路径：fast-forward

`branch.merge BRANCH` / 分支图“合入父分支”执行以下门槛：

1. child 在 `branches` 中有 `parent_relation=recorded` 的直接父分支；
2. child 与 parent ref 都存在；
3. child 对应 task（若有）已经 completed；
4. child 自己的 worktree、parent 已检出的 worktree都干净；
5. child 没有尚未收拢的直接子分支；
6. parent tip 是 child tip 的祖先。

父分支有 worktree 时在该 worktree 运行 `git merge --ff-only <child-tip>`，使 index 与工作目录同步；没有 worktree 时用带旧值的 `git update-ref` compare-and-swap 原子推进 ref。外部进程抢先推进会失败，不覆盖它。

反方向的 `branch.catchup BRANCH`（分支图的「让子分支跟上父分支」）走同一条骨架，只是主角互换：parent 在前、child 没有独有提交时，把 `git merge --ff-only <parent-tip>` 跑在 child 的 worktree 里（或 update-ref 推进 child 的 ref）。门槛同样是 recorded direct parent、blockers 为空、父子 ref 都在；`fast_forward` 与 `diverged` 一律拒绝，因为那两种情形要先把 child 的成果落上去或先在子侧吸收父分支。

成功后，关联 task 的 integration 收敛为 `merged`。输入分支没有 task owner，事件记在该输入的根 planner 上。

新输入产生的 `task.merge` 是兼容入口，走同一套 direct-parent / ff-only 规则。升级前已经存在、或内部测试直接创建且没有 input 的 legacy task 继续按原 `target_branch` 语义落地（可能 no-ff）；这是迁移兼容，不会出现在新输入分支流中。

## 分支状态

`Workspaces#branchState(child)` 实时计算：

- `fast_forward`：parent 是 child 的祖先；
- `diverged`：两边都有独有提交；
- `integrated`：child 已经在 parent 历史里；
- `missing`：ref 缺失。

同时返回 child 相对 parent 的 `ahead` / `behind` 与未收拢直接子分支 blockers。状态不写库，避免外部 Git 操作后缓存失真。

## 分歧：父分支先进入子侧

分歧时 runtime **不会**在 parent 上执行 `--no-ff`，也不会把冲突留在 parent worktree。用户执行 `branch.sync CHILD`（或在图上点“在子分支解决分歧”）：

1. 冻结当前 child tip 与 parent tip；
2. 从 child tip 创建一个独立 merger 子分支 / worktree；
3. merger 执行 `git merge <frozen-parent-tip>`；
4. 在子侧解决冲突、提交并测试；
5. 用户批准 merger → child 的 FF；
6. 用户批准 child → parent 的 FF。

这条路径不 rebase，不重写已审阅提交；最终 parent 得到的树就是 merger 测试过的树。parent 在期间再次前进，只会让第 6 步重新显示 diverged，必须再同步，不能偷偷二次合并。

同一 child 同时只允许一个活动或待落地的 branch-sync merger。

## 从叶子向根

一条分支还有未进入自己的直接子分支时，向上合并会被拒绝。典型顺序：

```text
code 下游 → 上游任务分支 → 输入分支 → 用户指定父分支
```

并行 sibling 都进入输入分支。因为第一个 sibling 会推进输入分支，后续 sibling 往往显示 diverged；它们按上述子侧同步流程逐个收敛。系统宁可要求显式同步，也不在聚合分支上产生未经独立测试的 merge commit。

## 批量入口

`task.merge_many` 保留为兼容接口：只接受相同直接父分支，逐项走同一规则。第一项造成父分支前进后，独立 sibling 可能需要同步；批次在首个 `diverged` 或错误处停止，已成功项不回滚。

新的主操作面是分支图，而非按 task 推测交付顺序。

## 一键合并

`branch.merge_all BRANCH`（Web 分支图的「一键合并全部子分支」、CLI `lush branch merge-all BRANCH`）把一条分支（典型是 main）的整棵后代子树从叶子向根自动收拢：

1. 只读的 `branch.merge_plan BRANCH` 列出全部后代，按「叶子在前」（谱系深度降序，其次创建时间、名字）给每条分支当前状态与将要执行的动作（`merge` / `sync` / `skip`）和阻塞原因；
2. 用户确认一次（Web 确认框展示这份顺序），`branch.merge_all` 开始执行，之后不再逐条确认；
3. runtime 逐条复用 `branch.merge` 的 ff-only 门槛；父子分歧时自动在该子分支下创建子侧 merger，运行置为 `paused` 并停住，merger 结算后自动落回它的直接父分支并继续；目标分支永不产生 merge commit；
4. 运行在「全部完成 / 遇到失败 / 用户取消」时结束，已成功落地的不回滚。

运行本身是目标分支附属的 versioned JSON（`branches.merge_run`），不是新业务实体；终态即清空。运行期间按「目标分支 + 它的全部后代」冻结写操作；此外，任何未结束的 merger 任务同样冻结「它处理的分支 + 它的全部后代 + 它的直接父分支」。冻结拦截新建 intent（`input.submit` / `draft.commit`）、`branch.merge` / `branch.sync` / `branch.catchup` / `branch.archive`、`task.retry` / `task.cleanup` / `task.delete` 与 `task.clear`；`branch.merge_cancel BRANCH` 清除运行、取消正在等待的 merger 并释放冻结，已落地提交保留。冻结计算见 `src/core/branch-freeze.js`。

相关：[分支优先架构](branch-first.md) · [Git 边界](git-boundary.md) · [分支谱系](branch-genealogy.md)
