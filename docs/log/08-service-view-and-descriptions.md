# 08 · 每个节点的三个查看接口与 description 重写

> 上一轮 Web UI 补上了 task 树。这一轮补的是「上级节点在派活前该问什么」：一个节点是什么（能力边界）、它现在还能建哪些子模板、在它上面开 task 会用哪段提示词。三件事此前只有一半能读到——`available_child_templates` 只活在 agent 的 Context 里，`description` 只出现在 `service inspect --json` 的快照里。同时把各模板的 `description` 从「名词短语」重写成一段陈述句，让能力边界本身可读。

- [x] **`service.view` 扩到五个 section**：`VIEW_SECTIONS` 从 `parent / children / prompt` 扩为 `description / parent / children / prompt / templates`，返回字段顺序固定为 `sid, description, parent, children, call_prompt, available_child_templates`。`description` 读**当前加载**的模板定义（模板文件已不在时回落创建时快照，两者都没有才是 `null`），因为它表达的是这个节点「是什么」，不是创建时冻结的权限；`templates` 则与 `child_templates` 一样以**创建时快照**为权限来源。`templates` 里每项带 `name / singleton / description / spawn_prompt`，已被占用的 singleton 不出现（「可用」必须等于「spawn 会成功」）。同步更新 `docs/reference/rpc.md` 的方法表与 section 表。

- [x] **一个函数、两条读路径**：把「这个 service 还能创建哪些模板」抽成 `core/queries.js` 的 `availableTemplates(templates, childTemplates, activeCount)`，`service.view` 的 `templates` section 与 `ContextBuilder` 里的 `available_child_templates` 都调它，agent 自己看到的下游模板与父节点用 `--with templates` 看到的是同一份数据，过滤规则不会再各自漂移。测试同时在 `test/core.test.js` 断言两者 `toEqual`，并覆盖 singleton 占用 / 释放时视图里出现与消失。

- [x] **CLI 渲染与帮助**：`formatView` 按 section 顺序渲染 `description`（一行）、`call_prompt`、`templates`（`名字 [· singleton] — description` + 缩进的 `spawn` 提示词，长文本按 `excerpt` 截断并提示 `--json`），`lush service inspect SID --with description,parent,children,prompt,templates` 可用；`src/cli/tree/service.js` 的 `inspect` cover 改成解释这三件事分别在回答什么，`src/agent/guide.js` 的 CLI 层说明补上「派活前用 `--with description,templates,prompt` 问一个节点」这一条（guide 与 CLI 声明树都在 fingerprint 里，改完要 `daemon restart`）。测试 `test/cli.test.js` 增加一条纯渲染用例。

- [x] **`description` 重写为一段陈述句**：五个随仓库发布的模板（lush-root / project-manager / project / dev-task / worktree-service）的 `description` 从「XX 节点：……」改写成第一人称陈述句，写清**做什么、边界在哪、什么交给谁**，并逐条与 `child_templates` 对齐（不宣称自己建不了的东西）。`docs/reference/templates.md` 的字段说明与示例、`README.md` 的命令示例同步；`src/template_loader.js` 的字段注释写明 `description` 是「给上级节点读的能力边界陈述」。

- [x] **Web UI 同步三个接口**：`UIClient.serviceView(sid, sections)` 具名工作流（默认 `['description','templates','prompt']`），HTTP adapter 新增 `GET /api/services/:sid/view` → `{ service }`；页面在「创建 Task」下方新增「Service 能力」面板，选中任一节点（含 stopped）即显示能力边界、可创建子模板（singleton 标记、`spawn_prompt` 可展开）与 call prompt，与左侧选中的 SID 对齐，service 消失时自动清空；轮询时只在内容变化时重渲染，不打扰展开状态。`docs/reference/ui.md` 同步视图与 HTTP 表，`test/web.test.js` 断言工作流的 method / params、三个 section 的内容、singleton 占用后的消失与未知 SID 的 404。

- [x] **验收**：`just test` 150 项通过（新增 3 条：`service.view` 的 section 语义、`formatView` 渲染、`/api/services/:sid/view` 的内容与 404）。另用真 daemon 手工验证：`service spawn 0 project-manager` 后，SID 0 的 `--with templates` 因 singleton 占用而显示 `templates (none)`，SID 1 显示 `project — 我是绑定某个已存在路径……` 加完整 `spawn` 提示词，`--json` 的字段顺序与 section 选择一致。
