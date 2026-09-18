# 14 · Web UI 右侧主栏跟着当前视图走

> 侧边栏切到「任务」并点选一个 Task 后，右侧首屏还是「创建 Task」表单 +「Service 能力」面板，Task 详情被推到 1000px 之外——看起来就是「点了没反应」。根因有两层：右侧三块面板永远堆在一起，与左侧选中无关；以及 `hidden` 属性被类上的 `display` 盖住（`.service-view { display: grid }` 让 `hidden` 的「可创建的子 Service 0 / Call Prompt」空骨架照样渲染）。

## Done

- [x] **右侧主栏与视图一一对应**（`src/ui/web/assets/app.js` 的 `setView`）：`服务` → 「创建 Task」+「Service 能力」；`任务` → 「Task 树」（含详情与子树）；`Notice` → 「Notice 详情」。原来只有 `notices` 是独立的，`services` / `tasks` 共用「三块面板从上到下堆」的布局，所以任务详情永远在首屏之外。
- [x] **切视图回到顶部**：面板高度差别很大，`setView` 切到另一个视图时 `window.scrollTo({ top: 0 })`，否则从服务视图滚下来的位置会让新视图的首屏漂走。
- [x] **`＋ 新建 Task`**：任务视图的面板标题栏加一个按钮，一次点击 `setView('services')` 并聚焦 goal，创建 Task 的能力没有被藏掉；选中的 Service 在视图之间保留，goal 可直接填写提交。
- [x] **修掉 `hidden` 被类上的 `display` 覆盖**（`styles.css`）：补全局 `[hidden] { display: none !important; }`。以浏览器量到的 computed display 为准重新审了 `#service-view` / `#task-detail` / `#task-tree` / `#detail-result` / `#notice-detail` / `#notice-text` / `#notice-answer` 与四块 panel：都是「带 hidden 就一定不渲染」，没有哪块依赖「hidden 不生效」。初始加载（未选 service）时 `#service-view` 的 computed display 从 `grid` 变成 `none`，`#service-hint` 正常显示。
- [x] **文档**：`README.md` 的 Web UI 段落与 `docs/reference/ui.md` 的三类视图说明按新行为改写。

## 验收

- `bun test`：175 项通过（基线也是 175）。中途一次 `cli.test.js` 的 `task agents kill …` 用例因时序失败，单跑与重跑全绿，与本次改动无关。
- 真浏览器（headless Chrome + CDP，1440x900 / 1280x800 / 900x900，页面来自本 worktree 的 `src/ui/web/assets`）在自起的临时 home（`LUSH_PROVIDER=mock`）+ 独立端口 4319 上实测：
  - 初始加载（服务视图、未选 service）：`#service-view` hidden=true、computed display=`none`（修复前为 `grid`，并在首屏渲染出空骨架）。
  - 点选 service SID 2 → 切「任务」→ 点第一行 task：`#create-panel` 与 `#service-panel` hidden、display `none`；`#tree-panel` top=138；`#task-detail` top=240 bottom=534（innerHeight=900，首屏内）、`#task-tree` top=534 bottom=615、`#detail-id` = 被点的 task id。修复前对应 `#task-detail` top=1115（首屏外）。
  - 2.5s 轮询之后（多等 3s）：`#detail-id` 与位置不变，选中项不丢。
  - 切回「服务」：`#create-panel` top=138、`#service-panel` top=557，`#tree-panel` 隐藏（`#task-detail` 的 boundingRect 为 0，不占首屏）。
  - 点 `＋ 新建 Task`（一次点击）→ 服务视图、goal 可填 → `requestSubmit()` 创建成功（`Task #N 已在后台启动`），页面自动切回任务视图并选中新 Task，`#detail-id` = 新 id。
  - 任务树里点子节点：`#detail-id` 从 `#2` 变为 `#3`，`#task-detail` top 仍为 240（首屏内）；已结束 Task 的「取消」禁用、「删除」可用、有父 Task 时 `↑` 可见。
  - `服务 → 任务 → Notice → 服务` 来回切换：各视图只剩自己的面板，无残留；切回任务后选中项 `#3` 仍在、top=240。
  - 1280x800：`#task-detail` top=240（<800）。900x900 单列布局：`#task-detail` top=858（<900，仍在首屏），但子树在首屏之外——单列时侧边栏在上方，布局仍按原有媒体查询堆叠。
  - daemon 离线（另一个只有空目录、没有 daemon 的 home + 端口 4320）：页面正常打开、`连接失败` 显示为 error、三个 tab 仍可切换且面板按视图显示。
  - 修复后截图：`/tmp/lush-after-fix.png`（1440x900，点选 Task 之后）。

## 备注

- 本轮只改 `src/ui/web/assets` 下的静态 html/css/js 与两份文档，不碰 Core / RPC / daemon 与 HTTP 路由契约（`test/web.test.js` 的断言原样通过）；无第三方依赖、无构建步骤。CSP 仍是 `script-src 'self'`，新增按钮与逻辑都在 `app.js` 里。
- `#task-detail` 自身在服务视图里仍保持 `hidden=false`（状态不销毁，切回任务视图无需重新拉取），只是父面板 `display: none`，所以它不占首屏。
- 900px 单列布局下侧边栏仍在上方（`min-height: 360px; max-height: none`），Task 详情只能保证在 900 高的首屏内、子树需要滚动；这是既有响应式布局的行为，本轮未改。
