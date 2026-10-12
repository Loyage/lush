# 快速对话退役与专用数据清理

本章规定快速对话整体删除后的兼容与清理边界。W235／用户决定 D555 明确要求同时安全清除专用历史、Prompt 库和模型配置，不保留旧功能入口。

## 功能与兼容

- 删除快速对话页面、输入框对话模式、选区右键模型动作、Prompt 管理、直连模型服务和专用模型配置。
- 全部 `/api/quick-chat/**`、`/api/host/quick-chat/**`、`/api/quick-explain/**`（含 Host 设置路径与项目前缀）关闭；`quick_explain.*`、`intro.*`、`explanation.*` 不保留公开调用、历史或配置别名。
- 正常输入的新建／追加模式、文本引用与来源定位、Agent 模型来源／凭证仍保留。
- 不删除 Worker、Input、消息、事件、执行记录、Git 或引用快照，不改写历史编号；历史无工具 Worker 的只读恢复兼容继续保留。

## 清理范围与安全

仅清理所属项目与设备的专用资源：项目 `<project>/.lush/quick-chat/quick-chat.sqlite`、设备私有 shared 根的旧 `quick-chat.sqlite`、项目及设备的 `quick-explanation.json`。不扫描其他项目，不把旧 Prompt 或对话导入任何新存储，也不再把专用配置纳入设备设置迁移。

实现入口为 `src/core/retired-chat.js`。daemon 在 Store 核验项目绑定后、开放 RPC 前执行；Host 在单项目启动或首次核验已登记项目绑定时执行。全局列表不枚举清理，失败不会由旧页轮询自动重放，修复后须显式启动／选择项目重试。开发测试使用临时项目，不直接操作用户当前存储。资源不存在时不为退役创建历史库。

清理必须核验目录／文件归属与私有权限，拒绝符号链接、硬链接、外来所有者、损坏或未知 schema；SQLite 清理必须持锁且确认无活跃调用 owner，不能抢未知锁或强删仍在使用的文件。存在 WAL／SHM 或孤立 journal 时拒绝，只有已知 DELETE-mode 历史可退役。异常保留清晰诊断与可恢复现场，不把未确认清理报告为成功；各资源独立提交，失败前已完成的清理不回滚。SQLite 保留空 v2 库和写阻断触发器，JSON 保留 `{version:2,retired:'quick-chat'}` 标记，防止旧 Host／设置写者重建内容。

旧设备迁移的完成 journal 保持只读兼容；在途 journal 若含旧专用配置，须先退役源／目标，再显式继续其他配置，不重新发布旧备份。历史备份不在本次清理范围内。

项目数据库打开并核验绑定后，继续事务删除已退役的 `introductions`、`explanation_followups` 表及旧结果／追问。`secure_delete` 不承诺擦除备份、外部副本或此前的 WAL 快照；专用数据清理不扩大为其他历史的删除授权。
