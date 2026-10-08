# 执行记录阅读器

本文描述执行过程的当前实现、数据边界和测试入口。修改前先读[设计理念](../design/agent-process.md)：目标是帮助用户理解 Agent 的运作，不是单纯堆放日志。

## 两条读路径

快速视图沿用 `worker.transcript`：从Worker的 Pi 兼容 JSONL 投影步骤，执行过程仅用户点击「打开执行详情」后全屏读取；打开后直接展示思考、回答、工具及结果的正文，仅运行时元数据默认折叠。刷新与新记录不会自动打开，返回Worker后停止正文续读。兼容读面保留单条 4,000 字符、每请求前 8 MiB 的限制与既有 token 口径，不重写会话或数据库。

完整阅读走 `core/transcript-reader.js`：

- 按Worker遍历所有会话文件，异步流式读取完成的 JSONL 行，不受快速视图的 8 MiB 范围限制。
- 搜索覆盖原步骤全文，不只搜预览或已加载 DOM；目前是大小写不敏感的连续子串匹配，不支持正则或语义搜索。
- 类型、工具名子串与失败筛选可以组合；失败指记录中的 `isError`，不猜测文本里的退出码。
- 返回按 `seq` 升序的有界摘要，`after` 为上一页最后一步；原文按 24,000 字符分页读取。
- 单行最多 16 MiB；超大行明确报“无法完整检索”，不会冒充无命中。坏 JSON 行跳过、未完成尾行等待后续写完；这与快速读面的步骤编号规则一致。
- 不持久化全文索引，也不缓存所有正文；每次查询从头流式扫描，因此超长历史的后页或原文查询可能较慢。当前能力是可完整翻找，不是恒定时间随机访问。

`seq` 在正常追加下稳定；会话清理或改写可能让旧编号失效。解释历史独立保存当时快照，不依赖源文件一直存在。

### 最新读取

需要优先看到尾部时走 `worker.transcript_latest`：它不复用快速视图的 8 MiB 头窗口，而是对Worker全部会话做一次完整的异步流式扫描，返回满足 `seq > after` 且（`before === 0` 或 `seq < before`）的最新 `limit` 步，按 `seq` 升序。`after` 是已读下界，`before` 是向回翻页的上界；两者默认 0 表示不设边界。

- 每步的字段、4,000 字符裁剪与 token 口径与 `worker.transcript` 完全一致：精确请求带 `exact/turn`，两次请求之间的批次带 `context_added/estimated/batch`，批首 `first` 只落在该批第一步；窗口从批次中间开始时不会误添 `first`，文件边界仍不跨文件推算。
- 返回 `next`（窗口最大 `seq`）/`oldest`（窗口最小 `seq`）/`has_older`（`(after, oldest)` 内是否还有步骤）供 `before` 连续往回翻页；空窗口的 `next` 回退到 `after`、`oldest` 回退到 `before`。
- 内存有界：只保留窗口与当前 token 批次，不缓存全部正文；不改写会话文件。全量扫描与全文搜索同级，超长历史不是恒定时间。单行超过 16 MiB 时置 `truncated` 并跳过该行，不冒充无数据；坏 JSON 行同快速读面一样跳过。
- 与快速读面的区别：快速读面从头读、受每请求前 8 MiB 预算限制，适合先看开始；最新读取为保证尾部可达会读完整个Worker记录，适合轮询最新步骤或从尾部向回翻找。

### 快速查看的阅读方向

全屏「执行过程」默认**最新在前**：初次展开走 `worker.transcript_latest?limit=100` 取尾部窗口，按 `seq` 降序渲染（最新步骤在最上），向上滚动回看更早，底部「加载更早」用 `before=oldest` 连续向前翻页。`state.steps` 始终按 `seq` 升序保存为规范态，方向只影响渲染与节点落位。阅读页工具栏或设置 → 界面 → 「执行过程排序」可切回「最早在前（正序）」，此时走 `worker.transcript` 从头部读取。两个方向都给两个有界翻页入口：`加载更早` 用 `before=oldest`、`加载更多` 用 `after=next`；asc 把更早的一页前插到顶部、desc 追加到底部。搜索定位出的居中窗口因此两侧都能继续读。切换偏好时已展开的过程按新方向重新加载，未展开不请求。

热Worker增量续读与终态补读也按方向取数：asc 用前向端点，desc 用 `transcript_latest?after=next`（`next` 恒为已知最大 `seq`），新步骤并入 `state.steps` 尾部、渲染到列表顶部，并在顶部提示「有新记录 · 跳到最新」（asc 仍跳到末尾）。desc 的 `has_older` 只由向旧翻页改变，增量不改动它；两种方向下按 `(file, call_id)` 的调用/结果配对跨翻页边界都不得重复或错配，已渲染节点的展开状态与阅读位置不被无谓重建吞掉。全屏阅读与设置共用同一排序偏好。

## 正文优先与因果配对

`transcript-body.js` 是执行正文渲染器，富文本与纯文本只差 `plain` 选项：工具参数按命令、文件、起始行、修改前后等标签直接展示；未知参数保留字段名；命令与输出使用保留真实换行的代码块，思考／回答按 Markdown 偏好渲染。富文本模式给命令（shell）与按文件扩展名识别出的文件正文着色，Markdown fence 也按语言着色（`code-highlight.js` 按需加载固定版本 highlight.js，受控 DOM 构建、不 innerHTML）。`plain` 模式只保留原始换行与扁平字段，不渲染 Markdown／JSON 树／着色，保留为纯文本渲染接缝，Web 不再提供终端模式。普通长内容默认显示前 10 行／1,000 字符，就地展开当前已加载内容；命令与失败文本不预折叠。参数最多预览 40 个字段、20 处修改，超限明确指向原文。

`transcript-model.js` 的摘要只供收起态与搜索定位使用，不再挤占默认正文。标题只保留类型、工具名或步骤编号，token 与时间弱化；会话文件与精确原文放在来源入口。页面使用主滚动，不为过程／正文再嵌套定高滚动框。

投影保留 `call_id`、`tool_name` 与 `is_error`。界面按 `(file, call_id)` 将已加载的输入输出放在同一个调用下，结果可以增量追加而不重建输入节点；跨页加载后同样配对。重复调用身份不猜配，缺 ID 的旧记录各自保留。

未见结果显示“尚未见到结果”，不是“成功”或“仍在运行”的断言。原始步骤编号与各自来源引用保留。完整步骤接口另查同一会话内的配对记录，最多附带 8 条关联摘要；前后各两步只作为阅读上下文，不自动发给解释 Agent。

## 全文翻找与原文

全屏执行详情左侧提供固定的紧凑搜索框、类型、工具与失败筛选；按 Enter 或「搜索」提交，输入和筛选变化不自动请求，Ctrl/⌘+Shift+F 聚焦搜索框。搜索控件不随命中摘要滚动，命中摘要按页浏览，关键词高亮；右侧只展示本页命中正文，与左栏按步骤编号升序一一对应（不受全部记录的阅读方向影响）。点击左栏命中在右栏就地定位，不加载无关步骤窗口。每项通过既有 `transcript-step` 读取首段最多 24,000 字符及可靠配对内容，最多 4 个并发请求；配对内容和至多 8 条的截断边界显式标注，相邻上下文按需展开且标明非命中。长正文在步骤旁继续分段读取完整原文。读取失败留在对应卡片并可重试，不把失败当成没有命中。

「返回全部记录」清空关键词与筛选，恢复既有富文本过程及翻页，不重开Worker页。兼容的独立检索 / 引用定位仍可按 `seq` 读取前后各 100 步的窗口，展开并定位到步骤。

### 全屏富文本详情

`transcript-view.js` 使用原生 dialog 顶层展示富文本执行过程：左侧命中列表与右侧正文各自滚动，搜索框保持可见，正文及工具输出不再嵌套滚动框；两栏有独立命名的 Grid 区域，项目导航样式仅匹配 `#sidebar`，不得污染执行页的 `aside`；窄屏上下排列，检索区有界且正文仍可阅读。工具栏提供返回与全部记录的正序／倒序选择，检索时禁用排序（命中按步骤编号排列）。搜索、调用配对、步骤折叠和有界翻页复用原渲染器，不另建 Web 终端模式、不启动 Pi／PTY／模型、不执行记录中的命令。

打开期间暂停Worker详情重画，全部记录模式下热Worker正文增量续读，保留节点与滚动位置；检索模式只提示新记录，不将非命中追加进正文，重新搜索才更新命中。搜索 / 翻页 / 返回全部记录 / 关闭会使旧检索与正文请求失效。返回／Esc 恢复Worker页位置与焦点；导航与 boot 关闭阅读页，迟到响应不写入已关闭的页面。排序切换重新加载对应头／尾窗口，过期方向请求不得覆盖新窗口。

「读取完整原文」通过既有 `worker.transcript_step` 按 24,000 字符分段，就地显示精确文字并提供继续读取／失败重试，不重复堆放配对与前后上下文。`worker.transcript_page` 保留为兼容只读 API：每页至多 50 段、96,000 字符正文、700,000 字节步骤 JSON，返回 `(next_seq,next_offset)`；不再有 Web 终端模式调用方。

### 平级的代码与改动视图

执行详情顶部增加键盘可切换的「执行记录 / 代码与改动」页签，默认仍是执行记录。代码页签首次点击才创建 `code-view.js` 并读取代码；切换保留两边的 DOM、选中文件、搜索与正文滚动，关闭释放代码计时器及请求。切到代码时暂停执行记录的增量正文读取、作废未完成的检索/正文队列；回到记录后已完成的搜索不重跑，未完成的搜索明确提示重新提交。

文件浏览器列出全部项目代码，未改文件可直接阅读；改动/未提交清单与目录共用选中状态。路径筛选按 Enter/按钮提交，目录按需读取，首层改动目录有界展开；用户显式折叠的目录在刷新/页签返回后保持折叠，不被自动展开规则覆盖。删除/重命名、暂存/未暂存、未跟踪、冲突各自可辨；缺少基线时明确净变化无法判断，不能把空列表报成无改动。数据和归档边界以[代码阅读器契约](code-reader.md)为准。

选中文件支持差异/文件内容、基线/当前版本、行号、按语言着色、上下差异块、增加上下文及分段读取。桌面默认并排，可切统一；窄屏强制统一并可收起文件栏。二进制/链接/子模块与模式变化保留元信息；正文按选中侧的类型/大小和读取原因识别不可展示内容，即使后端返回空 text，也不报空文件或已读到末尾。超限/不可用/不存在不冒充空文件或无差异。正文选区沿用文本引用，附路径、比较方向与采样出处，不新增代码语义目标或模型按钮。

仅前台代码页签按轮询偏好进行 single-flight 状态探测；状态变化只提示「加载最新」，不替换文件内容、选区或滚动位置。显式刷新才更新索引与选中文件；续读同时核对工作区 revision 和 file_revision，禁止把两个版本的文件片段拼接；`content.line_continued=true` 时核对字符偏移/行号并接入上一段的最后一行，不额外插入换行或重复行号，缺失该字段按 false 兼容。取消/切换后迟到响应作废。文件上的「在执行记录中搜索此路径」切回同级页签并清空旧类型/工具/失败过滤，只做路径文字搜索，不宣称修改因果定位。

### Worker 详情模块预览

Worker 详情的目标、进度、结果、错误、Agent 信息、状态、依赖、工作区、改动、子 Worker、决策记录、消息和事件等阅读模块，由 `detail-preview.js` 对**整个模块**提供高度预览：正文最多 `min(240px,32dvh)`，不因消息或历史条目数量增长而无限拉长。短模块不显示多余按钮；超长模块仅在标题右上角提供「展开完整内容 / 收起」，正文下方只保留预览说明，不重复提供按钮。展开后沿用页面主滚动，不为正文新增内层纵向滚动条。

这是展示限高，不是数据截断：不删除 DOM、Markdown 或引用，不改变原有历史分页，也不影响全屏执行详情。相同 Worker 的刷新保留模块手动状态，已有目标、结果和消息节点照旧复用；切到另一 Worker 恢复预览。自然正文与高度上限分别由 ResizeObserver 观测，涵盖按需历史加载、内容展开、窗口宽度以及仅高度变化。键盘聚焦正文内的控件、引用定位到正文时先自动展开，避免焦点或目标落在不可见区域；收起时把收起入口留在可见范围。操作栏、合并/验收控件、Hooks 与当前待决答复区不参与裁剪。

### 结果历史

`render-results.js` 默认直接展示 `Worker.result`，此前 invocation 结果在「此前结果」内按时间从新到旧排列，历史区默认展开，每项正文不再逐项折叠；整个结果模块受上述详情预览高度约束，展开模块后可连续阅读，显示调用身份与时间，重复文本也保留为不同调用。初始读 `worker.inspect.runs`（最新 50 条窗口及其 `runs_page` 游标）与已加载 `invocation.completed` 事件；更早结果通过既有 `worker.history_page` 逐页加载，按 run ID 去重，不把首屏窗口当成完整历史。无需新表／RPC，历史结果引用其不可变事件而不是可变的最新结果。同签名刷新时保留阅读节点与已加载历史；历史区的手动折叠状态在重绘时保留。

在真实终端里观看执行过程走 `lush worker transcript ID --follow`（Web「Agent」块的「复制命令」给出的同一条命令）：先用兼容读面 `worker.transcript` 分页打印已有记录，再用 `worker.transcript_latest` 以 `after` 为游标轮询新步骤，直到 Ctrl-C。它只读、不执行日志里的命令、不新增 RPC；一次轮询读到整页上限（200 步）时明确提示中间可能还有未显示的记录，不冒充已全部显示。该命令仅用户可运行，agent token 会被拒绝，`--json` 不适用。

## 专用解释 Agent（历史实现）

`explanation.*` / `intro.*` 已从 `src/rpc/registry.js` 移除，不再有公开 RPC / CLI / Web 入口；下面的实现与测试仍存在于源码中，只为读懂历史记录与后续清理，不能当作当前可操作的能力。当前可用的执行记录接口只有 `worker.transcript*`。

选中执行记录中的 1–8,192 字文字，右键“介绍：目的、原理与结果含义”，直接创建 `explainer` 根 Worker；不创建 Input、开发分支或 worktree，也不附着在可能已终态的源 Worker 下。

- 来源快照写入现有 `explanation.requested` Event，包含选区、Worker目标、所属步骤首段、配对输入输出摘要、来源编号与时间，截断有标记。
- Worker.result 保存解释；Worker / Agent / Run 沿用现有生命周期、并发、取消、重试与恢复规则，不增加业务实体或 schema。
- 结果在独立旁侧面板显示，关闭面板只停止客户端读取，不取消解释Worker；完成后从源Worker的“解释历史”回看，支持更早历史分页。
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
| `worker.transcript_search` | `id, query?, kind?, tool?, errors?, after?, limit?` | `steps, next, has_more, files, scope`；limit 默认 50，最大 100 |
| `worker.transcript_latest` | `id, after?, before?, limit?`（默认 0 / 0 / 100） | `steps, next, oldest, has_older, files, truncated`；最新优先窗口，limit 最大 200 |
| `worker.transcript_page` | `id, seq?, offset?`（默认 1 / 0） | `steps, next_seq, next_offset, has_more, files, scope` |
| `worker.transcript_step` | `id, seq, offset?` | `step, offset, next_offset, has_more, related, context` 与配对限制标记 |
| `explanation.start`（历史，无公开入口） | `id, seq, quote` | 新解释Worker的状态、来源快照 |
| `explanation.list`（历史，无公开入口） | 源Worker `id, before?` | `explanations, next, has_more`，每页 50 条 |
| `explanation.get`（历史，无公开入口） | 解释Worker `id` | `id, status, result, error, source` |

GET 路由：`/api/worker/<id>/transcript-latest`、`/api/worker/<id>/transcript-page`、`/api/worker/<id>/transcript-search`、`/api/worker/<id>/transcript-step`。`/api/worker/<id>/explanations` 与 `/api/explanation/<id>` 仍在源码里，但不在 `CORE_WORKER_READ` 白名单内，会被统一 404。

## 验证入口

`test/transcript-reader.test.js` 覆盖全量范围、截断后命中、配对、分页与文件边界；`test/transcript-latest.test.js` 覆盖最新窗口、`before` 往回翻页、`after` 只看新增、token／裁剪与 head 读面一致、超过 8 MiB 仍取到尾部、坏行跳过与超长行标记；`test/project/explanations.test.js` 覆盖快照、无分支和权限；`test/explainer-provider.test.js` 使用可控子进程检查禁用工具的参数与凭证。

代码阅读器前端回归在 `test/web/dom-code-view.test.js`：按需进入、全部文件/懒目录、路径筛选和分页、逐行差异/正文/版本、单飞与前台刷新、采样失效、归档/超限/删除降级、安全文本、页签状态与路径搜索。后端读面不由 DOM mock 证明，需另跑 Git/RPC 集成用例。

Web 路由与 DOM 交互见 `test/web/transcript-reader.test.js`、`test/web/dom-transcript-reader.test.js`、`test/web/dom-transcript-view.test.js`、`test/web/dom-results.test.js`；代码着色与搜索定位见 `test/web/dom-code-highlight.test.js`、`test/web/dom-transcript-reader.test.js`。测试只使用临时项目和 Mock／可控进程，不发送真实项目内容给模型。

安装了 Firefox 与 geckodriver 的环境可运行 `bun scripts/check-transcript-layout.js`，检查真实 CSS 下桌面／窄屏的两栏位置、搜索框归属、Enter／按钮提交、正文定位与独立滚动，以及深浅主题下的窄屏可读性。脚本仅起本机临时 HTTP fixture 与受控浏览器，不启动 daemon；失败保留 geckodriver 日志，成功清理临时目录并输出截图路径。
