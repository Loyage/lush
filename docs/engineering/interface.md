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

## 文档

左栏「文档」读取随代码发布的 `README.md`、`docs/**/*.md` 与受控的 standalone HTML。核心架构文档 `docs/core-architecture.html` 通过 sandbox iframe 与严格 CSP 展示；请求 id 只能命中扫描索引，不拼接任意文件路径。

## Web 与 daemon

Web 与 daemon 是两个独立进程。修改 daemon 代码后运行 `bun run daemon-restart`；修改 `src/ui/web/` 后运行 `bun run web-restart`。Web 默认只监听 `127.0.0.1`；公网模式使用 `.lush/web.json`、HttpOnly Cookie、Host / Origin / Sec-Fetch 校验，并应置于 HTTPS 反向代理后。

## RPC 边界

- UI 不直接读 SQLite 或执行 Git；
- RPC registry 校验方法、参数与 USER_ONLY / AGENT_ONLY；
- agent token 只在当前 invocation 有效；
- `candidate.prepare/verify/accept/changes/reject` 都是 USER_ONLY；
- Candidate HTML 报告与核心 HTML 文档使用独立收紧的 CSP。

## 轮询与读模型

`/api/snapshot` 返回 status、timeline、Intent、Plan、Work tasks、Notice 与 Candidate。`graph.get` 会运行只读 Git，因此按指纹与最长陈旧时间单独刷新，不进入每个 1.5 秒快照。用户正在输入反馈、Decision 或编辑表单时，轮询不得冲掉内容和焦点。
