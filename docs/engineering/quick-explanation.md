# 快捷解释实施契约

用户决定 #203：已选项目的所有 Lush 页面（含文档、设置、执行详情）选区右键提供「解释」；按项目保存配置与历史。首版仅复用现有 OpenAI 兼容 API Key 模型来源，不支持 Codex OAuth、不创建 Worker、不调用开发 Agent、不读取额外项目内容。全局未选项目不发起调用。

## 接口

新用户专属 RPC（不恢复旧 `intro.*` / `explanation.*`）：

- `quick_explain.config {}` → `{version:1,connection_id:string|null,model:string,prompt:string,default_prompt:string,ready:boolean,reason:string|null}`。model 是物理模型 ID，不带 provider 前缀。ready 仅代表本地配置就绪，不代表联网可用。
- `quick_explain.configure {config:{connection_id?,model?,prompt?}}` → 同一配置读面。部分更新，null 清除来源/模型，prompt null 或空恢复默认。校验来源存在、enabled、API Key、受支持 Chat Completions 协议及模型范围；不联网、不更改 Agent 默认。
- `quick_explain.start {quote,location?}` → 一条解释记录。quote 1–8192 字，location 复用引用 location 白名单；只发送所选文字和页面位置，不读关联文件或步骤。
- `quick_explain.get {id}` → `{id,status,quote,location,result,error,model,source:{connection_id,label,provider,endpoint}|null,prompt:string|null,created_at,updated_at}`。status running/completed/failed；历史来源不可用时显示未知。不返回密钥、原始请求/响应或私人网络设置。
- `quick_explain.list {before?,limit?}` → `{explanations:[记录摘要],has_more,next}`。项目全历史，默认 30、最多 50，按 id 降序；摘要 quote 最多 180 字、不返回结果正文和完整 prompt，用户点击 get 阅读。历史旧 introduction 可以只读展示，来源/prompt 未知，不改写旧记录。
- `quick_explain.delete {id}` → `{removed:id}`。永久删除一条解释历史记录（含同页列出的旧式 introduction 行）；正在进行的调用拒绝删除，模型来源配置、Prompt 与其他记录不变。删除是用户确认后的破坏性动作，不随配置或重启自动发生。

HTTP GET `/api/quick-explain/config`、`/api/quick-explain/history?before=&limit=`、`/api/quick-explain/<id>`；configure/start/delete 统一 POST `/api/action`。全部沿用项目路由前缀、认证、Origin、no-store 和用户权限。不得恢复旧公开解释 Agent 入口。

## 后台与安全

新增 `src/core/quick-explanation.js` 项目私有配置（0600 原子写）；新增 `src/core/project/quick-explanation.js` 方法对象，Project 方法 `quickExplanationConfig()`、`configureQuickExplanation(config)`、`startQuickExplanation(quote,location)`、`quickExplanation(id)`、`quickExplanations(before,limit)`。

复用 `introductions` 附属历史表，加可空 `source_snapshot` JSON 列记录安全来源和实际 prompt；旧行保持不变。网络、配置、模型、Prompt、凭证在发起时固定，运行用 `introRunning` 统一追踪，受限并发（最多 4）、超时 120 秒、响应有界、无工具。停止 abort 并等待请求；重启仅把新式遗留 running 记录标失败，不重放、不改旧式行。使用项目网络快照，不自动回退直连或切换账号。拒绝重定向，错误只显示安全固定分类/HTTP 状态，不保存上游响应正文、密钥或任意异常字符串。原文和页面位置作为不可信资料，固定只读安全规则不随自定义 Prompt 被覆盖。

## 前端

独立 `#quick-explain` 页面，导航「快捷解释」，集中配置和项目历史；来源选择只展示适用 API Key 来源，模型来自其限制/本地目录，也允许合法物理 ID 手输（服务端验证），来源改变不偷偷挑模型。Prompt 默认可编辑/恢复。保存不发模型请求；刷新历史不调用模型。

任意有效选区菜单「解释」使用 `agent-call` + `modelHelp()`，旁侧展示结果，保留原位置；全文执行 dialog 中挂到 dialog 内，关闭只停止客户端轮询、不取消后台。Esc/boot 清理，迟到响应和轮询不覆盖新页面/选区；未就绪给配置页入口。菜单的引用行为保持不变，无选区不自动把整块文字送模型。超长选区不得静默截断发起，应明确提示。

历史页每条记录提供确认后删除；`running` 记录禁用删除并按[按钮帮助](../design/ui-guidance.md)用 `.help-host` 承载说明，删除请求不取消后台调用。

## 并行职责

- 后台 child：新增配置、Project 方法与装配/base/lifecycle、Store schema/introductions、后台单元/项目测试；不改 RPC/server/assets/docs。
- 前端 child：assets（菜单、面板、新页面、导航装配）、index.html、专用样式、DOM 测试和 dom-world mock；不改后端/RPC/server/docs。
- 父：本文、模块/参考/使用文档、RPC registry/handlers、Host server 白名单和转发、接口测试、组合与全量测试。

## 验证

配置与后台回归见 `test/quick-explanation-settings.test.js`、`test/project/quick-explanation.test.js`；HTTP→RPC→真实后台（模型传输 mock）、权限/登录/Origin/多项目/远端转发见 `test/web/quick-explanation-api.test.js`；菜单/配置/历史/dialog/选区/迟到响应与 Esc 清理见 `test/web/dom-quick-explanation.test.js`。

交付验证：`bun run test --timeout 30000` 为 1995 pass、1 skip、0 fail（默认测试排除 packaging；真实回环 SSH/Electron 安装测试按既有条件跳过）。首次默认 5 秒阈值在并行负载下出现 4 个超时，其中 1 项为新配置测试；这四文件单独重跑 28 pass，增大单测超时后全量通过，未修改测试断言。完整日志 `/tmp/lush-w201-logs/full-test.log`、`retry-timeouts.log`、`full-test-30s.log`。文档检查通过，仅既有长度警告；未请求真实 API、未验证真实浏览器/Electron UI，未重启用户服务。

交付 8232 / 尝试 8235 源侧修复：共同祖先 `05ba9a5`，保留原源 `1c0bd2a` 并合入固定父 `89ea5b3`。双方无整体改名、公共接口或架构迁移；保留父侧消息准入说明及 diff 折叠/全量行数汇总，新解释 API 不调用 Worker 消息或依赖 diff 汇总字段。新增实际 renderDiff 展开后文件选区解释的组合 DOM 回归。相关 66 项通过，最终全量 `bun run test --timeout 30000` 为 2001 pass、1 skip、0 fail；文档检查通过。完整日志 `/tmp/lush-w201-logs/repair-focused.log`、`repair-full.log`、`repair-docs.log`；真实模型/浏览器和已跳过的桌面回环验证限制不变。
