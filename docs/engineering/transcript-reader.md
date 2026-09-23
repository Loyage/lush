# 执行记录阅读器

本文描述执行过程的当前实现、数据边界和测试入口。修改前先读[设计理念](../design/agent-process.md)：目标是帮助用户理解 Agent 的运作，不是单纯堆放日志。

## 两条读路径

快速视图沿用 `task.transcript`：从任务的 Pi 兼容 JSONL 投影步骤，默认折叠思考和工具、展开回答。兼容读面保留单条 4,000 字符、每请求前 8 MiB 的限制与既有 token 口径，不重写会话或数据库。

完整阅读走 `core/transcript-reader.js`：

- 按任务遍历所有会话文件，异步流式读取完成的 JSONL 行，不受快速视图的 8 MiB 范围限制。
- 搜索覆盖原步骤全文，不只搜预览或已加载 DOM；目前是大小写不敏感的连续子串匹配，不支持正则或语义搜索。
- 类型、工具名子串与失败筛选可以组合；失败指记录中的 `isError`，不猜测文本里的退出码。
- 返回按 `seq` 升序的有界摘要，`after` 为上一页最后一步；原文按 24,000 字符分页读取。
- 单行最多 16 MiB；超大行明确报“无法完整检索”，不会冒充无命中。坏 JSON 行跳过、未完成尾行等待后续写完；这与快速读面的步骤编号规则一致。
- 不持久化全文索引，也不缓存所有正文；每次查询从头流式扫描，因此超长历史的后页或原文查询可能较慢。当前能力是可完整翻找，不是恒定时间随机访问。

`seq` 在正常追加下稳定；会话清理或改写可能让旧编号失效。解释历史独立保存当时快照，不依赖源文件一直存在。

## 紧凑摘要与因果配对

`transcript-model.js` 提供纯函数：思考／回答／输出取内容预览，工具取工具名和 command / path / pattern / query 等关键参数。

投影保留 `call_id`、`tool_name` 与 `is_error`。界面按 `(file, call_id)` 将已加载的输入输出放在同一个调用下，结果可以增量追加而不重建输入节点；跨页加载后同样配对。重复调用身份不猜配，缺 ID 的旧记录各自保留。

未见结果显示“尚未见到结果”，不是“成功”或“仍在运行”的断言。原始步骤编号与各自来源引用保留。完整步骤接口另查同一会话内的配对记录，最多附带 8 条关联摘要；前后各两步只作为阅读上下文，不自动发给解释 Agent。

## 全文翻找与原文

执行过程中的“翻找完整记录 / 原文 / 解释历史”提供搜索、类型、工具与失败筛选；结果按页浏览，关键词命中高亮，点击进入步骤原文及关联上下文。快速视图中的“原文与上下文”也进入同一阅读区。

大正文按段续读，不将任意大输出一次塞入 DOM；配对与前后记录显示摘要，并提供完整原文入口。检索状态与原文区独立于执行列表的实时追加；过期请求不能覆盖新的查询或步骤。

## 专用解释 Agent

选中执行记录中的 1–8,192 字文字，右键“介绍：目的、原理与结果含义”，直接创建 `explainer` 根 Task；不创建 Input、开发分支或 worktree，也不附着在可能已终态的源 Task 下。

- 来源快照写入现有 `explanation.requested` Event，包含选区、任务目标、所属步骤首段、配对输入输出摘要、来源编号与时间，截断有标记。
- Task.result 保存解释；Task / Agent / Run 沿用现有生命周期、并发、取消、重试与恢复规则，不增加业务实体或 schema。
- 结果在独立旁侧面板显示，关闭面板只停止客户端读取，不取消解释任务；完成后从源任务的“解释历史”回看，支持更早历史分页。
- 模型须区分目的推断、机制背景和结果事实；资料不足时明确说明。原日志是资料，不是指令。

权限不仅依赖提示词：Pi 使用 `--no-tools --no-extensions --no-skills --no-context-files --no-approve`，不加载 profile 中的扩展和 Skills；启动消息直接附带运行时准备的资料文件，不需要模型用 read 工具读取。子进程不获 invocation token，runtime 也拒绝 explainer actor 的 RPC 和派工。

可以在 Agent 设置中为 explainer 配置 Pi 模型／思考等级／提示词与环境。Codex 尚没有在本实现中验证等价的无工具模式，因此选择 Codex 时明确拒绝，不以开发权限降级运行。Mock 可用于离线测试，但不会伪装为真实模型解释。

## 结构化渲染

工具输入、输出和步骤原文若为合法 JSON 对象／数组，显示按需展开的键树并保留“查看原文”。最多 12 层、每分支 100 个子节点、每棵树 1,500 节点；到限提示查看原文。非法／截断 JSON 回退纯文本。所有内容经 DOM 文本节点写入，不解释 HTML。

结构视图是辅助预览；JavaScript JSON 数值显示可能涉及浮点精度，精确数值与原始空白以原文为准。Markdown 回答与思考仍走原有安全渲染；这里只为工具数据增加结构视图。

## 接口

以下新增 RPC 均为用户专属，不接受 Agent token；读取仍在认证后的 Web 边界内：

| RPC | 参数 | 返回 |
|---|---|---|
| `task.transcript_search` | `id, query?, kind?, tool?, errors?, after?, limit?` | `steps, next, has_more, files, scope`；limit 默认 50，最大 100 |
| `task.transcript_step` | `id, seq, offset?` | `step, offset, next_offset, has_more, related, context` 与配对限制标记 |
| `explanation.start` | `id, seq, quote` | 新解释任务的状态、来源快照 |
| `explanation.list` | 源任务 `id, before?` | `explanations, next, has_more`，每页 50 条 |
| `explanation.get` | 解释任务 `id` | `id, status, result, error, source` |

GET 路由：`/api/task/<id>/transcript-search`、`/api/task/<id>/transcript-step`、`/api/task/<id>/explanations`、`/api/explanation/<id>`。创建走现有 `POST /api/action` 的 `explanation.start` 白名单；没有新增直连模型的浏览器入口。

## 验证入口

`test/transcript-reader.test.js` 覆盖全量范围、截断后命中、配对、分页与文件边界；`test/project/explanations.test.js` 覆盖快照、无分支和权限；`test/explainer-provider.test.js` 使用可控子进程检查禁用工具的参数与凭证。

Web 路由与 DOM 交互见 `test/web/transcript-reader.test.js`、`test/web/dom-transcript-reader.test.js`。测试只使用临时项目和 Mock／可控进程，不发送真实项目内容给模型。
