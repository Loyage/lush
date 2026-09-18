# CLI 与 Justfile

> 参考层：命令面。命令树每一层都能 `help`；协议细节见 [rpc.md](./rpc.md)，概念见 [concepts/](../concepts/)。

## 命令树

命令树按层组织：顶层（`call` 是入口）→ 命令组（`daemon` / `service` / `task` / `notice` / `agent`）→ 命令 → 参数。任何一层都能问自己这一层是什么、下面有什么、每个子命令干什么：

```bash
lush help                      # 顶层：整体覆盖范围 + 命令组
lush help task                 # 命令组：覆盖范围 + 子命令列表
lush help call                 # 单个命令：覆盖范围、用法、位置参数、选项、约束
lush task help inspect         # 等价写法；`-h` / `--help` / `lush help task inspect` 同理
lush --json help task          # 机器可读的命令树（summary/cover/usage/options/subcommands）
```

帮助文本与解析器读同一张命令表（`src/cli/tree/` 的命令声明），所以不会和真实参数不一致；`lush` / `lush task` 这类缺参数的调用会把用法打到 stderr 并以退出码 2 结束。

## 命令总览


| 命令（RPC） | 说明 |
| --- | --- |
| `lush call SID '<目标>' [--detach] [--interactive] [--dry-run]`（RPC `call` / `call.describe`） | 在 SID 上开一个根 task 并阻塞到它（及其整棵子树）结束；`--detach` 立刻返回 task 快照，`--interactive` 把它的 agent 交给你的终端 |
| `lush task list [--sid P] [--status S] [--roots\|--children] [--limit N]`（RPC `task.list`） | task 列表（ID / SID / 父 task / status / goal / result） |
| `lush task tree TASK_ID`（RPC `task.tree`） | 整棵协作树：每个节点一行 `#id service[sid] status · goal → result` |
| `lush task inspect TASK_ID`（RPC `task.inspect`） | task + 所在 service + 父 task + 直接子 task + 最近调用与事件 |
| `lush task result TASK_ID`（RPC `task.result`） | 结论（未结束时 `finished: false`） |
| `lush task wait TASK_ID`（RPC `task.wait`） | 阻塞到该 task 进入终态 |
| `lush task cancel TASK_ID`（RPC `task.cancel`） | 取消 task 及其整棵子树（中断正在跑的 agent） |
| `lush task complete TASK_ID [--result JSON]`（RPC `task.complete`） | 目标达成时结束 task 并写入 result |
| `lush task spawn SID --goal G [--parent-task-id T]`（RPC `task.spawn`） | 直接派一个 task（agent 的工具 `task_spawn` 的命令行等价物）；父 task 缺省取 `$LUSH_TASK_ID`（agent 里就是它自己），都没有时创建的是根 task——根 task 的正规入口是 `lush call SID GOAL --detach` |
| `lush task update-state TASK_ID --patch JSON`（RPC `task.update_state`） | 合并这个 task 的草稿 state |
| `lush task history TASK_ID [--after ID] [--limit N]`（RPC `task.history`） | 该 task 自己的对话 |
| `lush task session TASK_ID [--open]`（RPC `task.session`） | 该 task agent 的磁盘会话；`--open` / `lush task attach` 进入 pi TUI |
| `lush task delete TASK_ID [--recursive]`（RPC `task.delete`） | 删除已结束的 task 记录（call 行与消息保留为 service 的历史） |
| `lush task agents list\|show\|kill`（RPC `task.agents_*`） | 运行期 agent（`TASK.N`） |
| `lush task message TASK_ID --body TEXT [--from TASK_ID]`（RPC `task.message`） | 给直接父 task 或直接子 task 发一条消息（入队，不打断对方）；`--from` 缺省取 `$LUSH_TASK_ID` |
| `lush task inbox TASK_ID [--after ID] [--limit N]`（RPC `task.inbox`） | 该 task 收到的输入：父子消息与“子 task 已结算”的报告，`delivered_at` 说明是否已交给 agent |
| `lush notice list [--status S] [--task T] [--sid P] [--limit N]`（RPC `notice.list`） | 列出 agent 汇报给用户的 notice（ID / kind / status / wait / title / 上报者） |
| `lush notice show NOTICE_ID`（RPC `notice.inspect`） | 一条 notice 的完整快照：正文、上报者、fields 声明的表单、已填的 answer |
| `lush notice post --title T [--kind K] [--body B] [--fields JSON] [--task TASK_ID] [--no-wait]`（RPC `notice.post`） | **agent 侧**上报一条 notice；默认阻塞到用户结算并打印结算后的 notice（answer 在其中）。汇报者缺省取 `$LUSH_TASK_ID`；`--no-wait` 对应 `wait: false` |
| `lush notice answer NOTICE_ID --set K=V ... \| --text TEXT \| --answer JSON`（RPC `notice.answer`） | 填写回复；notice 变为 answered，正在等待的 task 被唤醒并拿到 `{status, answer}` |
| `lush notice dismiss NOTICE_ID [--reason TEXT]`（RPC `notice.dismiss`） | 只阅读不回答，notice 变为 dismissed；`--reason` 会随 note 一起交给等待的 task |


## 常用命令（Justfile）


```bash
just                 # 列出全部命令
just help            # 列出 lush CLI 的命令树（等价于 lush help）
just doctor          # 工具链 / 数据目录 / daemon 状态
just test            # bun test（just test openai 可按文件名过滤）
just web             # 只启动 Web UI（127.0.0.1:4318），不操作 daemon；just web 8080 改端口

just daemon-start    # 起 daemon（幂等）
just bootstrap       # 起 daemon 并创建 project-manager → implement-login
just tree | just ps | just status
just agent list      # agent profile（不需要 daemon）：just agent inspect default / add / edit / delete / default / path
just spawn 1 generic-task implement-login '实现登录功能'
just spawn 1 generic-task x '' '' demo-agent   # 第 6 个参数是该服务使用的 agent profile
just spawn 1 project my-repo '' '{"path":"/abs/repo"}'   # project 必须给变量 path（绝对路径，同时是 cwd）
just spawn 1 dev-task fix-login '修好登录' '' '' '修复登录流程' '任务详情正文'   # dev-task：name（就是 --name）+ title + detail（第 6、7 个参数）
just call 2 '请介绍一下你自己'          # 在 SID 2 上开一个根 task 并等它结束
just call 2 'hi' dry                  # 只打印将执行的命令（pi 命令行），不真的调用 agent
just detach 2 '慢慢做的事'             # 只建 task，随后 just tasks / just wait 1 观察
just tasks                            # task 列表；just tasks 2 只看某个 service 上的
just task-tree 1                      # 这棵 task 协作树；just result 1 / just task-inspect 1
just wait 1 | just cancel 1 | just task-spawn 2 '要它做的事'
just history 1 0 50                   # 某个 task 自己的对话
just session 1                        # 查看该 task 的 pi session（dir/id/file）
just session 1 open                   # 直接进 pi TUI 接续该会话
just complete 1 '"done"' | just task-state 1 '{"progress":"half"}' | just update-state 2 '{"progress":"half"}' | just update-vars 2 '{"branch":"dev"}'
just attach 1
just task-message 3 '把范围收窄到登录接口'   # 给直接父 / 子 task 传话（入队；from 缺省 $LUSH_TASK_ID）
just inbox 1          # 某个 task 收到的输入（父子消息 / 子 task 结算）
just notices          # 待处理的 notice（agent 汇报给用户）；just notices answered 看已回复的
just notice 7         # 一条 notice 的详情与要填的字段
just answer 7 plan=canary note=ok    # 填写回复并唤醒等待的 task；just answer-text 7 '自由文本'
just dismiss 7 '已知' # 只阅读不回答
just inspect 2       # 被动节点：metadata、变量、state、挂载的近期 task
just stop 1 | just delete 2 | just purge 2
just orphans         # SID 0 的孤儿池：策略 + 每个孤儿的 busy / 闲置秒数
just orphans sweep   # 立刻按 TTL / 上限回收一次（冻结，不删除）
just daemon-stop     # 或 just daemon-restart（保留服务树与历史）
just prune           # 列出并清理残留 daemon（home 已消失的孤儿）；just prune all 连临时 home 一起清
just log             # tail $LUSH_HOME/daemon.log
just clean           # 停 daemon 并删除仓库内的 .lush
just reset yes       # 推倒重来：清空当前 home 的整棵服务树（只剩 SID 0）再重启它的 daemon（不可逆，默认要输 yes）
```

`just` 默认把开发数据放在仓库内的 `.lush/`（已 gitignore），不碰你日常的 `~/.local/state/lush`；用 `LUSH_HOME` 可覆盖（此时 `just clean` 只提示、不删除仓库外的目录）。Web UI 的界面与 HTTP 接口见 [用户界面](./ui.md)。


## 开发数据目录

`just` 默认把开发数据放在仓库内的 `.lush/`（已 gitignore），不碰你日常的 `~/.local/state/lush`；用 `LUSH_HOME` 可覆盖（此时 `just clean` 只提示、不删除仓库外的目录）。

`just clean` 删的是**数据目录**（连历史一起没），`just reset` 删的是**服务树**（daemon、`agents/`、`daemon.log` 都保留，只把每个服务连同它的 Context / 消息 / 调用 / 事件递归 purge 掉）。两者都只作用于当前的 `LUSH_HOME`：别的 home 的 daemon 不会被碰，也不会被重启。

## 交互式与 dry-run

想「发起一次工作，同时自己也在场」，用 `lush call SID 'GOAL' --interactive`（简写 `-i`）：daemon 先建一个 `created` 状态的 task（写 user message、拦住并发），但 agent 不跑 `pi --print`，而是在你这个终端里跑同 cwd、同 session、同身份的 pi TUI，GOAL 作为 TUI 的首条消息；你在里面看它干活、直接插话，退出 TUI 后 CLI 把结果报回 daemon：成功把 task 记为 completed，失败记为 failed。只适用于外部 agent（`pi`）：内置运行时的 agent 跑在 Lush 服务内，没有可进入的终端，会报错。这次调用只有 prompt 落在 `agent_calls`，回复留在 pi 会话里；期间 `task cancel` 只能把它标记为 interrupted，不会关掉你终端里的 pi。

想先看一次 call 会执行什么，用 `--dry-run`：不建 task、不调用 agent、不写历史，只打印那行命令（`cd <cwd> && LUSH_HOME=... LUSH_SID=... LUSH_TASK_ID=... pi --print ... '<goal>'`），可以直接粘到 shell 里重放；`--json` 则给出 `executable` / `argv` / `command` / `cwd` / `env`。内置运行时没有外部命令，返回 `command: null` 与将要发送的消息条数。

