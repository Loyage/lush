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

- RPC 方法名与参数表（`registry.js` 的 `PARAMS`）、`USER_ONLY` / `AGENT_ONLY` 权限集合。Agent 进度使用 `progress.plan(steps)` / `progress.complete(step)`，只允许当前 invocation 给自己的 task 写入。Agent 配置使用 `agent.config`（只读）、`agent.models(agent)`（按需读取本机 CLI 模型目录）、`agent.resources`（按需发现已安装 Pi 扩展与 Skills）与用户专属的 `agent.configure`（整份写入）。
- CLI 命令与 `lush help` 的语义。
- SQLite schema、表名、列名与 `meta.task_id_high` / `meta.input_id_high` 的行为。新核心表为 `agent_runs` / `artifacts` / `review_candidates`；`tasks.review_candidate_id` 与附属元数据列 `tasks.progress_plan` 通过 `store/base.js` 的 `ADDED_COLUMNS` 渐进补齐。`progress_plan` 保存 versioned JSON，不引入新的业务实体；读模型统一投影为 `progress`。其它兼容列仍只加不改，不重写已有行。
- `src/index.js` 的导出、`bin/*` 的行为。
- Web 路由与 asset 路径：`server.js` 只按 basename 服务 `assets/` 下的 `.js` / `.css`，
  所以**新增前端模块不需要改 server.js**。读取路由里只有几个显式登记的例外：`/api/graph`、检验报告
  `/api/task/<id>/report`，以及「文档」视图的 `/api/docs`、`/api/docs/search-index` 与 `/api/docs/<id>`——数据源是
  `src/ui/web/docs.js`，只读随代码发布的 `docs/**/*.md` 与 `README.md`，与当前项目目录无关，
  只按扫出来的 id 查表命中；搜索索引按需返回、在浏览器匹配，Mermaid 流程图由浏览器按需加载本地固定版本渲染。认证边界也在 `server.js`：无 `.lush/web.json` 时只监听本机；
  有配置时监听公网，并用 `/login`、`/logout` 与 HttpOnly 会话 Cookie 保护全部页面、资源和 API。
- Web 进程的生命周期在 `src/ui/web/control.js`：`webListenerPids(port)` 认出端口上的监听者，
  `webOwners(config, port)` 把端口与 `.lush/web.state.json`（后台 Web 自己写的 pid / 端口 / 代码指纹）
  合起来给出「谁在听、命令行是不是 Lush Web」，`stopStaleWeb(port)` 只停命令行确实是 Lush Web 的进程
  （`bin/lush-web` / `ops.js web` / `ui/web/server.js`，先 SIGTERM、超时才 SIGKILL），`busyPortHint(port)`
  在端口被别人占着时把命令行原样报出来。`bun run web` 就是「后台 spawn `bin/lush-web` + 等它占住端口」
  （`waitForWebState`），`web-restart` 就是「停下旧的 + 后台起一个新的」；Web 进程不会跟着代码换版本，
  这是换版的正路。
- 环境变量与 agent capability 语义（`LUSH_PROJECT` / `LUSH_HOME` / `LUSH_TASK_ID` / `LUSH_AGENT_TOKEN`）。`LUSH_TASK_ID` 是与当前 agent 直接绑定的 task，不是任务树上的 `tasks.parent_id`；进度 RPC 仍以一次性 token 解析出的 actor 为准，不信任环境变量中的 ID。项目级 Agent 配置固定写在 `<project>/.lush/agent.json`：默认配置 + planner / coordinator / worker / research / verifier / merger 六类角色覆盖；写入原子替换，运行中的 invocation 不打断，下一次调用动态读取并生效。每份 profile 分 `default_prompt` 与 `append_prompt`：前者非空时替换 Lush 内置规则（UI 正常显示内置全文、可恢复默认，并明确警告能力、权限与交付协议可能失效），后者始终追加；旧 `prompt` 字段按 `append_prompt` 兼容读取。profile 另存 `extensions` / `skills` 路径列表，只给 Pi invocation 以显式参数加载，Codex 保留配置但不使用。
- `src/core/genealogy.js`（分支谱系的纯逻辑：`buildForest` / `pruneHidden` / `parentOf` / `childrenOf` / `ancestorsOf` /
  `descendantsOf` / `rootOf` / `chainOf`）与 `types.js` / `naming.js` 一样是共享纯模块：不碰 git、不写盘、
  不渲染，只被 `project/branches.js` 与 `test/branch-tree.test.js` 使用。`naming.js` 导出 `slugify` /
  `taskSlug` / `taskLabel` 与 `inputLabel(id)`（输入聚合分支的 `input-<id>` 名）。

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

## 分章地图

模块清单仍以本页为唯一入口，细表拆成三篇短章：

1. [Runtime 与持久化](modules-runtime.md)：Agent provider、Project、Workspaces 与 Store。
2. [Web 前端](modules-web.md)：浏览器模块、渲染职责与导出。
3. [CLI、RPC 与测试](modules-interfaces.md)：命令、协议与测试分区。

跨分区改动先从这里确认边界，再进入对应细表；新增或移动文件时必须同步更新所属章节。

---

[下一篇：Runtime 与持久化 →](modules-runtime.md)
