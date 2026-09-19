# 检验与对照检出

本文件管检验任务不写 Git 状态、派生的只读对照检出及其回收时机。

检验不写任何 Git 状态：它用 `git worktree add --detach` 在 `.lush/worktrees/<label>-base` 拉一份目标分支当前的只读对照，在它和被测 worktree 里分别跑同一场景。对照检出是派生状态，检验结算（成功或失败）后立即回收，报告文件保留；重启恢复时也会回收上次崩在中间的对照检出。用户可以用 `task cleanup` 再回收一次。

相关：[一次 invocation 与多级协作](invocation.md)、[工作区与分支回收](cleanup.md)。
