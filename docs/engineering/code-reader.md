# 执行详情的代码阅读器

本文说明执行详情「代码与改动」已实现的前后端契约、安全边界与读取限制，面向开发与测试。理念见 [Agent 执行过程](../design/agent-process.md)，职责见[模块地图](modules.md)。

## 用户可见范围

- 执行详情内「执行记录 / 代码与改动」平级切换；保留两边的选区之外的阅读状态、搜索、展开、文件与滚动位置。正文不被轮询替换，切走后停止该视图的正文读取。
- 代码视图左边是全项目文件树（未改文件也可读）及改动重点列表、路径筛选、仅改动筛选；右边是选中文件的差异/文件内容。初次未选文件展示汇总。
- 只包含 Git 已跟踪及未被忽略的未跟踪文件，始终排除任何路径组件为 `.git` / `.lush` 的内部目录，不递归进入子模块或跟随符号链接。
- 桌面差异默认并排，可切统一；窄屏统一并可收起文件栏。旧/新行号、代码着色、增删文字标志、改动导航、分段正文；未改变部分可按需读上下文/原文件。
- 没有专属工作区时不擅自读取 canonical 项目现场。归档后仅原始提交仍可读时降级为已提交版本，未提交内容不保留，Git 对象回收后明确不可用。不新增快照存储。
- 不编辑、不暂存、不提交、不回滚，不调用模型、不执行项目程序。文件路径到日志的入口只是全文搜索，不冒充代码行的因果追踪。

## 比较语义

`scope` 是 `task | iteration | working`，默认 `task`：

| scope | 基线 | 当前版本 |
| --- | --- | --- |
| task | `task.base_commit` | 实际工作区，包含已提交与未提交净变化 |
| iteration | `task.iteration_base_commit ?? task.base_commit` | 实际工作区；不是一次 invocation |
| working | 实际 `HEAD` | 实际工作区与未跟踪文件 |

归档模式当前版本为记录的原始源 `head_commit`（不得用 main / Squash 提交冒充）；working 范围不可用。无基线允许只读正文，差异不可用。读取时验证真实 worktree 身份和 HEAD；数据库 `head_commit` 不代表运行期最新 HEAD。

净变化与工作区脏状态独立。文件恢复到Worker基线后净 diff 可以为零，暂存/未暂存仍须显示；暂存内容与工作区抵消时仍保留状态，不伪造 index 独立 diff。子 Worker 尚未合入的文件不混入当前 Worker；已合入 child / 父同步也可能出现在Worker净变化中，不能断言全部由该 Agent 独创。

## 公共 API（version 1）

三个用户专属 RPC 及 GET 路由；均沿用已认证的 `/api/worker/<id>/…` 或多项目 `/p/<id>/api/worker/<id>/…`，Host 只转发：

| RPC | HTTP 后缀 | 参数（除 id） |
| --- | --- | --- |
| `worker.code_state` | `code-state` | `scope?, after?, limit?` |
| `worker.code_tree` | `code-tree` | `scope?, path?, query?, changed?, after?, limit?, revision?` |
| `worker.code_file` | `code-file` | `scope?, path, view?, side?, offset?, limit?, context?, revision?` |

- `id` 为 Worker id；`path` 必须是项目相对 literal 路径（tree 根用空字符串），不接受 cwd、任意 ref、绝对路径、`..`、NUL 或内部目录。路径不会作为 Git pathspec 指令执行，合法冒号/通配符/换行/tab 文件名按字面处理。
- `after` 为非负整数分页偏移，默认 0；`limit` tree/state 默认 100、最大 200。`changed` 是布尔值（HTTP `true/false`）；query 是显式按路径过滤，不是仓库全文搜索。无 query 的 tree 仅返回该目录直接子项，query 非空返回全路径匹配文件，均有界。
- file `view=diff|content`，默认 diff；`side=old|new`，默认 new；content 的 offset/limit 按 JS 字符计，默认 0/24000、上限 24000；diff 的 offset/limit 按 hunk 计，默认 0/20、上限 100，另有响应字节上限；`context` 为每块上下文行数，默认 3、最大 100。
- `revision` 是服务端给出的不透明采样标识，不是调用方可指定的版本或权限；提交对象固定，现场变化导致不一致时返回 stale，由用户刷新，不能拼接旧文件的后半段与新文件的前半段。

所有响应共有：`{version:1, task_id, scope, availability, reason, source, branch, base_commit, head_commit, sampled_at, revision, truncated}`。

- availability 为 `available | unavailable | stale`；source 为 `workspace | commit | none`；reason 为可供界面直接显示的安全中文原因或 null。权限/非法参数以现有 RPC 错误处理；读取失败、缺少现场/对象明确不可用，不伪装零改动。
- `revision` 可标识一次有界采样，不承诺整个工作区的原子快照；新采样无变化应保持相同标识。所有列表/文件记录引用其响应标识；返回分页时重验版本。
- `truncated` 表示底层预算导致范围不完整，与普通分页的 `has_more` 分开；必须显示限制，不能把尚未读取或超限的文件当成不存在。

### state

额外字段：`{files, next, has_more, summary}`。files 是净改动和脏状态文件的并集，按路径稳定排序；每页最多 limit。

`summary = {files_total, changed_total, pending_total, added, deleted, conflicts}`；超限无法确认的数字为 null，不把未知填零。

文件行：`{path, previous_path, kind, status, changed, staged, unstaged, untracked, conflict, added, deleted}`。

- kind 为 `file | directory | symlink | submodule | binary`；status 为 `A | M | D | R | T | U | null`，`changed` 表示所选基线的净变化；脏状态独立布尔字段。
- previous_path 没有则 null；文本增删行无法统计/二进制用 null。重命名的正文以 path 请求，old 对应 previous_path。

### tree

额外字段：`{path, query, entries, next, has_more}`。entries 沿用文件行形状，目录 kind=directory 并带 `name`（basename）；文件也有 name。目录 changed 表示后代存在净变化或脏状态，不预取后代正文。

删除路径/重命名旧路径按服务端映射提供可读的删除条目或 previous_path，不能因当前磁盘已不存在而丢失审阅入口。

### file

额外字段：`{path, previous_path, kind, status, file_revision, old, new, view, content?, diff?}`。

- old/new 元信息统一为 `{exists, kind, size, mode}`；不存在不同于空文件。二进制、链接、子模块与类型/模式变化给真实元信息及说明，不当普通文本。`file_revision` 标识两端实际内容，可用于选中文件的已读状态；任一侧超过正文预算而未完整读取时为 null，不能据此承诺版本内容完整。
- content 为 `{side, text, offset, next_offset, has_more, line_start, line_continued}`，只包含一侧本段内容；line_start 为本段起始行（1-based）。`line_continued:boolean` 表示本段起点仍在上一段最后一行内（不是新的一行），前端不得误加行号或换行；兼容缺失字段按 false 处理。超长单行仍按字符分段。
- diff 为 `{hunks, next_offset, has_more, too_large, reason}`。hunks 为 `{old_start, old_count, new_start, new_count, lines}`；lines 为 `{kind:'context'|'add'|'delete'|'meta', old_line:number|null, new_line:number|null, text}`。行 text 不含 patch 的 +/- 前缀（UI 独立显示），CR 和无末尾换行标记不可偷偷丢失；meta 保留 Git 的无末尾换行等信息。
- diff 不可计算/超预算时 `too_large` 或 reason 明示，提供分段原文回退，不假装无差异。上下文扩展可提高 context 重读，完整阅读走 content 分段。

## 生命周期与安全

只在前台且代码页签可见时按现有刷新偏好探测 state（正常约 3 秒、single-flight）；不定时下载全部文件。变更只更新状态/提示，已选文件保留旧正文，用户点加载最新才替换。关闭、切换 Worker/页签会取消/作废请求，迟到响应不能覆盖；当前正文不会因后台探测失去焦点/选区。

后端使用有界 Git 子进程、超时与输出限额；禁用外部 diff、textconv、fsmonitor、分页器和可选 index 写回。只读 Git 不占 mutation queue；读取身份漂移时返回 stale。Git 用参数数组和 literal path，历史读固定对象；现场从校验的普通文件句柄读取，拒绝链接穿越及符号链接换链竞态。目录、单文件、diff 与响应均有独立预算，不缓冲无限输出。

现场遍历复用项目已有的 `bun:ffi` 技术路线，通过系统 libc 的 `openat` / `readlinkat` 逐组件操作 Linux/macOS 目录句柄，节点禁止跟随链接；普通文件读取/校验/关闭走 `node:fs`，不引入原生包或编译器。内部目录匹配不区分大小写，避免大小写不敏感文件系统的别名绕过；无法安全读取已知路径时整次采样明确失败，不静默删掉该路径。临时隔离 Git 目录不加载项目定义的过滤器配置，读取后清理，不修改原 index 或引用。

首期不新增实体/表，不留存工作区快照。进程内读取状态与临时文件都不是归档留存承诺。

## 限额与已知限制

- 单次采样最多 20,000 个文件、15 秒；普通 Git 输出上限 4 MiB。超过预算明确不可用/不完整，无法确认的统计为 null。state/tree 每次请求仍需有界采样整个文件索引，目录懒加载限制的是响应与 DOM，不是底层只扫描一个目录。
- 单侧正文读取上限 8 MiB，再以至多 24,000 个 JS 字符分段交付；大于 8 MiB 仅元信息与限额说明，不承诺可以继续读完整文件。二进制/非 UTF-8 文件同样不作为空正文或「已读完」显示。
- 文本 diff 两侧输入合计最多 2 MiB，原始 diff/展开结构预算 512 KiB。超限可切原文，但原文仍受单侧 8 MiB 限制；不将超限伪装成无差异。
- 整个 JSON 响应最多 512 KiB，列表行预算 480 KiB；字节预算会让实际一页少于 limit，仍用 next/has_more 继续，不截断文件名。全局最多 4 个并发代码读取，超出明确繁忙。
- 状态中的未跟踪文本增删行可能为未知，文件打开后仍能读到实际差异；子模块只读登记提交，不递归扫描其未提交现场。首期不提供独立 index 版本审阅或逐步骤历史回放。
- 归档不保证原 Git 对象永久存在，不保存未提交内容。界面显示 Worker 工作区净变化，不保证每一行都是该 Agent 所写。
- Linux 与真实 Firefox 联调已验证；macOS 需要在真实 CI/机器验证，新增 `.github/workflows/code-reader-posix.yml` 覆盖两平台与 Bun 最低/当前版本，但添加 workflow 不等于 CI 已运行通过。

## 实现分工与验收

- 后端：`workspaces/code*.js`、`project/code.js`，对应入口 mixin、RPC registry/handler、Web 路由；更新 runtime/interfaces 地图与 API 参考；只用临时 Git 仓库及 mock Host 测试。
- 前端：`code-view.js`、文件树/diff 组件及 `transcript-view.js` 生命周期、样式、搜索接缝；更新 Web 地图与执行阅读器文档，DOM 测试自给自足。
- 统一验收：新增/删除/改名、已提交与未提交/撤回、冲突、特殊文件名、链接/内部目录/ignored 拦截、子模块/二进制/超大文件、父同步/多轮基线/归档降级、分页/失效、多项目路由鉴权、搜索往返/状态保留、真实浏览器窄屏/深浅主题。

真实浏览器验证入口 `bun scripts/check-code-reader-layout.js [截图目录]`：Firefox / geckodriver 驱动真实前端，与临时 Git 项目的 Workspaces 读面通过临时本机 HTTP fixture 对接；覆盖实际文件正文/diff、并排/统一与窄屏布局、路径搜索往返、刷新不抢正文、关闭停止探测。脚本自行清理临时项目/服务/浏览器，失败保留日志；不启动用户 daemon，不冒充生产 Host 鉴权测试（后者由 HTTP/RPC 单测覆盖）。

聚焦自动测试：`bun run test test/workspaces/code-posix.test.js test/workspaces/code-reader.test.js test/web/code-reader-api.test.js test/web/dom-code-view.test.js`。工作区/内核接口用真实临时 Git 与文件系统；HTTP/RPC 与 DOM 用受控 fixture，不调用模型。默认 `bun run test` 运行全部现有 Web/core 套件，不忽略测试目录。

改变本契约时必须同步后端与前端，不能单侧改变字段口径。
