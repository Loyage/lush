import { intArg, next } from '../args.js';

/** The `process agents` subgroup: the runtime workers of each logical process. */
export const processAgentGroup = {
  summary: '运行期 agent：谁在干活、干了多久、怎么终止',
  cover: [
    'agent 是「此刻在替某个进程干活」的工作者，不是逻辑进程：它没有 pid，只有 agents 空间的 id `PID.N`（PID 是它服务的进程，N 是本次 daemon 内该进程的第几个 agent）。',
    'list 默认只列正在跑的（包括 `call --interactive` 在你自己终端里跑的那些）；--all 额外列出本次 daemon 内存里保留的已结束条目（有界，重启即清空）。',
    'show 给出单个 agent 的完整信息：运行期事实、它在磁盘上的 session，以及对应的持久 call 行。kill 只杀这个工作者，不动逻辑进程（要改进程状态用 `lush process kill PID`）。',
    '不覆盖：磁盘上的持久 transcript（见 `lush process session PID`）、调用历史与产物（见 `lush process history PID` 和 `inspect` 的 recent_calls）。',
  ],
  notes: [
    'agent 空间不落库：daemon 重启后 list 为空（agent 本来就不存在了）；已经做完的活要去 call 行与磁盘 session 里找：`agents show ID` 同时给出两者。',
    '一个 PID 同时最多一个活动 agent（busy 保护），所以今天 `running` 是 0 或 1；编号形式已为正好的并行 agent 留好。',
  ],
  children: {
    list: {
      command: 'agents_list',
      method: 'process.agents_list',
      summary: '列出运行期 agent（默认只看正在跑的）',
      cover: [
        '按 `PID.N` 升序列出：AGENT、PID、NAME、PROVIDER、STATUS、CALL、OS-PID、ELAPSED、MODE。',
        'MODE：pipe（daemon 起的 pi）、tty（--interactive 在你终端里跑）、in-process（mock / openai）。',
      ],
      notes: [
        '--all 附带本次 daemon 内存里最多 32 条已结束条目（含 status 与 error），用于回答「刚才那次怎么结束的」。',
        '--pid 只看某个逻辑进程的 agent。',
      ],
      usage: ['lush process agents list [--pid PID] [--all]'],
      options: {
        '--pid': { arg: 'PID', desc: '只看该逻辑进程的 agent', apply: (r, v) => { r.pid = intArg(v, '--pid'); } },
        '--all': { arg: null, desc: '附带本次 daemon 内已结束的 agent 条目', apply: (r) => { r.all = true; } },
      },
      parse: () => ({}),
    },
    show: {
      command: 'agents_show',
      method: 'process.agents_show',
      summary: '查看单个 agent（运行期事实 + session + 持久 call）',
      cover: [
        '给出该 agent 的 id、pid、provider、status、call_id、os_pid、interactive、cancellable、开始/结束时间、时长与 error（若有）。',
        '同时附带它服务的进程的 session（若 provider 是外部 agent）和它对应的持久 call 行（prompt / status / output / error）。',
      ],
      usage: ['lush process agents show AGENT_ID'],
      positionals: [['AGENT_ID', 'agent 编号，形如 2.1']],
      parse: (args) => ({ id: next(args, 'id') }),
    },
    kill: {
      command: 'agents_kill',
      method: 'process.agents_kill',
      summary: '终止一个正在运行的 agent（不动逻辑进程）',
      cover: [
        '只杀这个工作者：该次调用被记为 interrupted，agent 从运行中列表消失，逻辑进程保持 running（要同时改进程状态用 `lush process kill PID`）。',
        'daemon 起的 pi 走取消路径 SIGKILL；`--interactive` 的由 daemon 直接 SIGKILL 你终端里的那个 pi（CLI 起手已把 os_pid 报给 daemon）。',
      ],
      notes: [
        '已结束或未知的 agent 会报错（没有可杀的东西）。',
        'OS pid 已经自己消失时 `killed: false`，调用仍会被标记为 interrupted。',
      ],
      usage: ['lush process agents kill AGENT_ID'],
      positionals: [['AGENT_ID', 'agent 编号，形如 2.1']],
      parse: (args) => ({ id: next(args, 'id') }),
    },
  },
};
