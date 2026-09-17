# Lush — Operating System for AI
# Bun / JavaScript，零第三方依赖；本文件是日常开发与操作的入口。
#
#   just                列出所有命令
#   just test           跑测试
#   just demo           完整演示
#   just daemon-start   起 daemon，然后用 just tree / just call 操作

set shell := ["zsh", "-uc"]

# 开发数据目录：默认仓库内 .lush（已被 .gitignore 忽略），可用 LUSH_HOME 覆盖
export LUSH_HOME := env_var_or_default("LUSH_HOME", justfile_directory() / ".lush")
export LUSH_PROVIDER := env_var_or_default("LUSH_PROVIDER", "mock")
export LUSH_CALL_TIMEOUT := env_var_or_default("LUSH_CALL_TIMEOUT", "120")
export LUSH_RPC_TIMEOUT := env_var_or_default("LUSH_RPC_TIMEOUT", "130")

# CLI 入口；无需安装（bun link 之后也可以直接用 lush / lushd）
lush := "bun ./bin/lush"

# ─────────────────────────────────────────────────────────────────────────────
#  入口
# ─────────────────────────────────────────────────────────────────────────────

# 列出所有命令
default:
  @just --list

# ─────────────────────────────────────────────────────────────────────────────
#  开发与验证
# ─────────────────────────────────────────────────────────────────────────────

# 检查工具链、数据目录与 daemon 状态
[group('dev')]
doctor:
  @echo "bun       $(bun --version)"
  @echo "LUSH_HOME {{LUSH_HOME}}"
  @echo "provider  {{LUSH_PROVIDER}}"
  @{{lush}} status 2>/dev/null || echo "daemon    stopped"

# 运行全部测试（可选过滤：just test openai）
[group('dev')]
test *args:
  bun test {{args}}

# 运行完整 CLI / daemon 演示：恢复、孤儿收养、reclaim
[group('dev')]
demo:
  bun run examples/mvp_demo.js

# test + demo
[group('dev')]
verify: test demo

# 起 daemon 并创建 README 里的最小流程（project-manager → implement-login）
[group('dev')]
bootstrap: daemon-start
  @{{lush}} spawn 0 generic-service --name project-manager
  @{{lush}} spawn 1 generic-task --name implement-login --goal '实现登录功能'
  @{{lush}} tree

# 停 daemon 并删除仓库内的开发数据目录（LUSH_HOME 在仓库外时只提示不删除）
[group('dev')]
clean:
  #!/usr/bin/env zsh
  set -u
  bun ./bin/lush daemon stop >/dev/null 2>&1 || true
  case "{{LUSH_HOME}}" in
    "{{justfile_directory()}}"/*) rm -rf "{{LUSH_HOME}}"; echo "已删除 {{LUSH_HOME}}" ;;
    *) echo "跳过：{{LUSH_HOME}} 不在仓库内，请手动处理" ;;
  esac

# ─────────────────────────────────────────────────────────────────────────────
#  daemon
# ─────────────────────────────────────────────────────────────────────────────

# 启动 daemon（幂等；日志写入 $LUSH_HOME/daemon.log）
[group('daemon')]
daemon-start:
  @{{lush}} daemon start

# 停止 daemon（等待单实例锁释放）
[group('daemon')]
daemon-stop:
  @{{lush}} daemon stop

# 重启 daemon：进程树、Context、消息与调用历史都会被保留
[group('daemon')]
daemon-restart: daemon-stop daemon-start

# daemon 状态：daemon_pid、provider、进程数、活动调用数
[group('daemon')]
status:
  @{{lush}} status

# 查看 daemon 日志尾部
[group('daemon')]
log:
  @tail -n 50 "{{LUSH_HOME}}/daemon.log"

# 前台运行 daemon（Ctrl-C 退出，便于看实时日志）
[group('daemon')]
foreground:
  bun ./bin/lushd

# ─────────────────────────────────────────────────────────────────────────────
#  Process 操作
# ─────────────────────────────────────────────────────────────────────────────

# 进程列表
[group('process')]
ps:
  @{{lush}} ps

# 进程树
[group('process')]
tree:
  @{{lush}} tree

# 查看单个进程：metadata、Context、Agent 状态、近期调用与事件
[group('process')]
inspect pid:
  @{{lush}} inspect {{pid}}

# 读取消息历史：just history 2 0 100
[group('process')]
history pid after="0" limit="100":
  @{{lush}} history {{pid}} --after {{after}} --limit {{limit}}

# 给进程发一次 prompt：just call 2 '请介绍一下你自己'
[group('process')]
call pid prompt:
  @{{lush}} call {{pid}} {{quote(prompt)}}

# 交互式对话（/exit 或 Ctrl-D 退出，不会停止进程）
[group('process')]
attach pid:
  @{{lush}} attach {{pid}}

# 创建子进程：just spawn 0 generic-task implement-login '实现登录功能'
[group('process')]
spawn parent template name="" goal="":
  @{{lush}} spawn {{parent}} {{template}}{{ if name != "" { " --name " + quote(name) } else { "" } }}{{ if goal != "" { " --goal " + quote(goal) } else { "" } }}

# 启动或重启进程（Service）
[group('process')]
start pid:
  @{{lush}} start {{pid}}

# 停止 Service（活动直接子节点会被 PID 0 收养）
[group('process')]
stop pid:
  @{{lush}} stop {{pid}}

# 停止 Service / 取消 Task，并中断其正在进行的 Agent 调用
[group('process')]
kill pid:
  @{{lush}} kill {{pid}}

# 标记已结束的 Task 为 reclaimed（保留 metadata、Context 与历史）
[group('process')]
reclaim pid:
  @{{lush}} reclaim {{pid}}
