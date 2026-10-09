# 设备共享设置与项目迁移契约

本契约落实 W116 / 用户待决 #261，范围内优先于旧文档“所有设置与模型凭证仅属于项目”的描述。理念见[设备共享设置](../design/device-settings.md)。每项目一个 daemon 与项目事实隔离不变。

## 存储与兼容

`Config.deviceHome` = `path.join(launcherStateDir(config.env), 'shared')`；不修改 `Config.home` / `LUSH_HOME`。设备目录不属于某项目的 Git/worktree。无项目 Host 使用独立设置服务，不构造 Project、Store 或虚假项目 daemon。

共享文件沿用现有私有格式：`settings.json`、`agent.json`、`network.json`、`quick-explanation.json`、`agent/*.env`、`credentials/agent-connections.json`、`pi/`。目录 0700、秘密文件 0600；安全读取、无 symlink/foreign owner、有限大小、原子替换与跨进程锁。已有 `.lush` 文件继续按项目覆盖读取，不因打开/重启自动迁移。

为保持既有 RPC/CLI 兼容，现有设置接口未给 `scope` 时仍选 `project`；新 Web 设置管理默认显式传 `device`。`project` 读取为有效项目配置（本地覆盖 → 共享 → 既有环境/内置默认）；`device` 忽略本地覆盖，读写设备层。`device` 保存不能因当前项目有覆盖而落错层。Worker 运行总读取有效项目配置。

只有真正的 `Config`/Host 配置具有 `deviceHome`。已有测试与内部最小 `{home,...}` 配置可保持纯项目模式；显式请求 device 但不存在 deviceHome 应拒绝，不猜用户真实目录。新增测试全部使用临时 `LUSH_GLOBAL_CONFIG`，不读取或写入真实用户共享目录。

安全读模型附加（source 为所选读面的来源，不冒充所有项目实际配置；project_override 描述项目读面的覆盖）：

```js
configuration_scope: {
  selected: 'device' | 'project',
  source: 'device' | 'project' | 'default' | 'mixed',
  device_home: string | null,
  project_home: string | null,
  project_override: boolean
}
```

运行设置每键另附 `source:'device'|'project'|'default'`，保持 `value/default/overridden` 兼容字段；project 默认值为共享有效值，清除单键时回到共享。Agent、网络、快捷解释是整个文档覆盖（UI 解释这一点）；通用/角色环境变量按设备 common、设备 role、项目 common、项目 role、Worker env 顺序叠加，不允许覆盖 LUSH_*。

## 共享配置基础接口（基础分区）

新增 `src/core/device-config.js`：

- `normalizeConfigurationScope(scope='project')` 严格只允许 device/project。
- `configurationHome(config,scope='project')` 选择写入根；device 缺 deviceHome 拒绝。
- `configurationScope(config,scope,source,projectOverride=false)` 返回上述 metadata（不是 envelope）。
- `scopedConfiguration(config,scope)` 给只处理单一存储根的模块返回配置副本：保留项目身份与 env，home 指向所选根、deviceHome 置空避免递归继承；绝不改进程环境或原对象。
- `documentConfigurationScope(config,scope,file)` 做文档来源投影；`validateConfigurationDirectory(config,scope,required=false)` 只读私有根校验，缺失不创建；`ensureConfigurationDirectory(config,scope)` 创建前检查祖先别名，再拒绝不安全既存根。
- `acquireConfigurationLock(config,scope,name='settings-write')` 支持 settings-write/migration/packages，返回 assert/release；`withConfigurationWriteLock(config,scope,fn)` 持锁到 Promise 结算，不抢未知残留锁。

扩展现有方法，新增 scope 只作为最后一个参数，默认 project：

- `RuntimeSettings.get(scope)` / `save(patch,scope)`；Config `configureRuntime(patch,scope)` 保存指定层后同步本项目有效值。新增 `Config.refreshRuntimeSettings()` 重新读取有效值、不写盘，在后续准入/状态读取或安全文件变化通知路径生效，不取消当前调用、不构造全局总预算。
- `AgentSettings.get(scope)` / `save(value,scope)` / `clearOverride()`；`resolve(role)` 仍取有效项目配置。
- `readNetworkConfiguration(config,scope)` / `saveNetworkConfiguration(config,value,scope)` / `clearNetworkOverride(config)`；networkSnapshot 总取项目有效配置。
- `readAgentEnvironment(config,target,scope)` / `saveAgentEnvironment(config,target,values,scope)`；增加 `clearAgentEnvironmentOverride(config,target)`；运行时按上述多层叠加。
- `QuickExplanationSettings.read(scope)` / `preview(patch,scope)` / `save(profile,scope)` / `clearOverride()`；纯 profile 的 read/preview/save 不混入 metadata（避免现有字段白名单拒绝），metadata 由 Project/Host 投影。
- Pi 基础配置/安装库使用 `scopedConfiguration` 明确选根。运行保留现有本地 pi 设置和显式旧资源路径的兼容；新共享安装通过 device scope 操作，调用快照和会话仍留项目 home。跨进程安装/更新需协调，不能让多个 daemon 同时修改共享库。
- 提供 `clearRuntimeOverrides(patch?)` 或沿用各键 null 清除，不删除未知历史键。

基础分区不修改 Project mixin / RPC / Host / Web assets / CLI / test/helpers.js；将实际 helper 与元数据差异写入报告，父分区做集成。

## 模型来源（连接与迁移分区）

`ConnectionManager(config,options)` 默认读取有效项目来源：共享连接 + 本地旧连接（同 ID 本地优先保留旧项目行为）。不按 label/provider 合并。只有可见安全投影增加存储作用域，不向凭证原始文档写读面字段。

新增 `ConnectionManager.forScope(scope='project')` 返回有生命周期管理的 scoped manager，device 仅看共享来源，project 为有效并集；每个连接的变更/登录/刷新/目录缓存按它实际存储根落盘与上锁。默认既有项目 mutation 保持本地来源语义；device 管理不被本地同 ID 阴影误导。管理器 stop 同时停止派生 scoped manager。

共享 OAuth refresh 必须使用同一实际目录的 refresh lock，多个项目同时调用不能各复制 refresh token 或各自刷新；runtime 仍仅复制 access token。本地旧凭证未迁移前可用，但不能自动把它复制进设备层。设备连接删除后不能让迁移源的旧文件重新显现。

`AgentConnectionsService` 可增加 `forScope(scope)` 返回共享同一项目历史的 scoped service 或为公开管理方法增加最后 scope 参数；最终实现报告需明确选择，父负责 Project 转发。项目 root service 在后续 config/source 读取时核对有效采样策略，变化才更新调度；scoped device editor 不建重复定时器。device 保存不因损坏的项目覆盖而假报失败，prune 必须用历史拥有项目的有效 retention，无法证明时保留历史。历史/实际消费者仍限当前项目，绝不汇总别项目 Worker；共享模型目录与最新余额/额度缓存跨项目复用，但观测历史仍不搬库。设备共享余额直接从实际设备根读取，不回退某项目的数据库缓存；无项目 Host 使用同一私有持久缓存，重启不丢已刷新值、不伪造项目历史。缓存字段与安全边界见[连接器契约](agent-connections.md#设备共享最新余额缓存w152)。

## 显式迁移（连接与迁移分区）

新增 `src/core/device-migration.js`：

- `previewDeviceMigration(config)` 同步或 Promise 返回 `{version:1,revision,can_migrate,blockers:string[],items:[{kind,source,destination,action}],warnings:string[],already_migrated:boolean}`。
- `migrateDeviceSettings(config,{revision,confirm:true})` 同步或 Promise 返回 `{version:1,migrated,already_migrated,backup,items,warnings}`。

预检只查看当前 config.project/home，不能取请求路径/任意文件名。不返回设置值/凭证原文/秘密摘要。revision 固定文件内容及相关身份，执行重新核对；新增、变更、同 ID 不同凭证、配置文件冲突阻止静默覆盖。device 已有相同内容可复用；连接可追加不同 ID，不按名字猜同账号。

范围：已有普通设置文档、env 文件、托管连接。安装资源路径导入前归一为原项目可信绝对路径，不能把 `./skill` 变为另一个项目的目录；旧安装库保留以保证旧 profile/Worker 路径可用，备份说明这一点，新安装管理面向共享库。项目 `.lush-agent` / AGENTS.md、会话、DB、历史、外部 Pi/Codex 认证不迁移。

先预检所有来源与目标、私有备份和持久步骤记录，再发布共享设置，最后把源项目对应活跃设置退役为备份；不得先删来源或以部分完成冒充迁移成功。跨进程 shared config writer/凭证锁与迁移协调，变更迟到不能覆盖已确认迁移。中断保留可续读记录，重试必须重新预检并按真实事实恢复；不自动重放未知副作用。记录为项目 `device-migration/current.json` → `<uuid>/journal.json`，备份在 `<uuid>/files/`。revision 是进程私有 HMAC，重启后需新预检，不返回秘密摘要。发布共享凭证前写源 `credentials/device-migration-active.json`；普通凭证读/刷新 fail-closed，仅可信迁移 reader 可恢复读取，全部源退役与目标复核后才删 guard。已知同 accountId + refresh、不同 UUID 的 OAuth 双活会阻止预检，不按名字推断账号。

父 Project wrapper 拒绝源项目活动 invocation/模型/登录/资源安装/写操作/Git 操作期间迁移，通过用户专属准入；daemon 保持项目 home 绑定。开发测试不实际迁移用户项目。

## RPC、Host 与 CLI（父分区）

现有 `system.configure`、`agent.config/configure`、`agent.environment(.configure)`、`agent.network(.configure)`、`quick_explain.config/configure`、模型来源管理与包管理接口允许可选 `scope`。system runtime 读面新增 `system.settings {scope?}`，避免为设备编辑读取全项目快照。

新 USER_ONLY：

- `settings.clear_override {kind,target?}`，kind 为 `agent|network|quick_explain|environment`，environment 必须给 target；runtime 按键 null 清除。
- `settings.migration.preview {}`。
- `settings.migration.apply {revision,confirm}`。

Host 提供 `GET /api/host/settings/<suffix>`，suffix 复用设置读路由：`runtime`、`agent/config`、`agent/models`、`agent/resources`、`agent/status`、`agent/environment?target=`、`agent/network`、`agent/connections`、`agent/connections/models?id=`、`agent/packages`、`quick-explain/config`。无项目仅展示共享配置，必须 device scope。

`POST /api/host/settings/action {method,params}` 只白名单共享设置 mutation，与现有方法名一致；强制 params.scope=device，不接受 Project/Worker/历史/模型调用/迁移/清除项目覆盖方法，也不接受路径/token。复用登录、Origin、JSON/no-store 校验，停止 Host 取消在途登录/网络/包安装。不为接口启动 daemon。

项目 `GET /api/settings/runtime?scope=` → system.settings，`GET /api/settings/migration` → migration.preview；设置现有读面用 `?scope=device|project`；POST 走既有 `/api/action`。

CLI 设置命令支持 `--scope device|project`（默认 project 保持兼容）；增加 `lush config migrate` 预检、`lush config migrate --confirm --revision REV` 执行；支持 JSON、安全错误和用户权限。

## Web（前端分区）

设置页面作用域默认 device；“设备共享 / 本项目覆盖”显式切换，不把 Worker 编辑或历史接口切到 device。新增 `settings-api.js` 封装设置读取/动作：有项目可走既有项目 route+scope，无项目走上述 host/settings endpoints。不要全局改变 api.js action 的 Worker 语义。

Agent 配置、系统运行/网络、快捷解释配置都提供作用域与继承/覆盖说明、清除项目覆盖入口。模型来源 device 默认总览；project 视图显示有效连接及旧来源作用域，避免误导共享修改。设置切换保留草稿，迟到响应不得污染另一作用域。

无项目时这些导航可用；项目服务控制、旧余额/快捷解释历史、实际消费者保留项目限制。无项目快捷解释配置能保存，但本轮不增加无项目模型调用/历史服务（明确说明需项目保存历史）。项目主题/配色按 W160 [工作台接缝](workbench.md)保存在项目中、跨浏览器共用；无项目工作台主题及其余界面偏好保留客户端作用域。

系统设置新增“迁移当前项目设置到设备共享”预检与显式确认，展示 items/blockers/warnings，携带 revision/confirm。迁移不调用 Agent，破坏性清除覆盖与迁移按钮有 data-help，禁用外层 help-host。

前端分区仅 assets 与对应 DOM 单测，不改 backend/RPC/CLI/设计文档或父接口测试；无需实际 backend即可用 mock 契约测试。新增模块按 basename 自动服务。

## 验证

`test/helpers.js` 的 fixture 默认各有独立、位于项目根之外的临时 `LUSH_GLOBAL_CONFIG`，close 清理自己的设备根；多项目共享测试必须显式传同一临时根，由测试拥有者清理。裸 `env()` 的 HOME/XDG 仍是测试用目录，不用真实用户主目录。组合测试不得把预期共享与偶然串扰混为一谈。

自动覆盖在 `device-settings.test.js`、`agent/connections-shared.test.js`、`project/agent-connections-shared.test.js`、`device-migration.test.js`、`project/device-migration.test.js`，实际两个临时 daemon 通过独立进程/RPC 复用配置见 `integration/device-settings.test.js`；接口/权限在 `device-settings-interfaces.test.js` / `web/device-settings-api.test.js`；DOM mock 与真实 HTTP/RPC/临时存储在 `web/dom-device-settings*.test.js`。`bun run check:device-settings` 是 Firefox 临时 fixture 检查，`check:agent-layout` 另保留已有来源/诊断/档案布局交互验证；都不启动用户 daemon 或读取真实来源。

临时设备根 + 两个临时项目 + mock 认证/模型/包进程；覆盖继承、覆盖、清除、保存作用域、另一个 daemon 后续读取、来源 ID 与 OAuth 并发锁、迁移冲突/非法权限/TOCTOU/重复执行/部分失败、安全 API、无项目管理不启动 daemon、UI 草稿与迟到响应、历史隔离和 Worker 显式覆盖。全量测试必须实际完整运行，日志留路径；真实登录/模型/第三方包与浏览器验收限制如实说明。

## W116 组合交付验证

三个分区已由 runtime 合入父分支（`13cf47a`、`10ae8fe`、`4be67e0`），父检查并确认三个 child。父补充 Host 保存时最新进度默认与 mixed 来源投影、来源后续读取更新采样、设备操作不能误用项目 retention 或因坏覆盖假报失败，以及本地模型资源/显式目录刷新运输回归。旧 Firefox fixture 补项目 bootstrap/scope，时间说明按现有「上次刷新」与缓存帮助核验，信息布局核验允许宽屏右侧动作或窄屏下方动作，保留等高/裁切/焦点/草稿断言。

最终实际完整运行 `bun run test --timeout 30000`：**2063 pass / 0 fail**，277 文件；`check:agent-layout` 与 `check:device-settings` 均通过 Firefox light/dark × 1440/900/390，含无项目配置、作用域草稿及旧历史边界。文档检查通过（既有体量警告）。日志在 `/tmp/lush-w231-logs/delivery-full.log`、`final-agent-layout.log`、`final-device-settings-firefox.log`、`final-docs.log`，截图在同目录两个 screenshots 子目录。

另有真实双 daemon（临时项目、mock 后端、无模型调用）专项通过，验证跨进程读取、新共享值、逐键覆盖/清除、Agent/env/network/快捷解释默认与项目 home 独立，日志 `two-daemons-settings.log`。

最终首轮全量的一个等待进度测试超时保留在 `final-full.log`：其受控 mock 在 workspace 准备与 shutdown 竞态下晚订阅 abort；补已取消信号处理，并等待 child 实际进入 mock，不放宽业务断言或超时阈值，完整重跑通过。未调用真实模型/OAuth、未真实安装第三方包、未迁移用户配置或重启用户服务；真实部署后仍由用户安全空闲时更新两端并预检/确认迁移。
