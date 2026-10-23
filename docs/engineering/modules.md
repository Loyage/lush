# 模块地图（并行开发的边界）

本页只定位长期职责、关键入口与契约。精确文件清单、导出签名和实现由源码与测试表达；内部搬家不要求同步地图，维护规则见[文档写作约定](../contributing/documentation.md#维护分级与时机)。按改动范围查相关章节，不沿索引递归通读。以下保留旧标题以兼容已有深链接，正文指向当前权威位置，不再保存临时派工或交付流水。

## 分区总览

| 职责 | 入口 | 深入位置 |
|---|---|---|
| 项目绑定 | `src/config.js` | [项目身份](identity-and-recovery.md) |
| Worker、消息、调度与生命周期 | `src/core/project.js` | [Runtime](modules-runtime.md)、[执行模型](execution-model.md) |
| Git 与 worktree | `src/core/workspaces.js` | [Git 边界](git-boundary.md)、[合并](merge.md) |
| SQLite 事实与读模型 | `src/persistence/store.js` | [Runtime](modules-runtime.md#持久化srcpersistencestorejs--srcpersistencestore) |
| Agent 调用与配置 | `src/agent/` | [Runtime](modules-runtime.md#agent-运行时接缝) |
| 项目通信与装配 | `src/rpc/`、`src/daemon/`、`src/ui/client.js` | [接口](modules-interfaces.md) |
| 整机登记、设备设置与来源转发 | `src/host/` | [Host 边界](host-boundary.md) |
| 设备模型资源管家执行与持久事实 | `src/device-valet/` | [设备管家](device-valet.md) |
| 浏览器与 CLI | `src/ui/web/`、`src/cli/main.js` | [Web](modules-web.md)、[CLI](modules-interfaces.md) |

## 三条规矩

1. 保持既有公共入口及兼容导出；公开白名单以[核心 API](core-api.md)和 `src/rpc/registry.js` 为准，不因内部模块存在而恢复旧入口。
2. Project／Workspaces／Store 的职责 mixin 由入口装配，方法仍用 `this`；装配必须查重名，不静默覆盖。
3. 跨 Worker 的文件范围和接口先在派工目标／消息中约定，不把一次派工分区永久写入文档。

## 设计方向与执行记录接缝

从[设计索引](../design/README.md)选择对应理念。执行记录与引用分别遵循[阅读器](transcript-reader.md)和[上下文引用](../design/references.md)；旧终端观看的替代入口见[移除说明](../native-viewer.md)。

## 当前公开面

[核心 API](core-api.md)规定公开能力与数据兼容；[接口参考](../reference/README.md)记录参数、权限和路由。SQLite 保留名称、事件和历史路径不得机械改名。创建时固定 Git 基线与本地 Pi 上下文 fork 见[分支优先架构](branch-first.md)。

## 用户工作台与设备唯一配置（W162／决定 #402）

[用户工作台契约](user-workspace.md)：技术配置设备唯一，Worker 显式参数保留；Host 不持有 Worker 权威事实、不跨项目调度。

## Agent 内置能力插件接缝（W217／D509）

[能力契约](agent-capabilities.md)：必需核心与四项可选能力、薄 Skill／按需指南及启停边界。

## 移除 Worker 并发槽（W210／D492）

[兼容边界](global-slots.md)：旧值保留但忽略；依赖、冻结、维护和真实退出屏障仍有效。

## 归并合并拟议接缝（W205／D482，尚未实现）

原拟议方向见[设计](../design/merge-convergence.md)；已实现范围以下节为准，不将愿景当现状。

## 分支归并首版接缝（W205／D482／D512）

[首版接口与限制](merge-convergence-implementation.md)、[Runtime 入口](merge-convergence-runtime.md)。协议 v3 默认关闭，旧 v1/v2 在途不转换；仅 runtime 工厂可创建 `integration` 身份。

## 工作台改造接缝

[工作台契约](workbench.md)：项目独立标签，关闭页面不停止后台，远程网络由用户管理。

## 总览面板与独立项目管理（W204）

[总览面板](dashboard-panel.md)：设备共享配置、来源读面、固定几何与管理页分离。

## 项目外观与标签页身份（W160）

[项目外观](workbench.md#项目外观w160)及[主题兼容](user-workspace.md#项目外观兼容决定-411)：设备主题与项目辨识色分离。

## 设备共享设置接缝

当前有效读取见[用户工作台](user-workspace.md#设备配置分区)；旧配置显式迁移与恢复见[设备设置](device-settings.md)。

## 快速对话退役（W235／D555）

[专用数据清理](project-quick-chat.md)是明确授权的例外，不删除正常 Worker／Input／执行记录或恢复旧调用。

## 项目出站网络接缝

[出站网络](outbound-network.md)：设备技术设置与项目执行隔离，不同于模型端点或 Host 入站代理。

## 输入输出与生命周期阅读接缝（W303／D666）

[完整历史协议](../reference/rpc/tasks.md#输入与结果完整历史读面)及[两个阅读模块](transcript-reader.md#输入输出与-worker-生命周期时间线w303d666)：内容与阶段分离，保留分批完整读取、真实来源、长正文与跨模块引用定位。

## 指令命名接缝

[指令兼容](core-api.md#指令更名与历史读取边界)：公开仅 order，历史 say 只读兼容，不迁移已有记录或路径。

## 验收即归档（W169／用户决定 #418）

[统一验收](worker-acceptance.md)：安全回收、部分失败与父级批量验收；父检查 child 默认不提前回收。

## Worker Hooks 实施接缝

[Hooks 契约](hooks.md)：Worker 附属挂载、受控动作、精确收据与未知副作用不重放。

### 快捷指令与 Hook（W151 / 决定 #363）

[快捷指令](shortcut-commands.md)：无指令预授权，自动化跟随最新定义、执行开始固定版本；仅 Hook 执行，无用户手动运行入口。

### 通用命令 Hook 与 main 推送示例（W133 / 决定 #319）

[命令 Hook](hooks.md#通用命令与-main-推送示例w133--用户决定-319)和[内置推送兼容](shortcut-commands.md#旧配置与-git-push)。

### 新指令结束后默认流程（W137 / 用户决定 #325）

[自动链](completion-hooks.md)：设备默认只在实际创建未来指令时复制，不提高 child 授权。

### 定时 Hooks（用户决定 #266）

[定时契约](hooks.md#定时-hook-增补用户决定-266)：显式时区、错过跳过、安全点准入。

### 时间信号与管理 Agent（用户决定 #270）

[管理契约](hook-signals-management.md)：无开发 Input／Git 的隔离身份，能力与授权不等同。

## daemon 自动选择 Hook 接缝（W118 / 决定 #267）

[自动选择](daemon-auto-select.md)：各 daemon 执行设备唯一策略，答复来源保留证据，不重放 invocation。

## Worker 自定义标题（W156）

[标题契约](core-api.md#worker-自定义标题)：用户只改展示元数据，不改变目标与运行身份。

## Worker 自动标题（W202／决定 D471）

[自动标题](core-api.md#agent-自动标题w202决定-d471)：有效自身 invocation 一次性写入，用户标题优先。

## Worker 用户编号接缝

[用户编号](../reference/api.md#用户编号与-cli-身份)：持久编号只用于展示／CLI lookup，内部整数仍用于权限、引用及路径。

## 用户追加输入编号（W198）

[追加编号](../reference/api.md#追加输入与-notice-编号)：明确用户追加按 Input 持久递增，历史不回填。

## 选择快照已停用（W138）

[停用边界](choice-snapshots.md)：不创建新快照／重选，已有附属资源只保留兼容与删除保护。

## Worker 统一运行设置（W147 / 决定 #357）

[Web 运行设置](web-agent-configuration.md)：显式读取完整 Profile，失败不回退默认覆盖；普通读面只返回安全摘要。

## 执行详情代码阅读器接缝

[代码阅读器](code-reader.md)：可信工作区与固定 Git 对象只读，不接受任意路径／ref。

## 用户确认的 Worker 彻底删除接缝

[删除预检与确认](../reference/rpc/maintenance.md#彻底删除-worker)：固定范围与 revision，失败保留现场，force 不绕过共享资源保护。

## 历史输入与输入缓冲区

[输入接口](input-history.md)、[条件发射](conditional-emission.md)与[用户操作](../input-history.md)。

## Worker 图与固定输入规则

[Worker 图](task-graph.md)：真实父子关系、有界读取及可信规则快照，不将布局边冒充交付目标。

### Worker 树资源消耗读面

[资源口径](task-graph.md#累计资源消耗)：自身／完整子树统计，未知与范围明确。

### Worker 图合并关系读面接缝

[合并摘要](task-graph.md#合并关系展示排序与动效)：SQL 全量直接子计数、有界关联项，不由局部卡片推算。

## 冻结期间的 Worker 追加输入（W153 / 决定 #376）

[消息准入](../reference/rpc/tasks.md#追加消息的准入与失败处理)：立即持久保存、解冻后投递；暂存不混入修复，不阻止固定交付但阻止验收。

## Worker 规划历史（W149 / 用户决定 #360）

[规划历史](../reference/rpc/tasks.md#规划历史)：实际投递用户新输入才重置计划，归档计时冻结。

## 可选进度汇报

[能力契约](agent-capabilities.md)：关闭隐藏读面、不删除已有记录。

## 进展漏报的计时接缝

[Agent 环境](../reference/agent-environment.md)记录漏报、未知耗时与 runtime 等待投影。

## Agent 管理与状态查询接缝

[双模式配置](agent-configuration-v2.md)、[账号连接](agent-connections.md)、[软件诊断与旧存档](agent-usage.md)；界面与运行资源分离。

## Worker 详情版本迭代

[版本图](version-history.md)：真实 Git parents 与固定成功交付证据，不按标题或可变 HEAD 猜归属。

## 页面导航与全类型 Worker 列表

[Web 入口](modules-web.md)：页面身份、取消／迟到保护；列表平铺，树独立表达层级，检索范围明确。

## 分支诊断增量读面

[分支诊断](../reference/rpc/branches.md#branch-节点的-diagnostics)：已提交净变化与未提交状态分开，失败不冒充零。

## Worker 详情的父分支提交距离（W142）

[实时提交距离](../reference/rpc/tasks.md#多轮交付验收与父同步)：固定本地 ref 对，不用创建基线替代当前事实。

## 已合并 Worker 的多轮交付接缝

[持续迭代](task-iteration.md)与[统一验收](worker-acceptance.md)：合并非终点，验收后安全回收。

## 展示功能已移除

[退休能力与磁盘边界](core-api.md#移除与磁盘边界)；历史 detached worktree 的回收保护见[清理](cleanup.md)。

## 父 Worker 自有交付队列（version 2，queue_protocol=1）

[合并协议](merge.md#当前-version-2父-worker-自有交付队列)：请求／尝试分开，固定源与父基线、串行 Squash、精确落地凭据恢复。

## 新式 Worker 的自动合并（version 2）

[自动合并开关](../reference/rpc/tasks.md#自动合并开关与本轮合并)与[合并协议](merge.md)。

### 历史 v2 重挂兼容与中断恢复

[历史兼容](merge.md#历史兼容)：仅凭明确预约／审计恢复原父，不复用旧尝试或重放未知 apply。

## 交付锁与合并编排（历史 version 1）

[历史交付锁](merge.md#历史-version-1交付锁与冻结)：固定提交批准，不适用于当前自动队列。

## Notice 提醒与历史接缝

[Notice 参考](../reference/rpc/notices.md)：分类、分页、已读和客户端提醒。

### 用户创建 Worker 的告知型生命周期 hook

[生命周期告知](../reference/rpc/notices.md#生命周期告知)：来源 Event 幂等，已读不答复、不唤醒 Worker。

## 当前项目维护暂停（W173／用户决定 #422）

[维护暂停](project-maintenance.md)：持久准入门与原父子等待恢复，只作用当前项目。

## 中断完成信号接缝（W216／D508）

[中断完成](interrupt-completion.md)：固定批次、真实退出与动态空闲证据分开。

## 可撤销中断与非阻塞继续接缝

[暂停与恢复](../reference/rpc/notices.md#非阻塞暂停与恢复)：requested 不冒称已停止，resuming 不重叠调用。

## Token 效率接缝

[Token 效率](token-efficiency.md)：有界因果上下文、唤醒聚合和可选软预算；[目标 ref 归因](target-branch-guard.md)不等于 OS 沙箱。

## 分章地图

[Runtime 与持久化](modules-runtime.md) · [Web 前端](modules-web.md) · [CLI、RPC 与测试](modules-interfaces.md)。只读受影响章节，内部细节直接定位源码／测试。

---

[下一篇：Runtime 与持久化 →](modules-runtime.md)
