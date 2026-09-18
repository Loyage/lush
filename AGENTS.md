# AGENTS.md

Lush —— AI 的操作系统（持久化逻辑 Process + agent runtime）。Bun / JavaScript，零第三方依赖。

这个文件只讲一件最容易出错、且会静默出错的事：**你敲的命令、真正应答你的 daemon、以及 agent 子进程里的 `lush`，可能是三份不同版本的代码。** 多个 worktree 并行开发时尤其如此。

## 铁律：在这个仓库里一律走 `just`

Justfile 把 `LUSH_HOME` 默认设为仓库内的 `.lush/`（已 gitignore），所以**每个 worktree 天然拥有自己独立的 daemon、数据库、socket**：

```bash
just                 # 列出所有命令
just doctor          # bun / LUSH_HOME / provider / code 目录 / daemon 状态
just test / demo / verify
just daemon-start / daemon-restart / daemon-stop / status / log
just ps / tree / inspect / call / spawn / complete / reclaim ...
just reset [yes]     # 推倒重来：清空本 home 的进程树（只剩 PID 0）并重启 daemon；默认要输 yes，不可逆
just clean           # 停 daemon 并删本仓库的 .lush
```

- **不要**裸跑 `./bin/lush`、`bun run lush` 或 `bun lush`：它们用默认 home（`$XDG_STATE_HOME/lush` 或 `~/.local/state/lush`），会和**别的 worktree 或你日常那份**共用同一个 daemon —— 你敲的是这份代码，应答的是另一份。
- 确实需要裸跑时，显式指定 home：`LUSH_HOME=$PWD/.lush bun ./bin/lush ...`
- 若你 shell 里 `export LUSH_HOME=...`，`just` 会采用你的值，隔离就失效了（`just doctor` 会显示实际的 `LUSH_HOME`）。

## 为什么：两层模型

- **CLI 是纯客户端**，通过 unix socket 上的 JSON-RPC 操作 daemon，自身不持有状态。谁应答你，由 **`LUSH_HOME` 指向的 socket** 决定，**与 worktree 无关**。
- **你敲的命令用哪份 CLI 代码** = 你所在的 worktree（`./bin/lush` 是相对路径；`bun run lush` 由 bun 从 cwd 向上找最近的 `package.json`）。
- **一个 home 只能有一个 daemon**（`daemon.lock` 单实例锁）。`daemon start` 发现已有 daemon 时直接返回 `already_running`，**不会替换版本** —— 先启动的那份代码会一直应答；要换版本只能用 `daemon restart`（先 stop 等锁释放，再 start）。
- **daemon 是长驻进程，版本在启动瞬间冻结**：`src/agent/guide.js`（喂给 agent 的提示词）、`src/cli/tree/`（CLI 声明树）、`templates/**/*.json`（模板按 spawn 树分层嵌套）都在启动时读入内存。改了这些，**不 restart 就不生效**（`just daemon-restart` / `lush daemon restart`，等价于 stop + start）。
- **agent 子进程里的 `lush` 也被钉死在 daemon 那份代码上**：`src/agent/pi.js` 把 daemon 自己 checkout 的 `bin/` 前置进 PATH（`LUSH_BIN_DIR`）。所以 agent 调 `lush` 用的是 daemon 的版本，不是你敲命令的版本。

## 排障：一条命令判断是否错位

```bash
just status    # 等价于 lush daemon status
```

看 `cli.code_match`：

- `true` → 应答你的 daemon 和当前 CLI 是同一份代码，正常。
- `false` → 看 `code_dir` 与 `fingerprint`：
  - `code_dir` 不同 → **别的 checkout 的 daemon** 在应答（典型：共用 home、或 `cd` 到另一个 worktree 敲命令）。
  - `code_dir` 相同但 `fingerprint` 不同 → **同一份代码，但 daemon 是改动前启动的** → `just daemon-restart`。
  - 完全不报 `code_dir`/`fingerprint` → daemon 版本太老（见下「边界」）。

只要不匹配，任何 `lush` 命令都会在 stderr 告警，并给出该重启哪一个 home，例如：

```text
lush: warning: lushd pid=14945 (home=...) runs different code -- different checkout: daemon /path/A, cli /path/B
lush: warning: restarted code only applies to the daemon you restart; run 'LUSH_HOME=... lush daemon restart'
```

## 新 worktree 检查清单

1. 所有 lush 操作用 `just`（自动 `.lush`，零配置隔离）。
2. 进来先 `just doctor`，确认 `LUSH_HOME` 是本 worktree 的 `.lush`、`code` 是当前目录。
3. 改代码或提示词（`guide.js` / `cli/tree/` / `templates/`）后 → **`just daemon-restart`**（`daemon-start` 遇到已有 daemon 不会换版本）。
4. 不要在 worktree A 里、用 worktree A 的 home，去操作属于 worktree B 的 daemon；怀疑错位就先 `just status`。
5. 收工可选 `just clean`；测试/演示留下的孤儿 daemon 用 `just prune`（`just prune all` 连临时 home 一起清）。

## 边界：fingerprint 覆盖什么、不覆盖什么

- fingerprint 只哈希 `src/agent/guide.js`、`src/cli/main.js` 与 `src/cli/tree/*.js`（CLI 声明树）、`templates/**/*.json`（递归，含嵌套子目录）。所以 `cli.code_match: true` 仅表示「**喂给 agent 的提示词与 CLI 声明面**」一致，**不代表整个代码库一致**：改 `src/core/`、`src/daemon/`、`src/persistence/` 等运行期代码不会改变 fingerprint，但行为会变。**改任何运行期代码后同样要 restart daemon。**
- 老版本 checkout（例如 main 分支上还没有 `src/identity.js` 的版本）启动的 daemon 不报告 `code_dir`/`fingerprint`：新版 CLI 会把它判为 stale 并告警，**老 CLI 则完全静默** —— 这是最危险的情况，此时只能靠 `ps` / `LUSH_HOME` 人工判断。

## 相关文档

- `README.md` 的「改代码或提示词之后，先确认你重启的是哪个 daemon」一节：同一问题的单 worktree 视角。
- `docs/`：文档按概念 / 参考 / 工程 / 历史四层组织，入口是 `docs/README.md`；
  模块边界与整体架构在 `docs/engineering/architecture.md`，daemon 与 CLI 的版本对齐在 `docs/engineering/identity.md`。
- `src/identity.js`：identity / fingerprint 机制的实现与设计理由（注释即设计文档）。
