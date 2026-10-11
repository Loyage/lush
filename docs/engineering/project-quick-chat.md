# 项目级快速对话与旧解释退役

W218／用户决定 D510 覆盖 W207 的全局历史与旧解释保留约定。

## 固定实施边界

- 删除旧解释页面、历史读写及模型解释调用实现。项目数据库打开并核验项目绑定后，事务删除 `introductions` 与 `explanation_followups` 表及旧结果／追问；secure_delete 不承诺擦除备份或之前的 WAL 快照；不删除 Worker、Input、执行记录、事件或引用快照，不改历史身份。
- 首次合法项目对话请求前，清除设备根 `quick-chat.sqlite` 中的旧全局对话及 Prompt 库，不导入、不分配项目；仅在私有文件／schema 校验、SQLite 排他锁与无活动 owner 条件满足时 secure_delete 清空内容。保留空 v2 退役文件与写阻断触发器，防止旧 Host 或先前已准入写者重建旧历史。不存在资源不创建，异常拒绝并明确报告，可由后续显式请求重试，不能删除任意路径／链接／活跃文件。
- 每项目持久历史、Prompt 库、右键注册与 C 高水位独立。模型选择、凭证与网络继续设备共用；固定首轮模型／Prompt／来源与无工具边界不变。
- 项目附属存储位于 `<project>/.lush/quick-chat/quick-chat.sqlite`，子目录私有，避免要求既有整个 `.lush` 根改变权限。
- Host 承接明确用户请求，不启动 daemon、不读引用目标、不创建 Worker。保留从项目输入／选区在新标签打开项目对话的现场保护。全局页面不提供对话或右键模型动作。

## 接口

项目身份只来自已登记 `/p/<id>/`（绑定 Host 允许无前缀项目 API）。项目 API 为 `/api/quick-chat/config`、`history`、`<id>`、`action`，方法／字段沿用 [原契约](quick-chat.md)；旧 `/api/host/quick-chat/*` 关闭。页 hash 沿用 `#quick-chat`、`#quick-chat-C<id>`、`#quick-chat-settings`，必须位于项目页；链接携带来源项目 base。模型设置复用现有设备设置接口，不扩大项目覆盖。

`QuickChatService(env=process.env, options={})` 新增必需 `options.home`，其值为项目私有 quick-chat 目录，不再以设备 home 保存历史；无 home 拒绝构造。其他方法不变。旧设备文件清理独立导出 `retireDeviceQuickChats(home)`（home 是设备私有 shared 根），必须幂等、安全拒绝活跃／不可信文件且保留诊断。

Host 项目身份解析新增 `projectHost.chatHome(id)`，只读核对登记、白名单与 canonical 路径并返回上述项目私有目录，不创建目录或连接后台；不接受用户路径。
