# 快捷指令与 Hook 授权契约

本文固定项目级快捷指令的定义、版本授权与执行契约；W228／D534 增加 Skill 风格元数据和提示词类型。设计见 [Worker Hooks](../design/hooks.md)，其他受控动作及自动链不变。

## 授权与版本

快捷指令是项目 SQLite meta 的附属 versioned JSON，不新增核心实体、Host 调度或 Agent 权限。定义包含 `{id?,name,kind?,command?|prompt?,default_worker_id?,description?,when_to_use?,tags?,examples?,warnings?}`。kind 为 shell 或 prompt，旧缺省为 shell；两类正文互斥。description（作用）、when_to_use（适用场景）、examples（示例）、warnings（风险）为可空字符串，tags 为字符串数组；编辑省略元数据保留原值。default_worker_id 仅兼容已有配置，为真实 Worker 内部正整数 ID 或 null，省略保留且不再核验旧目标可用性，显式非 null 值仍按类型校验、null 清空；不迁移或删除旧字段。页面不再管理手动默认目标，Hook 不采用此默认：Shell 用挂载目录、提示词用挂载父身份，不接受任意路径或静默改投 main。普通新增和修改不授权；内置默认 git push 初始化授权、Hook 仍停用。编辑包括元数据都递增 version 并撤权；删除不复用身份，不删除历史。旧数据读取仅补缺省，不自动重写或重新授权。

Hook Shell 动作新形为 `{type:'command',command_id:UUID,command_version:正整数}`，不得提交内联 command、运行目录、额外参数或 Shell 拼接。保存模板/挂载必须检查引用存在及版本；未授权版本可保存停用配置，但启用、提交及真正 spawn 前必须核验授权与版本。修改后不自动更新已有 Hook 的引用。撤权不承诺取消已开始的副作用，不自动重放旧触发。

快捷指令不是沙箱。沿用现有 POSIX Shell、有界执行、非交互认证、真实 Worker 目录、Git 串行门与冻结/同步/清理/真实 invocation 核验；移除 invocation 凭证，不公开原始输出或异常。W241／D566 删除所有用户手动运行入口（Web、CLI、RPC 与 Project 方法），不保留执行别名；只由已授权 Hook 执行。旧手动事件与未知恢复事实保留，不重放。每份指令公开最近安全执行摘要，不记录命令输出；读模型见[运行历史接缝](shortcut-command-runs.md)。

## 读面与 Project 方法

`hooks.list` 提供 `commands:{version:1,revision,items}`；每项含身份、版本、授权、默认 Worker、kind、上述元数据及 last_execution，正文按类型只返回 command 或 prompt。name 上限 120，command／prompt 上限 16000；description 2000、when_to_use／warnings 4000、examples 8000；tags 最多 32 项、每项 80。字符串拒绝 NUL。指令正文是用户配置，允许用户专属读面显示，不能放入错误、事件或原始输出。last_execution 可空，否则只含安全执行身份、Worker 整数 ID/持久编号、状态、时间和 command_result。每次变更/领取/收口更新 revision；模板及 Worker 自身 revision 保持独立。

- `shortcutCommands()`：只读 commands。
- `exportShortcutCommand(id,version)`：只读返回 `{filename,markdown}`，导出单条 Skill 风格 frontmatter 与正文；不安装、注入或授权。
- `saveShortcutCommand(command,expectedRevision)`：保存定义，返回完整 hooksList。
- `authorizeShortcutCommand(id,version,authorized,expectedRevision)`：当前版本显式授权/撤权，返回完整 hooksList。
- `removeShortcutCommand(id,expectedRevision)`：删除未来可用授权，保留历史，返回完整 hooksList。
- `importLegacyHookCommands(source,expectedRevision)`：source 为 `{worker_id,hook_id}` 或 `{template_id}`，revision 取该源 Worker Hooks 或模板目录。将源的内联 Shell 动作注册为未授权快捷指令并替换为版本引用；源规则停用，保留身份与执行历史，不重放旧触发。返回 `{...hooksList(),imported_command_ids,worker_hooks?}`。

## RPC / Web / CLI

以下接口全部用户专属，参数严格白名单；读面仍用 GET `/api/hooks`，写操作使用 POST `/api/action`。

| RPC | 参数 |
|---|---|
| `hooks.command_save` | command, expected_revision |
| `hooks.command_export` | id, version |
| `hooks.command_authorize` | id, version, authorized, expected_revision |
| `hooks.command_remove` | id, expected_revision |
| `hooks.command_import` | source, expected_revision |

CLI 使用 `hooks command list`（复用 hooks.list）、`save --file PATH --revision REV`、`authorize|revoke ID --version N --revision REV`、`remove ID --revision REV`、`import --file PATH --revision REV`。JSON 复用私有文件边界，Worker 编号仅在 CLI 转为整数；版本及 revision 不可省略。

## 提示词执行与 Skill 导出

提示词仅经 Hook 内部执行，必须有匹配挂载的精确 claim／receipt，不得缺少收据回落为 manual。父 Worker 仅允许 main／owner／order（历史 say 只读兼容），沿用默认运行设置与 order 的真实 Git 基线、冻结、同步及生命周期准入；Git 队列内创建及落库前复核确切版本与授权。安全历史记录 kind、新 Worker／Input 关联，succeeded 仅表示创建并提交成功，不代表 Agent 工作完成；结果从关联 Worker 查看。未知副作用不重放。

Hook 提示词引用 `{type:'prompt_command',command_id,command_version}`，仅允许 `worker.parent_ready`＋once；挂载 Worker 就是父。复用创建精确收据及恢复去重；同 Hook 不混合 Shell command 与 prompt_command，create_worker／prompt_command 总计最多一个。编辑、撤权及删除使两类未来引用失效，不自动升级。提示词启动和此 Hook 均标明 Agent 费用。

用户可通过 `hooks.command_export {id,version}`、CLI `hooks command export ID --version N` 或只读 `GET /api/hooks/commands/export?id=UUID&version=N` 导出定义。SQLite 仍是权威，Markdown 不是第二份可执行授权；本轮不自动向项目 Skill 注入，也不开放开发 Agent 发现、注册、授权或执行接口。导出不携带运行环境、凭证或历史，不表示已安装可调用 Skill。

## 旧配置与 git push

旧内联命令保留用于展示、显式导入与历史诊断，但不得再执行或启用。启动接缝停止旧命令未来执行；不得把读取当迁移，不重写历史收据，不重放未知/已发生触发。W151 追加要求：新项目先默认注册并授权内置 `git push` 快捷指令，再保存默认关闭的 main 模板和挂载，引用该指令版本。已有未修改的默认模板／挂载或最初未授权版本在启动初始化时一次性导入／授权，`command_hook_example.version=2` 标记升级已处理；只处理持久登记的内置身份，不处理用户副本或其他命令。用户已撤权、修改或删除的配置不恢复；旧触发全部丢弃，历史与未知收据保留。运行中旧命令先由恢复流程收口为 unknown 后才能导入。读取不执行升级，旧删除 tombstone 仍有效，不重装已删除项。其他旧命令仍需显式导入并授权。

## 界面与分区

自动化保留 `#hooks`，分「设置／指令管理／历史记录」子页面。指令管理复用列表型页面设计语言，统一提交式搜索与类型／授权筛选；列表→单条详情／编辑，提供新增、编辑、授权／撤权、删除及导出，返回保留列表状态，同页刷新与切换子页保留草稿及原 revision。无手动运行或默认 Worker 编辑入口。历史页面只查询安全历史并显式移除已结束记录（保留审计）。Hook 编辑器仅选择指令与版本，不能填写 Shell；旧内联命令提供显式导入。授权、删除前说明实际影响，保存不执行、不启动 Agent。失败保留草稿，迟到响应不覆盖新页面，旧服务缺 commands 保守禁用操作。

- Runtime 子分区：core/hooks、project/hooks/command-hooks、新 shortcut-commands 模块、Project 装配与必要执行门；test/project 命令测试及纯定义回归。维护 modules-runtime 对应条目，不改 RPC/CLI/assets。
- Web 子分区：assets Hook 表单/渲染/样式，快捷指令编辑与授权/执行/导入，DOM 回归；维护 modules-web 条目，不改 runtime/API。
- 接口子分区：RPC registry/handlers、CLI hooks/help、Web server 白名单及 API/CLI/HTTP 测试；维护公开参考，不改 runtime/assets。
- 父 W151：设计、工程、使用文档及 modules 总接缝；检查子分区交付、组合安全验证、完整测试与最终提交。

## W151 验证记录

三个分区已合入 W151 并由直接父 Agent 检查确认。父侧真实 HTTP/RPC/SQLite/Git 联调覆盖：git push 先注册再授权、与 main 同源的挂载修订、连续合并推送到临时本地 bare remote、模板与实例隔离、失败停止未来触发、手动执行所选 Worker 目录、编辑撤权／旧版本拒绝、删除与撤权、旧内联显式导入和不重放。

运行时专项另覆盖异步目录检查及 ref 基线读取期间撤权／编辑／删除、已开始命令不冒充可撤回、停止后续动作及积压触发、实际 invocation 互斥、关闭等待在途命令、私有配置与凭证／原始输出隔离、重启 unknown 不重放。父侧组合专项 **45 pass / 0 fail**，日志 `/tmp/lush-w151-logs/combined.log`。

完整 `bun run test --timeout 30000`：**2582 pass / 0 fail**，336 文件；日志 `/tmp/lush-w151-logs/full-final.log`。首次全量仅两个旧内联 HTTP 联调测试失败（`/tmp/lush-w151-logs/full-initial.log`），已迁移为注册、授权及明确版本引用并新增手动／导入回归；最终完整重跑通过。未调用真实模型、连接真实推送 remote 或重启用户 daemon/Host，真实浏览器交互仍未验证。

## W211／D496 目录与记录管理

旧默认目录字段仅保留兼容配置，不再用于手动路由；Hook 执行前仍复核授权、挂载目录、Git 与冻结／同步／实际 invocation。历史边界见[运行与历史](shortcut-command-runs.md)。项目自动化其余 Hook、时间信号、管理指令、模板模块也可展开／收起；授权与启停有醒目颜色及文字，不冒充运行结果或 Agent 调用。

### 默认推送追加要求

用户追加要求内置默认 `git push` 自动导入并授权，以便直接启用 main 的推送 Hook。本项覆盖上面首次交付的默认未授权行为：普通命令授权不变，推送 Hook 仍默认关闭。新增 `test/project/default-push-command.test.js` 覆盖默认即授权、旧默认一次性升级、内置模板与挂载共用一项指令、读取纯度、用户副本不升级、用户撤权／编辑／删除不恢复、积压触发丢弃、启动期间原 running 收口 unknown 后完成导入而不重放。真实 HTTP 联调直接启用默认 Hook 并推送到临时 bare remote，不再先手工授权。

专项 **39 pass / 0 fail**（`/tmp/lush-w151-logs/default-push-focused.log`）；最终完整 `bun run test --timeout 30000` **2595 pass / 0 fail**，339 文件（`/tmp/lush-w151-logs/default-push-full.log`）。未重启用户服务，运行中的旧 daemon 须加载新版本后才执行一次性初始化；真实浏览器仍未验证。

### 固定父基线修复

交付 13042／尝试 13045 在 W151 源工作区合入固定父提交 `4a1f132`，保留原源提交 `873ad3d`；共同祖先 `23c2bf8`。逐项检查双方含改名增量：父侧增加设备共享连接最新余额文件及本地读取，未发现符号改名、公共接口迁移或架构冲突，无文本冲突。快捷指令授权仍保存在当前项目 meta，不随连接余额改为设备共享；自动化的刷新时间选择器仍只消费同形 `connection.observation`，失败不使用 `last_success` 填入，因而无需代码适配。双方 Runtime 模块条目均保留。

合入后专项 **77 pass / 0 fail**（`/tmp/lush-w151-logs/repair-focused.log`）；完整 `bun run test --timeout 30000` **2590 pass / 0 fail**，338 文件（`/tmp/lush-w151-logs/repair-full.log`）；文档检查通过（既有篇幅警告，`/tmp/lush-w151-logs/repair-docs.log`）。未验证真实浏览器、真实模型或网络 remote，未修改父分支或重启用户服务。

交付 13091／尝试 13094 合入固定父提交 `4ac2c86`，保留追加源提交 `d30236a`；共同祖先 `4a1f132`。双方增量检查确认固定父代码树与上一源交付 `bd8257d` 完全一致，是同一成果的 squash，没有改名或接口迁移。Git 因历史关系产生八处内容／添加冲突，逐项保留本轮默认推送授权、一次性升级及相应文档／测试；合入后的代码树与 `d30236a` 一致，无额外语义适配。专项 **79 pass / 0 fail**（`/tmp/lush-w151-logs/default-repair-focused.log`），完整 **2595 pass / 0 fail**、339 文件（`/tmp/lush-w151-logs/default-repair-full.log`），文档检查通过（既有篇幅警告）。真实浏览器及外部 remote 仍未验证，未操作父分支或用户服务。
