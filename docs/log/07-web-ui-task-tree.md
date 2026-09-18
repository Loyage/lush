# 07 · Web UI 的 Task 树视图

> 上一轮把 `src/ui/` 拆成「UI adapter → UIClient → RPC」并加了最小 Web UI（service tree + 后台创建根 task）。这一轮把 Web UI 从「能开活」补成「能看活」：侧边栏可在服务视图与任务视图之间切换，选中一个 task 就能看到它派出去的全部子 task——即 `lush task tree` 的网页版——并支持取消与删除。

- [x] **侧边栏双视图：服务 / 任务**：`index.html` 的左侧栏加了 segmented tabs；服务视图仍是原来的 `service.tree` 渲染，任务视图是新的 task 浏览器。任务列表由 `task.list` 的扁平行在前端还原成森林（`parent_task_id` 不在已取窗口内的行成为根），所以「按状态 / 根 / 子筛选」之后仍是一棵树而不是丢了父节点的散点；每行显示 `#id`、状态色点、service 名与 goal，默认最多 500 条并提示被截断。右侧主栏保留「创建 Task」，并新增「Task 树」面板：选中 task 后用 `task.tree` 渲染它的整棵子树（每个节点是 `#id service-name[SID] status · goal`），点击树中任一节点即以它为根重新展开，`↑` 回到上级；面板顶部同时给出选中 task 的完整 goal、时间戳、子树规模与 result / error。「创建 Task」成功后自动切到任务视图并选中新 task，不再单独轮询 `task.result`。

- [x] **HTTP adapter 补齐 task 读写**：`server.js` 新增 `GET /api/tasks`（查询参数 `sid` / `status` / `roots` / `limit` 透传 `task.list`）、`GET /api/tasks/:id/tree`（`task.tree`）、`POST /api/tasks/:id/cancel`（`task.cancel`，因为取消会级联整棵子树，回答的是取消后的 `task.tree` 而不是 RPC 返回的单行）、`POST /api/tasks/:id/delete`（`task.delete { recursive }`，回答 `{ deleted: [id...] }`）。所有新路由都走既有的 same-origin 检查与 LushError → HTTP 状态映射（404 / 409 / 400 等），破坏性动作落在本来就不允许跨 Origin 的 `/api/` 前缀内。

- [x] **UIClient 增加具名工作流与严格解码**：`ui/client.js` 新增 `taskList({sid,status,roots,limit})`、`taskTree(id)`、`cancelTask(id)`、`deleteTask(id, recursive)`，与既有的 `createTask` / `taskResult` 并列——UI 依旧只说工作流、不说 JSON-RPC 方法名；另加两个和 `taskRequest` 同风格的严格解码器 `taskListQuery(search)`（拒绝未知 / 重复参数，枚举与范围仍交给 Core 报错）与 `taskDeleteRequest(value)`（只接受 `{ recursive?: boolean }`）。Web UI 只读 `LIST` / `TREE` 两种形状，取消与删除只发 id 与 `recursive`。

- [x] **取消与删除的交互**：两者都先弹确认框（取消提示会中断 agent、删除提示子 task 数量）；活动 task（created / running / waiting）只给「取消」，终态 task 只给「删除」，由 Core 状态机决定而不是前端猜。删除后选中项回到父 task；选中的 task 在别处（CLI / 其他页面）被删掉时，轮询拿到 404 会清掉选中项而不是卡住。任务视图与选中 task 的树跟随既有的 2.5 秒轮询刷新，daemon 离线时页面照旧保持可用。

- [x] **验收**：`test/web.test.js` 的共用客户端用例断言 4 个新工作流的 method / params；新增两条 HTTP 用例——一条断言 `task.list` 的默认顺序、`sid` / `status` / `roots` 筛选与 `task.tree` 的递归形状（真起一棵 SID 0 → 子 service 的两层 task 树），一条断言 cancel 级联到子 task、delete 递归删除并把已删 task 变成 404，另补查询参数与 delete body 的非法输入断言（400）。文档同步 `docs/reference/ui.md`（两类视图、破坏性动作、HTTP 表）、README 与 Justfile 的一行说明。147 项测试通过（`bun test`）；另用 mock provider 起真 daemon + `just web` 做了手工 e2e：`GET /api/tasks` 返回真实历史 task，「开启项目」那条的 `task.tree` 正确显示 `#1 lush[0] → #2 project-manager[1]`，取消已完成 task 幂等、删除后 tree 返回 404，跨 Origin 403、非法参数 400。

- [x] **删掉 `bun run demo`**：`just verify`（= `bun test` + `demo`）与 `just demo` 已无意义，一并移除 `examples/mvp_demo.js`、`package.json` 的 `demo` script、Justfile 的两个 recipe，以及 README / `docs/reference/cli.md` / `docs/reference/agents.md` / `AGENTS.md` / 本目录「验收命令」里的引用；验收入口现在就是 `bun test`（`just test`）。这不是本轮引入的：上一轮 `a75fe4b` 删掉了 `generic-task` / `generic-service` 两个模板，而 demo 第 55 行仍在 `service spawn 1 generic-task`，所以 `bun run demo` 从那时起就一直报 `template not found: generic-task`；与其把演示重写成 `project`（需要选一个 `path` 变量、并改写后半段的叙事）不如删掉——它给的信号测试已经覆盖，重复维护只会在模板演进时再次静默失效。
