# 快捷指令异步运行与历史（W192）

用户决定 #457：自动化页内分开「运行与记录」和「指令管理」，异步提交并读取持久结果，每次手动及 Hook 运行仅保存安全摘要。授权、版本、Worker 身份、Git 串行及冻结门禁沿用[快捷指令契约](shortcut-commands.md)，Shell 仍最多 60 秒／64 KiB，不保存 stdout／stderr。

## 实现接缝

新增用户专属接口，旧 `hooks.command_run` 同步语义兼容：

- `hooks.command_start {id,version,worker_id,expected_revision}` → `{execution_id,execution,commands}`，Project `startShortcutCommand(id,version,workerId,expectedRevision)`。
- `hooks.command_history {before?,limit?,execution_id?}` → `{version:1,items,has_more,next_before}`，Project `shortcutCommandHistory(options={})`。默认 limit 30，上限 100；before 是正整数事件游标；execution_id 是 UUID，按身份查询时不得带 before。
- `hooks.command_history_remove {execution_id}` 或 `{clear:true}` → `{removed_count}`，Project `removeShortcutCommandHistory(options={})`。参数严格二选一，逐条或全量移除 succeeded/failed 的公开历史，pending/running/unknown 拒绝；重复 UUID 幂等返回 0。持久隐藏标记保留原 Event，公开分页／精确查询和 commands.last_execution 不再显示移除项，启动恢复与去重仍扫描原审计，不撤回副作用或撤权。
- Web POST `/api/action` 允许 command_start 及 command_history_remove；GET `/api/hooks/commands/executions` 只读转发 command_history，拒绝未知／重复参数。

每项安全 execution：`{event_id,id,command_id,command_name,command_version,worker_id,worker_number,source,status,created_at,finished_at,command_result?}`，W228 的新记录另含 `kind,created_worker_id,created_worker_number,input_id`；旧记录按 Shell 兼容，未创建时关联可空。prompt 的 worker_id 是父身份，created_worker_id 是新指令身份；succeeded 仅表示创建并提交成功，Agent 后续结果属于关联 Worker，不以退出码或 Shell 成功口径呈现。提示词执行及精确收据约束见[快捷指令契约](shortcut-commands.md#提示词执行与-skill-导出)。source 为 manual／hook／unknown（旧记录无法确认）；status 为 pending／running／succeeded／failed／unknown。command_name 为提交时名称快照；不包含 Shell 正文、env、原始错误或输出。旧事件缺名称时允许 null，不拿当前名称冒充历史。Worker 优先记录当时持久 worker_number，旧记录可只读关联；无编号才显示 #整数 ID。

接受前检查 revision、授权及原执行门。接受后即时返回持久 pending 身份，不跨 Shell/Git 队列等待；真正执行前再次核验授权及安全门，拒绝后保存安全 failed 诊断，不排队等待安全门、不自动重试。Git 串行等待不同于安全门等待。领取后防止同 Worker 重复提交及 Agent／合并冲入，保持原有命令执行互斥。异步 job 纳入 shutdown 收口，不留下无捕获 rejection；重启未结算 pending/running 为 unknown，不重放副作用。请求断线也不重提。同步 run 保留原返回与异常口径。

历史沿用项目持久附属数据／Event，不新增核心实体；领取、spawn、收口分开记录。手动、Hook、失败、unknown 都可查询，编辑／撤权／删除不删除历史。历史按提交／开始事件倒序分页，固定游标不因旧记录完成而改变；旧 started/result 事件尽量只读兼容，不批量改写历史。按执行身份查询不依赖目录 last_execution（并发／改名／删除仍能找到）。只读接口不得执行恢复或命令。结果字段严格安全白名单。

## 页面与验证分区

- Runtime child：project/shortcut-commands.js、command-hooks.js 及必要执行互斥／恢复接缝，新增专项 tests，modules-runtime 对应条目。实现上面 Project 方法与读模型，不改 RPC／HTTP／assets。
- UI child：assets/shortcut-commands.js、render-hooks.js 及必要 styles、DOM tests、modules-web。自动化页内独立可缩放模块「快捷指令运行」「快捷指令管理」「运行记录」，运行区无编辑／授权／历史删除按钮，管理区无执行按钮。记录区单独提供逐条删除与清空已结束记录，确认说明保留审计、未知／活动不可删，失败不假定成功或自动重发。历史分页与状态查询，pending/running 显示进行中，网络异常仅显示连接／结果未确认，不冒充失败。不自动重试 mutation；读结果只在页面身份仍一致时继续，离开停止。返回可刷新历史恢复，不依赖浏览器缓存。默认 Worker 目录在指令管理保存，手动运行每次读新目录后预选；失效／冻结不回落 main，Hook 不用此默认。草稿／分页与迟到响应隔离，旧服务缺接口保守提示升级，不回退同步执行。
- W192 父：registry/handlers、HTTP、CLI 可选异步入口、契约／使用文档、真实临时项目组合及最终全量测试。子默认专项与受影响回归，不要求全量。

## W192 验证

两个 child 已合入 W192 并由父检查、验收。父复跑组合专项 60 项通过；修复新 pending 事件中文标签及连续运行目录 revision 后，专项 76 项通过。最终完整 `bun run test --timeout 30000`：**3213 pass / 0 fail**，411 文件；日志 `/tmp/lush-w192-logs/full-final.log`。`bun run docs:check` 通过，保留既有篇幅警告（`docs-final.log`）。

`bun run test/web/check-shortcut-commands-browser.js` 使用临时项目、真实 Firefox、HTTP→RPC→SQLite/Git/Shell：35 秒命令超过原 30 秒等待仍显示成功／退出码 0、执行一次、刷新恢复记录、第二次显式运行重读目录 revision、运行／管理分离、标签切换保留草稿；双主题 × 1440/390/320px 无横向裁剪。日志 `/tmp/lush-w192-logs/browser-final-rerun.log`，截图／driver 日志 `/tmp/lush-shortcut-browser-qwA99n/`。Firefox 外窗最小宽度需要 iframe；仅测试代理把 `frame-ancestors 'none'` 改为 self，其余生产 CSP／资源／接口保持，未放宽生产策略；原始生产 frame-ancestors 仍由 HTTP 安全回归覆盖。

首轮全量 **3210 pass / 1 fail**，原因是 pending 事件缺中文名称，已补标签与语义断言后完整重跑。早期浏览器夹具因生产禁止嵌入策略和窄屏点击未居中失败，修正测试代理与原生点击滚动后完整通过；失败日志为 `full-initial.log`、`browser-{initial,second,third}.log`，均在上述父日志目录，不作为通过证据。

未调用真实模型、真实网络 remote 或重跑 MeshNote 命令，未重启用户 daemon／Host。运行中的服务须在用户确认安全后加载新代码；部署及远程网络断线尚未实测。
