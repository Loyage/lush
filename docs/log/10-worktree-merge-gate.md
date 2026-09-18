# 10 · worktree 合并的人工门与 agent 侧 notice.post

> 上一轮加了 notice，但只覆盖了内置运行时：`notice` 是 `TOOL_DEFINITIONS` 里的工具，而默认后端 pi 走 `contextMode: 'cli'`，只有 bash + `lush` CLI——CLI 里只有用户侧的 `list / show / answer / dismiss`，**没有一条"上报并等待"的命令**。这一轮补上 agent 侧通路，并把它落到一个真实场景：worktree 改完后由 agent 问用户是否合并，用户答 yes 时由 project 节点执行合并。这也让"子返回信息控制上级走向"这条通路有了一个可跑的例子。

## Done

- [x] **agent 侧上报：RPC `notice.post` + `lush notice post`**。`core/service_manager/notices.js` 新增 `noticePost(taskId, title, kind, body, fields, wait)`：非 `wait` 时直接返回新建的 notice；`wait` 时 handler 自己 `await waitForNotice`，所以整个 RPC 一直挂着，用户 answer / dismiss 后返回**结算后的 notice（answer / note 已填）**——外部 agent 读这条命令的输出就拿到答复。汇报者取 `--task TASK_ID`，缺省用 `LUSH_TASK_ID`（pi 的环境里已有）；两者都没有报 usage 错误（退出码 2）。`--fields` 与内置工具同形。`core/dispatch.js` 的 `PARAMS`、`rpc/protocol.js` 的 `NOTICE_METHODS`、CLI 声明树（`src/cli/tree/notice.js` 的 `post`）与 `format/index.js`（`notice_post` → `formatNotice`）同步。

- [x] **`continuationPrompt` 不再把结构化 result 变成 `[object Object]`**。自动唤醒路径（agent 先回答、子 task 后结束）原先把 `child.result` 直接模板插值；子 task 用对象 result 传决定时，父 agent 收到的是 `[object Object]`。现在 `outcomeText` 对非字符串 result 做 `JSON.stringify`（`src/agent/runtime/task.js`）。`task_wait` 路径本来就正常（工具结果走 `jsonDump`）。

- [x] **worktree-service：人工门在上报者这一侧**。`system_prompt` 末尾追加一段：改动做完并验证过后，先用 notice 问用户是否合并（命令行 `lush notice post --title "是否把 <分支> 合并回目标分支" --kind decision --body "<改动与验证>" --fields '[{"name":"merge",...,"options":["yes","no"],"required":true},{"name":"target",...}]'`，内置运行时用 `notice` 工具），拿到 `answer.merge` / `answer.target` 再 `task_complete`；`status: dismissed` 表示 notice 被忽略或 task 已取消，不是许可。它**绝不自己合并**，把 `{ merge, target, worktree, branch, repo, base, commits, verification, changed_files }` 写进结构化 result。

- [x] **dev-task：只转达，不执行**。步骤 5 / 6 重写：把 worktree-service 结果里的合并决定与合并所需字段原样并入自己的 `result` 交给 project（缺字段写 null），明确不 merge / rebase / 删 worktree、不改写用户的决定。

- [x] **project：唯一执行合并的一级**。新增步骤 5（原步骤 5 顺延为 6）：`merge` 不是 `yes` 时只记结论；是 `yes` 时在主工作树 `path` 里先 `git status --porcelain` + `git worktree list` 确认现场，目标分支取 `target`、为空用 `branch` 变量，`git merge --no-ff <branch>`，冲突就停下报告，成功后再跑验证；绝不 force push / rebase / 删 worktree（除非用户在 notice 里明确要求）。

- [x] **guide 修正**：cli 模式原先错误地让 agent "用 `notice` 工具上报"，现在改为 `lush notice post ...`，并说明 `list` / `show` / `answer` / `dismiss` 是用户侧命令。

- [x] **验收**：`bun test` 166 项通过（新增 `notice.post` 的 RPC 用例：`wait:false` 立即返回、`wait:true` 阻塞到 answer、缺 title 报 -32602、汇报者不存在报 -32004；CLI 声明用例扩到 5 个子命令并断言 `post` 的 parse / check）。真 daemon 手工验证：`LUSH_TASK_ID=1 lush notice post --title '是否把 fix-login 合并回 main' --fields '[{merge,target}]'` 阻塞挂起，用户侧 `lush notice list` 显示 `[decision/open] · 阻塞中`，`lush notice answer 1 --set merge=yes --set target=main` 后那条命令立即输出 `status: answered` 与 `回答：{"merge":"yes","target":"main"}`。

## 备注

- 这一轮改了 `guide.js`、CLI 声明树、模板 prompt 与运行期代码，fingerprint 会变 → `just daemon-restart`。
- **"子 agent 控制上级走向"当前只有 `result` 这一条通路**：子必须在 `task_complete` 里把决定结构化地带上去，父在 `task_wait` / 自动唤醒时读到；没有运行中的子→父消息，notice 也不会直接唤醒父 task。三级链路（worktree-service → dev-task → project）就是靠每级把 result 原样上传来表达的。
- pi 侧的 notice 等待受 `LUSH_RPC_TIMEOUT`（默认调用超时 + 10 秒）约束：超时只是那条命令放弃，notice 保持 `open`，用户随后处理；agent 若需要更长的等待，属于下一步要解决的"notice 等待与 RPC 超时解耦"。
