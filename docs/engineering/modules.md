# 模块地图（并行开发的边界）

这份文件是**拆分的契约**：`src/` 与 `test/` 里每个文件的职责与导出签名。目标只有一个——
让两个并行 worker 尽量去改不同的文件。粒度细到这个程度不是审美，是为了让「谁动哪个文件」可预测。

改名、搬家、换签名都先改这里，再改代码。

## 三条规矩

1. **入口路径不变。** `src/core/project.js`、`src/core/workspaces.js`、`src/persistence/store.js`、
   `src/rpc/protocol.js`、`src/ui/web/assets/app.js`、`src/cli/main.js` 仍是各自的入口，必须继续
   导出与今天完全相同的名字（`Project` / `Workspaces` / `Store` / `Dispatcher` / `main` / `HELP`…），
   所以 `src/index.js`、`bin/`、`test/helpers.js` 与现有测试都不必跟着改。实现细节住进同名目录。
2. **组装方式是 mixin，不是继承链。** 每个职责模块导出**一个方法对象**，方法体里照旧用 `this`；
   入口文件把它们的原型属性合并进来，并在合并时查重名（重名＝拆分出错，立刻抛错，不静默覆盖）。
   这样搬家只是剪切粘贴，方法体一行都不用改，`this.store` / `this.running` 照旧。
3. **一个分区只改自己分区里的文件。** 分区见下；跨分区要改的东西，先在 `docs/engineering/modules.md`
   里加一条接口，而不是直接伸手。

## 公共面（拆不动，也不许变）

- RPC 方法名与参数表（`registry.js` 的 `PARAMS`）、`USER_ONLY` / `AGENT_ONLY` 权限集合。兼容读面保留 `system.status` / `task.list` / `task.history`，有界 Web 读面增量增加 `system.summary` / `task.activity` / `task.page` / `task.history_page`。Agent 进度使用 `progress.plan(steps)` / `progress.complete(step)`，只允许当前 invocation 给自己的 task 写入。Agent 配置使用 `agent.config`（只读）、`agent.models(agent)`（按需读取本机 CLI 模型目录）、`agent.resources`（按需发现已安装 Pi 扩展与 Skills）与用户专属的 `agent.configure`（整份写入）。Agent 环境文件通过用户专属的 `agent.environment(target)` / `agent.environment.configure(target,values)` 读写，target 是 `common` 或七类角色；由于返回值可能含密钥，连读取也拒绝 agent token。运行设置读写使用用户专属的 `system.configure`（参数 `settings`，部分更新，`null` 清除该键回退环境默认）。
- CLI 命令与 `lush help` 的语义。新增 `lush config [show]` 打印并发额度的生效值 / 环境默认值 / 是否被覆盖与设置文件路径，`lush config set concurrency|control-concurrency N` 写回，`lush config reset [concurrency|control-concurrency|all]` 清除覆盖；`--json` 输出与 `system.status.settings` 同一份结构化读模型。两端都是用户专属，agent 调用被拒。命令面用连字符（`control-concurrency`），设置文件与 RPC 里是下划线（`control_concurrency`）。
- SQLite schema、表名、列名与 `meta.task_id_high` / `meta.input_id_high` / `meta.overview_revision` 的行为。`overview_revision` 由读模型相关表的触发器单调推进，技术聚合表 `overview_task_counts` 由 task 触发器维护精确 layer/status 计数，首页用两者做 O(1) 失效与统计（它不是业务实体）；新核心表为 `agent_runs` / `artifacts` / `review_candidates`；`tasks.review_candidate_id` 与附属元数据列 `tasks.progress_plan` 通过 `store/base.js` 的 `ADDED_COLUMNS` 渐进补齐。`progress_plan` 保存 versioned JSON，不引入新的业务实体；读模型统一投影为 `progress`。`artifacts.payload` 继续使用同一 JSON 文本列：新 `run.result` 是 version 2 envelope，分开记录 invocation 完成与 `pass` / `fail` / `partial` / `unverified` 验收结论；`pass` 必须没有 `failures` / `unverified`，但可以保留 `baseline_failures` / `residual_risks`；旧 payload 不重写，读取时缺失或自相矛盾的证据明确投影为 `unknown`。其它兼容列仍只加不改，不重写已有行。
- `src/index.js` 的导出、`bin/*` 的行为。
- Web 路由与 asset 路径：`server.js` 只按 basename 服务 `assets/` 下的 `.js` / `.css`，
  所以**新增前端模块不需要改 server.js**。无 `--project` 的启动器另有 `/api/launcher` 与
  `/api/launcher/select`：前者返回当前/上次项目，后者只接受现存目录的绝对路径、自动启动对应 daemon，
  并把最后项目写入用户配置目录；带 `--project` 的单项目 Web 会拒绝切换。读取路由里其余显式例外是 `/api/graph`、检验报告
  `/api/task/<id>/report`，以及「文档」视图的 `/api/docs`、`/api/docs/search-index` 与 `/api/docs/<id>`——数据源是
  `src/ui/web/docs.js`，只读随代码发布的 `docs/**/*.md` 与 `README.md`，与当前项目目录无关，
  只按扫出来的 id 查表命中；另保留兼容 `/api/snapshot`，首页轮询走带 revision 的 `/api/overview`，历史任务与事件分别走 `/api/tasks`、`/api/task/<id>/history-page`，完整 Agent 配置只由设置页请求 `/api/agent/config`；搜索索引按需返回、在浏览器匹配，Mermaid 流程图由浏览器按需加载本地固定版本渲染。认证边界也在 `server.js`：无 `.lush/web.json` 时只监听本机；
  有配置时监听公网，并用 `/login`、`/logout` 与 HttpOnly 会话 Cookie 保护全部页面、资源和 API。
- 全局项目启动状态在 `src/ui/launcher.js`：只存 `launcher.json` 的 `last_project`，不是业务事实也不是
  `LUSH_HOME`；macOS / Linux / Windows 分别遵循各自用户配置目录。Electron 桌面壳使用独立随机端口复用同一
  Web server 与 assets，关闭时只停自己的临时 Web host，不停项目 daemon，因此可与后台 Web 同时打开。
- Web 进程的生命周期在 `src/ui/web/control.js`：`webListenerPids(port)` 认出端口上的监听者，
  `webOwners(config, port)` 把端口与 `.lush/web.state.json`（后台 Web 自己写的 pid / 端口 / 代码指纹）
  合起来给出「谁在听、命令行是不是 Lush Web」，`stopStaleWeb(port)` 只停命令行确实是 Lush Web 的进程
  （`bin/lush-web` / `ops.js web` / `ui/web/server.js`，先 SIGTERM、超时才 SIGKILL），`busyPortHint(port)`
  在端口被别人占着时把命令行原样报出来。`bun run web` 就是「后台 spawn `bin/lush-web` + 等它占住端口」
  （`waitForWebState`），`web-restart` 就是「停下旧的 + 后台起一个新的」；Web 进程不会跟着代码换版本，
  这是换版的正路。`doctor` / `web-status` 只读这些状态，把当前磁盘、daemon、Web 的代码目录 / 版本 / 指纹
  分开报告；不一致只产生带项目与端口的更新提示，不触发重启。
- 环境变量与 agent capability 语义（`LUSH_PROJECT` / `LUSH_HOME` / `LUSH_TASK_ID` / `LUSH_AGENT_TOKEN`）。`LUSH_TASK_ID` 是与当前 agent 直接绑定的 task，不是任务树上的 `tasks.parent_id`；进度 RPC 仍以一次性 token 解析出的 actor 为准，不信任环境变量中的 ID。项目级 Agent 配置固定写在 `<project>/.lush/agent.json`：默认配置 + planner / coordinator / worker / research / verifier / merger / showcase 七类角色覆盖；写入原子替换，运行中的 invocation 不打断，下一次调用动态读取并生效。每份 profile 分 `default_prompt` 与 `append_prompt`：前者非空时替换该角色的内置组合（UI 明确警告能力、权限与交付协议可能失效），后者追加在共享/本机文件补充之后；旧 `prompt` 字段按 `append_prompt` 兼容读取。内置规则由 `PROMPT_PARTS` 按角色组合；再叠加可提交的 `.lush-agent/{common,ROLE}.md` 与本机 `.lush/agent/{common,ROLE}.md`。Agent 子进程环境在 daemon 环境之上热加载 `.lush/agent/agent.env` 和角色 env，`LUSH_*` 不可覆盖；Web 键值编辑器把文件规范化为 owner-only 的 `NAME="value"`，空表删除对应文件。profile 另存 `extensions` / `skills` 路径列表，只给 Pi invocation 以显式参数加载，Codex 保留配置但不使用。
- 项目级运行设置固定写在 `<home>/settings.json`（version 1，权限 `600`），唯一读写入口是 `src/core/settings.js` 的 `RuntimeSettings`；目前只有 `concurrency`（1..64）与 `control_concurrency`（1..16），`null` / 缺键表示回退环境默认。`LUSH_CONCURRENCY` / `LUSH_CONTROL_CONCURRENCY` 只提供默认值；daemon 启动时读出生效值，运行时写盘后同步内存并重新准入，不需要重启。
- `src/core/genealogy.js`（分支谱系的纯逻辑：`buildForest` / `pruneHidden` / `parentOf` / `childrenOf` / `ancestorsOf` /
  `descendantsOf` / `rootOf` / `chainOf`）与 `types.js` / `naming.js` 一样是共享纯模块：不碰 git、不写盘、
  不渲染，只被 `project/branches.js` 与 `test/branch-tree.test.js` 使用。`naming.js` 导出 `slugify` /
  `taskSlug` / `taskLabel` 与 `inputLabel(id)`（输入聚合分支的 `input-<id>` 名）。

## 效果展示增量接口

- 新增专用 `showcase` agent（第七类可配置角色），只由用户 `showcase.start(branch,baseline?)` 创建独立根 Task，不参与代码交付或 Candidate 状态机。`tasks.showcase` 为不可变 version 1 JSON 元数据（分支、固定 commit、对比基线），只加可空列，不重写历史。
- 任意本地分支均可展示；已登记分支默认使用 `created_from_commit`，其余必须指定本地 baseline 分支并固定 merge-base。在独立 detached worktree 执行，不切换/提交用户分支。重试沿用冻结提交。
- RPC `showcase.list(branch?)` 读最近 50 条；`showcase.start` / `showcase.stop(id)` 为用户专属；`showcase.preview(command,path?)` 为当前 showcase invocation 专属，以 argv 数组启动预览。CLI `showcase start BRANCH [--baseline BRANCH]` / `list [--branch BRANCH]` / `stop ID` / `preview --file JSON`。
- 展示 HTML 写在 `<home>/showcase/<task>/report.html`，复用认证后的 `/api/task/<id>/report`，使用 sandbox CSP。`task.inspect.showcase` 给出冻结上下文、报告与托管预览状态。完成不等于检验通过、不批准合并；现有 verifier / Candidate API 与历史报告兼容保留，Web 的手动验收创建入口改为展示。
- 预览由 daemon 托管：运行于展示 worktree，动态分配本机端口，argv 中 `{port}` 替换，环境 `HOST=127.0.0.1` / `PORT`，不传 agent token；agent 须显式配置应用监听本机。完成后保留，失败/取消/用户停止/daemon 退出时停止进程组。守护子进程观察父进程 stdin 关闭以处理 daemon 崩溃；重启不自动重放。运行预览期间禁止回收 worktree。入口仅面向同机浏览器，不反向代理不可信应用。

## 分区总览

| 分区 | 入口 | 细粒度模块 | 独立可并行 |
|---|---|---|---|
| 任务编排 | `src/core/project.js` | `src/core/project/`（含 Plan 编译、Integration、Candidate） | ✅ |
| Git 边界 | `src/core/workspaces.js` | `src/core/workspaces/`（5 个） | ✅ |
| 持久化 | `src/persistence/store.js` | `src/persistence/store/`（含分支、run、candidate 与引用元数据） | ✅ |
| 前端 | `src/ui/web/assets/app.js` | `src/ui/web/assets/`（见下表） | ✅ |
| CLI | `src/cli/main.js` | `src/cli/`（含 Agent 配置命令） | ✅ |
| RPC | `src/rpc/protocol.js` | `src/rpc/`（7 个） | ✅ |
| 测试 | `test/*.test.js` | `test/<分区>/*.test.js` | 依赖上面六个落定后 |

前六个分区 **互不共享文件**，可以同时开工。测试分区要等它们落地，否则测的是半成品。

问卷决策沿用 Notice，不新增表或实体：`src/core/questionnaire.js` 负责严格校验与答案规范化，`Project.notice` 保存 `kind='questionnaire'`，调度器通过 `questionPending` / `parkForQuestion` 暂停并恢复 invocation；Web 端由 `render-questionnaire.js` 渲染，预览路由使用 `notice-preview.js` 的独立 CSP 清洗 HTML。

## 分章地图

模块清单仍以本页为唯一入口，细表拆成三篇短章：

1. [Runtime 与持久化](modules-runtime.md)：Agent provider、Project、Workspaces 与 Store。
2. [Web 前端](modules-web.md)：浏览器模块、渲染职责与导出。
3. [CLI、RPC 与测试](modules-interfaces.md)：命令、协议与测试分区。

跨分区改动先从这里确认边界，再进入对应细表；新增或移动文件时必须同步更新所属章节。

---

[下一篇：Runtime 与持久化 →](modules-runtime.md)
