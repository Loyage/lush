# 快捷指令运行历史

W241／D566 删除用户手动运行能力，保留 Hook 执行、旧手动历史与安全审计。本文固定历史查询／移除及恢复边界；授权、版本、Worker 身份、Git 串行与冻结门禁沿用[快捷指令契约](shortcut-commands.md)，Shell 仍最多 60 秒／64 KiB，不保存 stdout／stderr。

## 实现接缝

用户专属历史接口如下。`hooks.command_run/command_start`、CLI `run/start` 及 Project `runShortcutCommand/startShortcutCommand` 已删除，无兼容执行入口。

- `hooks.command_history {before?,limit?,execution_id?}` → `{version:1,items,has_more,next_before}`，Project `shortcutCommandHistory(options={})`。默认 limit 30，上限 100；before 是正整数事件游标；execution_id 是 UUID，按身份查询时不得带 before。
- `hooks.command_history_remove {execution_id}` 或 `{clear:true}` → `{removed_count}`，Project `removeShortcutCommandHistory(options={})`。参数严格二选一，逐条或全量移除 succeeded/failed 的公开历史，pending/running/unknown 拒绝；重复 UUID 幂等返回 0。持久隐藏标记保留原 Event，公开分页／精确查询和 commands.last_execution 不再显示移除项，启动恢复与去重仍扫描原审计，不撤回副作用或撤权。
- Web POST `/api/action` 仅保留 command_history_remove；GET `/api/hooks/commands/executions` 只读转发 command_history，拒绝未知／重复参数。

每项安全 execution：`{event_id,id,command_id,command_name,command_version,worker_id,worker_number,source,status,created_at,finished_at,command_result?}`，W228 的新记录另含 `kind,created_worker_id,created_worker_number,input_id`；旧记录按 Shell 兼容，未创建时关联可空。prompt 的 worker_id 是父身份，created_worker_id 是新指令身份；succeeded 仅表示创建并提交成功，Agent 后续结果属于关联 Worker，不以退出码或 Shell 成功口径呈现。提示词执行及精确收据约束见[快捷指令契约](shortcut-commands.md#提示词执行与-skill-导出)。source 为 manual／hook／unknown（旧记录无法确认）；status 为 pending／running／succeeded／failed／unknown。command_name 为提交时名称快照；不包含 Shell 正文、env、原始错误或输出。旧事件缺名称时允许 null，不拿当前名称冒充历史。Worker 优先记录当时持久 worker_number，旧记录可只读关联；无编号才显示 #整数 ID。

Hook 执行仍核验授权、精确版本及安全门，防止与同 Worker 的 Agent／合并重叠。重启时旧手动未结算 pending/running 收口为 unknown，不重放；历史隐藏不影响恢复扫描。没有手动新提交，也不因只读查询执行恢复。

历史沿用项目持久附属数据／Event，不新增核心实体；领取、spawn、收口分开记录。手动、Hook、失败、unknown 都可查询，编辑／撤权／删除不删除历史。历史按提交／开始事件倒序分页，固定游标不因旧记录完成而改变；旧 started/result 事件尽量只读兼容，不批量改写历史。按执行身份查询不依赖目录 last_execution（并发／改名／删除仍能找到）。只读接口不得执行恢复或命令。结果字段严格安全白名单。

## 页面

指令管理在独立子页面，列表→单条详情／编辑，无手动执行按钮；历史子页面保留独立运行记录模块，分页查看、逐条删除及清空已结束记录。确认说明保留审计，未知／活动不可删。pending/running 显示进行中，网络异常只表示连接／结果未确认，不冒充失败。读结果仅在页面身份一致时继续，离页停止；迟到响应不跨项目污染，旧服务缺接口保守提示升级，不回退执行。默认 Worker 仅兼容旧配置，不再有手动运行预选。

## W192 验证

两个 child 已合入 W192 并由父检查、验收。父复跑组合专项 60 项通过；修复新 pending 事件中文标签及连续运行目录 revision 后，专项 76 项通过。最终完整 `bun run test --timeout 30000`：**3213 pass / 0 fail**，411 文件；日志 `/tmp/lush-w192-logs/full-final.log`。`bun run docs:check` 通过，保留既有篇幅警告（`docs-final.log`）。

`bun run test/web/check-shortcut-commands-browser.js` 使用临时项目、真实 Firefox、HTTP→RPC→SQLite/Git/Shell：35 秒命令超过原 30 秒等待仍显示成功／退出码 0、执行一次、刷新恢复记录、第二次显式运行重读目录 revision、运行／管理分离、标签切换保留草稿；双主题 × 1440/390/320px 无横向裁剪。日志 `/tmp/lush-w192-logs/browser-final-rerun.log`，截图／driver 日志 `/tmp/lush-shortcut-browser-qwA99n/`。Firefox 外窗最小宽度需要 iframe；仅测试代理把 `frame-ancestors 'none'` 改为 self，其余生产 CSP／资源／接口保持，未放宽生产策略；原始生产 frame-ancestors 仍由 HTTP 安全回归覆盖。

首轮全量 **3210 pass / 1 fail**，原因是 pending 事件缺中文名称，已补标签与语义断言后完整重跑。早期浏览器夹具因生产禁止嵌入策略和窄屏点击未居中失败，修正测试代理与原生点击滚动后完整通过；失败日志为 `full-initial.log`、`browser-{initial,second,third}.log`，均在上述父日志目录，不作为通过证据。

未调用真实模型、真实网络 remote 或重跑 MeshNote 命令，未重启用户 daemon／Host。运行中的服务须在用户确认安全后加载新代码；部署及远程网络断线尚未实测。
