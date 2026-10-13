# 快捷指令与 Hook 授权契约

本章规定项目级快捷指令的定义、版本授权、Hook 执行与 Skill 风格导出。设计见[Worker Hooks](../design/hooks.md)，安全历史见[运行记录](shortcut-command-runs.md)。用户手动运行已删除，无兼容执行入口。

## 授权与版本

指令是项目 SQLite meta 的 versioned JSON 附属配置，不新增实体、Host 调度或 Agent 权限。定义含 `{id?,name,kind?,command?|prompt?,default_worker_id?,description?,when_to_use?,tags?,examples?,warnings?}`。kind 为 shell／prompt，旧缺省 shell，正文互斥。省略元数据保留原值；旧 default_worker_id 仅兼容，省略保留但不再核验旧目标，显式非 null 仍校验、null 清空。页面不编辑默认目标，Hook Shell 用挂载目录，提示词用挂载父，不接受任意路径或改投 main。

普通新增／修改不授权；内置 git push 初始化授权、Hook 默认停用。所有编辑（含元数据）递增 version 并撤权；删除不复用身份、不删除历史。读取只补缺省，不重写／重新授权。

Shell Hook 为 `{type:'command',command_id:UUID,command_version:正整数}`，不接受内联 command、目录、额外参数或拼接。保存核验引用存在／版本，未授权可保存停用配置；启用、提交、spawn 前必须重核授权，不自动升级旧引用。撤权不保证撤销已开始副作用，不重放旧触发。

执行仍为可信 POSIX Shell，最多 60 秒／64 KiB、非交互认证，核验真实 Worker 目录、Git 串行门、冻结／同步／清理和实际 invocation 互斥，去掉调用凭证；不公开原始输出／异常。它不是 OS 沙箱，只允许已授权 Hook 执行，旧手动事实／unknown 保留。

## 读面与 Project 方法

`hooks.list.commands={version:1,revision,items}`，item 含身份、版本、授权、默认 Worker、kind、元数据、last_execution，正文仅相应 command／prompt。name≤120，正文≤16000，description≤2000，when_to_use／warnings≤4000，examples≤8000，tags≤32项且每项≤80，字符串拒绝 NUL。正文仅用户配置读面可见，不进入错误／事件／执行输出；安全执行摘要不含正文或秘密。变更／领取／收口更新 revision，模板及 Worker revision 独立。

- `shortcutCommands()` 只读目录；`exportShortcutCommand(id,version)` 返回 `{filename,markdown}`，不安装／注入／授权。
- `saveShortcutCommand(command,expectedRevision)`、`authorizeShortcutCommand(id,version,authorized,expectedRevision)`、`removeShortcutCommand(id,expectedRevision)` 返回 hooksList，授权／删除只影响未来可用版本。
- `importLegacyHookCommands(source,expectedRevision)`：source 为 `{worker_id,hook_id}` 或 `{template_id}`，revision 属该源。将旧内联注册为未授权指令并替换引用，源挂载停用、身份／历史保留；返回 `{...hooksList(),imported_command_ids,worker_hooks?}`，不重放。

## RPC / Web / CLI

全部用户专属、严格参数白名单；GET `/api/hooks` 只读，POST `/api/action` 配置。

| RPC | 参数 |
|---|---|
| hooks.command_save | command, expected_revision |
| hooks.command_export | id, version |
| hooks.command_authorize | id, version, authorized, expected_revision |
| hooks.command_remove | id, expected_revision |
| hooks.command_import | source, expected_revision |

CLI `hooks command list/save/export/authorize/revoke/remove/import/history`；save／import 用私有 JSON 文件与 revision，版本引用不可省略。Worker 编号只在 CLI 转整数。不提供 run／start 别名。

## 提示词执行与 Skill 导出

提示词仅由 Hook 精确 claim／receipt 执行，缺收据不得回落 manual。父仅 main／owner／order（历史 say 读兼容），按默认运行参数与 order 真实 Git 基线、冻结／同步／生命周期准入；Git 创建与落库前复核版本／授权。历史 kind、新 Worker／Input 关联保存，succeeded 只表示创建提交成功，不代表 Agent 完成。

引用 `{type:'prompt_command',command_id,command_version}` 仅 worker.parent_ready＋once，挂载 Worker 即父；同 Hook 不混 Shell，create_worker／prompt_command 总计至多一项。编辑／撤权／删除不升级旧引用，未知不重放，调用带 Agent 费用标识。

导出经 RPC／CLI 或 GET `/api/hooks/commands/export?id=UUID&version=N`。SQLite 是授权权威，Markdown 不携 env、凭证或历史，不成为第二份可执行授权；不自动注入 Skill，不给开发 Agent 注册／授权／执行能力。

## 旧配置与 git push

旧内联仅展示／显式导入／诊断，不执行或启用。启动停止旧未来执行，不将读取当迁移，不重写收据。新项目默认注册并授权 git push，再保存关闭的 main 模板／挂载。旧未修改内置身份可在启动一次性导入／授权，`command_hook_example.version=2` 记升级；用户副本不处理，已撤权／修改／删除不恢复，tombstone 不重装。旧触发丢弃、历史与 unknown 保留，原 running 先恢复为 unknown 才能导入。其他命令仍需显式导入授权。

## 界面与分区

通用管理在独立辅助页面：`#hook-tools` 模板、`#hooks-commands` 指令管理、`#hook-tools-history` 全部指令历史；推送功能页另提供其引用指令的同源版本授权。指令列表→详情／编辑复用显式搜索和筛选，提供新增、授权、删除、导出，无手动运行或默认目录编辑。返回／重画保留草稿与原 revision；Hook 编辑只选指令版本，不填写 Shell。授权／删除说明影响，保存不执行；失败／迟到保护，旧服务缺字段保守禁用。具体历史状态／移除见[运行记录](shortcut-command-runs.md)。

## W151 验证记录

历史交付与通过数留在 Worker／Git 记录。当前专项定位 `test/project/shortcut-command*.test.js`、`test/shortcut-command-api.test.js` 与对应 Web API／DOM／集成，验证授权撤销、精确版本、实际互斥、私有投影、连续 Hook 和 unknown 不重放；使用临时项目、受控命令与本地 bare remote，不接用户账号或服务。

## W211／D496 目录与记录管理

旧默认目录只兼容配置，不再路由；自动化模块可展开／收起，启停和授权不冒充执行结果。安全历史见[运行记录](shortcut-command-runs.md)。

### 默认推送追加要求

内置推送兼容统一见[旧配置与 git push](#旧配置与-git-push)，专项入口 `test/project/default-push-command.test.js`。

### 固定父基线修复

快捷指令授权与 Hook 收据保持项目归属，不因设备连接／余额共享而全局化；历史修复记录不替代当前树的回归证据。
