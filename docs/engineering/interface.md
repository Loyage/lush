# 界面与传输

## 信息架构

Web 默认首页是**项目概览**，按 Worker 组织：

1. Worker 指标与正在推进的目标；
2. 运行中的 agent 与等待原因；
3. 真正需要用户处理的 Notice；
4. 折叠的运行时信息（Git 诊断在 Worker 图）。

左栏把页面分成「工作」（Worker 图、项目概览、待我处理、Worker列表）与「其他」（设置、帮助文档）。旧「分支与合并」视图已删除，旧 `#graph` 回概览；Worker 卡片提供精简 Git 父分支、当前检出、ahead/behind 和关系诊断，不改变 Worker 父子连线。完整 fork 谱系与未绑定本地分支绑定仅保留 CLI / RPC。Worker图与Worker详情回答执行关系、进度与交付状态，并复用同一 `branch.archive` 就地归档 Worker 的分支（归档＝收掉整棵子树，保留 Worker 记录）；概览按 Worker 展示。旧 Intent / Plan、草稿、效果展示、解释、托管模式与自动合并的操作入口不再显示。

页面内容可以通过“上下文引用”聚焦到下一条输入：Worker、Worker子树、Notice、Diff、结果、消息、执行步骤与事件注册语义引用；其它页面文字可直接选中后引用。引用卡片在加入输入前不受轮询影响，加入后随 Input 持久化；有稳定目标的卡片标签可点击导航到来源并一次性闪烁定位，找不到时给顶部提示，普通 text 引用与移除按钮不触发定位；所有引用文字仍以 `textContent` 渲染。Worker 图只保留通用文字/选区引用；历史分支引用不改写快照，点击时明确提示其 Web 定位入口已移除。

## 执行过程

执行记录的设计目标与取舍见[Agent 执行过程理念](../design/agent-process.md)，当前读路径、完整检索、调用配对、JSON 渲染与权限见[执行记录阅读器](transcript-reader.md)。

## 文档

左栏「文档」只读取随代码发布的 `README.md` 与 `docs/**/*.md`。目录搜索第一次输入时才拉轻量全文索引，在浏览器做中英文子串与多词 AND 匹配；标题、小节、普通代码、正文与 Mermaid 采用不同权重，不引入搜索依赖。流程图以 Mermaid fence 保存在 Markdown 源文档中，浏览器只在文档实际含图时按需加载本地固定版本，并使用 `securityLevel: strict`；生成的 SVG 以允许 `blob:` 的隔离图片显示，主页面仍禁止 inline style；宽图保留可读尺寸并横向滚动，切换深浅主题时从源码重绘。Agent 输出里的 Mermaid 仍按普通代码显示。请求 id 只能命中扫描索引，不拼接任意文件路径。

## Web 与 daemon

Web 与 daemon 是两个独立进程。`bun run doctor --project PATH` 分别列出当前磁盘、该项目 daemon 和项目绑定 Web 的代码目录 / 版本 / 指纹；无项目的全局启动器用 `bun run host-status` 单独检查。`host-status` 同样把当前磁盘与 Web 进程身份分开，不拿 daemon 正常代替 Web 已更新。发现差异时两条命令只给出指向正确项目、端口和进程的 `update_hint(s)`，不会自动重启；修改 daemon 代码后由用户运行 `bun run daemon-restart --project PATH`，修改 `src/ui/web/` 后由用户运行对应作用域的 `bun run host-restart`（这会清空 Web 登录会话）。Web 默认只监听 `127.0.0.1`；项目公网模式使用 `.lush/web.json`，全局启动器公网模式使用用户配置目录的 `web.json` 并要求 `projects` 白名单；两者都使用 HttpOnly Cookie、Host / Origin / Sec-Fetch 校验，并应置于 HTTPS 反向代理后。Electron 临时 host 始终只监听回环。

## RPC 边界

- UI 不直接读 SQLite 或执行 Git；
- RPC registry 校验方法、参数与 USER_ONLY / AGENT_ONLY；
- agent token 只在当前 invocation 有效；
- Web 的 `POST /api/action` 另有自己的动作白名单，且不接受 agent token；
- 报告与核心 HTML 文档使用独立收紧的 CSP。

## 轮询与读模型

`/api/overview` 返回有界的 Worker 核心读模型，`/api/snapshot` 保留兼容同源；Worker 图的 `/api/worker-graph` 会运行只读 Git，因此快照变且距上次 ≥3s 或距上次 ≥10s 时才单飞重拉；概览不再请求分支图。用户正在输入、编辑表单或决策时，轮询不得冲掉内容和焦点。
