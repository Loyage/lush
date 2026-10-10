# 历史输入与缓冲区接口

本文面向维护者，记录项目级原始输入检索、草稿版本与发射的接缝。理念见[历史输入与缓冲区](../design/input-history.md)，用户操作见[历史输入与暂存](../input-history.md)。公开接口以 `src/rpc/registry.js` 为权威。

## 读面

以下 RPC 均为用户专属，Host 只按项目身份转发：

| RPC | HTTP | 参数 |
|---|---|---|
| `input.history` | `GET /api/inputs` | `cursor?`、`limit?`、`q?`、`status?`、`integration?` |
| `input.get` | `GET /api/input/{kind}/{id}` | `kind:'draft'|'input'`、`id` |
| `input.parents` | `GET /api/input-parents` | 无 |

历史列表返回 `{items,next_cursor}`，默认每页 50 条、最多 100 条，正文预览最多 1000 字并带 `content_truncated`。搜索在服务端针对完整正文进行，不是搜索预览或首页 Worker 窗口。列表包含未发射 Draft 与全部 Input；已发射的草稿通过 `input_id` 保留审计联系，但不作为第二条历史记录列出。

条目包含 `kind`、`id`、`content`、`content_truncated`、`created_at`、`task_id`、`parent_id`、`branch`、`status`、`integration`、`merge_status`、`revision`。详情另返回完整正文和 `references`，草稿还返回 `hook_mount:{parent_id,hook_id,state}|null`；Input 原文只读。缺失 Worker 的旧输入保留，状态为 `unknown`。

`status` 是历史页的只读投影：`draft`、`created`、`queued`、`running`、`waiting`、`awaiting`、`paused`、`awaiting_acceptance`、`completed`、`failed`、`cancelled`、`unknown`。`created` 区分从未调用 Agent 的 paused Worker；同时检查本轮调用数、终身唤醒数与 Run 记录，避免重试清零 calls 后误报待开始。不会反写 Worker 状态。

原始 `integration` 与展示用 `merge_status` 分开，后者为 `merging`、`blocked`、`merged`、`none`。列表查询参数 `integration` **按 `merge_status` 筛选**。当前有效交付预约优先于旧落地记录，不把上一轮合并解释成本轮已交付。Worker状态与合并状态可同时筛选。

父候选返回 `{items:[{id,branch,goal,freeze}]}`，包括可预约的有效冻结父，`freeze` 为冻结投影或 null；，从完整项目查询而非 overview 取最近Worker。查询检查最多 2000 个候选父，超限明确报错而不是伪装成完整列表。读面不创建 Worker 或调用 Agent；最终可写性由发射路径再次校验。

## 写面与并发保护

| RPC | 参数与行为 |
|---|---|
| `draft.add` | `{content,references?,branch?}`：保存并返回完整 draft 条目；省略 branch 时解析 canonical 项目当时检出的分支所有者 |
| `draft.update` | `{id,content,references?,branch?,expected_revision}`：只更新未发射条目；省略 references 或 branch 保留原值 |
| `draft.remove` | `{id,expected_revision}`：只删除未发射条目，不删除 Input |
| `order.submit` 草稿路径 | `{draft_id,expected_revision,start?,defer?,profile?}`：正文、引用与父身份来自草稿；只在显式 `defer:true` 时允许 `profile`，不接受额外正文、引用或 branch |

这些动作通过 `POST /api/action` 的窄白名单调用，不恢复 `input.submit` 或旧 `draft.commit`。`order.submit` 的直接正文路径和 `start` 语义不变；草稿 `start:true` 发射并开始，`start:false` 仅创建待开始 Worker。

新草稿 revision 从 1 递增。更新、删除与发射必须显式携带 `expected_revision`；旧草稿用显式 `null` 匹配尚无版本的历史行，不能省略字段绕过校验。旧草稿没有父身份时，先选择父 Worker 并保存，再发射。历史行不批量回填或改写。

发射沿用当前指令协议，在创建 Git 锚点后的数据库事务内复核草稿版本、正文、引用和父身份，提交成功才回写 `input_id`。重复发射不能创建第二个 Worker；编辑/删除竞态导致旧提交失败而不是执行过期文字。Git 创建失败只清理本次自建锚点，保留用户草稿及已有工作区。

缓冲区不新增Worker实体，不产生 Agent 调度信号，不为保存想法冻结提交；真正的工作区基线在发射时固定。

主输入框创建、立即开始及预约发射成功后留在当前页面，不自动进入新 Worker 或预约父 Worker。`start:false` 真正创建成功时，`project/order.js` 在创建事务内记录 `task.start_pending` 并调用 `project/messages.js` 的 `notifyTaskLifecycle`，生成「待开始」纯告知；直接正文、草稿与 Hook 延迟创建共用此路径。Notice SQL 投影为 `lifecycle_type:'created'`，Web 复用告知条的查看 Worker／已知入口，并提供独立的页面与系统通知偏好。预约尚未创建、立即开始、用户暂停与重启恢复不产生此告知；不补发旧记录，不调用 Agent。

显式预约先保存一次性创建 Hook，不创建 Input/Worker/worktree。挂载认领草稿版本并保护其正文与引用；占用中不可编辑、删除或重复发射。等待／明确失败挂载停用或移除可释放占用；unknown 须检查现场后移除，不自动重放。已结束父上的未执行自定义挂载仍可移除释放草稿。创建成功才回写 `input_id`。参数与恢复边界见 [Hooks](hooks.md)。

## 实现职责

- `src/core/project/input-history.js`：公共草稿动作、父身份校验、历史详情与列表接缝。
- `src/persistence/store/input-history.js`：数据库有界分页与状态投影。
- `src/core/project/order.js`：草稿发射沿用指令的事务与工作区准入。
- `src/ui/web/assets/render-inputs.js` / `styles-inputs.css`：`#inputs` 页面、显式查询与分页、暂存编辑、原文详情。
- `src/ui/web/assets/composer.js`：主输入框快捷键、暂存与直接发送，独立完整父候选读面。

前端显式查询与刷新历史，不随 overview 重画编辑内容；所有异步响应核对页面身份，失败保留编辑，发射按钮单飞。CLI 不恢复旧 draft 命令，也不新增批量提交。

列表复用资源页的页头、筛选容器与卡片样式，条目等高，仅显示两行正文摘要、编号/时间和独立Worker/合并徽章。整条使用原生 button 进入详情，列表不内嵌 Worker 跳转、引用或草稿操作。`#inputs` 是列表；`#input-draft-<id>` / `#input-input-<id>` 是可直接打开的独立详情，仍归属 `ui.view.id='inputs'`。`openInputs({item?:{kind,id},push?:boolean})` 共用同一页面身份；同页往返保留列表查询、已加载分页、滚动位置和未保存编辑，重新读取/切换条目仍检查编辑保护。返回列表使在途详情响应失效，不会被迟到响应重新打开。

## 验证入口与边界

- `test/project/input-history.test.js`：状态、全库搜索分页、父身份、重开持久化、乐观锁和发射/编辑/删除竞态。
- `test/web/input-history.test.js`：HTTP 路由与参数白名单。
- `test/web/dom-input-buffer.test.js` / `dom-inputs.test.js`：键盘、输入法、单飞、编辑与迟到响应保护。
- `test/web/dom-inputs-api.test.js`：真实临时 HTTP/RPC/SQLite/Git 串联主输入暂存、搜索、修订保存、仅创建及原始引用回看，不连接用户项目。
- `bun scripts/check-input-history-ui.js`：Firefox/geckodriver 临时 fixture，验证双主题 1440/900/500px 实际视口的等高列表/详情布局、浏览器后退与键盘交互；Firefox 将请求的 390px 窗口限制为 500px 视口，不据此声称验证了 390px。
- `bun run scripts/check-composer-layout.js`：实际 `/p/<id>/` 项目页和 fixture API；Firefox 验证新建实线框／追加虚线框、常驻加粗目标、两种模式均沿用六种项目配色、双主题、聚焦／失焦、长标题、冻结／阻塞目标保留、Enter 真实投递、追加 ACK 自动恢复新建及导航退出。用真实 iframe 浏览上下文绕过 Firefox 顶层最小窗口限制，实际测试 1440/900/390px 视口；不连接 daemon 或模型，运行后清理服务与浏览器进程。

缓冲区上限 500 条。无已绑定父 Worker 或 detached HEAD 时，暂存需先明确选择有效父Worker；失败保留输入，不自动新建任意 owner。当前不提供批量发射、Worker 追加消息的全局检索或原始 Input 改写。
