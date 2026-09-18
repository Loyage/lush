# 13 · 模板提示词外置为 markdown（`@<路径>`）

> 上一轮之后模板的 `system_prompt` 已经涨到 1.3k–2.4k 字符，而 JSON 字符串里不能有真正的换行，所以它在文件里就是**一行** `\n` 转义：编辑器里读不了、`git diff` 里看不见改了哪句、评审提示词等于没评审。这一轮把长散文从 JSON 里挪出来，结构留在 JSON，正文进旁边的 markdown。

## Done

- [x] **模板 loader 支持 `@<路径>` 引用**（`src/template_loader.js`）：`description` / `spawn_prompt` / `system_prompt` 三个散文字段的值若整值等于 `@<路径>`，就相对**声明它的模板文件**读取并内联——与 `child_templates` 完全同一条相对路径规则。引用只在整值时生效（不是字符串插值），文件末尾由编辑器补的换行去掉、CRLF 归一成 LF、其余内容原样保留（文件内容不再递归解析：文件第一行以 `@` 开头也只是正文）。新增 `PROSE_FIELDS` 与 `inlineProse()`；`register()` 先把散文字段内联成一份副本（不改调用方对象），之后所有校验、`jsonDump`、快照看到的都是展开后的正文，所以 `text()` 的长度上限与写入 Context 的 `system_prompt` 都不需要额外分支。
- [x] **引用绝不退化成字面量**：文件读不到报 `-32602`（`template <name> <field>: no readable file at <abs>`），空引用 `@` 报 `-32602`（`empty reference`），程序化 `register`（没有文件可相对）写引用同样报 `-32602`——与 `child_templates` 写路径时的行为对齐。
- [x] **仓库模板迁移**：五个模板各拆出 `<name>/spawn_prompt.md` 与 `<name>/system_prompt.md`，JSON 里改成 `"@<name>/spawn_prompt.md"` / `"@<name>/system_prompt.md"`（从 `lush-root/project-manager/project.json` 看就是 `@project/spawn_prompt.md`）。于是 `<name>/` 装两样东西：自己那两段提示词（`.md`）和它能直接创建的模板（`.json`）。提示词**一字未改**，纯搬运；`description` 是渲染在列表里的一句话，保持内联。
- [x] **fingerprint 覆盖 `.md`**（`src/identity.js`）：`SURFACE_DIRS` 增加 `{ path: 'templates', extension: '.md', recursive: true }`。这些文件决定 agent 收到什么，和模板 JSON 一样属于提示词面——改动提示词文件同样要 `just daemon-restart`，也照样触发 `cli.code_match: false` 告警。
- [x] **测试**：`core.test.js` 新增一条用例（内联取到正文、CRLF 归一去尾换行、非 `@` 开头仍是字面量、缺文件 / 空引用 / 无文件的 `register` 分别报错且不留半个模板）。既有断言顺带覆盖了迁移本身：`dev-task` / `worktree-service` 的 `spawn_prompt` / `system_prompt` 关键词断言现在读的是 `.md` 里的正文，内联没生效就会失败。
- [x] **文档**：`docs/reference/templates.md` 新增〈提示词写在自己的文件里〉（规则、失败模式、目录树两样东西的说明），`docs/engineering/architecture.md` / `identity.md`、`docs/reference/rpc.md`、`AGENTS.md`、`README.md` 里 fingerprint 与「模板文件在哪」的说法同步加上 `.md`。

## 验收

- `just test`：175 项通过（新增 1 条）。
- 搬运保真：用一个临时脚本把 loader 内联后的每个散文字段与对应 `.md` 逐字节比对（`content === value + '\n'`），十个字段全部一致；`templates/*.json` 里不再出现 `\n` 转义。
- fingerprint 反应：改一行 `templates/lush-root/system_prompt.md` → fingerprint 变化，改回 → 与原值相同（`9f9385cbf295`）。

## 备注

- 这一轮改的是 `templates/**` 与 `src/template_loader.js` / `src/identity.js`，`code_match` 会变，照例 `just daemon-restart` 之后才生效；既有服务不受影响（Context 里的 `system_prompt` 是创建时的快照）。
- `spawn_prompt` 那几条本来就是**一段**话（500–750 字符），搬进 `.md` 后仍是一行——它们不是多行散文，只是长句子，需要拆成小段时直接在文件里换行即可，JSON 不用再动。
