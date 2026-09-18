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
# 默认 agent 是 pi（真实 agent，会真的调用模型）；开发/演示可 `just demo` 或改用 mock
export LUSH_PROVIDER := env_var_or_default("LUSH_PROVIDER", "pi")
export LUSH_CALL_TIMEOUT := env_var_or_default("LUSH_CALL_TIMEOUT", "900")
export LUSH_RPC_TIMEOUT := env_var_or_default("LUSH_RPC_TIMEOUT", "910")

# CLI 入口；无需安装（bun link 之后也可以直接用 lush / lushd）
lush := "bun ./bin/lush"

# ─────────────────────────────────────────────────────────────────────────────
#  入口
# ─────────────────────────────────────────────────────────────────────────────

# 列出所有命令（Justfile 层）
default:
  @just --list

# 列出 lush CLI 的命令树（每一层都可以再加 help / -h，如 {{lush}} process help）
help:
  @{{lush}} help

# ─────────────────────────────────────────────────────────────────────────────
#  开发与验证
# ─────────────────────────────────────────────────────────────────────────────

# 检查工具链、数据目录与 daemon 状态
[group('dev')]
doctor:
  @echo "bun       $(bun --version)"
  @echo "LUSH_HOME {{LUSH_HOME}}"
  @echo "provider  {{LUSH_PROVIDER}}"
  @echo "code      {{justfile_directory()}}"
  @{{lush}} daemon status 2>&1 || echo "daemon    stopped"

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
  @{{lush}} process spawn 0 generic-service --name project-manager
  @{{lush}} process spawn 1 generic-task --name implement-login --goal '实现登录功能'
  @{{lush}} process tree

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

# 只重启 LUSH_HOME={{LUSH_HOME}} 这一份；命令打到的若是别的 home，它不会被重启
# （`just doctor` / `just status` 会显示实际 home、代码指纹与是否匹配）
# 重启 daemon：进程树、Context、消息与调用历史都会被保留
[group('daemon')]
daemon-restart: daemon-stop daemon-start

# daemon 状态：daemon_pid、provider、进程数、活动调用数
[group('daemon')]
status:
  @{{lush}} daemon status

# 查看 daemon 日志尾部
[group('daemon')]
log:
  @tail -n 50 "{{LUSH_HOME}}/daemon.log"

# 前台运行 daemon（Ctrl-C 退出，便于看实时日志）
[group('daemon')]
foreground:
  bun ./bin/lushd

# 默认只清「home 目录已消失」的；`just prune all` 连仍存在但既不是当前 LUSH_HOME 也不是默认 home 的临时 home 一起清
# 清理残留 daemon（测试/演示用临时 LUSH_HOME 留下的孤儿），从不碰当前 LUSH_HOME 与默认 home
[group('daemon')]
prune mode="":
  #!/usr/bin/env zsh
  set -u
  # shebang recipe 的参数由 just 在运行前插值（不是位置参数）
  typeset mode="{{mode}}"
  typeset default_home="${XDG_STATE_HOME:-$HOME/.local/state}/lush"

  # 只认我们自己的 daemon：argv 里带 src/daemon/main.js（lushd 走的也是它）
  typeset -a pids
  pids=(${(f)"$(ps -eo pid=,command= | awk '/daemon\/main\.js$/ {print $1}')"})
  if (( ${#pids} == 0 )); then
    echo "没有运行中的 daemon"
    exit 0
  fi

  cwd_of() {
    if [[ -e /proc/$1/cwd ]]; then
      readlink -f /proc/$1/cwd 2>/dev/null && return
    fi
    lsof -a -p $1 -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
  }

  typeset -a doomed
  typeset kept=0
  for pid in $pids; do
    home="$(cwd_of $pid)"
    if [[ -z "$home" ]]; then
      echo "保留 pid=$pid（读不到工作目录，不动）"; kept=$(( kept + 1 )); continue
    fi
    if [[ "$home" == "$LUSH_HOME" ]]; then
      echo "保留 pid=$pid home=$home（当前 LUSH_HOME）"; kept=$(( kept + 1 )); continue
    fi
    if [[ "$home" == "$default_home" ]]; then
      echo "保留 pid=$pid home=$home（默认 home）"; kept=$(( kept + 1 )); continue
    fi
    if [[ ! -d "$home" ]]; then
      echo "清理 pid=$pid home=$home（目录已消失）"
      kill $pid 2>/dev/null && doomed+=($pid) || echo "  kill 失败，跳过"
      continue
    fi
    if [[ "$mode" == (all|--all|-a) ]]; then
      echo "清理 pid=$pid home=$home（临时 home；目录仍在，确认无用后自行删除）"
      kill $pid 2>/dev/null && doomed+=($pid) || echo "  kill 失败，跳过"
      continue
    fi
    echo "保留 pid=$pid home=$home（仍在，但不是当前/默认 home；just prune all 可清理）"
    kept=$(( kept + 1 ))
  done

  # 等它们真的退出：kill 只是请求，锁要等进程结束后才释放
  typeset stuck=0
  for pid in $doomed; do
    for _ in {1..50}; do
      kill -0 $pid 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 $pid 2>/dev/null; then
      echo "警告：pid=$pid 仍未退出（可能卡在 handler 里）"
      stuck=$(( stuck + 1 ))
    fi
  done
  echo "已停止 $(( ${#doomed} - stuck )) 个，保留 $kept 个，未退出 $stuck 个"

# ─────────────────────────────────────────────────────────────────────────────
#  Process 操作
# ─────────────────────────────────────────────────────────────────────────────

# 进程列表
[group('process')]
ps:
  @{{lush}} process list

# agent profile（配置文件，不需要 daemon）：just agent list / just agent inspect default
[group('agent')]
agent *args:
  @{{lush}} agent {{args}}

# 进程树
[group('process')]
tree:
  @{{lush}} process tree

# 查看 PID 0 收养的孤儿；加参数 sweep 立刻按策略回收一次：just orphans sweep
[group('process')]
orphans sweep="":
  @{{lush}} process orphans{{ if sweep != "" { " --sweep" } else { "" } }}

# 查看单个进程：metadata、Context、Agent 状态、近期调用与事件
[group('process')]
inspect pid sections="":
  @{{lush}} process inspect {{pid}}{{ if sections != "" { " --with " + quote(sections) } else { "" } }}

# 读取消息历史：just history 2 0 100
[group('process')]
history pid after="0" limit="100":
  @{{lush}} process history {{pid}} --after {{after}} --limit {{limit}}

# 给进程发一次 prompt：just call 2 '请介绍一下你自己'
# 加第三个参数只打印将执行的命令，不真的调用 agent：just call 2 'hi' dry
[group('process')]
call pid prompt dry="":
  @{{lush}} process call {{pid}} {{quote(prompt)}}{{ if dry != "" { " --dry-run" } else { "" } }}

# 以参与方式发起一次调用：在这个终端里跑 pi TUI，边看边插话，退出后结算这次调用
[group('process')]
enter pid prompt:
  @{{lush}} process call {{pid}} {{quote(prompt)}} --interactive

# 交互式对话（/exit 或 Ctrl-D 退出，不会停止进程）
[group('process')]
attach pid:
  @{{lush}} process attach {{pid}}

# 创建子进程：just spawn 0 generic-task implement-login '实现登录功能'
# project 模板必须给变量 path：just spawn 0 project my-repo '' '{"path":"/abs/repo"}'
# 指定 agent profile（见 just agent list）：just spawn 0 generic-task x '' '' demo-agent
[group('process')]
spawn parent template name="" goal="" vars="" agent="":
  @{{lush}} process spawn {{parent}} {{template}}{{ if name != "" { " --name " + quote(name) } else { "" } }}{{ if goal != "" { " --goal " + quote(goal) } else { "" } }}{{ if vars != "" { " --vars " + quote(vars) } else { "" } }}{{ if agent != "" { " --agent " + quote(agent) } else { "" } }}

# 完成 Task：just complete 2 '{"ok":true}'
[group('process')]
complete pid result="":
  @{{lush}} process complete {{pid}}{{ if result != "" { " --result " + quote(result) } else { "" } }}

# 合并持久 state：just update-state 2 '{"progress":"half"}'
[group('process')]
update-state pid patch:
  @{{lush}} process update-state {{pid}} --patch {{quote(patch)}}

# 修改模板声明为 mutable 的变量：just update-vars 2 '{"branch":"dev"}'
[group('process')]
update-vars pid patch:
  @{{lush}} process update-vars {{pid}} --vars {{quote(patch)}}

# 查看进程的 agent session（pi）：just session 2；加第二个参数进入 pi TUI：just session 2 open
[group('process')]
session pid open="":
  @{{lush}} process session {{pid}}{{ if open != "" { " --open" } else { "" } }}

# 运行期 agent：谁在干活、干了多久、怎么终止（tree 默认就会在活跃进程下标一行）
[group('process')]
agents all="":
  @{{lush}} process agents list{{ if all != "" { " --all" } else { "" } }}

# 启动或重启进程（Service）
[group('process')]
start pid:
  @{{lush}} process start {{pid}}

# 停止 Service（活动直接子节点会被 PID 0 收养）
[group('process')]
stop pid:
  @{{lush}} process stop {{pid}}

# 停止 Service / 取消 Task，并中断其正在进行的 Agent 调用
[group('process')]
kill pid:
  @{{lush}} process kill {{pid}}

# 标记已结束的 Task 为 reclaimed（保留 metadata、Context 与历史）
[group('process')]
reclaim pid:
  @{{lush}} process reclaim {{pid}}

# 硬删除已结束的进程：Context、消息、调用与事件一起消失（不可逆）
[group('process')]
delete pid recursive="":
  @{{lush}} process delete {{pid}}{{ if recursive != "" { " --recursive" } else { "" } }}

# 先停止/取消再硬删除，一条命令清掉一个进程（running 也能删，不可逆）
[group('process')]
purge pid recursive="":
  @{{lush}} process purge {{pid}}{{ if recursive != "" { " --recursive" } else { "" } }}
