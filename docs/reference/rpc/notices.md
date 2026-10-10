# 待决问题与告知

Notice 共用持久记录，但决策与告知的语义独立。Agent 需要用户决断时发布问题；普通进度与完成汇报仍写 Worker result。用户直接创建 Worker 的本轮静息或异常停止由 runtime 内置 hook 自动生成纯告知，不需要 Agent 自己发布，也不额外调用模型。

| CLI | RPC | 参数 |
|---|---|---|
| `notice list` | `notice.list` | `{}` |
| 项目历史分页 | `notice.page` | `{status?: 'all', before?: ID, limit?: 30}` |
| Host 来源增量同步（用户专属） | `notice.sync` | `{cursor?: 不透明游标, limit?: 100}` |
| `notice post 'title' --worker ID --body 'body'` | `notice.post` | `{task, title, body?: '', questions?}` |
| `notice post 'title' --questions-file FILE` | `notice.post` | 文件为 `{questions:[…]}`，agent 可省略 `--worker` |
| `notice answer ID 'answer'` | `notice.answer` | `{id, answer:字符串, expected_identity?:记录身份}`（旧式文字问题） |
| `notice answer ID --answers-file FILE` | `notice.answer` | `{id, answer:{answers:[…]}, expected_identity?:记录身份}`（结构化问卷） |
| `notice dismiss ID` | `notice.dismiss` | `{id, expected_identity?:记录身份}` |
| `notice read ID` | `notice.read` | `{id, expected_identity?:记录身份}`（用户专属，只将 `info/sent` 标记已读） |

在源码仓库中统一用 `bun run lush notice …`（或 `bun run answer …`）。Agent 子进程通过注入的 CLI 与 `LUSH_PROJECT` 连接原项目，即使 cwd 是独立 worktree，也不会把问题发到另一个项目。

CLI 的 `--worker` 映射到保留的 RPC 参数 `task`，不接受旧 `--task` 别名；不要把 `notice.post {task,…}` 改成不存在的 `worker` 参数。见[更名边界](../../engineering/core-api.md#worker-更名与兼容边界)。

## 全局来源同步与记录身份

Host 全局收件箱使用用户专属 `notice.sync`，不通过首页 200 条窗口冒充完整历史。返回 `{version:1,project,epoch,reset,changes,cursor,has_more}`；changes 为 `{id,identity,deleted,notice?}`。初始化固定 watermark 分页扫描旧记录，随后补增量；日志过期或数据库 epoch 变化返回 reset 重新补齐。新增、答复、已读、直接 SQL 结算及删除由附属索引／触发器同步，原 Notice 行不回填或重写。

所有 Notice 读面附加 `sync_identity`、`sync_revision`、`sync_epoch`。整数 ID 仅在来源项目内有效；新全局前端将所见 `sync_identity` 作为 `expected_identity` 交给 Host，来源 RPC 在同一事务核验再执行，删除／ID 复用不误答新记录。该可选 RPC 字段不改变既有 CLI 参数，旧客户端可省略；不是调用方自报答案来源。

全局缓存是私有、有界的派生视图，离线／补齐状态明确，不能据缓存执行动作。来源移除／无权访问后不再返回缓存；读取不启动停止的 daemon。HTTP 路径及容量／失败边界见[用户工作台契约](../../engineering/user-workspace.md#全局收件箱分区)。

## 生命周期告知

内置 hook 只覆盖用户直接创建的 `order` / `analysis`。指令正常完成一轮工作、无待决问题、未处理输入或未结算子Worker后，以 `task.idle` 事件生成“本轮已结束”的告知；它仍可能在等待合并或进一步指示，并不代表验收完成。同步修复的轮末也使用相同事件。超时、调用失败、daemon 中断恢复及分析检出失败保存失败原因。子 Worker 与内部 main/owner/merge 不触发此 hook；等待子Worker、问卷、用户主动暂停/取消和安全抢占不额外告知。

指令以 `start:false` 仅创建成功时，在创建事务内以 `task.start_pending` 生成「待开始」告知，提醒尚未调用 Agent，可主动打开 Worker 配置后手动开始。直接正文、草稿及预约 Hook 的真实创建共用该路径；预约仅挂载、立即开始或重启恢复不生成、不补发此告知。发射后前端留在原页，查看由用户主动触发。

告知固定 `kind='info' / status='sent'`，不进入 open 问题口径，不阻塞调度、合并或验收。Notice 的可空 `source_event_id INTEGER` 指向来源 Event，并以唯一索引去重；`read_at TEXT` 保存已读时间。Worker状态、来源事件和告知同事务写入，旧 Notice 的新字段保持 NULL，不回填、不补发历史完成通知。

Notice 读面另投影可空 `lifecycle_type`，依据同 Worker 的来源 Event：`task.start_pending` → `created`，`task.idle` → `idle`，`completed` → `analysis`，`failed` / `merge.repair_interrupted` / `analysis.fork_failed` → `failed`。只对带来源的 info 告知分类，旧普通 info、丢失或未知来源为 NULL；不修改存储、不按标题或当前 Worker 状态猜测。`notice.list/page`、Worker 详情与生命周期生成/已读返回使用相同投影。

`notice.read` 用户专属、幂等，只允许 info/sent；首次记录 `notice.read` Event，不产生收件箱消息，不答复问题、批准合并、验收或唤醒 Agent。已读后 Notice 仍是 sent，正文及来源永久保留在历史里。Web 在点击告知并成功加载所属 Worker 后调用它，打开失败不标已读；告知条的「已知」及手机横滑直接调用它，无需打开 Worker，写入失败保留告知并允许重试。

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
- 推荐项排第一并在 label 标「（推荐）」，默认**不自动选择**。用户显式开启设备全局 [自动选择授权](../../engineering/daemon-auto-select.md) 后，单选固定选择第一项，多选交回 Agent 自行判断；开启也处理已有待答问卷及文字问题。多选仅用于多个选项可以同时成立的题目。
- 每题自动提供自定义答案，不要手写 `Other` / `其他` / `自定义答案` 占位选项。自定义答案替代该题全部选项，不与选项混用。
- `preview` 是 Markdown（最多 12000 字）；`previewHtml` 是自包含静态 HTML/CSS（最多 16000 字）。整个 versioned envelope 最多 64000 UTF-8 字节，背景 body 最多 8000 字。无需预览的简单偏好题只写说明即可。
- 发布前完整校验，非法请求不建 notice、不暂停Worker。每个 Worker 同时最多一份开放问卷。

问卷存入现有 notices 表：`kind='questionnaire'`，`body` 为 `{version:1,body,questions}` JSON。不新增实体、表或列，不迁移旧数据库。旧式文字 notice 与计划审批保持原格式。

## 非阻塞暂停与恢复

发布结构化问卷是 agent 本轮的**最后一个动作**。同一数据库事务先保存 notice、消费本轮已交付消息、记录暂停结果、将 Worker 标为 `awaiting`，然后中止本轮 invocation 的进程组并作废 token。它不是失败、不是 completed，不检查/提交/清理 worker 的半成品工作区；取消Worker仍按原有规则处理。

普通追加消息与子Worker结果继续落收件箱，但开放问卷会挡住重新排队。回答/忽略后投递消息，再由 Worker 唤醒 Agent；若用户回答发生在旧进程尚未收尾时，释放 running 占位后的收件箱复查保证不会丢唤醒。重启保留待答问题，不自动重放暂停前的调用。

答复必须按题目顺序覆盖全部问题，选项使用 **零基序号**：

```json
{"answers":[{"selected":[0],"custom":""}]}
```

自定义答案示例：`{"answers":[{"selected":[],"custom":"先保留当前布局"}]}`。最多 4000 字。多选用 `selected:[0,1]`；单选只能有一项。缺题、越界、重复项、伪造标签或选项与自定义混用会被拒绝，原 notice 保持 open。

服务端从已存问卷生成规范化答案：`{version:1,answers:[{question,header,selected,labels,custom}]}`，JSON 存入 `notice.answer`。收件箱消息包含 `{notice_id,title,dismissed,answer}`，其中 answer 是规范化对象，不是客户端自报的标签。答复 RPC 只允许用户；同一 notice 只能结算一次。读面附带 `answer_source:user|lush|null`：用户答复为 user，daemon 自动答复为 lush，未答为 null；历史已回答/已忽略兼容为 user、不改写历史行。自动答复消息和事件同样带来源，Worker 不得把自动选择误当用户决断。

忽略问卷表示**未做决定，不是默认同意推荐项**。普通 owner 收到 `dismissed:true` 消息后继续评估，不应实施依赖未决选择的工作。从未被唤醒的预置解分歧Worker（`resolves_task_id` 且 `agent_wakes=0`）会因忽略被直接取消，见[合并](../../engineering/merge.md)。

## 选择快照已停用

用户 W138 要求取消选择快照，待方向明确后再开发。新问卷不保存代码或上下文快照；`notice.snapshot` / `notice.rechoose` 及对应 CLI、HTTP、Web 重选入口不再开放。正常选择与答复不变，历史问卷和原答案仍可只读回看。已有快照及已创建路线不擅自删除或改写，兼容边界见[停用说明](../../engineering/choice-snapshots.md)。

## Web

「待我处理」面板提供待决、未读告知、自动选择、已回答、已忽略和全部记录筛选，包括普通提问、问卷与纯提醒。待决事项在面板内查看正文、答复或审批；生命周期告知直接进入对应 Worker，成功加载后自动已读。历史事项保留原正文与处理记录，不会因已读、答复、忽略、刷新或重启丢失。

问卷单选点一次即进入下一题；多选点选后继续；预览按钮/悬停/键盘聚焦可先看方案，不提交答案。最后展示全部题目的选择、说明与可展开预览，可返回修改，一次确认整份问卷。在记录面板提交后原地显示处理结果；从Worker详情答复时仍可自动打开下一个未决问题。

全局选择草稿按来源项目、sync_epoch、sync_identity 隔离；旧项目读面仍兼容 notice id、创建时间及正文，在当前标签页的 sessionStorage 保存；切换Worker、轮询、刷新再打开不会丢选择。发送失败保留草稿、允许重试；其它标签页已处理时服务端拒绝重复提交。

HTML 通过已认证的只读预览路由渲染，不读取 agent 提供的本机路径：先白名单清洗，删除脚本、事件、外链导航、meta refresh、表单、嵌套 frame 等，再使用独立 CSP 和无权限 iframe sandbox。仅允许内联样式与 data 图片/字体，禁止网络与脚本、宿主访问、导航与表单提交。预览是**静态提案，不是已实现效果**。浏览器使用该实现，主页面 CSP 不放宽。

兼容 `notice.list` 优先返回未决项，其次未读生命周期告知，再是历史记录，同组按新到旧排列；最多 200 条并受 RPC 字节预算限制。记录面板使用 `notice.page`（HTTP `GET /api/notices`），按 ID 降序返回 `{notices,cursor,has_more,limit}`；status 为 `all|open|answered|dismissed|sent|unread|automatic`；`automatic` 在数据库分页前只匹配已回答、question/questionnaire、持久 `answer_source='lush'` 的问答，不根据答案正文或当前开关猜来源，关闭后仍可回放原问题与答案；`unread` 仅匹配 info/sent、source_event_id 非空且 read_at 为空，limit 为 1–100、默认 30。使用返回的 cursor 作为下一页 before，字节预算截断时也保留续页游标，所以历史不受 200 条总量限制。

旧式文字问题仍接收字符串，发布后依赖 agent 结束本轮再停在 awaiting；它不是结构化问卷的主动中止路径。

### 页面告知条与分类设置

「设置 → 界面」分别为 **Worker 待开始、Worker 本轮结束、只读分析完成、异常停止** 设置「页面告知条」与「系统通知」；各类各渠道默认允许，系统通知还需总开关与授权。未知分类的生命周期告知保持可见。待决问题独立保留，不能用「已知」或横滑消除。设计取舍见[通知与告知理念](../../design/notices.md)。

类别／渠道偏好由 Host 保存为后台机器同一系统用户的设备设置，各客户端同步；localStorage 只缓存首帧。关闭类别不阻止告知生成、不删记录、不改未读数。已读事实仍由来源项目保存，不是浏览器偏好。

页面告知条展示可见类别的最新未读告知及数量，提供查看 Worker 与「已知」两个入口。「已知」只标记当前展示的一条，下一条依次显示。手机可水平滑动执行同一动作，同时保留按钮；垂直滚动、短滑、文本选择或取消手势不消除。

### 浏览器／系统提醒

设备设置的系统提醒总开关默认关闭，由 Host 权威保存；浏览器通知权限是独立客户端能力，只在用户手势下请求。拒绝、不支持或非安全上下文显示本客户端说明，不将已保存的设备总开关写回 false、不影响其它客户端。Host 保存失败则不能假称总开关已开启。远程 Web 需 HTTPS，本机可用 localhost。

仅在浏览器页面打开期间，对新出现的未处理问题、问卷和计划发送通知；后台窗口也可以提醒，但受浏览器节流、系统权限与勿扰模式约束。首次加载／刷新／切换项目不补发旧事项；旧普通完成提醒（source_event_id 为空的 info）仅留档，新的未读生命周期告知也可提醒。点击生命周期告知通知聚焦应用并打开所属 Worker，成功加载后标已读；问题仍进入对应决策处理入口。分类的系统通知开关独立过滤纯告知，不过滤待决问题；关闭期间的新事项不在重新开启时补发。关闭开关只停止提醒，关闭浏览器页面后不提供后台推送。
