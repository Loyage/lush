# 24 · Web UI 的页面与路由同版本：静态资源冻结 + UI revision

> 目标：修掉一个**静默且必然发生**的错位——`lush-web` 把页面**逐请求从磁盘读**，路由表却在**进程启动时冻结**。改了 `src/ui/**` 而没重启这个进程时，它吐给浏览器的是**新版页面**，应答的却是**旧版路由**：新版页面调用的路由在旧路由表里根本不存在，用户看到的是「API route not found」。

## 怎么发现的

用户在 Web UI 里给 service 派活，得到 `API route not found`。现场排查：

- 4318 端口上的 `bun ./bin/lush-web` 启动于 20:58，早于把「创建 Task」改成 intension 的那次提交（22:46）。
- `curl /app.js` 拿到的**逐字节等于仓库里最新的 `app.js`**（它往 `/api/intents` 提交）；而 `POST /api/intents` 回 `API route not found`，`POST /api/tasks` 这个**老路由还在**（回 `method not found: call`，因为新 daemon 已经没有 `call`）。
- 也就是说同一个进程里，页面是一版、路由是另一版。`bun run status` 的 `cli.code_match: true` 对此完全静默：fingerprint 只哈希「喂给 agent 的提示词与 CLI 声明面」，既不含 `src/ui/**`，也不知道有 `lush-web` 这个独立进程。

根因不是那次改动，而是**读盘时机**：`Bun.file(...)` 在 `fetch()` 内部求值，路由表在模块加载时定格。

## Done

- [x] **静态资源在构造时冻结**（`src/ui/web/server.js`）：`ASSETS` 的三份文件在 `WebUIServer` 构造时一次读进内存（`loadAssets`），`fetch` 只从内存取。一个进程 = 一份页面 + 一份路由表，两者不可能再错位；`stop()` 后再 `start()` 同一对象也不会中途换版（内存里那份不重读）。代价明确：改 `src/ui/**` 后必须重启 `lush-web`。
- [x] **UI revision**（`src/identity.js` 的 `uiRevision()`）：`src/ui/**` 递归内容的 sha256 前 12 位，缓存。它是**独立于 `codeIdentity()`** 的第二个摘要，理由写在注释里——daemon/CLI 的 fingerprint 讲的是「agent 被告知什么」，纯 UI 改动不该被报成「daemon 过期」而催人重启 daemon。
- [x] **页面自报版本 + 过期页面显式报错**：`assets/app.js` 顶部的 `UI_REVISION = '__LUSH_UI_REVISION__'` 由服务端在冻结时替换成自己的 revision（`index.html` / `styles.css` 一并替换，虽然只有 app.js 用得上），`api()` 在每个请求上带 `X-Lush-UI-Revision`。服务端在路由之前先看这个头：**带了且不等于本进程的 revision** → `409`，`error.data.reason = "ui_revision_mismatch"`，消息里给出 page/server 两个 revision 与 reload；**不带**（curl、测试、其他 adapter）→ 行为不变。页面收到这个标记就调 `stalePage()`：顶部状态改成「页面已过期，请刷新」，消息区提示一次并**只提示一次**（2.5 秒的轮询不会把它刷成噪音）。
- [x] **404 说人话**：`/api/` 下未命中的路由，消息从 `API route not found` 改成 `API route not found: <path> (a page from another build is asking for it; reload the browser)`——老页面 + 新服务端（它连 revision 头都没有）只剩这一条路可以自救。
- [x] **文档**：`docs/reference/ui.md` 写清「`lush-web` 也是版本冻结的长驻进程，改 `src/ui/**` 要重启它」、`X-Lush-UI-Revision` 与 `409` 的契约，以及 404 的新消息。
- [x] **验收**：`bun test` **205 项通过**。`test/web.test.js` 新增一条：页面里被替换成 `uiRevision()` 且不含 token、同一路由两次请求逐字节相同（内存那份）、`HEAD` 仍是 200；`/api/tree` 带对得上 / 对不上的头分别是 `200` / `409`（并断言 `error.data` 的两个 revision 与消息里的 `reload`），`POST /api/intents` 带旧版本头是 `409`（**没有**真的提交输入），`POST /api/tasks` 这种搬走了的路由是 `404` 且消息可操作；不带头的请求（其余全部用例）行为不变。

## 备注

- 现场是手工处置的：杀掉那个 stale 的 `lush-web`（PID 12268）后用同样的 `LUSH_HOME=$PWD/.lush LUSH_WEB_PORT=4318` 重启，`POST /api/intents` 立刻从 `404` 变成 `400`（路由在，只是空 body 被拒）。
- 这一层**只保证「同一进程内页面与 API 一致」+「不一致时说出来」**，没做的是：`bun run web` 发现端口上已有别的 revision 在监听时的告警 / 拒绝（现在是 `EADDRINUSE` 或你手快就两版并存），以及把「`lush-web` 也是版本冻结的长驻进程」写进 `AGENTS.md` 与 `docs/engineering/identity.md` 的排障清单。要做的话是下一轮。
- 「页面逐请求读盘、路由启动时冻结」曾有一个看似的好处：改页面不用重启。这个好处是假的——页面和它要调的 API 一起改才是常态，分开读只会让两者对不上。
