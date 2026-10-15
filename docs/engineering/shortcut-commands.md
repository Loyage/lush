# 快捷指令与 Hook 契约

本章规定项目级快捷指令的定义、版本、Hook 执行与 Skill 风格导出。设计见[Worker Hooks](../design/hooks.md)，安全历史见[运行记录](shortcut-command-runs.md)。用户手动运行已删除，无兼容执行入口。

## 定义与版本

指令是项目 SQLite meta 的 versioned JSON 附属配置，不新增实体、Host 调度或 Agent 权限。定义含 `{id?,name,kind?,command?|prompt?,default_worker_id?,description?,when_to_use?,tags?,examples?,warnings?}`。kind 为 shell／prompt，旧缺省 shell，正文互斥。省略元数据保留原值；旧 default_worker_id 仅兼容，省略保留但不再核验旧目标，显式非 null 仍校验、null 清空。页面不编辑默认目标，Hook Shell 用挂载目录，提示词用挂载父，不接受任意路径或改投 main。

快捷指令没有预授权状态。所有编辑（含元数据）递增 version，版本用于导出、历史与精确执行证据，不是执行许可。编辑不撤权、不停用挂载，已有自动化未来执行跟随最新定义；保存本身不执行。删除不复用身份、不删除历史。

Shell Hook 为 `{type:'command',command_id:UUID}`，不接受内联 command、目录、额外参数或拼接。旧可选 `command_version` 接受正安全整数，仅兼容旧配置，不固定未来执行版本。保存及执行前核验指令存在和类型匹配；删除或切换为不匹配类型仍阻止执行。启停、项目权限、合并／验收级别授权和管理 Agent 危险操作确认均不因移除快捷指令授权而放宽。

执行开始固定实际定义的身份、kind、名称、版本和正文；异步编辑不得造成收据记录旧版本而执行新正文，或用当前目录替换已开始运行的证据。已固定运行与未来跟随最新定义的触发必须区分；不承诺撤回已开始副作用，unknown 不重放。

执行仍为可信 POSIX Shell，最多 60 秒／64 KiB、非交互认证，核验真实 Worker 目录、Git 串行门、冻结／同步／清理和实际 invocation 互斥，去掉调用凭证；不公开原始输出／异常。它不是 OS 沙箱，只由 Hook 执行，旧手动事实／unknown 保留。

## 读面与 Project 方法

`hooks.list.commands={version:1,revision,items}`，item 含身份、版本、默认 Worker、kind、元数据、last_execution，**不公开 authorized**，正文仅相应 command／prompt。name≤120，正文≤16000，description≤2000，when_to_use／warnings≤4000，examples≤8000，tags≤32项且每项≤80，字符串拒绝 NUL。正文仅用户配置读面可见，不进入错误／事件／执行输出；安全执行摘要不含正文或秘密。变更／领取／收口更新 revision，模板及 Worker revision 独立。

- `shortcutCommands()` 只读目录；`exportShortcutCommand(id,version)` 返回 `{filename,markdown}`，不安装／注入或赋予 Agent 调用能力。
- `saveShortcutCommand(command,expectedRevision)`、`removeShortcutCommand(id,expectedRevision)` 返回 hooksList。`authorizeShortcutCommand` 已删除。
- `importLegacyHookCommands(source,expectedRevision)`：source 为 `{worker_id,hook_id}` 或 `{template_id}`，revision 属该源。将旧内联注册为指令并替换引用，源挂载停用、身份／历史保留；返回 `{...hooksList(),imported_command_ids,worker_hooks?}`，不重放。

## RPC / Web / CLI

全部用户专属、严格参数白名单；GET `/api/hooks` 只读，POST `/api/action` 配置。

| RPC | 参数 |
|---|---|
| hooks.command_save | command, expected_revision |
| hooks.command_export | id, version |
| hooks.command_remove | id, expected_revision |
| hooks.command_import | source, expected_revision |

CLI `hooks command list/save/export/remove/import/history`；save／import 用私有 JSON 文件与 revision，export 仍要求精确版本。`hooks.command_authorize` 和 CLI `hooks command authorize/revoke` 已删除，无兼容授权入口。Worker 编号只在 CLI 转整数。不提供 run／start 别名。

## 提示词执行与 Skill 导出

提示词仅由 Hook 精确 claim／receipt 执行，缺收据不得回落 manual。父仅 main／owner／order（历史 say 读兼容），按默认运行参数与 order 真实 Git 基线、冻结／同步／生命周期准入；Git 创建与落库前复核固定定义及执行收据。历史 kind、新 Worker／Input 关联保存，succeeded 只表示创建提交成功，不代表 Agent 完成。

引用 `{type:'prompt_command',command_id}` 仅 worker.parent_ready＋once，挂载 Worker 即父；同 Hook 不混 Shell，create_worker／prompt_command 总计至多一项。类型变化不能解除一次性创建熔断，调用带 Agent 费用标识。

导出经 RPC／CLI 或 GET `/api/hooks/commands/export?id=UUID&version=N`。SQLite 是定义权威，Markdown 不携 env、凭证或历史，不成为第二份执行配置；不自动注入 Skill，不给开发 Agent 注册或执行能力。

## 旧配置与 git push

旧指令未授权／已撤权字段不再阻塞未来执行，但已停用规则不自动启用；不改写历史、固定执行证据或重放旧触发。旧内联仅展示／显式导入／诊断，不执行或启用。启动停止旧内联未来执行，不将读取当迁移，不重写收据。新项目默认注册 git push，再保存关闭的 main 模板／挂载。旧未修改内置身份可在启动一次性导入；用户副本不处理，已修改／删除配置不恢复，tombstone 不重装。旧触发丢弃、历史与 unknown 保留，原 running 先恢复为 unknown 才能导入。其他内联命令仍需显式导入。

## 界面与分区

通用管理在独立辅助页面：`#hook-tools` 模板、`#hooks-commands` 指令管理、`#hook-tools-history` 全部指令历史；推送功能页管理引用和挂载启停。指令列表→详情／编辑复用显式搜索和类型筛选，提供新增、编辑、删除、导出，无授权／撤权按钮、授权筛选、手动运行或默认目录编辑。返回／重画保留草稿与原 revision；Hook 编辑只选指令，不填写 Shell。删除说明影响，保存不执行；失败／迟到保护，旧服务缺字段保守禁用。具体历史状态／移除见[运行记录](shortcut-command-runs.md)。

## 验证入口

当前专项定位 `test/project/shortcut-commands.test.js`、`test/project/shortcut-command-runs.test.js`、`test/shortcut-command-api.test.js` 与对应 Web API／DOM／集成，保留定义版本、真实执行目录、安全收据与历史投影等代表路径；使用临时项目、受控命令与本地 bare remote，不接用户账号或服务。真实推送冒烟见 `test/project/hooks-command.test.js`，不再保留完整互斥、异常与兼容矩阵。

快捷指令定义与 Hook 收据保持项目归属，不因设备连接／余额共享而全局化；历史修复记录不替代当前树的回归证据。
