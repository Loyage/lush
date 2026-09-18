# 模板（ServiceTemplate）

> 参考层：模板文件的字段契约、保留变量名、目录摆放与加载顺序。

## ServiceTemplate

模板描述**一种服务**（被动节点）。JSON 文件字段固定为七项，缺一或多一都报错：

```json
{
  "name": "coding-node",
  "singleton": false,
  "description": "我是完成编码目标的节点：在给定仓库路径上实现 / 修改 / 修复代码并跑最小验证；我不做调研选型，也不合并或推送改动。",
  "spawn_prompt": "创建编码节点：service_spawn {template: \"coding-node\", name: <短名，必填>, goal: <目标，可选>}；建完用 task spawn 把活派给它。",
  "system_prompt": "你是编码节点。收到 task 后先用真实命令把事情做完，再 task_complete 写清改了什么、怎么验证的。",
  "child_templates": ["generic-task", "generic-service"],
  "variables": {
    "immutable": {
      "repo": { "required": true, "description": "代码仓库根目录（绝对路径，同时是 task 的 cwd）" }
    },
    "mutable": {
      "branch": { "default": "main", "description": "当前工作分支，可用 update-vars 修改" }
    }
  }
}
```

- `name`：模板名，也是 `service.spawn` / `lush service spawn` 的 template 参数。
- `singleton`：`true` 时同一个父 SID 下最多一个活动实例；实例停止后名额释放。
- `description`：一段陈述句，说明这个节点**自己的**能力范围（做什么、边界在哪），用于上级节点判断该不该把活派到这里、该建什么 task；出现在创建方的 `available_child_templates` 与 `service.view --with description`，所以保持一句话、不换行。
- `spawn_prompt`：告诉创建方「怎么创建这个模板、需要哪些变量」，随 Context 注入创建方 agent。
- `system_prompt`：实例创建时快照进它自己的 Context，成为它上面每个 task 的 agent 的第一条 system message。

这三个散文字段都可以写成 `@<路径>`，把正文放进旁边的独立文件（见〈提示词写在自己的文件里〉）。
- `child_templates`：该实例允许创建的子模板（相对自己文件的路径，或模板名；`*` 表示全部）。
- `variables`：变量声明，分 `immutable` / `mutable`；每个变量有 `description`（必填）与可选 `required` / `default` / `pattern` / `max_length` / `single_line`。

模板按层级顺序加载（能创建某个模板的模板排在它前面），`available_child_templates` 也是这个顺序。`$LUSH_HOME/templates/**/*.json` 可以加用户模板，重启后生效。

### 提示词写在自己的文件里

JSON 字符串里不能有真正的换行，所以 `system_prompt` 这种多段散文写在 JSON 里只能是一行 `\n` 转义——编辑器里读不了、`git diff` 里看不见改了哪句。于是 `description` / `spawn_prompt` / `system_prompt` 三个散文字段可以写成 `@<路径>`，由 loader 相对**声明它的模板文件**读取并内联（与 `child_templates` 同一条相对路径规则）：

```json
{
  "name": "project",
  "spawn_prompt": "@project/spawn_prompt.md",
  "system_prompt": "@project/system_prompt.md"
}
```

- `@` 只在字符串整值等于 `@<路径>` 时生效，不是字符串插值；文件末尾由编辑器补的那一个换行会被去掉，CRLF 归一化成 LF，其余内容原样保留（不递归解析：文件里以 `@` 开头的第一行就是正文）。
- 引用必须是可读文件：文件不存在、路径为空、或模板是程序化 `register` 注册的（没有文件可相对）都报 `-32602`，**绝不退化成字面量**。
- 校验与快照看到的都是内联后的正文（长度上限、`service.view --with prompt`、创建时写入 Context 的 `system_prompt` 都是展开后的文本）。
- 这些 `.md` 与模板 JSON 一样属于「喂给 agent 的提示词面」：`src/identity.js` 的 fingerprint 同时哈希 `templates/**/*.json` 与 `templates/**/*.md`，改了提示词文件同样要 `just daemon-restart`。

### 保留变量名

| 名字 | 含义 |
| --- | --- |
| `path` | 工作目录：必须存在、必须是绝对路径、只能 immutable；它同时是该节点上所有 task 的 cwd |
| `name` | 服务名：`--name` 与 `variables.name` 是同一个值，格式按声明校验 |
| `title` / `detail` | 节点的一行摘要与详情正文，`service list` / `tree` / `inspect` 会渲染 |
## 仓库模板的摆放

每个模板 `<name>.json` 旁边有一个同名文件夹 `<name>/`，里面放它能直接创建的模板（被多个模板创建的共享模板跟最浅的那个父模板放一起），于是目录本身就是 spawn 树：

```text
templates/lush-root.json
templates/lush-root/{spawn_prompt,system_prompt}.md
templates/lush-root/project-manager.json
templates/lush-root/project-manager/{spawn_prompt,system_prompt}.md
templates/lush-root/project-manager/{project,generic-task,generic-service,research-task}.json
templates/lush-root/project-manager/project/dev-task.json
templates/lush-root/project-manager/project/dev-task/worktree-service.json
```

`<name>/` 因此装两样东西：`<name>` 自己的两段提示词（`spawn_prompt.md` / `system_prompt.md`），和它能直接创建的模板（`.json`）。`child_templates` 写相对自己文件的路径（`lush-root/project-manager.json`、`project/dev-task.json`、`dev-task/worktree-service.json`、同目录的 `generic-task.json`），loader 递归读取并把它解析成模板名，白名单、快照与权限比对里始终只有名字；也接受直接写模板名（程序化 `register` 没有文件可相对，旧用户模板继续可用）。`$LUSH_HOME/templates/**/*.json` 可增加新模板，不覆盖仓库模板，重启后加载。

**SID 0 只能创建 `project-manager`**：`lush-root` 的 `child_templates` 只有这一项，用户模板同样不在其列（列表是显式的，没有 `*`）。

### 随仓库发布的模板

- `project-manager`（SID 0 的子模板，单例）：开 / 关项目。它创建 `project` / `research-task` / `generic-task` / `generic-service`，不含 `project`（嵌套 project 在创建时被白名单拒绝，-32010）。
- `project`（非单例）：必须提供 immutable 变量 `path`（已存在的绝对目录，会成为 agent 的 cwd），另有 mutable 变量 `branch`（默认 `main`）。它的 `system_prompt` 带一条「先拆分、再创建」的协议：明显多条指令时按目标模板自己的 `spawn_prompt` / `variables` 声明配置字段、用 `service_spawn` 逐个创建 task 服务，只有一条目标时不硬拆；默认只创建、不逐个 call。`system_prompt` 里还有一条合并与回收协议：dev-task 的结果带 `merge` 字段（用户在 notice 里的答复），`yes` 时由 project 亲自在主工作树 path 执行 `git merge --no-ff <branch>`（有冲突就停下报告）；合并成功后再用 notice 问用户是否回收 worktree 资源（`git worktree remove` + `git branch -d`，有未提交改动时只有用户选了 force 才加 `--force`）；绝不 force push / rebase。
- `dev-task`（`project` 的子模板）：用三个正式字段描述一项开发任务——`name`（`^[A-Za-z][A-Za-z0-9_-]*$`、≤64，同时就是服务名，用来命名相关的 worktree / 分支）、`title`（一行摘要、≤200，`service list` 与 `inspect` 显示的就是它）、`detail`（详情正文，可多行、可空、≤20000）；`lush service spawn 1 dev-task --name fix-login --title 修复登录流程 --detail 正文`。默认行为：除非 goal / detail 里明确说明例外（不要新 worktree、就在当前工作树上改、复用某个已有 worktree），它一律为这件工作新建一个独立 git worktree，并把实际改动派给 `worktree-service` 在新 worktree 里用 agent 做。工作目录与分支由任务自己向父服务取。它自己**不执行合并**：把 worktree-service 结果里的 `merge` / `target` / `worktree` / `branch` / `repo` 等字段原样向上转达给 project；合并成功后的 worktree 回收也由 project 在用户同意后执行，dev-task 不删 worktree。
- `worktree-service`（`dev-task` 的子模板）：一个 git worktree 一个管理器，只声明保留变量 `path`（必填、不可变、已存在的绝对目录，缺失 / 相对 / 不存在都在创建时被拒），同一个变量就是它的 agent 工作目录，所以它一被 call 就站在那个 worktree 里；`spawn_prompt` 要求先看 `children` 复用相同 `path` 的实例。它的 `system_prompt` 带一道人工门：改动做完并验证过后用 notice 问用户是否合并（命令行 `lush notice post --title ... --kind decision --fields '[{"name":"merge","type":"choice","options":["yes","no"],"required":true},{"name":"target","type":"text"}]'`，内置运行时用 `notice` 工具），然后把用户决定与 worktree / 分支 / repo / 验证结果写进 `task_complete` 的 result；它自己绝不 merge / push / 删 worktree。
