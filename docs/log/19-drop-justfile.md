# 19 · 删掉 Justfile：把开发 / 操作入口迁到 `package.json` scripts（`bun run`）

> 入口面收敛到一种工具：仓库本来就要 bun，Justfile 只是额外的一层。这一轮删掉根目录的 Justfile（51 个 recipe），把每个入口搬成 `package.json` 的 script（`bun run <name>`），环境语义（仓库内 `.lush`、外部 `LUSH_HOME` 优先、`pi` provider、两个超时、CLI 走 `bun ./bin/lush`）与带参数 / 多步 recipe 的行为等价保留；文档与源码里把 `just` 当命令用的引用同步改写。

## Done

- [x] **清点 Justfile**：`just --list` 共 **51 个 recipe**（原需求记的是 57；以 `just --list` 与源码为准）。`default` 由「`bun run` 不带参数时列出全部 script」替代，其余 50 条一一对应。

- [x] **`package.json` scripts 化**：`"test"` 保留 `bun test`（`bun run test openai` 原生按文件名过滤），`"lush"` / `"lushd"` 保留原样的 `bun run bin/lush` / `bun run bin/lushd`（它们是 AGENTS.md 告警里那条**不带仓库 home 的逃生口**，故意不给默认 `LUSH_HOME`）。其余入口都是 `bun ./scripts/ops.js <name>`；`bun run`（无参数）列出全部 script。

- [x] **环境语义集中到 `scripts/lib.js`**：`LUSH_HOME` 缺省 `<repo>/.lush`（外部已 export 的值优先，用 `env.LUSH_HOME ||` 实现，不覆盖）、`LUSH_PROVIDER` 缺省 `pi`、`LUSH_CALL_TIMEOUT` 缺省 `900`、`LUSH_RPC_TIMEOUT` 缺省 `910`；所有 CLI 调用走本 checkout 的 `bin/lush`（daemon / web 走 `bin/lushd` / `bin/lush-web`）。脚本根目录由 `scripts/` 向上推出（package root），不依赖调用时的 cwd。

- [x] **带逻辑 / 多步 / 带位置参数的 recipe 全部有等价入口**：`scripts/ops.js` 负责参数装配（`reset.js` / `prune.js` 是两个较长的实现）。参数按 argv 数组直接传给 CLI，不再经过 shell 拼接，所以 `construct` 的 7 个位置参数、`{}` JSON 变量、`answer` 的多个 `key=value` 都不会被二次引号化。

  | Justfile recipe | 入口 | 关键行为 |
  | --- | --- | --- |
  | `default` | `bun run` | 列出全部 script |
  | `help` | `bun run help` | `lush help` |
  | `web port` | `bun run web [port]` | `LUSH_WEB_PORT` 默认 4318 |
  | `doctor` | `bun run doctor` | bun / LUSH_HOME / provider / code / daemon status，未运行时打 `daemon stopped` |
  | `test *args` | `bun run test [args]` | `bun test` + 过滤 |
  | `bootstrap` | `bun run bootstrap` | daemon start → construct project-manager → construct implement-login → tree |
  | `clean` | `bun run clean` | 先停 daemon，仅当 `LUSH_HOME` 在仓库内才 `rm -rf`，否则只提示 |
  | `reset yes` | `bun run reset [yes]` | 未运行时直接 start；否则列根节点 → 要 `yes`（或跳过）→ 逐个 `service purge --recursive` → `daemon restart`；purge 失败退出非 0 |
  | `prune mode` | `bun run prune [all]` | 默认只清 home 目录已消失的 daemon；`all` 连仍存在的临时 home；从不碰当前 / 默认 home |
  | `daemon-start/stop/restart` | 同名 `bun run` | 透传 |
  | `status` / `log` / `foreground` | 同名 `bun run` | `log` = `tail -n 50 $LUSH_HOME/daemon.log`；`foreground` = 前台 `bin/lushd` |
  | `ps` / `tree` / `agent` | 同名 `bun run` | `lush service list` / `service tree` / `agent ...` |
  | `orphans sweep` | `bun run orphans [sweep]` | 有参数追加 `--sweep` |
  | `inspect sid sections` | `bun run inspect <sid> [sections]` | 有 sections 追加 `--with` |
  | `history task after limit` | `bun run history <task> [after] [limit]` | 默认 `0 100` |
  | `call sid prompt dry` | `bun run call <sid> <prompt> [dry]` | 有第三参追加 `--dry-run` |
  | `enter` / `detach` | 同名 `bun run` | `--interactive` / `--detach` |
  | `tasks` / `task-tree` / `task-inspect` / `result` / `wait` / `cancel` | 同名 `bun run` | 透传（`tasks` 可带 sid） |
  | `task-construct sid goal parent` | `bun run task-construct <sid> <goal> [parent]` | 有 parent 追加 `--parent-task-id` |
  | `attach` | `bun run attach <task>` | 透传 |
  | `construct parent template name goal vars agent title detail` | `bun run construct ...` | 位置参数映射到 `--name/--goal/--vars/--agent/--title/--detail` |
  | `complete` / `task-state` / `update-state` / `update-vars` | 同名 `bun run` | 透传（`--result` / `--patch` / `--vars`） |
  | `session task open` | `bun run session <task> [open]` | 有第二参追加 `--open` |
  | `agents all` | `bun run agents [all]` | 有参数追加 `--all` |
  | `task-message to body from` | `bun run task-message <to> <body> [from]` | 有 from 追加 `--from` |
  | `inbox` / `trace task limit` | 同名 `bun run` | `trace` 默认 `--limit 200` |
  | `start` / `stop` / `delete` / `purge` | 同名 `bun run` | `delete` / `purge` 有第二参追加 `--recursive` |
  | `notices status` | `bun run notices [status]` | 有状态追加 `--status` |
  | `notice id` | `bun run notice <id>` | `notice show` |
  | `answer id *sets` | `bun run answer <id> [k=v ...]` | 每个 `k=v` 变 `--set k=v` |
  | `answer-text id text` | `bun run answer-text <id> <text>` | `--text` |
  | `dismiss id reason` | `bun run dismiss <id> [reason]` | 有 reason 追加 `--reason` |

- [x] **`prune` 的 `sid` → `pid`（顺带修一个 macOS 上的死 bug）**：Justfile 用 `ps -eo sid=,command=`，BSD ps 直接报 `sid: keyword not found`，所以在 macOS 上 `just prune` 永远「没有运行中的 daemon」。改用 `ps -eo pid=,command=`（两平台通用；daemon 是 detached，本来 pid 即 sid），行为不变、在 macOS 上真的能清。

- [x] **文档与提示词面**：AGENTS.md「铁律」整节（保留「不要裸跑 `./bin/lush` / `bun run lush`」与 `LUSH_HOME` 覆盖两条告警，并说明 `lush` / `lushd` script 保持不带默认 home）、README.md「常用命令」整节与文内引用、`docs/reference/cli.md`（标题 + 常用命令整节）、`docs/README.md`、`docs/engineering/identity.md`、`docs/concepts/service-model.md`、`docs/reference/ui.md`、`docs/reference/templates.md` 全部改成 `bun run`；源码里用户可见的引用：`src/cli/tree/daemon.js` help 文本、`src/cli/main.js` 注释、`src/identity.js` 注释。`docs/log/**` 的历史条目一律不改，本轮新增本条目并在 `docs/log/README.md` 索引加一行。

## 验收

- `bun test`：**184 项全绿**。基线 commit 上就有一个环境泄漏：测试帮助函数 `{...process.env}` 会把 agent 会话里的 `LUSH_TASK_ID` / `LUSH_SID` 带进去，`task construct` 会拿它当缺省父 task 而报 `task not found`（基线在 agent 环境里只有 182/2）。本轮顺手在 `test/cli.test.js` 的 `setup()` 里清掉这两个变量（测试不应继承 agent 会话），使 `bun test` / `bun run test` 在任何环境里都是 184 全绿。
- `Justfile` 不存在（`git rm`）。
- 除 `docs/log/**` 历史外，`grep -E '\bjust[[:space:]]+[a-zA-Z]'` 只剩英文单词 `just` 的误报（`just a start` 等），没有把 `just` 当命令的引用。
- 冒烟（都在本 worktree 的临时 `LUSH_HOME` 里，不碰全局 daemon）：`bun run doctor`、`bun run test`、`bun run`（列出 52 个 script）、`bun run orphans sweep`（参数透传）、`bun run reset yes`（purge 1 → daemon restart → 树只剩 SID 0）、`bun run prune`（清掉 home 目录已消失的 daemon，保留默认 home 与当前 home）、`bun run prune all`、`bun run clean`（仓库内 `.lush` 删除、仓库外只提示）、notice 全流程（`notices` / `notice` / `answer 1 plan=canary` / `answer-text` / `dismiss 2 '原因'`）、task 全流程（`task-construct` / `tasks` / `task-tree` / `task-inspect` / `result` / `history` / `trace` / `inbox` / `session` / `agents`）、`bun run web 4399`（HTTP 200）。
- 改了 `src/cli/tree/**`、`src/cli/main.js`（fingerprint 面）→ 已在临时 home 上验证 `bun run daemon-restart` 后 help 文本生效；全局 home 的 daemon 未被重启。

## 备注

- **`bootstrap` 与文档示例引用的 `generic-task` 本来就不存在**（生产模板只剩 `lush-root` 嵌套的 project-manager / project / dev-task / worktree-service）。Justfile 的 `bootstrap` 与 `construct 1 generic-task ...` 在删 Justfile 之前就会 `template not found`，本轮按原样保留等价入口，不静默改语义；要用可跑通的最小流程，改成 `bun run construct 0 project-manager project-manager`（name 是第 3 个位置参数）。
- **`just` 的 `*args` 在 `bun run` 下没有同名对应得最直白**：`test *args` 由 `bun test` 原生接住（`bun run test openai`），`agent *args` / `answer *sets` 由 `scripts/ops.js` 配平；`bun run` 会把多余参数原样附在 script 末尾，行为与逐个手敲 CLI 一致。
- `scripts/` 里的注释保留了「Ports the Justfile's …」这类迁移动机说明，方便后来者对照；除 bun 外没有引入任何依赖，`bun install` 不是必需步骤。
