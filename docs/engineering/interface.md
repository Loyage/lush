# 界面与传输

## 信息架构

默认 Web 首页是 **Intent 工作台**：

1. Intent 总数与正在推进的目标；
2. 等待验收的 Review Candidate；
3. Intent 原文、Plan 状态、最新候选版本与 HTML 结果入口；
4. 真正需要用户处理的 Decision / Notice；
5. 运行中的 agent 与时间轴；
6. 折叠的 Git 交付诊断。

分支图继续提供完整 fork 谱系、ahead/behind、分歧、缺失、worktree、同步与归档动作，但它是高级 Git 诊断页，不是产品主线。任务树回答执行关系；Candidate 页面和报告回答“结果是不是用户想要的”。

页面内容可以通过“上下文引用”聚焦到下一条输入：任务、任务子树、分支图、交付项、Intent、Spec、Notice、Diff、结果、消息、执行步骤、事件和检验记录注册语义引用；其它页面文字可直接选中后引用。只有存在候选时才拦截 `contextmenu`。引用卡片在加入草稿前不受轮询影响，加入后随 Draft / Input 持久化；所有引用文字仍以 `textContent` 渲染。

## 执行过程

执行记录的设计目标与取舍见[Agent 执行过程理念](../design/agent-process.md)，当前读路径、完整检索、调用配对、JSON 渲染和专用解释 Agent 的权限见[执行记录阅读器](transcript-reader.md)。右键“介绍”只在执行步骤有选区时提供；它直接创建无开发分支的解释任务，不经过输入缓存，结果就地显示并留档。

## 文档

左栏「文档」只读取随代码发布的 `README.md` 与 `docs/**/*.md`。目录搜索第一次输入时才拉轻量全文索引，在浏览器做中英文子串与多词 AND 匹配；标题、小节、普通代码、正文与 Mermaid 采用不同权重，不引入搜索依赖。流程图以 Mermaid fence 保存在 Markdown 源文档中，浏览器只在文档实际含图时按需加载本地固定版本，并使用 `securityLevel: strict`；生成的 SVG 以允许 `blob:` 的隔离图片显示，主页面仍禁止 inline style；宽图保留可读尺寸并横向滚动，切换深浅主题时从源码重绘。Agent 输出里的 Mermaid 仍按普通代码显示。请求 id 只能命中扫描索引，不拼接任意文件路径。

## Web 与 daemon

Web 与 daemon 是两个独立进程。`bun run doctor --project PATH` 分别列出当前磁盘、该项目 daemon 和项目绑定 Web 的代码目录 / 版本 / 指纹；无项目的全局启动器用 `bun run web-status` 单独检查。`web-status` 同样把当前磁盘与 Web 进程身份分开，不拿 daemon 正常代替 Web 已更新。发现差异时两条命令只给出指向正确项目、端口和进程的 `update_hint(s)`，不会自动重启；修改 daemon 代码后由用户运行 `bun run daemon-restart --project PATH`，修改 `src/ui/web/` 后由用户运行对应作用域的 `bun run web-restart`（这会清空 Web 登录会话）。Web 默认只监听 `127.0.0.1`；项目公网模式使用 `.lush/web.json`，全局启动器公网模式使用用户配置目录的 `web.json` 并要求 `projects` 白名单；两者都使用 HttpOnly Cookie、Host / Origin / Sec-Fetch 校验，并应置于 HTTPS 反向代理后。Electron 临时 host 始终只监听回环。

## RPC 边界

- UI 不直接读 SQLite 或执行 Git；
- RPC registry 校验方法、参数与 USER_ONLY / AGENT_ONLY；
- agent token 只在当前 invocation 有效；
- `candidate.prepare/verify/accept/changes/reject` 都是 USER_ONLY；
- Candidate HTML 报告与核心 HTML 文档使用独立收紧的 CSP。

## 轮询与读模型

`/api/snapshot` 返回 status、timeline、Intent、Plan、Work tasks、Notice 与 Candidate。`graph.get` 会运行只读 Git，因此按指纹与最长陈旧时间单独刷新，不进入每个 1.5 秒快照。用户正在输入反馈、Decision 或编辑表单时，轮询不得冲掉内容和焦点。
