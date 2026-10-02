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

条目包含 `kind`、`id`、`content`、`content_truncated`、`created_at`、`task_id`、`parent_id`、`branch`、`status`、`integration`、`merge_status`、`revision`。详情另返回完整正文和 `references`；Input 原文只读。缺失 Worker 的旧输入保留，状态为 `unknown`。

`status` 是历史页的只读投影：`draft`、`created`、`queued`、`running`、`waiting`、`awaiting`、`paused`、`awaiting_acceptance`、`completed`、`failed`、`cancelled`、`unknown`。`created` 区分从未调用 Agent 的 paused Worker；同时检查本轮调用数、终身唤醒数与 Run 记录，避免重试清零 calls 后误报待开始。不会反写 Worker 状态。

原始 `integration` 与展示用 `merge_status` 分开，后者为 `merging`、`blocked`、`merged`、`none`。列表查询参数 `integration` **按 `merge_status` 筛选**。当前有效交付预约优先于旧落地记录，不把上一轮合并解释成本轮已交付。Worker状态与合并状态可同时筛选。

父候选返回 `{items:[{id,branch,goal}]}`，从完整项目查询而非 overview 取最近Worker。查询检查最多 2000 个候选父，超限明确报错而不是伪装成完整列表。读面不创建 Worker 或调用 Agent；最终可写性由发射路径再次校验。

## 写面与并发保护

| RPC | 参数与行为 |
|---|---|
| `draft.add` | `{content,references?,branch?}`：保存并返回完整 draft 条目；省略 branch 时解析 canonical 项目当时检出的分支所有者 |
| `draft.update` | `{id,content,references?,branch?,expected_revision}`：只更新未发射条目；省略 references 或 branch 保留原值 |
| `draft.remove` | `{id,expected_revision}`：只删除未发射条目，不删除 Input |
| `say.submit` 草稿路径 | `{draft_id,expected_revision,start?}`：从保存的父身份、正文与引用创建 say Worker，不接受额外正文、引用或 branch |

这些动作通过 `POST /api/action` 的窄白名单调用，不恢复 `input.submit` 或旧 `draft.commit`。`say.submit` 的直接正文路径和 `start` 语义不变；草稿 `start:true` 发射并开始，`start:false` 仅创建待开始 Worker。

新草稿 revision 从 1 递增。更新、删除与发射必须显式携带 `expected_revision`；旧草稿用显式 `null` 匹配尚无版本的历史行，不能省略字段绕过校验。旧草稿没有父身份时，先选择父 Worker 并保存，再发射。历史行不批量回填或改写。

发射沿用当前 say 协议，在创建 Git 锚点后的数据库事务内复核草稿版本、正文、引用和父身份，提交成功才回写 `input_id`。重复发射不能创建第二个 Worker；编辑/删除竞态导致旧提交失败而不是执行过期文字。Git 创建失败只清理本次自建锚点，保留用户草稿及已有工作区。

缓冲区不新增Worker实体，不产生 Agent 调度信号，不为保存想法冻结提交；真正的工作区基线在发射时固定。

## 实现职责

- `src/core/project/input-history.js`：公共草稿动作、父身份校验、历史详情与列表接缝。
- `src/persistence/store/input-history.js`：数据库有界分页与状态投影。
- `src/core/project/say.js`：草稿发射沿用 say 的事务与工作区准入。
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

缓冲区上限 500 条。无已绑定父 Worker 或 detached HEAD 时，暂存需先明确选择有效父Worker；失败保留输入，不自动新建任意 owner。当前不提供批量发射、Worker 追加消息的全局检索或原始 Input 改写。
