# 分支效果展示

本文介绍如何让专用 `showcase` agent 分析一个分支，并实际展示修改后的效果。实现入口为 `src/core/project/showcase.js`；它是普通 Task 的专用角色，不是新的业务实体。

## 从哪里开始

- Web / 桌面：分支图里对**可预约**的本地分支显示次要「预约效果展示」按钮，入口不要求当前已满足完整准入。首页、Intent 列表和任务详情不提供启动入口；已有展示仍可从分支、关联 Intent 或展示任务查看。
- 仅允许已登记、有明确父分支和创建基线的非主干本地分支；排除 main / master、远端默认分支、无父分支的根、归档/删除/缺失分支。相关规划/开发/合并任务必须成功完成，子分支已收拢，相关工作区干净、无冲突或 Git 操作中间态，相对基线有实际文件改动。检验通过和批准合并不是前提；无法确认状态时不开放。
- 同一分支有活动展示时不开放；成功展示过相同文件树时不开放，实际文件内容变化后才重新开放。空提交、只改提交信息或换基线不算内容变化；历史失败/取消不算成功，可在稳定且代码未变时重试。
- 默认对比创建时的提交。CLI 可显式覆盖对比基线（使用共同祖先），但不能绕过上述准入规则；普通未登记分支不能通过指定基线直接展示。RPC 与 Web 使用同一套后端校验。

```bash
bun run lush showcase start feature/ui --baseline main
bun run lush showcase start lush/project/input-1
bun run lush showcase list --branch feature/ui
bun run lush task inspect 12
bun run lush showcase stop 12
```

Web 不再提供创建/启动手动验收的主入口。底层 `task verify`、`candidate prepare/verify`、历史检验报告与 Candidate 接受/反馈接口仍兼容保留；**效果展示不设置检验 pass、不把 Candidate 变为 ready，也不自动合并**。看完后仍需审阅代码与检验结果，并在分支图明确批准合并。

## 预约效果展示

「效果展示」入口在开发型分支创建后就亮起：点击是**预约**，不是立即启动。

- **入口范围**：`graph.get` 的分支节点用 `reserve_allowed` / `reserve_reason` 回答「现在能不能预约」——已登记、有明确父分支和创建基线的非主干本地分支即可预约，不要求已经完成开发、检验通过或批准合并。准入暂未满足时仍然可预约。
- **持久化与取消**：预约存成 `branches.showcase_reservation`（versioned JSON，`pending`），不是新实体；重复预约幂等。Web 上已预约的分支显示「已预约效果展示」与「取消预约」，取消后回到预约入口；已经开始的展示任务不受取消影响，那是 `showcase.stop` 的职责。
- **满足准入时自动启动**：预约只是一个触发器。每次分支结算、daemon 恢复、合并或跟上父分支后，后端重跑现有 `showcaseEligibility`；一旦满足完整准入就清除预约并自动创建展示任务，Web 会跳到任务详情。预约期间分支上一直显示当前阻塞原因。
- **归档自动取消**：分支归档或删除时，它的预约一并清除（并留 `showcase.unreserved` 事件），不会对已不存在的分支启动展示。
- **不绕过准入**：预约不改变任何准入规则，只是把 `showcase.start` 推迟到准入满足之后；用户仍可直接用 CLI 手动启动。
- **不自动合并**：自动启动的展示与手动启动一样，只产出报告与可选预览，不设置检验 pass、不把 Candidate 变为 ready，也不自动合并。

RPC：`showcase.reserve(branch)` 挂起预约（当前已满足准入时立即创建展示 Task），`showcase.unreserve(branch)` 取消；两者都是用户专属。

## agent 实际做什么

1. runtime 固定展示提交和对比起点，各创建一个独立 detached worktree；不切换用户分支，不提交或暂存用户修改。
2. agent 阅读 diff、提交与相关实现，识别用户能感知的变化，报告执行里程碑。
3. agent 自主设计最直观的方案并执行：UI 可用真实截图/前后对照/可操作预览，CLI 用相同输入的输出，API 用实际请求响应，性能用可复现实测。
4. agent 写自包含 HTML 展示页：修改摘要、方案及理由、真实证据、体验步骤、复现命令、未展示项和限制。运行受阻必须如实说明，不能用示意图冒充实际截图。
5. 任务详情内嵌展示页，另提供新窗口入口及托管预览的打开/停止按钮。展示页缺失或不合法时任务失败，不能仅凭最终一句“完成”算交付。

只展示冻结的**已提交代码**。源分支后续移动不改变这一轮展示；失败/取消重试仍使用原提交，但重新校验稳定性、去重和当前文件树。代码已变时必须启动新展示，不能重试旧版本。

报告固定在 `.lush/showcase/<task-id>/report.html`，最大 8 MiB。新一轮调用会把已有报告留为 `report-before-run-<run-id>.html`，必须重新交付，不静默复用失败轮次的报告。Git 检出保留供检查，用户可在停止预览后用 `task cleanup` 安全回收；有源码改动或未知提交时拒绝清理，不强制删除。

## 本机可运行预览

需要持续体验时，agent 使用 `showcase.preview` 请求 daemon 启动服务，不自行后台化：

```json
{
  "command": ["bun", "run", "dev", "--host", "127.0.0.1", "--port", "{port}"],
  "path": "/"
}
```

这只是参数格式示例，必须按实际项目调整。agent 执行 `lush showcase preview --file FILE.json`，参数直接作为 argv 传递，没有 shell 插值。runtime 分配本机端口，替换 `{port}`，设置 `HOST=127.0.0.1` 和 `PORT`，在展示 worktree 运行。应用不一定自动读取这些变量，agent **必须显式确认仅监听本机**。端口可连通只代表进程启动，agent 仍须实际检查页面或接口。

- 预览只继承 PATH、HOME、临时目录和语言等基础环境，不继承 Lush actor token、项目绑定或 daemon 的 API 密钥。
- 最多同时运行 8 个预览。每个任务最多一个，日志尾部最多 64 KiB，在同目录 `preview.log`。
- 展示成功后服务继续运行，不占 agent invocation 槽；用户停止、任务失败/取消、daemon 正常退出会停止受管进程组。独立 supervisor 通过 stdin EOF 处理 daemon 意外退出。
- 重启不自动执行旧命令；静态报告仍可看。不为重开预览重复展示已成功展示的同一份代码。运行中的预览阻止 worktree 清理。
- URL 只指向 `127.0.0.1`，必须在 daemon 所在电脑打开。远程 Web 用户仍可阅读报告，不能把自己的 localhost 当作服务器；Lush 不代理预览服务，也不承诺它受 Lush 登录认证保护。

**这是执行本地项目代码，不是 OS 安全沙箱。** worktree 仅隔离 Git 工作现场，不能阻止项目脚本访问宿主文件或网络。只展示可信分支；使用临时数据，禁止连接生产数据、覆盖真实服务。需要凭据、依赖安装或外部副作用时，agent 应先通过待决问题取得批准。报告页则使用无同源权限的 sandbox CSP，禁止外部资源和网络请求；可运行应用在另一个端口打开。

## RPC 与配置

| RPC | 参数 | 权限 / 结果 |
|---|---|---|
| `showcase.start` | `branch`, 可选 `baseline` | 仅用户；返回新 showcase Task 详情 |
| `showcase.reserve` | `branch` | 仅用户；挂起预约；已满足准入时立即创建展示 Task 并返回 `task_id` |
| `showcase.unreserve` | `branch` | 仅用户；取消预约，已开始的展示任务不受影响 |
| `showcase.list` | 可选 `branch` | 最近 50 条，有报告标志与当前预览状态 |
| `showcase.preview` | argv 数组 `command`, 可选 URL `path` | 仅当前有效 showcase invocation，不接受 task id |
| `showcase.stop` | `id` | 仅用户；停止预览，不删除报告或取消整个任务 |

`graph.get` 的分支节点提供 `showcase.reserve_allowed` / `reserve_reason`（现在能不能预约）、`reserved` / `reserved_at`（是否已预约）以及 `allowed` / `reason` / `latest_task_id`（完整准入与最近展示）；前端按 `reserve_allowed` 给预约入口、按 `reserved` 给取消入口，`allowed` 只用于确认键文案（现在已满足则写「开始展示」）与是否立即开始，不再决定入口有无。点击与提交时都重新检查。`task.inspect.showcase` 提供固定提交、文件树、两个目录、报告位置和实时预览状态。`GET /api/showcases?branch=...` 返回列表；`GET /api/task/<id>/report` 复用认证和独立 sandbox CSP。展示结果保存为 `showcase.result` Artifact，与 `run.result.verification` 分开。

Agent 设置、模型、Prompt、扩展、Skills 和环境文件都支持 `showcase` 角色。可以在设置页配置浏览器/截图所需能力；工具未安装时 agent 必须明确降低展示范围。详见 [Agent 环境](reference/agent-environment.md)。

---

[返回文档总览](README.md) · [底层检验与安全回收](task-flow-3-delivery.md)
