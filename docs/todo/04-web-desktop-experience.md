# Web / 桌面体验与前端架构审查

面向维护者，聚焦输入可靠性、页面异步生命周期、Notice 历史、前端大数据开销与桌面偏好。原报告只提出建议；下列 2026-10-02 复核已实施既定语义的低风险修复，涉及产品取舍的条目仍待决定。设计依据：[Web 模块边界](../engineering/modules-web.md)、[执行过程理念](../design/agent-process.md)、[阅读器约束](../engineering/transcript-reader.md)、[文档约定](../contributing/documentation.md)。

## 范围、基线与验证

- 原审查基线：`99fcbc993640c057488532a19ca08814ab60b73e`；当前版本已包含 say / Worker 中心输入及交付流程变更，以上旧基线的代码行与行为结论不应直接视为当前事实。原审查时起始工作树干净，仅新增本文件。
- 静态审查：`src/ui/web/assets/` 的导航、输入、Notice、图、统计、执行记录及 `src/ui/desktop/`；认证 / IPC 安全不在本报告范围。
- 已执行：`git rev-parse HEAD`、`git status --short`；临时目录下 `bun run doctor --project "$tmp"` 返回本 worktree 代码身份，临时项目无 daemon / Web，随后清理目录，未接触真实项目运行状态。
- 已执行：`bun run test` 后附 `test/web/` 下 `dom-{composer,drafts,token-efficiency,navigation,dialog,graph,statistics,transcript-reader,transcript-terminal,notices}.test.js` 与 `notice-notifications.test.js` 的展开路径，61 通过 / 0 失败；另跑 `bun run test test/web/notice-records.test.js`，3 通过 / 0 失败。
- 已执行：`bun run /tmp/lush-web-audit-repro.Oiyhb8/repro.mjs`，复用 `installDom` / `makeWorld`、可控 fetch 与延迟 Promise，5 项断言通过，复现 U-01～U-05；`bun run /tmp/lush-web-audit-repro.Oiyhb8/graph.mjs` 复现 U-06 的节点行为。临时脚本已删除，关键步骤保留在各项中。
- 文档验证：`bun run docs:check` 检查 53 篇 Markdown 通过；`git diff --check` 无错误；本 worktree 唯一新增文件为本报告。
- **未做真实浏览器、读屏器或 Electron 桌面验证，也未测实际帧率 / 内存峰值。** DOM 复现证明控制流与节点行为，不等价于端到端观感；现有测试通过不代表下列边界已覆盖。
- 已确认现有保护：页面读取有身份令牌、直接提交有单飞与并发输入保留、问卷有草稿恢复、通知默认关闭 / 首屏静默 / 去重、统计有有界分桶、完整执行记录仅手动续读。人工批准、重启不重放和读取限额不作为缺陷。

## 当前 HEAD 复核（2026-10-02）

复核基线：`81257d12e3001214e7f03bc4ee2398f834e35ee3`。先读模块设计理念、UI guidance、input-history、references、Web 模块地图；只修改本 Worker 的前端 assets、对应测试与本专题，不改 desktop 主进程、Web server、公共 helper 或接口。下面保留原复现和建议作为历史证据，**不把已下线的 planner / 分支图恢复为需求**。

| 条目 | 当前结论 | 本轮处理 |
|---|---|---|
| U-01 | 原路径已下线，原建议不再适用 | 当前 composer 的暂存/单条 say 与在途输入保护已有测试 |
| U-02 | 原面板已下线，新历史输入编辑已保护失败内容 | 补 500 / 离线 / 远端删除、轮询、重试回归，无需改实现 |
| U-03 | 用户确认后已实施过期提示与显式刷新 | revision 变化不扫描旧页；显式刷新已加载页数、保留输入，无新读 API |
| U-04 | 当前 Notice 答复/忽略/问卷写后导航仍有问题 | 已修复页面与 Notice 选择身份保护；历史 plan 分支同样受保护，但未恢复 API |
| U-05 | 当前输入弹窗仍误提交 composing Enter | 已修复，覆盖 composition 状态 / isComposing / keyCode 229 |
| U-06 | 原分支图已下线；Worker 树折叠已惰性挂载，但相同数据仍重建 | 已加内容/偏好/宽度 render key，变化仍更新；不引入虚拟化 |
| U-07 | 本地桌面随机 origin 的偏好问题仍成立 | 待用户决定窄宿主适配或稳定 origin；远程固定 origin 和通知开关不泛化为此问题 |

验证与限制见文末；实际浏览器 IME、帧率及 Electron 重启未验证。`bun run doctor` 的 fingerprint 相同、代码目录为主项目而非本 worktree，故报告 `code_match=false`；未重启用户服务，测试仅使用临时项目 / DOM mock。

## U-01 · 旧批量草稿提交可能漏掉当前输入（历史路径已下线）

- **状态：已过时，不实施原方案；原 P2 · 基线时已复现（DOM / mock）· S**。现行 `composer.js` 的 `submitInput` 直接暂存或单条 say，`render-inputs.js` 按草稿 ID/修订发射，不读 `selectedDraftIds` 或轮询集合；旧 `draft.commit` / planner 不在公开入口。当前 say 默认关闭自动合并，有结果不等于自动发出合并请求。`dom-inputs.test.js` / `dom-composer.test.js` 与现有输入保护测试覆盖当前路径。原基线证据：`src/ui/web/assets/composer.js` `buffer` / `selectedDraftIds` / `initComposer`，39–49、86–97 行；`src/ui/web/assets/api.js` `action`，11–14 行；`src/ui/web/assets/refresh.js` `refresh`，71–72 行。
- 问题与触发：已有草稿 #1 时挂起一个快照轮询，再输入新要求并「提交并规划」；`draft.add` 返回新草稿，但 `action` 的刷新遇到 `ui.busy` 直接返回，提交 ID 仍来自旧 `ui.draftIds`。复现结果只提交 `[1]`，新要求留在 #2，输入框却已清空；无旧草稿时则报“没有勾选”。
- 影响与反例：不会删除已入库草稿，但用户以为一起交付的当前要求没有进入该 planner；直接执行的并发输入保护测试通过，不能覆盖这条两阶段路径。
- 建议与取舍：`buffer` 返回已创建草稿 ID，不把轮询当提交集合的数据依赖；建议本次提交采用点击时选中 ID 加本次新增 ID。等待期间勾选 / 父分支修改究竟影响本次还是下次，应先确认，再决定冻结快照或禁用控件；不要求新增自动重试或重放机制。
- 验收：分别覆盖轮询在飞、快照失败、只有输入、有旧草稿、请求期间勾选改变；本次应提交集合可确定，草稿创建失败不 commit，输入失败保留。

## U-02 · 草稿编辑保存失败后，本地修改失去恢复机会

- **状态：原路径已下线，当前路径已有修复，本轮补边界回归；原 P2 · 基线时已复现（DOM / mock）· S**。`render-inputs.js` 的保存只在成功后更新 `saved` 修订，失败保留 textarea、父身份、引用与可重试状态；轮询不重画编辑面。本轮 `dom-inputs.test.js` 补 500 / 离线 / 远端删除与保存中轮询/列表刷新，仍能取回全部本地编辑并重试。远端删除不自动复活草稿；测试解除 mock 故障后重试仅验证本地表单恢复，不承诺已删除 ID 真能保存。原证据来自 `src/ui/web/assets/render-drafts.js` `startDraftEdit/save`，11–38 行；`renderDrafts`，77–96 行。
- 问题与触发：保存前先 `done=true; finish()`，清掉编辑锁；令 `draft.update` 返回 500，再提供一份含旧正文的变化快照，编辑框会被重建移除。复现中“unsaved replacement”完全从页面消失，服务端仍是旧正文。
- 影响与反例：轮询期间正在编辑的保护已经存在，但不覆盖保存失败；即使 revision 未变暂时留下 textarea，`done` 已为 true，原保存闭包不能再次提交。
- 建议与取舍：仅成功后退出编辑；失败保留值、引用与可重试状态，并就地显示错误。若记录已被其它客户端提交 / 删除，应显示冲突并提供复制内容，而非默认覆盖远端。
- 验收：更新 500 / 离线 / 保存中轮询 / 远端删除后仍可取回修改文字；重试成功只更新一次，Esc 明确取消，成功后正常解除编辑锁。

## U-03 · Notice 已加载旧页不能可靠反映远端结算

- **状态：用户确认后已实施过期提示策略（2026-10-02，Notice #77）；P2 · DOM / mock · M**。修复前 205 条 open 记录的未选中旧项可能仍显示 open；用户选定 revision 变化后提示可能过期、不后台扫描。当前轮询仅应用有界 snapshot 中已知状态；显式「刷新已加载记录」冻结当前已加载页数、逐页只读重载，不重置翻页深度或当前答复，打开具体事项仍重查。任何项目 revision 变化都保守提示可能过期，不伪称 Notice 专用 revision。请求失败保留列表/输入，期间新 revision 不清除过期提示，无新 API 或模型调用。
- **回归**：`notice-records.test.js` 205 条记录加载两页，快照外未选中旧项远端结算后提示；重复轮询没有历史请求，显式刷新两页后旧项离开 open 筛选，当前答复/节点/列表滚动保留；覆盖刷新期间 revision 与失败。与 S-02 定向共 **20 pass / 0 fail**（`/tmp/lush-103-decisions.LmS9JG.log`）。原证据：`src/ui/web/assets/render-notices.js` `loadNoticeRecords`，44–80 行；`renderNotices`，114–136 行；`src/rpc/handlers/notice.js` `notice.list` / `notice.page`，5–21 行。
- 问题与触发：加载两页 open 记录，不选中最旧项，让它在另一客户端变为 answered，再调用 preserve 刷新；刷新只查第一页及当前选中项，以旧 rows 合并，最旧项仍显示 open。生产触发还需该项结算后落在有界 snapshot 之外（例如很多较新的 open 项），否则 snapshot 能纠正。
- 影响与反例：历史列表、计数与筛选可能长期保留错误状态；点击该项有 `readNoticeRecord` 重查保护，不能声称必然提交陈旧决定。现有测试验证了选中项远端结算，但未覆盖未选中的旧页。
- 建议与取舍：候选方案为按已加载 ID 有界校验状态，或 revision 变化后标记旧页过期并可刷新；需确认优先保留翻页位置还是自动更新完整列表，避免每次轮询扫描全部历史。
- 验收：超过 200 条且有分页时，未选中的旧项在远端结算后最终离开 open 筛选；历史页不回跳、输入不丢，并为每轮请求量设上限。

## U-04 · 写操作完成后的导航没有沿用页面身份保护

- **状态：仍合理，已修复并补回归；P2 · DOM / mock · S**。当前 `noticePanel` 的普通答复/忽略与问卷成功后仍会调用 detail/openNotice。修复在写操作起点捕获 `ui.view`、Notice 导航请求与历史页筛选/选中项身份；action 正常刷新共享数据，但离页或切换同页 Notice 后不再导航、清除另一页编辑锁或替换当前选中项，只给非打断式成功提示。`notice-records.test.js` 覆盖成功/失败期间转 Worker 树、普通答复/忽略、问卷提交/忽略、历史计划分支，以及同记录页切换选中项；现有原页答复测试仍通过。plan 分支没有当前公开 API，本轮只保护遗留代码，不恢复审批功能。原证据：`src/ui/web/assets/render-notices.js` `noticePanel/refreshRecord/settle`，174–183、198–205、225–239 行；对照 `src/ui/web/assets/detail.js` `loadDetail`，10–35 行。
- 问题与触发：从Worker详情回复 Notice，挂起 action 响应，用户导航到分支图，再放行响应；闭包仍执行 `detail(notice.task_id)`。复现中当前视图由 graph 变回 task，用户新导航被旧动作夺回。
- 影响与反例：读请求的迟到响应已有防护，现有导航测试通过；但新的 `detail()` 调用合法创建新身份，因此原读保护不能挡住写后跳转。这里不是 Notice 答案写错，而是后续页面流程出错。
- 建议与取舍：动作开始时捕获 view / notice 身份，成功后无条件刷新缓存，但只有原页面仍持有身份才推进本地导航；离开后的成功用非打断式提示反馈。
- 验收：回复、忽略、计划审批、问卷提交期间跳转到其它页面，完成 / 失败都不夺回画布；停留原页面时仍正确显示结算状态或下一项。

## U-05 · 输入弹窗把中文组词回车当成最终提交

- **状态：仍合理，已修复并补回归；P2 · 合成 DOM 事件；真实 IME 待验证 · S**。`dialog.js` 的输入回车现在与 composer 一致，忽略 compositionstart/end 区间、`isComposing` 和 `keyCode === 229`；不增加全局延迟。`dom-dialog.test.js` 验证候选回车不 preventDefault、不关闭弹窗，结束组词后普通 Enter 仍提交完整值，原 Esc / Tab / 焦点恢复保留。原证据：`src/ui/web/assets/dialog.js` `open` 的 `input.onkeydown`，66–71 行；对照 `src/ui/web/assets/composer.js` `initComposer`，101–105 行及 `render-drafts.js`，32–35 行已有 `isComposing` 防护。
- 问题与触发：`promptDialog` 输入收到 `{key:'Enter', isComposing:true}` 时直接兑现 Promise，实测返回尚未完成的文字；计划驳回等调用方可能随即发送该值，用户原意只是确认中文候选。
- 建议与取舍：与主输入框统一忽略 composing 回车；按目标浏览器需要评估 compositionend / keyCode 229 兼容，而非盲目加入全局延迟。现有 Enter / Esc / Tab / 焦点恢复测试应保留。
- 验收：合成 composing Enter 不关闭弹窗，普通 Enter 仍提交；真实浏览器与 Electron 的中文输入法各验证一次组词、候选确认及最终提交。

## U-06 · 分支图轮询强制整树重建，折叠不减少 DOM 构造

- **状态：原分支图建议已过时；当前 Worker 树残余重复构造已修复；原 P2 · 节点行为，实际性能影响待验证 · M**。`render-graph.js` / `#graph` / `/api/graph` 已删除；现行 `render-task-graph.js` 的 paint 仅对未折叠节点递归，折叠已不挂载后代。当前 `loadTaskGraph` 对相同数据仍整树重建，本轮用完整有界 graph（含 diagnostics）、极简/折叠/状态筛选/归档/文件展开偏好及布局宽度生成 render key；相同数据保持 DOM/焦点/滚动，内容或偏好改变照常重画，原待决编辑、选区、popover 与动效保护不变。`dom-task-graph.test.js` 新回归覆盖相同轮询节点身份、目标变化与折叠惰性挂载，现有诊断/筛选/极简测试验证变化刷新。不做虚拟化，也不宣称已有实测帧率收益。原证据：`src/ui/web/assets/render-graph.js` `loadGraph`，137–143 行；`branchBlock`，517–536 行；`renderGraph`，572–615 行；`src/ui/web/assets/refresh.js` `graphStale/refresh`，57–68、107–115 行。
- 问题与触发：正常轮询走 `loadGraph → renderGraph(force:true)`，绕过指纹未变的短路；折叠只切 class，仍递归创建所有子分支 / Worker。fixture 中折叠 main 后仍有 4 个后代分支 DOM，同一份 graph 再加载会替换根分支节点。
- 影响与反例：存在随全图规模增长的周期性主线程开销及焦点 / 选区风险；已有 3s / 10s 取数节流、图截断、决策输入保护，不能据此宣称已经测到卡顿。统计分桶和 transcript 手动续读的限额也不应一并删掉。
- 建议与取舍：先让轮询尊重包含 diagnostics 的 render key，手动刷新按需另行处理；再比较折叠子树惰性创建与按分支 key 更新。是否进一步虚拟化需性能证据，不预设重写框架。
- 验收：相同图连续轮询保持分支节点身份；先按当前 API 的 20 / 200 节点规模记录构造节点数、渲染耗时与真实浏览器长Worker，折叠显著减少挂载；1,000 / 5,000 节点仅作为合成压力实验，不暗示当前 API 支持该规模。诊断变化、折叠偏好与已输入回复仍正确。

## U-07 · 桌面随机端口让多数本地偏好跨启动丢失

- **状态：仍合理，待用户决定存储边界；P2 · 当前代码确认，Electron 重启实测待验证 · M**。现行启动在 `desktop/local-host.js`，本地窗口虽使用 `connections.js` 的稳定 `persist:lush-local` partition，localStorage 仍按 HTTP origin 分隔；端口 0 造成新 origin。`prefs.js` 仍只读写 localStorage，通知开关例外经 preload/ConnectionStore 持久化。远端固定 HTTPS Host 本身不受本地随机端口影响。选项：① 窄宿主受管偏好适配（推荐；本地外观共享、项目偏好仍按稳定项目 ID，远端/浏览器保持 origin 隔离，需确认用户偏好并协调 IPC 契约）；② 稳定应用 origin（更大主进程/路由/鉴权设计）；③ 暂不实施，保留当前 origin 规则。不要改固定端口，也不借此改项目 Agent/runtime 设置。由父 Worker 汇总统一 Notice。原证据：`src/ui/desktop/main.js` `startHost/createWindow`，34–41、67–88 行；`src/ui/web/assets/prefs.js` `PREF_DEFS/readPref/writePref`，74–89、91–122 行；对照 `src/ui/web/assets/notice-notifications.js` `initNoticeNotifications`，12–18 行。
- 问题与触发：桌面每次启动 host 使用端口 `0`，界面主题、Markdown、轮询频率等按 Web origin 的 localStorage 保存；下次端口不同即换存储命名空间。固定 Electron userData 目录不会自动合并不同 origin 的 localStorage。
- 影响与反例：用户调整过的界面习惯可能重启后回默认；通知开关已经单独走 userData 持久化，不受影响，不能泛称所有设置丢失，项目级 Agent / runtime 设置也不在此问题内。
- 建议与取舍：候选为将受管桌面偏好通过窄宿主存储适配保存，或设计稳定应用 origin；需确认跨项目共享哪些偏好及浏览器端是否保持独立。不要为省事改用固定端口而破坏 Web / 桌面并存。
- 验收：两次启动端口明确不同，主题、减少动效、Markdown、轮询频率仍保留；恢复默认同时清掉宿主偏好，浏览器客户端与项目级设置不被意外改写。

## 本轮验证与交付边界

- `bun run test test/web` 完整执行：**449 通过 / 0 失败**，78 个文件；日志 `/tmp/lush-106-web-final.5kM0u9.log`。覆盖新回归与现有导航、输入、通知、树关系/筛选/极简/诊断、执行记录及临时 HTTP 集成。
- `bun run test` 完整执行：**1095 通过 / 1 失败 / 1 导入错误**，184 个文件；唯一错误为环境缺少 devDependency `@electron/asar`，`test/packaging/windows-desktop.test.js` 无法导入，未产生断言级失败。完整日志 `/tmp/lush-106-full-suite.lHkZtv.log`。未安装依赖、未改 package 或桌面文件，不把这一轮说成全套通过。
- 输入边界独立执行：15 通过 / 0 失败，日志 `/tmp/lush-106-inputs.rhk5ez.log`。首轮新 Notice 测试曾因 DOM stub 的容器 textContent 不清子节点/不参与 deepText 而失败；改为真实文本子节点后通过，失败日志保留 `/tmp/lush-106-targeted.zCcSqe.log`，修正后五文件 41 通过 / 0 失败日志 `/tmp/lush-106-targeted.LavCml.log`。
- U-03 临时 DOM / 可控 fetch 复现：205 条已载记录、远端结算未选中 #1 后 preserve 只查一页，#1 仍 open；选择它后正确显示 answered。日志 `/tmp/lush-106-u03-repro.log`，步骤保留在 U-03；不是生产数据测试。
- U-06 的 20 / 200 Worker 合成有界 fixture：相同轮询零新 DOM 元素构造，折叠仅挂载根卡片；目标、Git 诊断和本地筛选变化仍正常刷新。节点构造证明不等价于真实浏览器帧率或内存峰值，未进行 1,000 / 5,000 节点虚拟化试验。
- `bun run docs:check`：68 篇 Markdown 通过；`git diff --check` 通过。未验证真实中文 IME、读屏器、Electron 重启。U-03 后续已按用户选择实施，见条目当前状态；U-07 未选入下一批，继续留待评审。
- 交付 3764 / 尝试 3767 的源侧修复：按 runtime 指定在自己的 worktree 合入固定父提交 `209dc762470b1b51bb0a0331b2d003443c29eb15`，合并提交 `32e90777c5d4ae30a38f698df6b37ce0e0f713d1` 保留原源提交 `cf8e2f4abe3cdfe3011be66dbbb9c5ac26cb77a0`，无内容冲突。合入后 `bun run test test/web test/desktop` 完整执行 **476 通过 / 0 失败**（83 文件），日志 `/tmp/lush-106-merge-verify.ppOXrv.log`；文档 68 篇与 diff 检查通过。未操作父分支，也未扩大前端实施范围。
