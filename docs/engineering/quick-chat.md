# 快速对话实施契约

W207／用户决定 D486、D487：快捷解释升级为快速对话。新对话设备级统一保存，在无项目或项目离线时仍可使用；独立全局页面展示完整多轮对话。从项目输入框／选区右键入口在新标签打开，原项目现场保持。每段对话展示持久 C 编号（C1、C2），删除不复用。所有 Prompt 共用现有设备快捷解释直连模型配置。旧项目解释与追问历史保留、不迁移、不改写。

## 边界

这是附属纯文本历史，不是 Worker／Input 或新开发实体。Host 承接明确的用户直连请求，不调度项目、启动 daemon、执行工具或访问引用目标。用户消息和 Prompt 可以要求解释、整理、摘要、记录等纯文本工作；引用快照是不可信资料，不作为行为指令。固定规则限制工具／文件访问、状态修改和伪造执行事实，但不再限制模型只能解释。

设备私有根沿用 `launcherStateDir(env)/shared`，不改 LUSH_HOME。文件必须拒绝符号链接、硬链接、外来所有者、不安全权限和损坏数据，错误不暴露秘密／原始响应。配置读缺省不创建资源，Prompt 写入有跨进程锁与 revision；会话编号和轮次准入有持久事务、并发与重启安全。停止中不接新请求，关闭 abort 并等待自己在途调用。未知副作用不自动重放，不能把其他仍活跃 Host 的请求恢复成失败。

## Host HTTP（仅根路由）

- `GET /api/host/quick-chat/config` → `{version:1,revision,prompts:[{id,name,prompt,context_menu,builtin}],model:{connection_id,model,ready,reason,default_prompt}}`。model 复用设备配置，所有历史不因设置变化改写。默认 builtin id 为 `explain`、name 为「快速解释」、context_menu 为 true；默认正文复用设备已有解释 Prompt，避免丢弃用户配置。允许编辑／关闭 builtin，不删除 builtin；自定义 Prompt 可仅保存（context_menu false）。
- `GET /api/host/quick-chat/history?before=&limit=` → `{conversations:[摘要],has_more,next}`；默认 30、最多 50，id 降序。摘要 `{id,number,status,content,prompt_name,model,created_at,updated_at,turn_count}`，content 有界预览且裁剪用省略号明示。
- `GET /api/host/quick-chat/<id>` → `{id,number,status,content,references,prompt:{id,name,prompt},source:{connection_id,label,provider,endpoint},model,turns:[{id,content,result,status,error,truncated,created_at,updated_at}],created_at,updated_at}`。每次请求是一个 turn（包含首次）；status running/completed/failed 指最新轮，失败不删除既有成功轮。旧失败允许明确新消息继续，但不自动重试。source 无凭证。
- `POST /api/host/quick-chat/action` 接受 `{method,params}`；method 是下列短名，不是任意 RPC。白名单、登录、Origin、JSON、no-store 与未知字段拒绝必须完整；项目前缀和 Agent token 拒绝。
  - `prompt_save {prompt:{id?,name,prompt,context_menu},expected_revision}`：id 缺省生成稳定 UUID；name 1–80 字单行，prompt 1–16384 字，context_menu boolean；最多 50 个 Prompt；返回完整 config。
  - `prompt_remove {id,expected_revision}`：不能删除 explain；返回完整 config。修改／删除不影响历史快照。
  - `start {prompt_id,content,references?}`：content 0–8192 字，最多 12 个引用，每个 quote 最多8192字、整体48KiB；content 和 references 至少一项非空。返回完整新对话（异步调用 status running）。引用采用现有快照字段 version/kind/target/label/quote/location/captured_at，可附 `project_id`（16位已捕获身份字符串，仅出处，不启动／解析项目）。只发送内容、引用所见快照和位置，不解析 target、不读文件。
  - `send {id,content}`：content 1–8192字，对同段对话追加新轮，运行中拒绝；返回完整对话。来源、模型与 Prompt 沿用首次快照，配置变更不能静默切换。
  - `delete {id}`：删除历史及所有轮次，运行中拒绝，不取消调用；编号高水位保留。

模型传输复用现有受支持 Chat Completions API Key 来源／网络设置（不支持 OAuth）。来源／凭证／网络在每次调用发起时固定，原来源删除／变更明确失败。最多 4 个同时调用、120 秒超时、响应256KiB上限、禁止重定向、安全错误分类。多轮请求有128KiB上下文预算，丢弃最早轮时本轮 `truncated:true` 明示；首次用户内容和引用保留，超预算不能悄悄截断。

## 页面与输入模式

根 `#quick-chat` 为历史／新对话入口，`#quick-chat-C<id>` 为对话详情，`#quick-chat-settings` 为 Prompt 和共用模型配置。旧 `#quick-explain` 引导新配置，旧项目 `#quick-explain-history` 保留明确标注的旧解释历史。

项目主输入框增加 `chat` 模式，明显区别 create／append，选择 Prompt 后明确点击发送；选择本身不调用模型。可以仅引用而无正文；发送后在新标签打开对应 C 对话页。成功仅消费确认发送的正文和引用，在途编辑／切换目标保留；失败保留内容。模型调用按钮使用 `agent-call`＋`modelHelp()`，非 Agent。模式可显式返回新建，导航退出临时模式，不能误走 draft.add/order.submit/worker.message。全局对话页可直接新建／继续，显示统一 C 编号、Prompt／来源快照、引用、轮次和上下文截断。

全局任意有效选区右键，按配置显示「快速解释」及 context_menu 为 true 的自定义 Prompt；保存但未注册的 Prompt 不显示。无项目／项目离线也可调用。无选区不自动发送整块文字；超长选区明确拒绝而非静默截断。右键动作直接调用并新标签打开独立对话页；仅引用操作不调用模型。弹窗阻止须提供可见对话链接，不诱导重发。

## 实施分区与导出

- 后台 child：新增 `src/host/quick-chat.js` 导出 `QuickChatService(env=process.env,options={})`，方法 `config()`、`list({before=null,limit=30}={})`、`get(id)`、`action(method,params)`、`close()`；新增私有存储模块位于 `src/core/quick-chat*.js`，按需要复用已有设备设置／连接／网络模块但不修改公共配置格式。`options.settingsService` 可注入已有 DeviceSettingsService，否则自行构造并负责关闭；模型测试通过 `options.fetch/timeoutMs` 注入。只改这些新模块及自己的专项测试，不改 server.js、user-services.js、assets 或旧 project 路径。
- 前端 child：assets 与对应 DOM／浏览器专项，包含导航、Prompt 配置管理、独立详情、右键与 composer chat 模式；模型配置复用现有 Host settings API。HTTP 契约按上文，父负责真实路由。只改 assets／前端测试，不改后台／server／本契约。测试 DOM mock 可扩展，不降低现有断言。
- W207 父：server.js 的根路由、lazy 服务和关闭接缝；HTTP安全与跨层集成测试；文档和地图；检查子成果后最终全量 `bun run test` 与 `bun run docs:check`。child 默认仅专项／受影响回归，影响广泛或无法判断时说明原因并扩大验证，不在各层重复全量。

实际完成状态与验证证据在交付报告记录，本契约不代表已经实现。
