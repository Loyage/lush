# Agent 指导：手动预装远端执行节点（Runner）

本文交给在**远端服务器**上操作的 AI coding agent：在该机器上准备一个可被 Lush 中央连接的 Runner 执行节点。它回答「需要哪些环境、放哪些文件、如何配置与核验」；接口、权限、凭据与生命周期契约以 [Runner 管理接口](../reference/rpc/runners.md) 和 [Runner 协议](../engineering/runner-protocol.md) 为准，本文不复制规则。中央侧的登记、检查、固定身份与项目授权是**用户专属**动作，不在远端完成。本机要部署的是执行节点，不是 Lush 后台；部署 Lush 本身见[本机 Agent 指导](agent-guide.md)。

## 目标与边界

- 目标：让 `ssh <alias> lush-runner serve` 能在**非交互会话**里启动一个 Runner 节点（读节点配置 → 通过 cgroup v2 预检 → 在 stdin/stdout 上等待中央握手）。
- 只在这台服务器上操作；不得改动用户的 SSH 配置、不得开放任何监听端口、不得安装 Lush daemon / Host。
- 不得把令牌明文写入磁盘、argv、日志或报告：远端只需要哈希，明文只进入中央 Lush。
- 需要 root 或 `sudo` 的步骤先征得用户同意；Runner 本体以普通用户运行，不以 root 运行。
- 每一步都要能验证；输入缺失或环境不满足时停下来问用户，不要猜。

## 开始前需要的输入

向用户索取以下值；任一缺失就停下。**只要哈希，不要令牌明文。**

| 输入 | 说明 |
|---|---|
| `node_id` | 中央「执行节点」登记后生成的稳定 UUID |
| `project_id` | 中央项目配对身份（`runner project get` 的稳定 ID） |
| `machine_token_hash` | 机器令牌字符串的 SHA-256（小写 hex，64 字符） |
| `control_token_hash` | 该项目控制令牌字符串的 SHA-256（小写 hex，64 字符） |
| runner 闭包来源 | 与中央版本一致的 Lush 检出（路径或归档） |
| SSH 别名 | 中央用来连接本机的别名（如 `thinkpad`），仅用于核验 |

令牌由用户生成，用 `printf '%s' "$TOKEN" | sha256sum` 得到哈希；明文由用户通过中央 `runner credentials set` 保存。

## 1. 环境核对

```bash
uname -s -m                                  # 必须是 Linux + x86_64 / aarch64
bun --version                                # >= 1.2.0
git --version
test -f /sys/fs/cgroup/cgroup.controllers && echo cgroup-v2   # cgroup v2 必需
systemctl --user is-system-running 2>/dev/null || true
```

非 Linux、无 cgroup v2 或 Bun 版本不足时不得继续。Runner 使用 `bun:sqlite`、`bun:ffi` 与真实 cgroup v2，没有降级路径。

## 2. 放置 Runner 闭包

从与中央一致的 Lush 检出复制以下文件（保持相对路径；Runner 闭包零第三方运行时依赖）：

```
bin/lush-runner
src/runner/*.js
src/core/types.js
src/core/workspaces/code.js
src/core/workspaces/code-io.js
src/core/workspaces/code-model.js
src/core/workspaces/code-posix.js
```

中央按固定命令 `lush-runner serve` 启动，必须让它在**非交互 SSH 会话**里可解析。稳妥做法是安装一个显式调用 Bun 的 wrapper（`bun` 可能不在非交互 PATH 中）：

```bash
install -d -m 0755 ~/.local/share/lush-runner-runtime
cp -R <检出>/bin <检出>/src ~/.local/share/lush-runner-runtime/
printf '#!/bin/sh\nexec %s %s "$@"\n' "$(command -v bun)" "$HOME/.local/share/lush-runner-runtime/bin/lush-runner" \
  | sudo tee /usr/local/bin/lush-runner >/dev/null
sudo chmod 0755 /usr/local/bin/lush-runner
lush-runner --help
```

`--help` 应输出 `lush-runner serve` 用法。若用户不允许写 `/usr/local/bin`，改用其它在非交互 PATH 内的目录；不要把可执行文件只放在 `~/bin`。

## 3. 准备专属 cgroup v2 子树

Runner 要求一个**已委托、当前用户可写**的 cgroup v2 子树，且不能是 `/sys/fs/cgroup`。以 systemd user 服务承载：

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/lush-runner-cgroup.service <<'EOF'
[Service]
Type=oneshot
RemainAfterExit=yes
Delegate=yes
ExecStart=/bin/true
EOF
systemctl --user daemon-reload
systemctl --user enable --now lush-runner-cgroup.service
sudo loginctl enable-linger "$USER"   # 无长驻会话时保持用户管理器与 cgroup 存在（需用户同意）
```

取得路径并核验：

```bash
CG="/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value lush-runner-cgroup.service)"
echo "$CG"
ls -ld "$CG" && cat "$CG/cgroup.type"         # 期望 domain
test -w "$CG/cgroup.procs" && test -w "$CG/cgroup.kill" && echo writable
```

该绝对路径（realpath 后一致、不含符号链接）就是配置里的 `cgroup_root`。

## 4. 写节点配置

创建 `~/.config/lush-runner/config.json`（**0600，owner-only**；目录建议 0700）：

```json
{
  "version": 1,
  "root": "/home/<user>/.local/share/lush-runner",
  "node_id": "<node_id>",
  "machine_token_hash": "<machine_token_hash>",
  "projects": { "<project_id>": { "control_token_hash": "<control_token_hash>" } },
  "cgroup_root": "<第 3 步的 CG 绝对路径>"
}
```

- `root`、`cgroup_root` 必须是绝对且 realpath 一致的路径（途中不得有符号链接）；`root` 不存在会以 0700 创建。
- 只允许 `version`、`root`、`node_id`、`machine_token_hash`、`projects`、`cgroup_root`、`max_commands`、`memory_reserve_bytes`、`output_storage_bytes`、`budgets`、`command_path`、`command_env_allowlist`；未知字段会被拒绝。
- 安装身份 `runner_id` 不在配置里，由 Runner 首次启动在本机数据库生成，由中央检查返回后由用户固定。

```bash
chmod 0700 ~/.config/lush-runner && chmod 0600 ~/.config/lush-runner/config.json
```

## 5. 本机核验

```bash
lush-runner serve </dev/null; echo "exit=$?"
```

| 现象 | 含义 |
|---|---|
| 静默、`exit=0` | 配置与 cgroup 预检通过，节点可被中央连接 |
| `{"code":"UNSUPPORTED",...}` | `cgroup_root` 不对、不可写或不是 cgroup v2 |
| `{"code":"UNAVAILABLE","code":"INVALID_REQUEST",...}` | 配置读不到：权限不是 0600、非当前用户所有、路径含符号链接或字段非法 |

直接在终端运行 `lush-runner serve`（不带重定向）会看起来「卡住」，那是正常的：它在等协议帧，`Ctrl-D` 退出。它不是常驻服务，由中央按每条 SSH 连接启动，核验后无需保留进程。

## 6. 交回中央（用户动作）

远端只需向用户报告：`node_id`、`project_id` 已写入，本机核验结果，以及 `cgroup_root`。用户随后在 Lush 管理入口完成：登记节点 → `runner credentials set` 保存明文令牌 → `runner nodes check` 核对返回的 `runner_id` → 固定 `expected_runner_id` → `runner project set` 授权并设默认节点。具体参数、revision 与失败处理见 [Runner 管理接口](../reference/rpc/runners.md#手工预装节点首次配对与失败处理)。

## 7. 安全边界

- Runner 以普通用户运行；不 `sudo` 启动、不写系统级 cgroup、不改 `/sys/fs/cgroup` 根或 SSH 配置。
- 节点配置 owner-only；服务器上不得留存令牌明文、私钥副本或认证响应。
- 不自动固定安装身份、不自动授权项目、不创建 Worker；这些是用户专属动作。
- 不动用户已有的 Runner 安装或配置；已有未知安装应停下报告，不覆盖。
- 真实 SSH、cgroup 与跨机执行需用户实机验收；本机烟测不等于完整链路已验收。

## 8. 排错速查

| 现象 | 处理 |
|---|---|
| `command not found: lush-runner` | wrapper 未放非交互 PATH；核对 `/usr/local/bin/lush-runner` 与 `bun` 绝对路径 |
| `lush-runner --help` 报错 | wrapper 的 Bun 路径或闭包不完整；核对 `bin` 与 `src` 相对结构 |
| `{"code":"UNSUPPORTED"}` | 重新核验 `cgroup.type=domain`、可写、realpath 一致、非 `/sys/fs/cgroup` |
| `{"code":"UNAVAILABLE"}` | `config.json` 权限/所有者/符号链接问题 |
| 中央 `runner.nodes.check` 失败 | 中央连接细节与凭据配对见管理接口；核对令牌哈希与 `project_id` 是否一致 |
| 用户会话结束后 cgroup 消失 | `loginctl enable-linger` 未开启，或服务未 `enable` |

## 9. 交付结果

报告：机器与架构、Bun/Git 版本、闭包路径与版本来源、`cgroup_root`、`config.json` 权限、实际执行的核验命令与输出、未验证项。不包含令牌明文、私钥或原始认证响应。失败保留完整输出，不自动重试或改动系统。

---

[返回部署索引](README.md) · [Runner 管理接口](../reference/rpc/runners.md)
