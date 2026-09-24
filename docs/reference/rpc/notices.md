# 待决问题

notice 是所有角色、所有任务分支共用的用户决策入口。普通进度、完成汇报写 task result，不发 notice。计划批次批准继续用 `plan.propose` / `approve` / `reject`。

| CLI | RPC | 参数 |
|---|---|---|
| `notice list` | `notice.list` | `{}` |
| Web 历史分页 | `notice.page` | `{status?: 'all', before?: ID, limit?: 30}` |
| `notice post 'title' --task ID --body 'body'` | `notice.post` | `{task, title, body?: '', questions?}` |
| `notice post 'title' --questions-file FILE` | `notice.post` | 文件为 `{questions:[…]}`，agent 可省略 `--task` |
| `notice answer ID 'answer'` | `notice.answer` | `{id, answer:字符串}`（旧式文字问题） |
| `notice answer ID --answers-file FILE` | `notice.answer` | `{id, answer:{answers:[…]}}`（结构化问卷） |
| `notice dismiss ID` | `notice.dismiss` | `{id}` |

在源码仓库中统一用 `bun run lush notice …`（或 `bun run answer …`）。Agent 子进程通过注入的 CLI 与 `LUSH_PROJECT` 连接原项目，即使 cwd 是独立 worktree，也不会把问题发到另一个项目。

## 结构化问卷

`questions` 含 1–4 题，每题 2–4 项，结构借鉴 rpiv-ask-user-question，但调用与暂停完全由 Lush 管理，不加载交互式 pi 插件：

```json
{
  "questions": [{
    "header": "导航布局",
    "question": "设置页面采用哪种导航？",
    "options": [
      {"label": "侧栏（推荐）", "description": "分类扩展方便，但占用横向空间。", "previewHtml": "<nav>账户<br>通知<br>安全</nav>"},
      {"label": "顶部标签", "description": "适合分类较少的页面，内容更宽。", "preview": "账户 | 通知 | 安全"}
    ],
    "multiSelect": false
  }]
}
```

- `header` 最多 16 字，`question` 最多 2000 字；label 最多 60 字，description 最多 2000 字，均不能为空。选项标签不可重复。
- 推荐项排第一并在 label 标「（推荐）」，默认**不自动选择**；显式开启[托管模式](../../sleep-mode.md)后可由管家按授权代理选择。多选仅用于多个选项可以同时成立的题目。
- 每题自动提供自定义答案，不要手写 `Other` / `其他` / `自定义答案` 占位选项。自定义答案替代该题全部选项，不与选项混用。
- `preview` 是 Markdown（最多 12000 字）；`previewHtml` 是自包含静态 HTML/CSS（最多 16000 字）。整个 versioned envelope 最多 64000 UTF-8 字节，背景 body 最多 8000 字。无需预览的简单偏好题只写说明即可。
- 发布前完整校验，非法请求不建 notice、不暂停任务。每个 task 同时最多一份开放问卷。

问卷存入现有 notices 表：`kind='questionnaire'`，`body` 为 `{version:1,body,questions}` JSON。不新增实体、表或列，不迁移旧数据库。旧式文字 notice 与计划审批保持原格式。

## 非阻塞暂停与恢复

发布结构化问卷是 agent 本轮的**最后一个动作**。同一数据库事务先保存 notice、消费本轮已交付消息、记录暂停结果、将 task 标为 `awaiting`，然后中止本轮 invocation 的进程组并作废 token。它不是失败、不是 completed，不检查/提交/清理 worker 的半成品工作区；取消任务仍按原有规则处理。

普通追加消息与子任务结果继续落收件箱，但开放问卷会挡住重新排队。回答/忽略后投递消息，再由 task 唤醒 agent；若用户回答发生在旧进程尚未收尾时，释放 running 占位后的收件箱复查保证不会丢唤醒。重启保留待答问题，不自动重放暂停前的调用。

答复必须按题目顺序覆盖全部问题，选项使用 **零基序号**：

```json
{"answers":[{"selected":[0],"custom":""}]}
```

自定义答案示例：`{"answers":[{"selected":[],"custom":"先保留当前布局"}]}`。最多 4000 字。多选用 `selected:[0,1]`；单选只能有一项。缺题、越界、重复项、伪造标签或选项与自定义混用会被拒绝，原 notice 保持 open。

服务端从已存问卷生成规范化答案：`{version:1,answers:[{question,header,selected,labels,custom}]}`，JSON 存入 `notice.answer`。收件箱消息包含 `{notice_id,title,dismissed,answer}`，其中 answer 是规范化对象，不是客户端自报的标签。答复 RPC 只允许用户；显式授权的[托管模式管家](../../sleep-mode.md)由运行时内部代答并单独留档；同一 notice 只能结算一次。

忽略问卷表示**未做决定，不是默认同意推荐项**。普通 owner 收到 `dismissed:true` 消息后继续评估，不应实施依赖未决选择的工作。只有从未被唤醒的预置解冲突任务（`resolves_task_id` 且 `agent_wakes=0`）会因忽略被直接取消，见[合并](merge.md)。

## Web / Electron

「待我处理」面板另提供独立的「管家选择」审计页，并提供未处理、已回答、已忽略和全部记录四个普通 Notice 筛选，包括普通提问、问卷、计划审批与纯提醒。点开后在面板内查看正文、答复或审批；已处理事项只读展示原问题与结果，不会因答复、忽略、刷新或重启丢失。原有显式 `task.delete` / `task.clear` 的清库行为不变，见[维护](maintenance.md)。

问卷单选点一次即进入下一题；多选点选后继续；预览按钮/悬停/键盘聚焦可先看方案，不提交答案。最后展示全部题目的选择、说明与可展开预览，可返回修改，一次确认整份问卷。在记录面板提交后原地显示处理结果；从任务详情答复时仍可自动打开下一个未决问题。

选择草稿按项目、notice id、创建时间及正文隔离，在当前标签页的 sessionStorage 保存；切换任务、轮询、刷新再打开不会丢选择。发送失败保留草稿、允许重试；其它标签页已处理时服务端拒绝重复提交。

HTML 通过已认证的只读预览路由渲染，不读取 agent 提供的本机路径：先白名单清洗，删除脚本、事件、外链导航、meta refresh、表单、嵌套 frame 等，再使用独立 CSP 和无权限 iframe sandbox。仅允许内联样式与 data 图片/字体，禁止网络与脚本、宿主访问、导航与表单提交。预览是**静态提案，不是已实现效果**。浏览器与 Electron 共用该实现，主页面 CSP 不放宽。

兼容 `notice.list` 优先返回未决项，同组按新到旧排列；最多 200 条并受 RPC 字节预算限制。记录面板使用 `notice.page`（HTTP `GET /api/notices`），按 ID 降序返回 `{notices,cursor,has_more,limit}`；status 为 `all|open|answered|dismissed|sent`，limit 为 1–100、默认 30。使用返回的 cursor 作为下一页 before，字节预算截断时也保留续页游标，所以历史不受 200 条总量限制。

旧式文字问题仍接收字符串，发布后依赖 agent 结束本轮再停在 awaiting；它不是结构化问卷的主动中止路径。

### 浏览器／系统提醒

在「待你决定」或「设置 → 界面 → 待决事项系统提醒」开启。默认关闭，开关仅属于当前客户端：浏览器按站点保存，桌面端保存在 Electron userData，不随随机端口丢失。首次开启 Web 提醒须主动授权；拒绝、不支持或非安全上下文会显示说明，不影响记录与答复。远程 Web 需 HTTPS，本机可用 localhost。

仅在页面／桌面窗口打开期间，对新出现的未处理问题、问卷和计划发送通知；后台窗口也可以提醒，但受浏览器节流、系统权限与勿扰模式约束。首次加载／刷新／切换项目不补发旧事项，普通完成提醒（info）仅留档，不弹系统通知。点击通知聚焦应用并进入待决面板。关闭开关只停止提醒，关闭页面／桌面窗口后不提供后台推送。
