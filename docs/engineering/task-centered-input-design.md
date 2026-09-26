# Task 中心输入：当前约束

本文面向修改输入、Task、Agent、Git 和 UI 的开发者，概括当前 say 路径的设计边界；具体接口与异常处理以[Task RPC](../reference/rpc/tasks.md)、[输入 RPC](../reference/rpc/inputs.md)和[模块地图](modules.md)为准。旧协议的规划与 Candidate 见[历史流程](../task-flow-1-planning.md)。

## 输入与分支归属

- `say TEXT` 或 `say --draft ID` 一次提交一条 Input，直接创建拥有分支/worktree 的 say Task；不创建 planner/scheduler，也不匹配旧 `input_routes`。Web 普通「发送」不提交其它草稿。引用作为输入附件保留，不混进正文。
- main 的持久根 Task 平时静息；其它本地父分支需要显式绑定所有者。任务从父分支已提交 tip 创建，不能带上未提交工作。普通 say 即使只回答问题也有 worktree；用户对 main/owner 的按需只读 `task analyze` 则使用无分支的分离检出。
- 每个新 Task 与 Agent 一对一；子 Task 有自己的分支与固定起点，完成后只发持久信号。父 Agent 确认固定提交才快进集成。若兄弟任务或父提交造成分歧，解分歧 Task 在子侧吸收父 tip，父 Agent 再确认；不得伪造父侧合并。

## 调用与交付

- Task 身份、收件箱与工作区跨 invocation 保留；等待子任务/用户时释放并发槽。用户追加输入先落库，在已验证的安全点抢占（Pi 的 `turn_end`），否则轮末交付。硬中断的未知副作用不自动重放。一次性 Agent token 只对本轮有效。
- say 的 `merge` 与 `showcase` 预约互斥。预约展示时立即创建展示子 Task 并让它先做准备；say 真正完成且满足展示准入后发信号，展示子 Task 重新固定最终提交并交付，say 在展示结算后才终结。展示不代表检验通过。合并预约仅在静息、后代已结算、工作区干净且能快进时发请求，固定源/父提交并锁父分支；请求不等于授权合并。
- 直接父 say Agent 可确认集成；main/owner 需要用户按固定 commit + baseline 批准。父分支自己前进或外部 Git 更改可能让请求失去快进前提，必须保留诊断、交由源侧解决或撤销请求。撤销不删除分支/历史。`completed` 不等于 `merged`。只想了解、没有代码改动的 say 不会自己结束（一次调用正常返回只进入 waiting）；用户用 `task.resolve` 把它标记为「已解决」——与「取消」区分，保留答案并以 `completed`/`integration='none'` 结算，仅在没有提交、工作区干净且无在途交付时允许。需要把只读提问留在 main/owner 上回答时用 `task.analyze`。
- 旧 Input、Plan、Candidate、路由事件仍可读，并按旧协议安全收尾；不能由旧记录的 role 或 task ID 猜测新协议身份。旧合并接口不能绕过新任务的父确认/人工批准。
