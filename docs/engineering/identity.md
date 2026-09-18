# daemon 与 CLI 的版本对齐

> 工程层：为什么「我敲的命令」和「应答我的 daemon」可能不是同一份代码，以及怎么判断。

仓库里的开发流程与 worktree 检查清单见根目录 [AGENTS.md](../../AGENTS.md)；实现见 [`src/identity.js`](../../src/identity.js)（注释即设计文档）。

## 两层模型

- **CLI 是纯客户端**：通过 Unix socket 上的 JSON-RPC 操作 daemon，自身不持有状态。谁应答你，由 **`LUSH_HOME` 指向的 socket** 决定，与 worktree 无关。
- **你敲的命令用哪份 CLI 代码** = 你所在的 worktree（`./bin/lush` 是相对路径；`bun run lush` 由 bun 从 cwd 向上找最近的 `package.json`）。
- **一个 home 只能有一个 daemon**（`daemon.lock` 单实例锁）。`daemon start` 发现已有 daemon 时直接返回 `already_running`，**不会替换版本**：先启动的那份代码会一直应答，换版本只能用 `daemon restart`（先 stop 等锁释放，再 start）。
- **daemon 是长驻进程，版本在启动瞬间冻结**：`src/agent/guide.js`（喂给 agent 的提示词）、`src/cli/tree/`（CLI 声明树）、`templates/**/*.json` 都在启动时读入内存。改了这些，不 restart 不生效；改运行期代码（`src/core/`、`src/daemon/`、`src/persistence/`）同理。
- **agent 子进程里的 `lush` 也被钉死在 daemon 那份代码上**：`src/agent/pi.js` 把 daemon 自己 checkout 的 `bin/` 前置进 PATH（`LUSH_BIN_DIR`）。所以 agent 调 `lush` 用的是 daemon 的版本，不是你敲命令的版本。

## 判断是否错位

```bash
just status    # 等价于 lush daemon status
```

看 `cli.code_match`：

- `true` → 应答你的 daemon 和当前 CLI 是同一份代码，正常。
- `false`，且 `code_dir` 不同 → **别的 checkout 的 daemon** 在应答（典型：共用 home，或 `cd` 到另一个 worktree 敲命令）。
- `false`，且 `code_dir` 相同、`fingerprint` 不同 → **同一份代码，但 daemon 是改动前启动的** → `just daemon-restart`。
- 完全不报 `code_dir` / `fingerprint` → daemon 版本太老，只能靠 `ps` / `LUSH_HOME` 人工判断——这是最危险的情况，此时新版 CLI 会告警、老 CLI 则完全静默。

只要不匹配，任何 `lush` 命令都会在 stderr 告警，并给出该重启哪一个 home。

## fingerprint 覆盖什么、不覆盖什么

fingerprint 只哈希 `src/agent/guide.js`、`src/cli/main.js`、`src/cli/tree/*.js`（CLI 声明树）与 `templates/**/*.json`（递归，含嵌套子目录）。所以 `cli.code_match: true` 仅表示「**喂给 agent 的提示词与 CLI 声明面**」一致，**不代表整个代码库一致**：改 `src/core/`、`src/daemon/`、`src/persistence/` 等运行期代码不会改变 fingerprint，但行为会变。**改任何运行期代码后同样要 restart daemon。**

## 重启的边界

- `restart` 只重启 `LUSH_HOME` 指向的那一份 daemon。另一个 home 的 daemon 不会被碰，任何命令都影响不到它。
- 分开在不同 shell 里跑 `lush`（其中一个没有 `export LUSH_HOME`，走 `~/.local/state/lush`）就是两个 daemon、两棵树、两份历史。
- 改代码后 `daemon start` 是无效操作（幂等），只有 `restart` / 或者先 `stop` 再 `start` 才换版本；测试与演示留下的孤儿 daemon 用 `just prune`。
