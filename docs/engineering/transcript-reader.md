# 执行记录阅读器

本文描述执行过程的当前实现、数据边界和测试入口。修改前先读[设计理念](../design/agent-process.md)：目标是帮助用户理解 Agent 的运作，不是单纯堆放日志。

## 两条读路径

快速视图沿用 `task.transcript`：从任务的 Pi 兼容 JSONL 投影步骤，执行过程默认收起，仅用户点击展开后读取；展开后直接展示思考、回答、工具及结果的正文，仅运行时元数据默认折叠。任务之间独立记忆本次会话的展开选择；刷新与新记录不会自动展开，收起后停止快速正文续读。兼容读面保留单条 4,000 字符、每请求前 8 MiB 的限制与既有 token 口径，不重写会话或数据库。

完整阅读走 `core/transcript-reader.js`：

- 按任务遍历所有会话文件，异步流式读取完成的 JSONL 行，不受快速视图的 8 MiB 范围限制。
- 搜索覆盖原步骤全文，不只搜预览或已加载 DOM；目前是大小写不敏感的连续子串匹配，不支持正则或语义搜索。
- 类型、工具名子串与失败筛选可以组合；失败指记录中的 `isError`，不猜测文本里的退出码。
- 返回按 `seq` 升序的有界摘要，`after` 为上一页最后一步；原文按 24,000 字符分页读取。
- 单行最多 16 MiB；超大行明确报“无法完整检索”，不会冒充无命中。坏 JSON 行跳过、未完成尾行等待后续写完；这与快速读面的步骤编号规则一致。
- 不持久化全文索引，也不缓存所有正文；每次查询从头流式扫描，因此超长历史的后页或原文查询可能较慢。当前能力是可完整翻找，不是恒定时间随机访问。

`seq` 在正常追加下稳定；会话清理或改写可能让旧编号失效。解释历史独立保存当时快照，不依赖源文件一直存在。

### 最新读取

需要优先看到尾部时走 `task.transcript_latest`：它不复用快速视图的 8 MiB 头窗口，而是对任务全部会话做一次完整的异步流式扫描，返回满足 `seq > after` 且（`before === 0` 或 `seq < before`）的最新 `limit` 步，按 `seq` 升序。`after` 是已读下界，`before` 是向回翻页的上界；两者默认 0 表示不设边界。

- 每步的字段、4,000 字符裁剪与 token 口径与 `task.transcript` 完全一致：精确请求带 `exact/turn`，两次请求之间的批次带 `context_added/estimated/batch`，批首 `first` 只落在该批第一步；窗口从批次中间开始时不会误添 `first`，文件边界仍不跨文件推算。
- 返回 `next`（窗口最大 `seq`）/`oldest`（窗口最小 `seq`）/`has_older`（`(after, oldest)` 内是否还有步骤）供 `before` 连续往回翻页；空窗口的 `next` 回退到 `after`、`oldest` 回退到 `before`。
- 内存有界：只保留窗口与当前 token 批次，不缓存全部正文；不改写会话文件。全量扫描与全文搜索同级，超长历史不是恒定时间。单行超过 16 MiB 时置 `truncated` 并跳过该行，不冒充无数据；坏 JSON 行同快速读面一样跳过。
- 与快速读面的区别：快速读面从头读、受每请求前 8 MiB 预算限制，适合先看开始；最新读取为保证尾部可达会读完整个任务记录，适合轮询最新步骤或从尾部向回翻找。

## 正文优先与因果配对

`transcript-body.js` 是快速视图与查找正文的共享渲染器：工具参数按命令、文件、起始行、修改前后等标签直接展示；未知参数保留字段名；命令与输出使用保留真实换行的代码块，思考／回答按 Markdown 偏好渲染。普通长内容默认显示前 10 行／1,000 字符，就地展开当前已加载内容；命令与失败文本不预折叠。参数最多预览 40 个字段、20 处修改，超限明确指向原文。

`transcript-model.js` 的摘要只供收起态与搜索定位使用，不再挤占默认正文。标题只保留类型、工具名或步骤编号，token 与时间弱化；会话文件与精确原文放在来源入口。页面使用主滚动，不为过程／正文再嵌套定高滚动框。

投影保留 `call_id`、`tool_name` 与 `is_error`。界面按 `(file, call_id)` 将已加载的输入输出放在同一个调用下，结果可以增量追加而不重建输入节点；跨页加载后同样配对。重复调用身份不猜配，缺 ID 的旧记录各自保留。

未见结果显示“尚未见到结果”，不是“成功”或“仍在运行”的断言。原始步骤编号与各自来源引用保留。完整步骤接口另查同一会话内的配对记录，最多附带 8 条关联摘要；前后各两步只作为阅读上下文，不自动发给解释 Agent。

## 全文翻找与原文

展开后的执行过程顶部提供全文搜索、类型、工具与失败筛选及解释历史入口；结果按页浏览，关键词命中高亮，点击在终端模式中从命中步骤开始阅读。删除旧“完整原文与上下文”阅读区，不再把相同正文与相邻记录重复堆到过程顶部；快速视图仍可就地查看当前段原文与来源。

### 只读终端模式

`transcript-terminal.js` 是 Pi 风格的独立全宽阅读视图，**不是 Pi 原生 TUI 或可交互终端**：不启动 Pi、PTY 或模型，不执行日志中的命令／ANSI 控制序列，无新增运行时依赖。沿用已保存的文字投影，按文件顺序与步骤编号展示输入、思考、回答、工具调用、输出及会话信息；图片只保留既有投影中的占位，不声称重放完整终端画面或未保存的流式内容。

任务页的“终端模式”从头读取；搜索／截断正文入口从该步骤开始，可“前 50 步”或“从头阅读”。调用与结果保留调用 ID，不按邻接猜配，不另外复制前后上下文。命令字符串显示真实换行、回答按 Markdown 偏好渲染，分段 JSON／Markdown 回退精确文本；每段可查看来源与原文。

连续读取走 `task.transcript_page`：每页至多 50 段、96,000 字符正文、700,000 字节步骤 JSON，单段至多 24,000 字符，不截断 Unicode 代理对；返回 `(next_seq,next_offset)`，超长单步骤也可续读。接口复用全量流式扫描，不受快速视图的 8 MiB／4,000 字符裁剪影响，不对每一步重复查询上下文。每页仍从头扫描，超长历史后页不是恒定时间读取。

仅打开和用户点击续读时加载有界页面，已加载段落连续保留；内存随用户手动续读增长，不自动预取全部记录。到末尾可“检查新记录”，不会自动滚动或重建已读节点。打开期间暂停任务详情重画与快速列表续读；关闭／Esc 恢复原任务页位置与焦点，关闭、导航、切换读取位置与 boot 都使旧请求失效。原搜索／步骤 API 继续兼容，解释仍使用原步骤和可靠配对快照。

## 专用解释 Agent

选中执行记录中的 1–8,192 字文字，右键“介绍：目的、原理与结果含义”，直接创建 `explainer` 根 Task；不创建 Input、开发分支或 worktree，也不附着在可能已终态的源 Task 下。

- 来源快照写入现有 `explanation.requested` Event，包含选区、任务目标、所属步骤首段、配对输入输出摘要、来源编号与时间，截断有标记。
- Task.result 保存解释；Task / Agent / Run 沿用现有生命周期、并发、取消、重试与恢复规则，不增加业务实体或 schema。
- 结果在独立旁侧面板显示，关闭面板只停止客户端读取，不取消解释任务；完成后从源任务的“解释历史”回看，支持更早历史分页。
- 模型须区分目的推断、机制背景和结果事实；资料不足时明确说明。原日志是资料，不是指令。

权限不仅依赖提示词：Pi 使用 `--no-tools --no-extensions --no-skills --no-context-files --no-approve`，不加载 profile 中的扩展和 Skills；启动消息直接附带运行时准备的资料文件，不需要模型用 read 工具读取。子进程不获 invocation token，runtime 也拒绝 explainer actor 的 RPC 和派工。

可以在 Agent 设置中为 explainer 配置 Pi 模型／思考等级／提示词与环境。Codex 尚没有在本实现中验证等价的无工具模式，因此选择 Codex 时明确拒绝，不以开发权限降级运行。Mock 可用于离线测试，但不会伪装为真实模型解释。

## 结构化渲染

通用工具输出与嵌套参数若为合法 JSON 对象／数组，显示根层默认展开、子层按需展开的键树并保留“查看原文”；字符串直接呈现换行，不用 `JSON.stringify` 把正文变成字面 `\\n`。最多 12 层、每分支 100 个子节点、每棵树 1,500 节点；到限提示查看原文。非法／截断 JSON 回退纯文本。所有内容经 DOM 文本节点写入，不解释 HTML。

结构视图是辅助预览；JavaScript JSON 数值显示可能涉及浮点精度，精确数值与原始空白以原文为准。Markdown 回答与思考仍走原有安全渲染；这里只为工具数据增加结构视图。

## 接口

以下新增 RPC 均为用户专属，不接受 Agent token；读取仍在认证后的 Web 边界内：

| RPC | 参数 | 返回 |
|---|---|---|
| `task.transcript_search` | `id, query?, kind?, tool?, errors?, after?, limit?` | `steps, next, has_more, files, scope`；limit 默认 50，最大 100 |
| `task.transcript_latest` | `id, after?, before?, limit?`（默认 0 / 0 / 100） | `steps, next, oldest, has_older, files, truncated`；最新优先窗口，limit 最大 200 |
| `task.transcript_page` | `id, seq?, offset?`（默认 1 / 0） | `steps, next_seq, next_offset, has_more, files, scope` |
| `task.transcript_step` | `id, seq, offset?` | `step, offset, next_offset, has_more, related, context` 与配对限制标记 |
| `explanation.start` | `id, seq, quote` | 新解释任务的状态、来源快照 |
| `explanation.list` | 源任务 `id, before?` | `explanations, next, has_more`，每页 50 条 |
| `explanation.get` | 解释任务 `id` | `id, status, result, error, source` |

GET 路由：`/api/task/<id>/transcript-latest`、`/api/task/<id>/transcript-page`、`/api/task/<id>/transcript-search`、`/api/task/<id>/transcript-step`、`/api/task/<id>/explanations`、`/api/explanation/<id>`。创建走现有 `POST /api/action` 的 `explanation.start` 白名单；没有新增直连模型的浏览器入口。

## 验证入口

`test/transcript-reader.test.js` 覆盖全量范围、截断后命中、配对、分页与文件边界；`test/transcript-latest.test.js` 覆盖最新窗口、`before` 往回翻页、`after` 只看新增、token／裁剪与 head 读面一致、超过 8 MiB 仍取到尾部、坏行跳过与超长行标记；`test/project/explanations.test.js` 覆盖快照、无分支和权限；`test/explainer-provider.test.js` 使用可控子进程检查禁用工具的参数与凭证。

Web 路由与 DOM 交互见 `test/web/transcript-reader.test.js`、`test/web/dom-transcript-reader.test.js`、`test/web/dom-transcript-terminal.test.js`。测试只使用临时项目和 Mock／可控进程，不发送真实项目内容给模型。
