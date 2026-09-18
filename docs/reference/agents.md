# Agent profile、session 与内置后端

> 参考层：一个服务用哪个 agent、它的 session 在哪、内置后端怎么配。概念（后端与 Context）见 [concepts/agents.md](../concepts/agents.md)。

## 默认 backend：纯净 pi

`call` 默认交给 **`pi`** 执行（`LUSH_PROVIDER=pi`）。**行为变更**：Lush 现在给 pi 加上一组纯净化开关，pi 只带自己的 read / bash / edit / write 工具，**不再加载你本机的 pi extensions / skills / prompt templates / themes 与 `AGENTS.md` context 文件**（等价于 `--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files`）。要让某个 agent（或全局默认）恢复 pi 原本的加载行为，用 `lush agent add/edit … --plugins`，见下面的「agent profile」。

每次 call 起一个 `pi --print` 子服务，**每个 SID 一个 pi session**（`$LUSH_HOME/pi-sessions/`，`--session-id lush-<SID>`），多轮上下文由 pi 自己持久化。Lush 给 pi 的输入是三层提示词：

1. 模板的 `system_prompt`（用 `--system-prompt` **替换** pi 默认的 coding 提示词）；
2. 共享的 Lush 说明层（`src/agent/guide.js`）：介绍 Lush 是什么、如何用 `lush` CLI 操作服务，所有 agent 后端都会带上；
3. 运行时数据 `LUSH_CONTEXT`（自身 metadata、父/子摘要、state、可创建模板及其 `construct_prompt`）。

pi 用自带的 read / bash / edit / write 工具干活，并**通过 bash 调用 `lush` CLI** 来 construct / call / complete 其他服务；`LUSH_HOME`、`LUSH_SID` 会传给它，仓库 `bin/` 会被加进 PATH。若服务创建时给了 `path` 变量（例如 `project` 模板），pi 的 cwd 就是该目录，否则是 `$LUSH_HOME`。

```bash
export LUSH_PROVIDER=pi            # 默认
# export LUSH_PI_COMMAND=pi        # pi 可执行文件（默认在 PATH 找 pi）
# export LUSH_PI_PROVIDER=openai   # 透传给 pi --provider
# export LUSH_PI_MODEL=gpt-5       # 透传给 pi --model
export LUSH_CALL_TIMEOUT=900       # pi 真实干活很慢，默认 15 分钟
lush service construct 0 project-manager --name project-manager
lush service construct 1 project my-repo --name my-repo --vars '{"path":"/abs/repo"}'
lush call 0 '打开 /abs/repo，列出待办并开工'   # 根 task 落在 SID 0，再逐层向下派
```

取消（`task cancel` / `task agents kill` / 超时 / daemon 退出）会杀掉对应的 pi 子服务；pi 的 session 文件保留在 `$LUSH_HOME/pi-sessions/` 供审计，Lush 自身只记录 prompt 与最终文本。

### agent profile：一个服务用哪个 agent、这个 agent 长什么样

**agent profile** 把「用哪个 agent」变成可配置的一等概念。每个 profile 是一个文件 `$LUSH_HOME/agents/<name>.json`（**文件名就是 agent 名**，没有 `name` 字段，可手写），由 `lush agent` 命令组读写：

```bash
lush agent list                 # NAME PROVIDER COMMAND MODEL PLUGINS DEFAULT SOURCE PATH
lush agent inspect default      # 完整配置 + 定义来源 + 校验 + 真正会跑的 argv 预览
lush agent add analyst --model gpt-5 --flag --verbose   # 新 profile，默认就是纯净 pi
lush agent add legacy --plugins # 这个 profile 保留 pi 自己的插件默认行为
lush agent edit analyst --no-plugins                    # 增量修改：未给出的字段不变
lush agent delete analyst       # default 拒绝删除
lush agent default analyst      # 把 analyst 的字段复制到 default 的 override
lush agent path                 # profile 目录（$LUSH_HOME/agents）
```

**`lush agent` 不经过 daemon**：它只读写 `$LUSH_HOME/agents/*.json`，daemon 没运行时也能用（这是它和 `lush service ...` 的区别）。daemon 在**每次 call 时按名字读盘**，所以改完 profile 不用 `daemon-restart`（`daemon-restart` 仍然要用于改代码 / 提示词 / 模板）。

**选择优先级**（服务 > 环境变量 > 内置 default）：

1. 服务显式选择：`lush service construct … --agent <name>`，或模板里的可选字段 `agent`（`--agent` 覆盖模板）。选中的名字写进服务 state（`lush service inspect SID` 的 `agent.profile` 与 `context.state.agent` 都能看到），之后这个节点上每个 task 的 invocation、`task session`、`call --dry-run` 都用它。
2. 环境变量：`LUSH_PROVIDER` / `LUSH_PI_COMMAND` / `LUSH_PI_PROVIDER` / `LUSH_PI_MODEL`（语义与以前完全一致，`LUSH_PROVIDER=mock` 仍然照常工作）。
3. 内置 `default`：provider `pi` + 纯净化参数。它永远可用、不可删除，但可以写 `$LUSH_HOME/agents/default.json` 逐字段覆盖（`lush agent edit default …` / `lush agent default <name>`）。

解析是**逐字段叠加**：profile 里声明了的字段优先，没声明的字段回落到环境变量，再回落到内置 fallback。所以一个 profile 只写它要改的字段即可，而 `LUSH_PI_COMMAND` 之类的环境变量对所有 pi profile 仍然生效（例如把 pi 指向 stub 做测试）。

profile 字段（都可省略，未知字段会被拒绝）：

| 字段 | 含义 |
| --- | --- |
| `provider` | `pi`（默认，外部子服务）/ `openai` / `mock`（Lush 内置运行时） |
| `command` | pi 可执行文件；省略时用 `LUSH_PI_COMMAND`，最后回落到 `pi` |
| `model` / `pi_provider` | 透传 pi `--model` / `--provider` |
| `plugins` | `false`（默认）= 纯净化：追加五个 `--no-*`；`true` = 不追加任何插件开关 |
| `flags` | 额外 pi 参数（字符串数组），追加在插件开关之后 |
| `description` | 备注，只用于 `list` / `inspect` |

pi 的 argv 顺序固定：`pi [--print] <插件开关> <flags> --session-dir … --session-id … --name … --system-prompt … --append-system-prompt … [--provider] [--model] <prompt>`；`lush agent inspect <name>` 会用一个占位 invocation 把它整条打印出来，`lush call SID 'hi' --dry-run` 打的是真实节点上的那条。


## agent 与 session 是两回事

**agent = 此刻在替某个 task 干活的工作者**（运行期）；**session = pi 在磁盘上的持久 transcript**（按 task）。前者会消失，后者会留下。

```bash
lush service tree              # 树里直接标出谁在干活：worker[1] → agent 3.1 running · 1m32s
lush service tree --no-agents  # 只看纯节点结构
lush task agents list          # 运行中的 agent：AGENT/TASK/SID/NAME/PROVIDER/STATUS/CALL/OS-SID/ELAPSED/MODE
lush task agents list --all    # 附带本次 daemon 内存里保留的已结束条目（有界 32 条，重启即清空）
lush task agents show 3.1      # 运行期事实 + 它在磁盘上的 session + 对应的持久 call 行
lush task agents kill 3.1      # 杀掉这个工作者，并把它服务的 task 记为 cancelled
```

agent 没有自己的 sid：它在自己的空间里用 `TASK.N` 标识（`3.1` = 服务 task #3 的第 1 个 agent，`N` 在本次 daemon 内按 task 单调递增）。它也不落库——重启后 `agents list` 为空，持久记录是 task 行与 `agent_calls` 的那一行（`agents show` 会把它一并给出）。`MODE` 说明它跑在哪：`pipe`（daemon 起的 pi）、`tty`（`call --interactive` 在你终端里跑的 pi，CLI 起手把 OS PID 报给 daemon，所以 daemon 也能杀它）、`in-service`（`mock` / `openai`）。

```bash
lush task session 3        # 那个 task 的持久 transcript：session-dir / session-id / file / cwd / browse
lush --json task session 3 # 结构化：argv、command、browse_command、env、path_prefix、busy
lush task session 3 --open # 把这个终端交给该 task 的 pi session（= lush task attach 3）
```

session 属于它所在的 task：session-id（`lush-task-<id>`）与回话文件（`$LUSH_HOME/pi-sessions/<session 开始时间>_lush-task-<id>.jsonl`）都按 task 算，task 进入终态后依然可查；同一次唤醒追加到同一个文件（多于 1 个只出现在 pi 自己 `--fork` / `/clone` 时）。所以运行期与磁盘都挂在 `task` 下：`task agents …` 查运行期，`task session …` 查磁盘；名字容易混的是 `agent` 命令组——那是**配置**（profile，见上一节），与某个 task 此刻的 agent 无关。


## 内置后端（mock / openai）

`LUSH_PROVIDER=mock`：确定性架构演示，不是真实语言模型，支持身份查询、中文/英文创建子节点与「派给下游」请求，以及显式工具指令（`/tool task_complete {...}`、`/tool service_construct {...}`）；`bun test` 用它。

`LUSH_PROVIDER=openai`：Lush 内置的 OpenAI-style Chat Completions 运行时（多轮 tool calling，agent 直接用 `task_*` / `service_*` 工具）。

```bash
export LUSH_PROVIDER=openai
export LUSH_API_KEY='...'
export LUSH_BASE_URL='https://api.openai.com/v1'
export LUSH_MODEL='your-model'
lush daemon start    # 或 lush daemon restart：服务树与历史保留，只有代码 / 环境变量变新
```

环境变量由 **daemon 启动时** 读取，切换需重启（`lush daemon restart`）。API key 不写入数据库。请求走 Bun 的 `fetch`，自动遵循标准代理环境变量（`http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`）；本机 loopback base URL 会把 loopback 主机名补进 `NO_PROXY`，保证本地模型直连。拒绝 HTTP 重定向以避免转发 API key。调用带 `AbortSignal`，取消后不再执行工具或写入结果；daemon 退出时不会等待网络请求自然结束。不自动重试有副作用的 Agent 调用。内置运行时不支持流式输出。Mock 的自然语言识别只是演示规则。

`mock` / `openai` 也可以写进 agent profile（`lush agent add x --provider mock`）：被服务显式选中的 profile 优先于 `LUSH_PROVIDER`，所以同一个 daemon 里可以同时有跑 pi 的服务和跑内置运行时的服务（各自带上匹配的 Lush 说明层：`cli` 或 `tools`）。openai 的 URL / key / model 仍然只来自环境变量。
