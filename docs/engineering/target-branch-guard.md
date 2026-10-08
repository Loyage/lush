# 调用期目标分支移动检测

目标是发现 Worker 越过专属 worktree 写入 main／父分支的异常，同时不能把父 Worker 在自己 worktree 内的正常提交误判成子 Worker 越界。入口是 `project/scheduling.js` 与 `workspaces/ref-guard.js`；职责见[Runtime 模块地图](modules-runtime.md)，观测与来源的表达遵循[Agent 执行过程](../design/agent-process.md)。

## 观测与归因

每次 provider 调用前注册目标分支 `refs/heads/<target_branch>` 的观测窗口，固定基线 tip。证据只保留在仍存活的窗口中，不新增业务实体、数据库列或长期凭证。

窗口按**同一 ref 的精确 before → after 转移链**判断最终 tip 是否可解释：

- daemon 经 `Workspaces.gitOutput` 成功执行的 checkout 分支写入（commit／merge 等）或具名 update-ref，记录该分支写入前后的 tip。失败命令、commit-tree 对象创建、历史快照 ref 与无关分支操作不能抵消目标分支移动；[选择快照已停用](choice-snapshots.md)，本检测不恢复问卷捕获或重选入口。
- 新式 Squash 自定义 ref 事务用已核验的 receipt 注册在途写入，仅事务成功后记录精确的父 baseline → landed commit；未提交／失败事务没有成功证据。
- 用户授权的命令 Hook 经 `trackRefWrite` 记录**所挂载分支**的成功 before → after；Shell 失败、未开始或触及其他 ref 都不能提供这些 ref 的成功归因。基线读取后再次核验命令准入，旧的全局 `noteRefWrite` 接口不再使用。
- provider 启动前确认 Worker 的分支与 worktree 身份，建立所属分支观测窗口。返回／抢占／暂停／失败时，在释放调用身份之前收口，写 `invocation.branch_observed {branch,before,after,run_id,source:'worker_ownership_window'}`。只记录实际变化，不以 running Map 中有一个身份条目作为证据。
- 子调用结束时也可对仍活动的目标分支所属调用采样；父先结束时，其已收口的转移仍保留在子调用的窗口中。子从父调用中间的 tip 开始时，按同一个采样切开父窗口，避免 A → C 无法解释子基线 B 的误判。
- 检测等待**该 ref** 的在途 daemon 写入收据；读 tip 时遇到新的并发写入最多重采样三次，不把“有写入正在发生”当成任意豁免。

早先合法 A → B 不会豁免后续无法解释的 B → C；无关 ref 的活动也不能豁免。每个窗口最多保留 4096 条转移，溢出时对改变的 tip 保守拒绝，诊断标明证据溢出；所有调用退出路径都释放窗口与所属调用观察者。

## 异常与历史

无法连接基线与最终 tip 时仍将调用按失败处理，阻止自动交付／验收／归档，保留提交和工作区。事件沿用 `invocation.target_branch_moved`，增补 `reason:'unattributed_ref_movement'`、`evidence_overflow` 与最近最多 20 条转移摘要。

新诊断明确说“未归因的移动”，不声称已证明当前 Worker 越界。Web 根据 reason 显示新名称；旧事件的标题、错误、记录和语义保留，不改写历史。失败现场由用户检查后显式重试原 Worker，不 reset、删除成果或自动重放调用。

**这不是操作系统沙箱，也不是写入进程身份证明。** 所属调用的 before／after 观测说明变动发生在确认的分支所有权窗口内，不能区分同权限外部进程在同一个窗口内的并发写入。daemon 命令采样也不替代 Git CAS／ref 锁和交付凭据核验。Lush 不因这项检测接管用户手动 Git，且无法撤销已经落地的异常提交。

观测窗口为本 daemon 的调用期临时证据，不跨重启恢复活动调用；仍遵守未知副作用不自动重放。审计事件保留历史来源，不用于猜测重启后的写入身份。

## 验证

- `test/project/target-branch-guard.test.js`：真实临时 Git、可控 provider，覆盖父仍活动／父先结束／子从中间 tip 开始／父多轮调用，真实越界与父结束后的异常移动，以及无关分支、失败写入、对象与快照 ref、合法写入前后的归因缺口。
- `test/workspaces/ref-guard.test.js`：独立基线、在途收据、失败副作用、数量上限与所有权丢失。
- `test/workspaces/task-squash.test.js`：检出／未检出父分支的自定义 Squash 精确转移，原有 CAS、取消、未知落地与恢复安全门保持不变。
- `test/project/completion*.test.js`、`test/project/preempt.test.js`、`test/project/interrupt.test.js`：失败不能进入自动链，生命周期退出与抢占路径。
- `test/web/event-labels.test.js`：新观测与未归因名称、旧事件兼容。

测试只使用临时项目，不重启用户 daemon、修改其它 Worker 或恢复旧失败状态。修复合入后须在无活动调用时由用户更新 daemon，已失败 Worker仍由用户显式重试。

## 固定父基线适配

交付 11942／尝试 11968 在 W140 源工作区吸收固定父提交 `2e7a104`，保留源提交 `1c3586f`；共同祖先为 `443c37e`。双方增量无整体改名或分支／交付数据模型迁移。父侧停用选择快照与重选、将 child 自动链整体改为用户只读、增加项目新指令默认自动链与详情模块预览。合并保留已删除的快照收尾入口，不恢复公开捕获／重选；历史快照工具不影响分支归因。保留 child 锁定、项目默认值及预览，合并两类新增事件标签；本修复不改这些权限与产品行为。

新增临时项目回归：项目默认自动到 merge／accept／archive 时，未归因目标移动仍失败并保留 worktree，不进入合并、验收或归档。其余父先结束、精确 ref 收据及旧事件兼容测试继续有效。

修复专项 **126 pass / 0 fail**；完整 `bun run test --timeout 30000` **2410 pass / 0 fail**，315 文件。日志 `/tmp/lush-w140-merge-11968-focused.log` 与 `/tmp/lush-w140-merge-11968-full.log`。文档检查通过，仅既有篇幅警告。真实浏览器和模型调用仍需另行验收；未修改父分支、其它 Worker 现场或用户服务。
