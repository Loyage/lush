# 快捷指令运行历史

W241／D566 删除用户手动运行能力，保留 Hook 执行、旧手动历史与安全审计。本文固定历史查询／移除及恢复边界；版本固定、Worker 身份、Git 串行与冻结门禁沿用[快捷指令契约](shortcut-commands.md)，Shell 仍最多 60 秒／64 KiB，不保存 stdout／stderr。

## 实现接缝

用户专属历史接口如下。`hooks.command_run/command_start`、CLI `run/start` 及 Project `runShortcutCommand/startShortcutCommand` 已删除，无兼容执行入口。

- `hooks.command_history {before?,limit?,execution_id?}` → `{version:1,items,has_more,next_before}`，Project `shortcutCommandHistory(options={})`。默认 limit 30，上限 100；before 是正整数事件游标；execution_id 是 UUID，按身份查询时不得带 before。
- `hooks.command_history_remove {execution_id}` 或 `{clear:true}` → `{removed_count}`，Project `removeShortcutCommandHistory(options={})`。参数严格二选一，逐条或全量移除 succeeded/failed 的公开历史，pending/running/unknown 拒绝；重复 UUID 幂等返回 0。持久隐藏标记保留原 Event，公开分页／精确查询和 commands.last_execution 不再显示移除项，启动恢复与去重仍扫描原审计，不撤回副作用或改变挂载启停。
- Web POST `/api/action` 仅保留 command_history_remove；GET `/api/hooks/commands/executions` 只读转发 command_history，拒绝未知／重复参数。

每项安全 execution：`{event_id,id,command_id,command_name,command_version,worker_id,worker_number,source,status,created_at,finished_at,command_result?}`，W228 的新记录另含 `kind,created_worker_id,created_worker_number,input_id`；旧记录按 Shell 兼容，未创建时关联可空。prompt 的 worker_id 是父身份，created_worker_id 是新指令身份；succeeded 仅表示创建并提交成功，Agent 后续结果属于关联 Worker，不以退出码或 Shell 成功口径呈现。提示词执行及精确收据约束见[快捷指令契约](shortcut-commands.md#提示词执行与-skill-导出)。source 为 manual／hook／unknown（旧记录无法确认）；status 为 pending／running／succeeded／failed／unknown。command_name／command_version 为实际固定定义的名称／版本快照，固定时机见[执行契约](shortcut-commands.md#定义与版本)；历史旧快照保持原义，不用当前目录改写。不包含 Shell 正文、env、原始错误或输出。旧事件缺名称时允许 null，不拿当前名称冒充历史。Worker 优先记录当时持久 worker_number，旧记录可只读关联；无编号才显示 #整数 ID。

Hook 未来执行跟随最新定义，实际开始固定版本、正文及收据，仍核验安全门，防止与同 Worker 的 Agent／合并重叠；编辑不得混用历史证据与新正文。重启时旧手动未结算 pending/running 收口为 unknown，不重放；历史隐藏不影响恢复扫描。没有手动新提交，也不因只读查询执行恢复。

历史沿用项目持久附属数据／Event，不新增核心实体；领取、spawn、收口分开记录。手动、Hook、失败、unknown 都可查询，编辑／删除不删除历史，旧授权字段不再阻塞未来执行，已停用规则不自动启用。历史按提交／开始事件倒序分页，固定游标不因旧记录完成而改变；旧 started/result 事件尽量只读兼容，不批量改写历史。按执行身份查询不依赖目录 last_execution（并发／改名／删除仍能找到）。只读接口不得执行恢复或命令。结果字段严格安全白名单。

## 页面

指令管理在独立子页面，列表→单条详情／编辑，无手动执行按钮；历史子页面保留独立运行记录模块，分页查看、逐条删除及清空已结束记录。确认说明保留审计，未知／活动不可删。pending/running 显示进行中，网络异常只表示连接／结果未确认，不冒充失败。读结果仅在页面身份一致时继续，离页停止；迟到响应不跨项目污染，旧服务缺接口保守提示升级，不回退执行。默认 Worker 仅兼容旧配置，不再有手动运行预选。

## W192 验证

保留历史入口；旧手动运行验收过程与日志留在 Worker／提交记录，不再作为现行操作指南。手动运行的执行身份、未知恢复、分页／移除和离页保护不再保留独立回归；当前仅保留少量命令 Hook 冒烟，覆盖取舍见[贡献指南](../contributing/README.md#覆盖取舍)。受控 fixture 不证明真实模型、外部 remote 或部署网络可用，不操作用户服务。
