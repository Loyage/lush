# 17 · 命名统一：创建用的 prompt 叫构造 prompt（`spawn_prompt` → `construct_prompt`），`spawn` 语系整体改成 `construct`

> 上一轮（[16](./16-worktree-service-destructor.md)）给 worktree 回收加了「析构」（被回收的节点声明契约、由持有它的节点执行删除），命名上却留着不对称：回收那边叫「析构」，构造这边却叫 `spawn_prompt` / `service spawn` / `task spawn`。这一轮把「构造」这一侧统一成 `construct`：模板字段、RPC 方法、CLI 命令、agent 工具、内部符号、CLI 声明树与文档一次改完，**不留旧名**。

## Done

- [x] **模板字段 `spawn_prompt` → `construct_prompt`**：`template_loader.js` 的 `REQUIRED_FIELDS` / `PROSE_FIELDS` / 长度校验、创建时快照、`available_child_templates`（`core/queries.js`）、`service.view` 与 `service inspect` 的渲染（`src/cli/format/service/inspect.js` 的 `construct` 标签）、Web UI 的「构造方式（construct_prompt）」标签（`src/ui/web/assets/{app.js,styles.css}`）；5 个模板 JSON 与它们旁边的 `spawn_prompt.md` 一并改名成 `construct_prompt.md`（`git mv`，`@` 引用同步）。
- [x] **命令与 RPC**：`lush service spawn` → `lush service construct`（RPC `service.construct`、handler `ServiceManager.construct`、`core/dispatch.js` 的参数表、CLI 声明树 `children.construct`、`serviceSpawnChild` → `serviceConstructChild`、文件 `src/cli/tree/service_spawn.js` → `service_construct.js`）；`lush task spawn` → `lush task construct`（RPC `task.construct`、`taskSpawn` → `taskConstruct`、`spawnTask` → `constructTask`、`tasks/rules.js` 的 `spawn()` → `construct()`）。CLI 的 canonical command id 相应变成 `construct`（service）与 `task_construct`（task），`format/index.js` 与 `main.js` 的分支同步。
- [x] **Agent 工具（内置运行时）**：`service_spawn` → `service_construct`、`task_spawn` → `task_construct`（`src/agent/tools.js` 的 `TOOL_PARAMS`、工具名与 `AgentTools.construct` 方法、`src/agent/mock.js` 的匹配词）；`src/agent/guide.js` 的 TOOL_HOWTO / CLI_HOWTO 与「命令组速览」全部改口径。
- [x] **其余符号与工具**：`spawnVariables` → `constructVariables`、`test/task_spawn.test.js` → `test/task_construct.test.js`、Justfile 的 `just spawn` → `just construct` 与 `just task-spawn` → `just task-construct`（含注释里的示例）、`docs/reference/cli.md` 的命令示例与表格、README / AGENTS.md / architecture / identity / rpc / ui / templates 文档。
- [x] **不做兼容、不改 OS 进程语汇**：模板只认 `construct_prompt`——旧模板（`$LUSH_HOME/templates/**/*.json` 里写 `spawn_prompt`）在加载时按「字段集不符」直接 `-32602` 报错，不静默降级、不加 deprecated 别名（与 `--args` 那种旧写法不同，这里字段名是接口面，报错即文档）。`Bun.spawn` / `cp.spawn` / `spawnSync` / `on_spawn` / 「daemon spawn 出 agent」这类讲**操作系统进程**的词一律不动；`docs/log/**` 的历史条目也不改写（[16](./16-worktree-service-destructor.md) 与本轮同一批未提交改动，其正文已随本轮改名）。

## 验收

- `bun test`：179 项通过（与基线同数——本轮只改名字，没有新增或删除行为；`test/core.test.js` 的模板字段断言、`test/cli.test.js` 的 `construct` 标签断言、`test/web.test.js` 的模板 fixture 都跟着改名）。
- `lush help service construct` / `lush help task construct` 正常渲染（`LUSH_HOME` 指向临时目录，不需要 daemon）：summary、cover、usage、positionals 全是新名字。
- 模板 loader 加载五个模板通过（`construct_prompt` 的 `@` 引用内联、层级排序、`child_templates` 解析都不受影响）。

## 备注

- 改到的文件都在提示词 / 声明面里（`templates/**`、`src/cli/tree/**`、`src/agent/guide.js`、`src/cli/main.js`）→ fingerprint 变化，**必须 `just daemon-restart`** 才生效；`src/core/`、`src/rpc/` 这些运行期改动同样要重启。
- 老 service 的快照里存的还是 `spawn_prompt` 字段（创建时快照），代码不再读它，只会在 `service inspect --json` 的 `template_snapshot` 里看到；`available_child_templates` 与 `service.view` 一律从**当前加载的模板**取 `construct_prompt`，所以既有节点不会显示空 prompt。
- 命令名的中文摘要跟着改成「构造」口径（`service construct` 的 summary 是「构造子服务」），但散文里的普通动词仍保留「创建」——名字统一成 construct，行文不必生造中文。
