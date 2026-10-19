# 设备共享设置与项目迁移契约

本章负责旧项目配置的显式迁移、私有锁、凭证交接与失败恢复。当前技术配置设备唯一、不支持项目覆盖，有效读取与 Host 接口以[用户工作台契约](user-workspace.md#设备配置分区)为准。W116 的旧继承行为仅用于理解历史，不恢复为活跃设置。

## 存储与兼容

`Config.deviceHome` 来自 `launcherStateDir(config.env)/shared`，不改变项目 `Config.home`／`LUSH_HOME`、Store、Git 或 Worker 身份。无项目 Host 使用独立设置服务，不构造伪 Project／daemon。

共享文件沿用私有格式：settings.json、agent.json、network.json、agent/*.env、credentials/agent-connections.json、pi/。目录 0700、秘密文件 0600；拒绝链接／外来所有者／不安全权限／超限内容，私有原子替换与跨进程锁。打开／重启不自动迁移，旧项目技术文件不参与活跃配置。

真实 Config 只选设备技术根，默认 scope=device，显式 project 拒绝。低层独立 `{home,...}` 测试配置及 readLocal／configurationHome 仅供最小 fixture 与迁移，不构成生产旁路；deviceHome 缺失时不能猜真实用户目录。历史 `configuration_scope` 附属读字段可保留，不能用它授权切换凭证根。旧并发值兼容见[移除并发槽](global-slots.md)。

## 共享配置基础接口（基础分区）

`src/core/device-config.js` 负责作用域、私有目录与锁；配置服务的精确 helper 签名以源码为准。scoped 副本保留项目身份，不改原对象或进程环境；只读缺失不创建根，创建前核查祖先别名，未知残留锁不偷取。

settings-write／migration／packages 锁协调多个 daemon 的共享写入，持锁覆盖实际文件操作但不跨 Agent 调用。热更新只改变后续准入／调用，不取消当前快照。共享包库安装／更新串行，历史显式资源路径与项目会话仍按原归属保留。

## 模型来源（连接与迁移分区）

有效连接仅来自设备；旧项目来源只供显式迁移，不按 label／provider 猜同账号或自动合并。登录、目录和 OAuth refresh 锁落实际凭证根，派生 manager／service 随主生命周期关闭，不能每个项目复制 refresh token 各自刷新；invocation 只复制 access。

项目历史／实际消费者不搬库、不汇总其他项目 Worker。有效采样策略变动才更新调度，device 编辑不创建重复定时器；历史 prune 必须用拥有项目的有效 retention，无法证明时保留。最新设备余额缓存跨项目复用，不回退某项目数据库或伪造无项目历史；缓存协议见[连接器](agent-connections.md#设备共享最新余额缓存w152)。删除设备连接不能让旧迁移源重新显现。

## 显式迁移（连接与迁移分区）

`src/core/device-migration.js` 提供 `previewDeviceMigration(config)` 与 `migrateDeviceSettings(config,{revision,confirm:true})`。预检返回 version、revision、can_migrate、blockers、items（kind/source/destination/action）、warnings、already_migrated；执行返回 migrated／already_migrated／backup／items／warnings。不返回设置值、凭证原文或秘密摘要。

- 来源固定当前 config.project/home，不接受任意请求路径／文件名。revision 固定内容及身份，执行重新核对；新增、变更、同 ID 不同凭证或目标冲突阻止覆盖。设备相同内容可复用，不同连接 ID 可追加，不按名称猜账号。
- 范围为普通设置、env、托管连接及旧私有 common／受支持角色 Markdown。Markdown 只显式导入设备同名补充：私有权限、身份、有界大小和 revision 校验，相同复用／不同阻止；预检说明会影响所有项目，不显示原文。成功后源 Markdown 保留但不再活跃，不能把此保留规则用于 JSON／env／凭证。
- 安装相对路径先归一为原项目可信绝对路径，不能把 ./skill 重解释到另一项目；旧安装库保留以兼容已有 Worker 路径。项目 AGENTS.md／`.lush-agent/`、DB、会话、历史及外部 Pi／Codex 认证不迁移。
- 先全量预检、私有备份和持久步骤，再发布共享文件，最后退役对应源设置；不得先删来源或把部分完成报成功。锁协调共享 writer／凭证更新，迟到变更不能覆盖已确认迁移。
- 中断保留 journal，重新预检后按精确事实续办，不重放未知副作用。项目 `device-migration/current.json` 指向 `<uuid>/journal.json`，备份 `<uuid>/files/`；revision 为进程私有 HMAC，重启需新预检。
- 共享凭证发布前写源 `credentials/device-migration-active.json`，普通读／刷新 fail-closed，仅可信迁移 reader 可恢复；所有源退役和目标复核后才删 guard。已知相同 accountId＋refresh、不同 UUID 的 OAuth 双活阻止预检。
- Project wrapper 必须拒绝源项目活动 invocation／模型／登录／安装／写操作／Git 期间迁移；用户专属，不在开发测试中迁移真实项目。

## RPC、Host 与 CLI（父分区）

用户专属 `settings.migration.preview {}`／`settings.migration.apply {revision,confirm:true}`，CLI `config migration preview` 只预检，独立写入口 `config migration apply --confirm --revision REV` 才修改；两者拒绝混合用法。来源固定已登记项目，沿项目身份路由转发，不把 Host 变为任意路径／RPC 代理。

技术设置的当前 `/api/host/settings/**` 白名单与默认 device 见[用户工作台](user-workspace.md#host-http-与父分区)及[Web 路由](../reference/web-routes.md#设备设置与旧配置迁移)。旧 settings.clear_override 不再清除活跃项目覆盖，Agent 无配置权限；Worker 显式 profile 不因技术 scope 收敛而丢失。

## Web（前端分区）

设置只编辑设备值，无项目也可用；`settings-api.js` 固定根 Host API，不改变 Worker action 语义。旧源通过已登记项目选择、预检与 revision 确认迁移；展示完整条目／阻塞／警告，明确 Markdown 留存不活跃与 JSON／env／凭证退役，失败／迟到响应保护草稿。

迁移不调用 Agent，帮助与禁用说明遵循[UI 指引](../design/ui-guidance.md)。项目消费者／历史仍限项目；主题与项目辨识色的分离见[外观兼容](user-workspace.md#项目外观兼容决定-411)。

## 验证

临时设备根＋两个临时项目＋mock 认证／模型／安装进程；覆盖设备唯一有效值、另一个 daemon 后续读取、Worker 显式覆盖、来源 ID／OAuth 并发锁、迁移冲突／权限／TOCTOU／幂等／部分失败、API 用户边界、无项目不启动后台、草稿／迟到响应和历史隔离。

`test/integration/device-settings.test.js` 保留设备设置主流程；迁移、接口及完整页面组合不再逐项回归，覆盖取舍见[贡献指南](../contributing/README.md#覆盖取舍)。`bun run check:device-settings`／`check:agent-layout` 使用 Firefox 临时 fixture，不证明真实 OAuth／模型／第三方包可用，不操作用户服务。fixture 的 HOME／XDG／LUSH_GLOBAL_CONFIG 必须临时隔离；共享双项目测试显式拥有同一临时根并负责退出清理。

## W116 组合交付验证

保留历史深链接；旧继承／覆盖测试与交付结果见 Worker／Git 记录，不代表当前活跃能力或当前代码树的通过证据。
