# 本地桌面受管界面偏好

本文规定 Electron 本地窗口的受管偏好存储与 IPC 边界。实现位于 `src/ui/desktop/connections.js`、`runtime.js`、`preload.cjs` 与 Web `prefs.js`；远端连接、通知与窗口安全见[桌面部署](../deployment/remote-desktop.md)。本地 Host 仍使用随机端口，不建立固定应用 origin。

## 存储与范围

`ConnectionStore.uiPreferences(project, change?)` 在 Electron userData 的独立 `ui-preferences.json` 中保存 version 1 / revision / shared / projects；原连接与通知记录不被新适配接管。目录按 `700` 创建，文件按 `600` 临时写入并 rename。没有项目库写入、任意文件接口或旧端口存储扫描 / 迁移。

- 本地共享：`theme`、`markdown`、`reduceMotion`、`polling`、`toastDuration`、`transcriptOrder`。
- 按稳定项目 ID 隔离：`sidebarSort`、`collapsed`、`filters`、`taskGraphStatuses`、`taskGraphMinimal`、`taskGraphCollapsed`。Worker 树折叠从原 `scopedKey` 直接存储接入 `PREF_DEFS`，原浏览器键继续兼容。
- 排除通知开关 / 分类、通知去重、未发送草稿 / 引用、项目 Agent 配置和 runtime 设置。
- 浏览器和远程桌面仍使用 origin 的 localStorage；不会读写本地 UI 文件或跨 Host 分享这些偏好。
- 本地启动器根页面仅可读写共享偏好；项目偏好只能从 `/p/<16位十六进制ID>/` 页面写入。

## 窄 IPC 与身份

只有本地工作窗口的 preload 提供：

- `readPreferences()`：读取当前页面的共享 / 当前项目快照。
- `writePreference(name, value)`：写一个白名单名称的序列化值。
- `resetPreferences()`：清共享与当前项目偏好，保留其它项目。
- `onPreferencesChanged(callback)`：订阅快照，返回解除监听函数；不暴露 IPC event。

主进程的 `lush:ui-preferences` 每次重新核验登记窗口、workspace 类型、未销毁、主 frame、所属 Host origin 与精确页面路径。项目 ID 仅从受信 frame 地址派生，渲染层不能指定项目、文件、Host 或任意存储键。登录页、预览、子 frame、连接页、远程窗口均被拒绝。远程回环 Host 即使与本地窗口同 origin，也没有本地能力。

`change` 仅允许 `{name,value}` 或 `{reset:true}`。名称、枚举、布尔字符串、集合及筛选字段有白名单校验，单值不超过 65,536 字符。接口不接受任意键值存储或 Node / 通用 IPC。

## 初始化、并发与失败

`boot()` 在重置 UI 状态、主题 / 排序与定时器初始化前等待 `initDesktopPreferences()`。恢复只读，不将默认值或快照写回；收到的通知偏好仍由既有通知适配初始化。

主进程同步执行按键 read-modify-write，成功后向仍受信的本地工作窗口广播各自的共享 / 当前项目快照。revision 单调递增；不同键不以整份旧快照互相覆盖，同键按主进程接收顺序后写生效。reset 是同一队列里的操作，之后的显式写入可以重新设置一个偏好；不会复活 reset 前的其它字段。此边界串行 Electron 自身写入，不承诺锁住外部编辑 userData 的程序。

前端保留同步 setter API，按调用顺序排队 IPC，并用待写选择覆盖迟到快照。旧 revision、其它项目或旧 bridge / origin 的结果不应用。广播更新本地缓存和偏好重画器；Worker 树在下一次正常刷新使用新折叠 / 筛选状态，不额外抢占用户阅读或执行 Agent。

缺文件视为首次使用；非 ENOENT 的读取 / JSON 失败不得当作空数据覆盖磁盘。写入失败保留原文件及当前会话选择，系统设置显示错误，不自动重试。重新显式修改可重试持久化；读取成功本身不宣称尚未写入的会话选择已经保存。

## 恢复默认与通知

`resetPrefs()` 清新增宿主共享与当前项目偏好，保留其他项目。既有通知重置语义不变：总开关回关闭、分类回默认，并通过原 `notificationSettings` / `noticePreferences` IPC 保存；新 UI 文件不保存或覆盖通知设置。浏览器 / 远端的 reset 与 origin 隔离保持原样，不删除草稿或通知历史。

## 验证边界

`test/desktop/{connections,runtime}.test.js` 覆盖实际临时文件、端口变化的模拟 Electron IPC、按键 / 重置顺序及拒绝未受信来源；`test/web/desktop-preferences.test.js` 覆盖初始化不回写、在途选择、旧快照、读写失败、通知重置与远端隔离。既有真实 Firefox 专项验证发货页面正常加载，不等于 Electron contextBridge 接线或真实 Electron 跨进程重启验收。

发布前仍需在实际 Electron 中启动两次、确认端口不同，验证主题 / 行为与项目视图保留、其它项目不被 reset 清除、通知仍按原契约恢复。不要用模拟窗口或浏览器 fixture 宣称该验收完成。

[返回工程索引](README.md) · [Web 模块地图](modules-web.md)
