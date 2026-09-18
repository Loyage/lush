import { intArg, next } from '../args.js';

/** The `task agents` subgroup: the runtime workers that are working on tasks. */
export const taskAgentGroup = {
  summary: '运行期 agent：哪个 task 正在被谁干、干了多久、怎么终止',
  cover: [
    'agent 是「此刻在替某个 task 干活」的工作者，不是逻辑服务也不是 task：它没有自己的 sid，只有 agents 空间的 id `TASK.N`（TASK 是它服务的 task，N 是本次 daemon 内该 task 的第几个 agent）。',
    'list 默认只列正在跑的（包括 `call --interactive` 在你终端里跑的那些）；--all 额外列出本次 daemon 内存里保留的已结束条目（有界，重启即清空）。',
    'show 给出单个 agent 的完整信息：运行期事实、它写的磁盘 session，以及对应的持久 call 行。kill 只杀这个工作者，并把它服务的 task 记为 cancelled（agent 被强行杀掉，没有答案可记）。',
    '不覆盖：磁盘上的持久 transcript（见 `lush task session TASK_ID`）、task 的对话与产物（见 `lush task history TASK_ID` 和 `task inspect`）。',
  ],
  notes: [
    'agent 空间不落库：daemon 重启后 list 为空（agent 本来就不存在了）；已经做完的活要去 task 行、call 行与磁盘 session 里找：`agents show ID` 同时给出后两者。',
    '一个 task 同时最多一个活动 agent；一个 service 同时最多一个活动 task，所以一个 service 上此刻也只可能有一个 agent。',
  ],
  children: {
    list: {
      command: 'task_agents_list',
      method: 'task.agents_list',
      summary: '列出运行期 agent（默认只看正在跑的）',
      cover: [
        '按 `TASK.N` 升序列出：AGENT、TASK、SID、NAME、PROVIDER、STATUS、CALL、OS-SID、ELAPSED、MODE。',
        'MODE：pipe（daemon 起的 pi）、tty（--interactive 在你终端里跑）、in-service（mock / openai）。',
      ],
      notes: [
        '--all 附带本次 daemon 内存里最多 32 条已结束条目（含 status 与 error），用于回答「刚才那次怎么结束的」。',
        '--task-id / --sid 只看某个 task 或某个 service 的 agent；--sid 看到的是挂在该 service 上的那个活动 task 的 agent。',
      ],
      usage: ['lush task agents list [--task-id TASK_ID] [--sid SID] [--all]'],
      options: {
        '--task-id': { arg: 'TASK_ID', desc: '只看该 task 的 agent', apply: (r, v) => { r.task_id = intArg(v, '--task-id'); } },
        '--sid': { arg: 'SID', desc: '只看该 service 上的 agent', apply: (r, v) => { r.sid = intArg(v, '--sid'); } },
        '--all': { arg: null, desc: '附带本次 daemon 内已结束的 agent 条目', apply: (r) => { r.all = true; } },
      },
      parse: () => ({}),
    },
    show: {
      command: 'task_agents_show',
      method: 'task.agents_show',
      summary: '查看单个 agent（运行期事实 + session + 持久 call）',
      cover: [
        '给出该 agent 的 id、task_id、sid、provider、status、call_id、os_pid、interactive、cancellable、开始/结束时间、时长与 error（若有）。',
        '同时附带它服务的 task 对应的 session（若 provider 是外部 agent）和它对应的持久 call 行（prompt / status / output / error）。',
      ],
      usage: ['lush task agents show AGENT_ID'],
      positionals: [['AGENT_ID', 'agent 编号，形如 12.1']],
      parse: (args) => ({ id: next(args, 'id') }),
    },
    kill: {
      command: 'task_agents_kill',
      method: 'task.agents_kill',
      summary: '终止一个正在运行的 agent（它服务的 task 会被取消）',
      cover: [
        '只杀这个工作者：该次调用记为 interrupted，agent 从运行中列表消失，它服务的 task 记为 cancelled（agent 被强杀后没有答案可记；要保留结果请用 `lush task cancel` 之外的方式，或等它自己结束）。',
        'daemon 起的 pi 走取消路径 SIGKILL；`--interactive` 的由 daemon 直接 SIGKILL 你终端里的那个 pi（CLI 起手已把 os_pid 报给 daemon），并在同一刻结算这次调用，不再等终端回报或超时。',
      ],
      notes: [
        '已结束或未知的 agent 会报错（没有可杀的东西）。',
        '结果里的 `outcome` 说明 OS 侧怎么结束的：`killed`（SIGKILL 送达）、`gone`（sid 本来就已不存在，同样立刻记为 interrupted）、`no_pid`（服务内 provider，或终端还没上报 pi 的 sid——此时只标记取消，等终端回报或超时）。',
      ],
      usage: ['lush task agents kill AGENT_ID'],
      positionals: [['AGENT_ID', 'agent 编号，形如 12.1']],
      parse: (args) => ({ id: next(args, 'id') }),
    },
  },
};
