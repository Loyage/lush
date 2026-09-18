# CLI 与 package.json scripts

> 参考层：命令面。命令树每一层都能 `help`；协议细节见 [rpc.md](./rpc.md)，概念见 [concepts/](../concepts/)。

## 命令树

命令树按层组织：顶层 → 命令组（`intent` / `task` / `service` / `notice` / `daemon` / `agent`）→ 命令 → 参数。人的入口是 `lush intent submit`（你的话先是一条 intension，由 SID 0 解析成工作）。任何一层都能问自己这一层是什么、下面有什么、每个子命令干什么：

```bash
lush help                      # 顶层：整体覆盖范围 + 命令组
lush help intent               # 命令组：覆盖范围 + 子命令列表
lush help intent submit        # 单个命令：覆盖范围、用法、位置参数、选项、约束
lush task help inspect         # 等价写法；`-h` / `--help` / `lush help task inspect` 同理
lush --json help task          # 机器可读的命令树（summary/cover/usage/options/subcommands）
```

帮助文本与解析器读同一张命令表（`src/cli/tree/` 的命令声明），所以不会和真实参数不一致；`lush` / `lush task` 这类缺参数的调用会把用法打到 stderr 并以退出码 2 结束。

## 命令总览


| 命令（RPC） | 说明 |
| --- | --- |
| `lush intent submit '<原话>' [--sid SID] [--wait]`（RPC `intent.submit`） | **人的入口**：把你说的话记成一条 intension 交给 SID 0 解析；`--sid` 是"我希望它落在哪"的提示（可省略），`--wait` 阻塞到它结算 |
| `lush intent list [--open] [--status S] [--sid SID\|none] [--limit N]`（RPC `intent.list`） | 你的输入：状态、原话、指定的 service、解析 task；`--open` 只看队列里的 |
| `lush intent show INTENSION_ID`（RPC `intent.inspect`） | 一条输入的全部：原话、解析 task、resolution（派了哪些 task）、response（结论）、相关 notice |
| `lush intent context [INTENSION_ID] [--from-task T]`（RPC `intent.context`） | 解析器视角的全局快照：这条输入 + 对目标的机械体检 + 模板树 + 服务树 + 队列与未决 notice |
| `lush intent settle --status settled\|rejected [--response T] [--reason T] [INTENSION_ID]`（RPC `intent.settle`） | （解析器侧）给这条输入下结论；省略 id 时取 `$LUSH_TASK_ID` 找到它正在解析的那条 |
| `lush intent defer --blocked-by TASK_ID [--reason T] [INTENSION_ID]`（RPC `intent.defer`） | （解析器侧）用户选了"排队等它结束"：输入回到队列，等那个 task 结算后重新解析 |
| `lush intent withdraw INTENSION_ID [--reason T]`（RPC `intent.withdraw`） | 撤回还没开始解析的输入 |
| `lush intent wait INTENSION_ID`（RPC `intent.wait`） | 阻塞到这条输入结算（settled / rejected） |
| `lush task list [--sid P] [--status S] [--roots\|--children] [--limit N]`（RPC `task.list`） | task 列表（ID / SID / 父 task / status / goal / result）；status 含 `waiting`（等子 task）与 `awaiting`（等用户处理它上报的 notice） |
| `lush task tree TASK_ID`（RPC `task.tree`） | 整棵协作树：每个节点一行 `#id service[sid] status · goal → result` |
| `lush task trace TASK_ID [--limit N]`（RPC `task.trace`） | 调用链：该 task 子树里「派活 / 消息 / 结算」按时间排成的一行一步（双向消息都在），只保留最近的 N 步（默认 200） |
| `lush task inspect TASK_ID`（RPC `task.inspect`） | task + 所在 service + 父 task + 直接子 task + 最近调用与事件 |
| `lush task result TASK_ID`（RPC `task.result`） | 结论（未结束时 `finished: false`） |
| `lush task wait TASK_ID`（RPC `task.wait`） | 阻塞到该 task 进入终态 |
| `lush task cancel TASK_ID`（RPC `task.cancel`） | 取消 task 及其整棵子树（中断正在跑的 agent） |
| `lush task complete TASK_ID [--result JSON]`（RPC `task.complete`） | 目标达成时结束 task 并写入 result |
| `lush task construct SID --goal G [--parent-task-id T]`（RPC `task.construct`） | 向下游派一个子 task（agent 的工具 `task_construct` 的命令行等价物）；父 task 缺省取 `$LUSH_TASK_ID`（agent 里就是它自己），**两者都没有会报用法错误**——根 task 只有 intension 队列能创建（`lush intent submit`） |
| `lush task update-state TASK_ID --patch JSON`（RPC `task.update_state`） | 合并这个 task 的草稿 state |
| `lush task history TASK_ID [--after ID] [--limit N]`（RPC `task.history`） | 该 task 自己的对话 |
| `lush task session TASK_ID [--open]`（RPC `task.session`） | 该 task agent 的磁盘会话；`--open` / `lush task attach` 进入 pi TUI |
| `lush task delete TASK_ID [--recursive]`（RPC `task.delete`） | 删除已结束的 task 记录（call 行与消息保留为 service 的历史） |
| `lush task agents list\|show\|kill`（RPC `task.agents_*`） | 运行期 agent（`TASK.N`） |
| `lush task message TASK_ID --body TEXT [--from TASK_ID]`（RPC `task.message`） | 给直接父 task 或直接子 task 发一条消息（入队，不打断对方）；`--from` 缺省取 `$LUSH_TASK_ID` |
| `lush task inbox TASK_ID [--after ID] [--limit N]`（RPC `task.inbox`） | 该 task 收到的输入：父子消息与“子 task 已结算”的报告，`delivered_at` 说明是否已交给 agent |
| `lush notice list [--status S] [--task T] [--sid P] [--limit N]`（RPC `notice.list`） | 列出 agent 汇报给用户的 notice（ID / kind / status / wait / title / 上报者） |
| `lush notice show NOTICE_ID`（RPC `notice.inspect`） | 一条 notice 的完整快照：正文、上报者、fields 声明的表单、已填的 answer |
| `lush notice post --title T [--kind K] [--body B] [--fields JSON] [--task TASK_ID] [--no-wait]`（RPC `notice.post`） | **agent 侧**上报一条 notice；立即返回 open 的 notice（不阻塞）。默认 `wait: true` 把上报的 task 挂在它上面（那个 task 进入 awaiting），答复会作为它的下一次输入送回；`--no-wait` 对应 `wait: false`（纯记录）。汇报者缺省取 `$LUSH_TASK_ID` |
| `lush notice answer NOTICE_ID --set K=V ... \| --text TEXT \| --answer JSON`（RPC `notice.answer`） | 填写回复；notice 变为 answered，挂在上面的 task 拿到一次新输入（`notice_settled`）继续 |
| `lush notice dismiss NOTICE_ID [--reason TEXT]`（RPC `notice.dismiss`） | 只阅读不回答，notice 变为 dismissed；`--reason` 会随 note 一起交给挂在上面的 task |


## 常用命令（`bun run`）


```bash
bun run              # 列出全部 script
bun run help         # 列出 lush CLI 的命令树（等价于 lush help）
bun run doctor       # 工具链 / 数据目录 / daemon 状态
bun run test         # bun test（bun run test openai 可按文件名过滤）
bun run web          # 只启动 Web UI（127.0.0.1:4318），不操作 daemon；bun run web 8080 改端口

bun run daemon-start    # 起 daemon（幂等）
bun run bootstrap       # 起 daemon 并创建 project-manager → implement-login
bun run tree | bun run ps | bun run status
bun run agent list      # agent profile（不需要 daemon）：bun run agent inspect default / add / edit / delete / default / path
bun run construct 1 generic-task implement-login '实现登录功能'
bun run construct 1 generic-task x '' '' demo-agent   # 第 6 个参数是该服务使用的 agent profile
bun run construct 1 project my-repo '' '{"path":"/abs/repo"}'   # project 必须给变量 path（绝对路径，同时是 cwd）
bun run construct 1 dev-task fix-login '修好登录' '' '' '修复登录流程' '任务详情正文'   # dev-task：name（就是 --name）+ title + detail（第 6、7 个参数）

bun run intent '给某条项目加一点东西'    # 提交一条 intension 并等它结算（人的入口）
bun run intent '这句话我指定目标' 11     # 同上，并把目标 service 告诉解析器
bun run intent-now '先记下来，不等'      # 只提交，立刻返回
bun run intents open                   # 队列：状态、原话、解析 task
bun run intent-show 3 | bun run intent-context 3
bun run call 2 '请介绍一下你自己'          # 在 SID 2 上开一个根 task 并等它结束
bun run call 2 'hi' dry                  # 只打印将执行的命令（pi 命令行），不真的调用 agent
bun run detach 2 '慢慢做的事'             # 只建 task，随后 bun run tasks / bun run wait 1 观察
bun run tasks                            # task 列表；bun run tasks 2 只看某个 service 上的
bun run task-tree 1                      # 这棵 task 协作树；bun run result 1 / bun run task-inspect 1
bun run wait 1 | bun run cancel 1 | bun run task-construct 2 '要它做的事'
bun run history 1 0 50                   # 某个 task 自己的对话
bun run session 1                        # 查看该 task 的 pi session（dir/id/file）
bun run session 1 open                   # 直接进 pi TUI 接续该会话
bun run complete 1 '"done"' | bun run task-state 1 '{"progress":"half"}' | bun run update-state 2 '{"progress":"half"}' | bun run update-vars 2 '{"branch":"dev"}'
bun run attach 1
bun run task-message 3 '把范围收窄到登录接口'   # 给直接父 / 子 task 传话（入队；from 缺省 $LUSH_TASK_ID）
bun run inbox 1          # 某个 task 收到的输入（父子消息 / 子 task 结算）
bun run notices          # 待处理的 notice（agent 汇报给用户）；bun run notices answered 看已回复的
bun run notice 7         # 一条 notice 的详情与要填的字段
bun run answer 7 plan=canary note=ok    # 填写回复并唤醒等待的 task；bun run answer-text 7 '自由文本'
bun run dismiss 7 '已知' # 只阅读不回答
bun run inspect 2       # 被动节点：metadata、变量、state、挂载的近期 task
bun run stop 1 | bun run delete 2 | bun run purge 2
bun run orphans         # SID 0 的孤儿池：策略 + 每个孤儿的 busy / 闲置秒数
bun run orphans sweep   # 立刻按 TTL / 上限回收一次（冻结，不删除）
bun run daemon-stop     # 或 bun run daemon-restart（保留服务树与历史）
bun run prune           # 列出并清理残留 daemon（home 已消失的孤儿）；bun run prune all 连临时 home 一起清
bun run log             # tail $LUSH_HOME/daemon.log
bun run clean           # 停 daemon 并删除仓库内的 .lush
bun run reset yes       # 推倒重来：撤回队列里未处理的输入 + 清空服务树（只剩 SID 0）再重启 daemon（不可逆，默认要输 yes）
```

`bun run` 的这些入口默认把开发数据放在仓库内的 `.lush/`（已 gitignore），不碰你日常的 `~/.local/state/lush`；用 `LUSH_HOME` 可覆盖（此时 `bun run clean` 只提示、不删除仓库外的目录）。`lush` / `lushd` 两个 script 保持原样（`bun run bin/lush` / `bun run bin/lushd`），不带默认 `LUSH_HOME`。Web UI 的界面与 HTTP 接口见 [用户界面](./ui.md)。


## 开发数据目录

`bun run` 的这些入口默认把开发数据放在仓库内的 `.lush/`（已 gitignore），不碰你日常的 `~/.local/state/lush`；用 `LUSH_HOME` 可覆盖（此时 `bun run clean` 只提示、不删除仓库外的目录）。

`bun run clean` 删的是**数据目录**（连历史一起没），`bun run reset` 删的是**服务树加未处理的输入**（daemon、`agents/`、`daemon.log` 都保留：先把队列里的 intension 逐条撤回，再把每个服务连同它的 Context / 消息 / 调用 / 事件递归 purge 掉）。两者都只作用于当前的 `LUSH_HOME`：别的 home 的 daemon 不会被碰，也不会被重启。

## 亲自当解析器：--interactive

`lush intent submit '<原话>' --interactive`（简写 `-i`）把这条输入的**解析 task** 交给你：daemon 记下输入、在 SID 0 上建一个 `created` 状态的 task（不启动），然后在这个终端里跑同 cwd、同 session、同身份的 pi TUI，原话就是 TUI 的首条消息。你在里面看解析器怎么读全局、怎么判断，也可以自己动手把它安排掉；退出 TUI 后 CLI 把结果报回 daemon（成功 → task completed，**这条输入随之结算**——人手报的成功是结论，即使他没留下文字（`response` 为空），输入也不会被再解析一遍；失败 → failed → 输入回到队列重试）。只适用于外部 agent（`pi`）：内置运行时的 agent 跑在 Lush 服务内，没有可进入的终端，会在开跑之前就报错（不会留下半截的 task）。`--interactive` 与 `--wait` 互斥。

想只是**看**某个 task 的 agent 干活（不新建输入），用 `lush task session TASK_ID --open`（等价 `lush task attach TASK_ID`）。

要看某个 agent 真正会跑的 argv，用 `lush agent inspect <name>`（profile 层面的预览）或 `lush task session TASK_ID --json` 里的 argv 字段。

