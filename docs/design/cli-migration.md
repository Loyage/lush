# CLI 精简迁移依据

本文记录 W358／D731 确认的 CLI 删除与保留边界，供升级脚本和维护调用方时参考。精确可执行目录、参数与示例只由 `src/cli/catalog.js` 和同源 help 维护；设计取舍见[CLI 设计](cli.md)，授权与输出契约见[CLI 与 RPC](../reference/api.md#cli-原子切换与迁移w356d727)。本文不是权限名单或验证通过证据。

## 删除边界

本次精简替代“每个有效 RPC 都配一个 CLI”的旧目标：保留日常核心与自定义自动化，删除用户专属业务 CLI，仅例外保留本地启动诊断。所有删除项都不保留可执行别名；底层 RPC、Web、权限配置、既有记录和文件不随 CLI 删除。

| 删除类别 | 典型旧入口 | 后续处理 |
| --- | --- | --- |
| 用户专属工作操作 | worker watch／wait／create／config show／accept-preview；accept 强制模式 | 使用已有 Web 阅读、创建、运行设置或强制验收；普通 accept 仍保留 |
| 高级图与版本浏览 | worker graph／merge graph、branch history／versions／graph | 使用已有 Web／RPC；tree 只是委派或分支树，不冒充完整图 |
| 分支高级管理与旧兼容 | branch bind／archive／integrate／legacy-convergence | 使用已有 Web／RPC；旧在途与历史协议不变，不重放 |
| 低频维护 | worker cleanup／worker automation list（挂载总览）、automation upgrade／command import／command history-remove | 普通验收仍安全回收资源；特殊维护留在既有后台／Web，不新造 CLI 旁路 |
| 私有配置与认证 | config agent show／set／reset、config network／migration、agent source save／login | 使用现有用户设置、模型来源登录及迁移界面／RPC；不要把秘密移入 argv |
| 插件与用量历史 | agent resource／package／usage、source history／sampling | 现有安装库、设置和历史仍保留，不向当前管家加载插件 |
| 管家创建与急救 | valet submit／schedule／emergency | 使用现有用户管理输入、急救及绑定 RPC；管家不能自复制或批准自己的授权 |
| 本地业务文件参数 | profile-file／file／questions-file／answers-file | 管理业务使用已支持的内联 JSON／文本；不保留读取文件模式。lushw 本地问卷文件不在删除范围 |

## 保留的流程

- 新建仍用 order；直接追加用 worker message；可靠条件追加用 input draft create → show → submit。保存不授权、提交不保证立即投递，多条件为 AND。
- 保留工作列表、详情、树、必要诊断、沟通、运行控制、合并、普通验收与删除，以及对应前置读取和预检。删除仍须真实 revision 与精确确认。
- 自定义自动化保留定义、注册、快捷指令、信号及固定版本挂载；注册不挂载、不执行。不因保留自动化恢复旧安装、迁移或手动运行捷径。
- 模型来源及缓存、必要运行设置、完整显式配置、设备 Valet 权限查询／审核保留；后台逐项权限和本轮设备授权仍有效。
- valet 只保留安全上下文、收据及自身标题、进度和 Notice。通用 W／V 查询仍用 worker，类型限制不变。
- status、project diagnostics／pause／resume 和 daemon request-stop 保留。daemon／Host 生命周期、日志、doctor、help 是用户本地启动诊断例外，不向 Valet 开放进程或文件能力。
- lushw 的 self／parent／children、question、skills 与 help 不变。开发 invocation 不因此获得任意管理目标或项目枚举权限。

## 仍有效的早期迁移规则

- worker list 默认 recent（活动项加有界历史尾部）；旧完整枚举须显式 `--view all`，终态历史用 `--view history`。游标绑定 view、筛选与实际续读来源，不混用。
- 旧 order 的 buffer → input draft create；append 的可靠发射 → draft create --append-to → show → submit；quiet → when-idle；defer 删除。旧 management 模式不再迁到另一个 CLI 创建入口，使用用户管理输入。
- 自动合并开关使用 worker automation enable／disable 的 auto-merge 挂载，不能一律改为 completion merge 而降低 accept 授权。所需方法变更不自动复制自定义权限。
- worker merge request 是本轮意图；条件 revision 只来自 merge show，不能与挂载 revision 混用。branch merge-all 仍逐项普通请求。
- Notice 使用 ask／notify／mark-read 明确区分决策、告知和已知；删除强制验收 CLI 不取消底层统一验收与用户安全确认。
- 旧 Task、say、lushc、项目式 lushw、原子 Hook 安装、持续归并写入口及业务快捷脚本均不恢复。

## 发布与失败处理

目录、parser、处理器、帮助、Prompt 与调用方必须同包更新。旧输入只本地拒绝或给迁移提示，不读取旧文件或执行替代命令；保留历史命令展示，不静默转换重放。

用户须在安全空闲点分别更新 daemon 与 Host。目录版本改变只使相关旧用法失效，不代表后台已更新，也不自动重启。waiting、pending_confirmation、unknown 不报告完成；响应未知时保留原收据，只读核对，不换身份重发。
