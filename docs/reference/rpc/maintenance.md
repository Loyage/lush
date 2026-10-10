# 磁盘回收

本节管安全回收 `worker.cleanup` 与用户确认的彻底删除 `worker.delete`；仅删除代码现场、保留记录时走归档 `branch.archive`，见[分支谱系](branches.md)。旧 `task.delete` / `task.clear` 不恢复为兼容别名。

| CLI | RPC | 参数 |
|---|---|---|
| `worker cleanup ID [--keep-branch]` | `worker.cleanup` | `{id, keep_branch?}` |

`worker.cleanup` 回收一个已结束Worker占的磁盘状态：worktree 目录、检验对照检出（如果有）与Worker分支。只有 `integration` 为 `merged` / `none` / `superseded` 的Worker可回收（`superseded` 是「这一轮解冲突已被下一轮取代」，分支仍当恢复点看待）。worktree 仍然不强制删除（干净检查 + commit 已进 HEAD 的检查不变）；分支额外要求**它的顶端就是审阅过的那次提交**，且那次提交已经是 `target_branch` 的祖先——任一条不满足就保留分支，并在返回的 `cleanup.branch` / `cleanup.reason` 里说明。删除用 `git update-ref -d <ref> <tip>` 的 compare-and-delete，不用 `--force`：检查之后分支被谁动过就拒绝，审阅过之外的提交一条也不会丢；`branch` 快照不再存在时库里也会清空。`keep_branch: true`（CLI `--keep-branch`）只回收 worktree，把分支留成恢复点。返回 `{...task, cleanup: {worktree: removed|absent, branch: removed|kept|absent, reason}}`。

W169／决定 #418：**验收即归档**，`worker.accept` 受检回收分支子树 worktree/ref、保留完整运行历史，脏现场阻止；回收成功才完成验收，部分失败可显式续办，unknown 不自动重放。待验收 `awaiting_acceptance` 的 Worker 暂时保留工作区供追加输入；child 直接父 Agent 检查后验收并回收资源，无需用户逐个操作。验收不隐式确认后代；失败／取消及特殊现场另用「清理资源」，不伪装成功验收。详见[统一验收](../../engineering/worker-acceptance.md)。新式 Squash 交付按固定源提交、已落地树及父提交受检；本轮 ref 漂移或新增未交付改动不能借上轮 merged 状态删除。已归档Worker不自动重建。见[持续迭代](../../engineering/task-iteration.md)。

旧输入分支（`lush/<项目哈希>/input-<id>` 与它的检出）与旧 planner 工作区仍可能留在磁盘上；它们不再由新的公开入口创建，daemon 也不会自动回收或重放。

## 彻底删除 Worker

详情页与 Worker 图提供「删除」：先只读检索 Worker 与全部真实后代、关联资源和阻塞原因，再显示应用内最终确认。确认即授权丢弃所列范围内未提交与未合并代码，并清除专属历史，不能撤销；不会调用 Agent。

| CLI | RPC | 参数 |
|---|---|---|
| `worker delete ID` | `worker.delete_preview` | `{id}`，只读预检 |
| `worker delete ID --confirm --revision REV` | `worker.delete` | `{id,revision,confirm:true}`，确认预检范围 |

预检返回 `{id,revision,can_delete,blockers,workers,inputs,resources,warnings}`。`workers` 列出将删除的整棵子树，`inputs` 列出不再被其他 Worker 使用的原始输入，`resources` 分 worktrees / branches / files 展示实际发现的资源。CLI 第一次只预检；检查输出后，把其中的 revision 带入第二条确认命令。范围或资源状态改变时拒绝旧 revision，必须重新预检和确认；不允许只传 ID 绕过确认。

整棵子树必须已终态且调用完全退出。活动 Worker 请先手动取消，等待停止再删除；main / owner 不可删除，外部依赖、共享资源、交付冻结与无法确认归属的路径会阻止操作并说明原因。

清理专属 worktree、本地分支、执行会话、规则及附属文件，之后删除 Worker / 消息 / Notice / 事件 / Run / Artifact / 上下文索引等专属记录，并删除无剩余使用者的 Input 与已发射 Draft。删除资源失败保留 Worker 及诊断，可处理后重新预检继续，不能把未清理完成报成成功。已合并到父分支的代码不会撤销，Git 提交历史、其他记录中的引用快照不会抹除，ID 永不复用。此功能不是备份、安全擦除或 Git 历史重写。

相关：[工作区与分支回收](../../engineering/cleanup.md) · [分支谱系](branches.md) · [分支合并](../../engineering/merge.md)
