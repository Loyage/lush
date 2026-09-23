# Web / 桌面体验与前端架构审查

面向维护者，聚焦输入可靠性、页面异步生命周期、Notice 历史、前端大数据开销与桌面偏好；只提出建议，不实施功能。设计依据：[Web 模块边界](../engineering/modules-web.md)、[执行过程理念](../design/agent-process.md)、[阅读器约束](../engineering/transcript-reader.md)、[文档约定](../contributing/documentation.md)。

## 范围、基线与验证

- HEAD：`99fcbc993640c057488532a19ca08814ab60b73e`，与指定基线一致；起始工作树干净。只新增本文件，不 commit / merge / push。
- 静态审查：`src/ui/web/assets/` 的导航、输入、Notice、图、统计、执行记录及 `src/ui/desktop/`；认证 / IPC 安全不在本报告范围。
- 已执行：`git rev-parse HEAD`、`git status --short`；临时目录下 `bun run doctor --project "$tmp"` 返回本 worktree 代码身份，临时项目无 daemon / Web，随后清理目录，未接触真实项目运行状态。
- 已执行：`bun run test` 后附 `test/web/` 下 `dom-{composer,drafts,token-efficiency,navigation,dialog,graph,statistics,transcript-reader,transcript-terminal,notices}.test.js` 与 `notice-notifications.test.js` 的展开路径，61 通过 / 0 失败；另跑 `bun run test test/web/notice-records.test.js`，3 通过 / 0 失败。
- 已执行：`bun run /tmp/lush-web-audit-repro.Oiyhb8/repro.mjs`，复用 `installDom` / `makeWorld`、可控 fetch 与延迟 Promise，5 项断言通过，复现 U-01～U-05；`bun run /tmp/lush-web-audit-repro.Oiyhb8/graph.mjs` 复现 U-06 的节点行为。临时脚本已删除，关键步骤保留在各项中。
- 文档验证：`bun run docs:check` 检查 53 篇 Markdown 通过；`git diff --check` 无错误；本 worktree 唯一新增文件为本报告。
- **未做真实浏览器、读屏器或 Electron 桌面验证，也未测实际帧率 / 内存峰值。** DOM 复现证明控制流与节点行为，不等价于端到端观感；现有测试通过不代表下列边界已覆盖。
- 已确认现有保护：页面读取有身份令牌、直接提交有单飞与并发输入保留、问卷有草稿恢复、通知默认关闭 / 首屏静默 / 去重、统计有有界分桶、完整执行记录仅手动续读。人工批准、重启不重放和读取限额不作为缺陷。

## U-01 · 批量提交依赖轮询副作用，可能漏掉当前输入

- **P2 · 已复现（DOM / mock）· S**。证据：`src/ui/web/assets/composer.js` `buffer` / `selectedDraftIds` / `initComposer`，39–49、86–97 行；`src/ui/web/assets/api.js` `action`，11–14 行；`src/ui/web/assets/refresh.js` `refresh`，71–72 行。
- 问题与触发：已有草稿 #1 时挂起一个快照轮询，再输入新要求并「提交并规划」；`draft.add` 返回新草稿，但 `action` 的刷新遇到 `ui.busy` 直接返回，提交 ID 仍来自旧 `ui.draftIds`。复现结果只提交 `[1]`，新要求留在 #2，输入框却已清空；无旧草稿时则报“没有勾选”。
- 影响与反例：不会删除已入库草稿，但用户以为一起交付的当前要求没有进入该 planner；直接执行的并发输入保护测试通过，不能覆盖这条两阶段路径。
- 建议与取舍：`buffer` 返回已创建草稿 ID，不把轮询当提交集合的数据依赖；建议本次提交采用点击时选中 ID 加本次新增 ID。等待期间勾选 / 父分支修改究竟影响本次还是下次，应先确认，再决定冻结快照或禁用控件；不要求新增自动重试或重放机制。
- 验收：分别覆盖轮询在飞、快照失败、只有输入、有旧草稿、请求期间勾选改变；本次应提交集合可确定，草稿创建失败不 commit，输入失败保留。

## U-02 · 草稿编辑保存失败后，本地修改失去恢复机会

- **P2 · 已复现（DOM / mock）· S**。证据：`src/ui/web/assets/render-drafts.js` `startDraftEdit/save`，11–38 行；`renderDrafts`，77–96 行。
- 问题与触发：保存前先 `done=true; finish()`，清掉编辑锁；令 `draft.update` 返回 500，再提供一份含旧正文的变化快照，编辑框会被重建移除。复现中“unsaved replacement”完全从页面消失，服务端仍是旧正文。
- 影响与反例：轮询期间正在编辑的保护已经存在，但不覆盖保存失败；即使 revision 未变暂时留下 textarea，`done` 已为 true，原保存闭包不能再次提交。
- 建议与取舍：仅成功后退出编辑；失败保留值、引用与可重试状态，并就地显示错误。若记录已被其它客户端提交 / 删除，应显示冲突并提供复制内容，而非默认覆盖远端。
- 验收：更新 500 / 离线 / 保存中轮询 / 远端删除后仍可取回修改文字；重试成功只更新一次，Esc 明确取消，成功后正常解除编辑锁。

## U-03 · Notice 已加载旧页不能可靠反映远端结算

- **P2 · 已复现（DOM / mock）· M**。证据：`src/ui/web/assets/render-notices.js` `loadNoticeRecords`，44–80 行；`renderNotices`，114–136 行；`src/rpc/handlers/notice.js` `notice.list` / `notice.page`，5–21 行。
- 问题与触发：加载两页 open 记录，不选中最旧项，让它在另一客户端变为 answered，再调用 preserve 刷新；刷新只查第一页及当前选中项，以旧 rows 合并，最旧项仍显示 open。生产触发还需该项结算后落在有界 snapshot 之外（例如很多较新的 open 项），否则 snapshot 能纠正。
- 影响与反例：历史列表、计数与筛选可能长期保留错误状态；点击该项有 `readNoticeRecord` 重查保护，不能声称必然提交陈旧决定。现有测试验证了选中项远端结算，但未覆盖未选中的旧页。
- 建议与取舍：候选方案为按已加载 ID 有界校验状态，或 revision 变化后标记旧页过期并可刷新；需确认优先保留翻页位置还是自动更新完整列表，避免每次轮询扫描全部历史。
- 验收：超过 200 条且有分页时，未选中的旧项在远端结算后最终离开 open 筛选；历史页不回跳、输入不丢，并为每轮请求量设上限。

## U-04 · 写操作完成后的导航没有沿用页面身份保护

- **P2 · 已复现（DOM / mock）· S**。证据：`src/ui/web/assets/render-notices.js` `noticePanel/refreshRecord/settle`，174–183、198–205、225–239 行；对照 `src/ui/web/assets/detail.js` `loadDetail`，10–35 行。
- 问题与触发：从任务详情回复 Notice，挂起 action 响应，用户导航到分支图，再放行响应；闭包仍执行 `detail(notice.task_id)`。复现中当前视图由 graph 变回 task，用户新导航被旧动作夺回。
- 影响与反例：读请求的迟到响应已有防护，现有导航测试通过；但新的 `detail()` 调用合法创建新身份，因此原读保护不能挡住写后跳转。这里不是 Notice 答案写错，而是后续页面流程出错。
- 建议与取舍：动作开始时捕获 view / notice 身份，成功后无条件刷新缓存，但只有原页面仍持有身份才推进本地导航；离开后的成功用非打断式提示反馈。
- 验收：回复、忽略、计划审批、问卷提交期间跳转到其它页面，完成 / 失败都不夺回画布；停留原页面时仍正确显示结算状态或下一项。

## U-05 · 输入弹窗把中文组词回车当成最终提交

- **P2 · 已复现（合成 DOM 事件；真实 IME 待验证）· S**。证据：`src/ui/web/assets/dialog.js` `open` 的 `input.onkeydown`，66–71 行；对照 `src/ui/web/assets/composer.js` `initComposer`，101–105 行及 `render-drafts.js`，32–35 行已有 `isComposing` 防护。
- 问题与触发：`promptDialog` 输入收到 `{key:'Enter', isComposing:true}` 时直接兑现 Promise，实测返回尚未完成的文字；计划驳回等调用方可能随即发送该值，用户原意只是确认中文候选。
- 建议与取舍：与主输入框统一忽略 composing 回车；按目标浏览器需要评估 compositionend / keyCode 229 兼容，而非盲目加入全局延迟。现有 Enter / Esc / Tab / 焦点恢复测试应保留。
- 验收：合成 composing Enter 不关闭弹窗，普通 Enter 仍提交；真实浏览器与 Electron 的中文输入法各验证一次组词、候选确认及最终提交。

## U-06 · 分支图轮询强制整树重建，折叠不减少 DOM 构造

- **P2 · 已复现（节点行为）；实际性能影响待验证 · M**。证据：`src/ui/web/assets/render-graph.js` `loadGraph`，137–143 行；`branchBlock`，517–536 行；`renderGraph`，572–615 行；`src/ui/web/assets/refresh.js` `graphStale/refresh`，57–68、107–115 行。
- 问题与触发：正常轮询走 `loadGraph → renderGraph(force:true)`，绕过指纹未变的短路；折叠只切 class，仍递归创建所有子分支 / 任务。fixture 中折叠 main 后仍有 4 个后代分支 DOM，同一份 graph 再加载会替换根分支节点。
- 影响与反例：存在随全图规模增长的周期性主线程开销及焦点 / 选区风险；已有 3s / 10s 取数节流、图截断、决策输入保护，不能据此宣称已经测到卡顿。统计分桶和 transcript 手动续读的限额也不应一并删掉。
- 建议与取舍：先让轮询尊重包含 diagnostics 的 render key，手动刷新按需另行处理；再比较折叠子树惰性创建与按分支 key 更新。是否进一步虚拟化需性能证据，不预设重写框架。
- 验收：相同图连续轮询保持分支节点身份；先按当前 API 的 20 / 200 节点规模记录构造节点数、渲染耗时与真实浏览器长任务，折叠显著减少挂载；1,000 / 5,000 节点仅作为合成压力实验，不暗示当前 API 支持该规模。诊断变化、折叠偏好与已输入回复仍正确。

## U-07 · 桌面随机端口让多数本地偏好跨启动丢失

- **P2 · 代码确认（Electron 重启实测待验证）· M**。证据：`src/ui/desktop/main.js` `startHost/createWindow`，34–41、67–88 行；`src/ui/web/assets/prefs.js` `PREF_DEFS/readPref/writePref`，74–89、91–122 行；对照 `src/ui/web/assets/notice-notifications.js` `initNoticeNotifications`，12–18 行。
- 问题与触发：桌面每次启动 host 使用端口 `0`，界面主题、Markdown、轮询频率等按 Web origin 的 localStorage 保存；下次端口不同即换存储命名空间。固定 Electron userData 目录不会自动合并不同 origin 的 localStorage。
- 影响与反例：用户调整过的界面习惯可能重启后回默认；通知开关已经单独走 userData 持久化，不受影响，不能泛称所有设置丢失，项目级 Agent / runtime 设置也不在此问题内。
- 建议与取舍：候选为将受管桌面偏好通过窄宿主存储适配保存，或设计稳定应用 origin；需确认跨项目共享哪些偏好及浏览器端是否保持独立。不要为省事改用固定端口而破坏 Web / 桌面并存。
- 验收：两次启动端口明确不同，主题、减少动效、Markdown、轮询频率仍保留；恢复默认同时清掉宿主偏好，浏览器客户端与项目级设置不被意外改写。
