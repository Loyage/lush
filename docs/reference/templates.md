# 模板（ServiceTemplate）

> 参考层：模板文件的字段契约、保留变量名、目录摆放与加载顺序。

## ServiceTemplate

模板描述**一种服务**（被动节点）。JSON 文件字段固定为七项，缺一或多一都报错：

```json
{
  "name": "coding-node",
  "singleton": false,
  "description": "我是完成编码目标的节点：在给定仓库路径上实现 / 修改 / 修复代码并跑最小验证；我不做调研选型，也不合并或推送改动。",
  "construct_prompt": "构造编码节点：service_construct {template: \"coding-node\", name: <短名，必填>, goal: <目标，可选>}；建完用 task construct 把活派给它。",
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

- `name`：模板名，也是 `service.construct` / `lush service construct` 的 template 参数。
- `singleton`：`true` 时同一个父 SID 下最多一个活动实例；实例停止后名额释放。
- `description`：一段陈述句，说明这个节点**自己的**能力范围（做什么、边界在哪），用于上级节点判断该不该把活派到这里、该建什么 task；出现在创建方的 `available_child_templates` 与 `service.view --with description`，所以保持一句话、不换行。
- `construct_prompt`（构造 prompt）：告诉**构造方**（要构造这个节点的那个 agent）「怎么构造这个模板的实例、需要哪些变量」，随 Context 注入构造方 agent。
- `system_prompt`：实例构造时快照进它自己的 Context，成为它上面每个 task 的 agent 的第一条 system message。

两个 prompt 的名字成对：`construct_prompt` 是「怎么构造这个节点」（给构造方看），`system_prompt` 是「这个节点自己是什么、被回收时遵守什么」（给它的 agent 看——worktree 的**析构**约定就写在 `worktree-service` 的 `system_prompt` 末尾，没有独立字段）。

这三个散文字段都可以写成 `@<路径>`，把正文放进旁边的独立文件（见〈提示词写在自己的文件里〉）。
- `child_templates`：该实例允许创建的子模板（相对自己文件的路径，或模板名；`*` 表示全部）。
- `variables`：变量声明，分 `immutable` / `mutable`；每个变量有 `description`（必填）与可选 `required` / `default` / `pattern` / `max_length` / `single_line`。

模板按层级顺序加载（能创建某个模板的模板排在它前面），`available_child_templates` 也是这个顺序。`$LUSH_HOME/templates/**/*.json` 可以加用户模板，重启后生效。

### 提示词写在自己的文件里

JSON 字符串里不能有真正的换行，所以 `system_prompt` 这种多段散文写在 JSON 里只能是一行 `\n` 转义——编辑器里读不了、`git diff` 里看不见改了哪句。于是 `description` / `construct_prompt` / `system_prompt` 三个散文字段可以写成 `@<路径>`，由 loader 相对**声明它的模板文件**读取并内联（与 `child_templates` 同一条相对路径规则）：

```json
{
  "name": "project",
  "construct_prompt": "@project/construct_prompt.md",
  "system_prompt": "@project/system_prompt.md"
}
```

- `@` 只在字符串整值等于 `@<路径>` 时生效，不是字符串插值；文件末尾由编辑器补的那一个换行会被去掉，CRLF 归一化成 LF，其余内容原样保留（不递归解析：文件里以 `@` 开头的第一行就是正文）。
- 引用必须是可读文件：文件不存在、路径为空、或模板是程序化 `register` 注册的（没有文件可相对）都报 `-32602`，**绝不退化成字面量**。
- 校验与快照看到的都是内联后的正文（长度上限、`service.view --with prompt`、创建时写入 Context 的 `system_prompt` 都是展开后的文本）。
- 这些 `.md` 与模板 JSON 一样属于「喂给 agent 的提示词面」：`src/identity.js` 的 fingerprint 同时哈希 `templates/**/*.json` 与 `templates/**/*.md`，改了提示词文件同样要 `bun run daemon-restart`。

### 保留变量名

| 名字 | 含义 |
| --- | --- |
| `path` | 工作目录：必须存在、必须是绝对路径、只能 immutable；它同时是该节点上所有 task 的 cwd |
| `name` | 服务名：`--name` 与 `variables.name` 是同一个值，格式按声明校验 |
| `title` / `detail` | 节点的一行摘要与详情正文，`service list` / `tree` / `inspect` 会渲染 |
## 仓库模板的摆放

每个模板 `<name>.json` 旁边有一个同名文件夹 `<name>/`，里面放它能直接创建的模板（被多个模板创建的共享模板跟最浅的那个父模板放一起），于是目录本身就是 构造树：

```text
templates/lush-root.json
templates/lush-root/{construct_prompt,system_prompt}.md
templates/lush-root/project-manager.json
templates/lush-root/project-manager/{construct_prompt,system_prompt}.md
templates/lush-root/project-manager/{project,generic-task,generic-service,research-task}.json
templates/lush-root/project-manager/project/dev-task.json
templates/lush-root/project-manager/project/dev-task/worktree-service.json
```

`<name>/` 因此装两样东西：`<name>` 自己的两段提示词（`construct_prompt.md` / `system_prompt.md`），和它能直接创建的模板（`.json`）。`child_templates` 写相对自己文件的路径（`lush-root/project-manager.json`、`project/dev-task.json`、`dev-task/worktree-service.json`、同目录的 `generic-task.json`），loader 递归读取并把它解析成模板名，白名单、快照与权限比对里始终只有名字；也接受直接写模板名（程序化 `register` 没有文件可相对，旧用户模板继续可用）。`$LUSH_HOME/templates/**/*.json` 可增加新模板，不覆盖仓库模板，重启后加载。

**SID 0 只能创建 `project-manager`**：`lush-root` 的 `child_templates` 只有这一项，用户模板同样不在其列（列表是显式的，没有 `*`）。

### 随仓库发布的模板

- `project-manager`（SID 0 的子模板，单例）：开 / 关项目。它创建 `project` / `research-task` / `generic-task` / `generic-service`，不含 `project`（嵌套 project 在创建时被白名单拒绝，-32010）。
- `project`（非单例）：必须提供 immutable 变量 `path`（已存在的绝对目录，会成为 agent 的 cwd，也是它建 worktree / 跑 merge 的主工作树），另有 mutable 变量 `branch`（默认 `main`）。它的 `system_prompt` 按 goal 分**两个阶段**。**阶段 1（goal 不以「合并」/「回收」开头）**：先按「一批活」拆分（明显多条才拆，一条不硬拆），为每件起一个唯一短名（先查 `git worktree list` / `branch --list` / children 里 dev-task 的 name），**串行执行 `git worktree add`**（多路并行时若各 dev-task 各自建，分支名与目录会互相撞车），再按目标模板自己的 `construct_prompt` / `variables` 声明用 `service_construct` 建 dev-task、`task_construct` 派活（一次可派多个），然后结束本轮等子 task；全部结算后把待决清单（name / 分支 / worktree / 改动 / 验证 / 结论）写进 state 的 `worktrees` 键，用 `wait: false` 的 notice 报给用户并 `task_complete` 收尾——**阶段 1 不挂靠、不等人**：`wait: false` 是纯记录，而默认的 `wait: true` 会把那个 task 停在 awaiting，在用户处理前一直占着节点。**阶段 2（goal 以「合并」/「回收」开头，语法 `合并：<name>=yes|no[@<目标分支>] … 回收：<name>=yes …`）**：核对 state 与各 worktree-service 节点的 path / 分支 / 主仓库 / HEAD 后，在主工作树 path 执行 `git merge --no-ff <branch>`（有冲突就停下报告），合并必须逐件串行；回收则给对应 dev-task 开 goal 以「回收」开头的 task（互不相干的 worktree 可一次派多个），dev-task 执行析构（stop 那个 worktree-service → `git worktree remove` + `git branch -d`），project 再据其 result 决定是否把 dev-task 节点也 stop（记录保留）；有未提交改动时只有用户给了 force 才加 `--force`；绝不 force push / rebase。两个阶段的划分源于一条不变量：**合并是「主工作树」这一个资源的串行操作**，而开发可以并行。
- `dev-task`（`project` 的子模板）：用三个正式字段描述一项开发任务——`name`（`^[A-Za-z][A-Za-z0-9_-]*$`、≤64，同时就是服务名，用来命名相关的 worktree / 分支）、`title`（一行摘要、≤200，`service list` 与 `inspect` 显示的就是它）、`detail`（详情正文，可多行、可空、≤20000）；`lush service construct 1 dev-task --name fix-login --title 修复登录流程 --detail 正文`。worktree 归谁建：**project 在派开发 task 时会把 `worktree=<目录> branch=<分支>` 写进 goal**，它已经串行建好了，dev-task 直接复用、不再 `git worktree add`；只有 goal 里没有 worktree、且没有「不要新 worktree / 就在当前工作树上改」这类例外时，dev-task 才自己建（独立使用时的兜底），否则一律把实际改动派给 `worktree-service` 在它自己的 worktree 里用 agent 做。它自己**不执行合并、也不问用户**：把 worktree-service 的结构化结果（`merge` 在阶段 1 一律是 `null`）原样向上转达给 project，是否合并由用户在 project 的阶段 2 答复。它也是**析构的执行者**：goal 以「回收」开头的 task（`回收：worktree=… branch=… repo=… target=… force=…`）不是开发任务，它不新建 worktree，只核对那个 worktree-service 节点的 state → 自检（`git status --porcelain` 空、分支已合并）→ `lush service stop <worktree-service SID>`（service 被回收，记录保留）→ `git -C <repo> worktree remove <path>` [--force] + `git -C <repo> branch -d <branch>`，把 `reclaimed` / `kept` / `destructible` / `reason` / `evidence` 写进 result；自检不过且用户没给 force 时什么都不删。
- `worktree-service`（`dev-task` 的子模板）：一个 git worktree 一个管理器，只声明保留变量 `path`（必填、不可变、已存在的绝对目录，缺失 / 相对 / 不存在都在创建时被拒），同一个变量就是它的 agent 工作目录，所以它一被 call 就站在那个 worktree 里；`construct_prompt` 说明这个目录通常已由 project 用 `git worktree add` 建好、并要求先看 `children` 复用相同 `path` 的实例。它的 `system_prompt` 不做合并决定也**不阻塞等人**：改动做完并验证过后如实 `task_complete`，把 `merge: null, target: null` 与 worktree / 分支 / repo / 验证结果写进 result——一次开发有好几路并行，谁都不该被一个人的答复拖住；是否合并由用户在 project 的阶段 2（goal 以「合并」开头的 task）里决定、再由 project 在主工作树里执行。它自己绝不 merge / push / 删 worktree。`system_prompt` 末尾写着它的**析构契约**：回收是用户的决定、由 dev-task 在它被 stop 之后执行，它必须把 path / 分支 / 主仓库 / HEAD 写进持久 state（回收时删哪个目录、哪个分支、删到哪个 commit 只认这四项），worktree 干净且分支已合并回收才能成立，它自己不删任何东西。
