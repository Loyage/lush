import { intArg, next, UsageError } from '../args.js';

/**
 * `lush call SID GOAL` — the user's entry point.
 *
 * It creates a **root task** on the service and waits for it: the task's agent
 * works the goal, delegating to child services with child tasks as needed, and
 * the command returns the task tree's outcome. That is the whole shape of Lush
 * in one command — a service (passive node) receives a task (work), and the
 * work travels down the service tree until it is done.
 */
export const callCommand = {
  command: 'call',
  method: (args) => (args.dry_run ? 'call.describe' : 'call'),
  summary: '在某个 service 上创建 task 并等它（及其子树）结束',
  cover: [
    '在 SID 上创建一个根 task，立刻开始跑它的 agent；命令阻塞到该 task 进入终态，返回 task 快照（含 result）。因为终态 task 不会有活动子 task，这也等于等到它派出去的一整棵子树结束。',
    '想先拿到 task id 就走，用 --detach：返回 task 快照，随后用 `lush task wait` / `task inspect` / `task tree` 观察（`lush task tree TASK_ID` 能看到这件事在服务间怎么协作）。',
    '--interactive 改为在这个终端里执行该 task 的 agent（pi TUI）：daemon 照常建 task、记调用并标记 busy，pi 退出后 CLI 向 daemon 结算，task 随之 completed 或 failed。',
  ],
  notes: [
    '目标就是 task 的 goal：写得越具体（要什么、约束、怎么算完成），下游派活越准。',
    '要求目标 service 为 active，且它身上此刻没有别的活动 task（一个 service 同时只做一件事）；被拒绝时先 `lush task wait` 那个 task，或换一个下游节点。',
    '--dry-run 不创建 task、不写任何记录：pi 后端打印本来要执行的命令行，内置运行时打印 command: null 与消息条数。',
    '--interactive 只适用于外部 agent（pi）；--detach、--dry-run 不能与它同时使用。',
    '调用方中途消失（关窗口 / SIGKILL）时任务照常在 daemon 里跑完；这次 RPC 等待被放弃，task 不受影响。',
  ],
  usage: [
    'lush call SID GOAL [--detach]',
    'lush call SID GOAL --interactive  # 在本终端进入 pi TUI 做这个 task',
    'lush call SID GOAL --dry-run      # 只描述将要执行的调用',
  ],
  positionals: [['SID', '目标服务 SID'], ['GOAL', '要做什么（原话，会成为 task 的 goal）']],
  options: {
    '--detach': {
      arg: null,
      desc: '只创建 task 并返回它的 id / 快照，不等待',
      apply: (r) => { r.detach = true; },
    },
    '--interactive': {
      arg: null,
      desc: '在本终端用 pi TUI 做这个 task（仅外部 agent）',
      apply: (r) => { r.interactive = true; },
    },
    '-i': { arg: null, desc: '--interactive 的简写', apply: (r) => { r.interactive = true; } },
    '--dry-run': { arg: null, desc: '只描述本来要执行的调用，不创建 task、不调用 agent', apply: (r) => { r.dry_run = true; } },
  },
  parse: (args) => ({ sid: intArg(args.shift(), 'sid'), goal: next(args, 'goal') }),
  check: (r) => {
    if (r.interactive && r.dry_run) throw new UsageError('--interactive cannot be combined with --dry-run');
    if (r.interactive && r.detach) throw new UsageError('--interactive cannot be combined with --detach');
    // The terminal is handed to pi, so there is nothing left to serialize.
    if (r.interactive && r.json) throw new UsageError('--interactive cannot be combined with --json');
    // `call.describe` takes the same text, but names it `prompt`.
    if (r.dry_run) {
      r.prompt = r.goal;
      delete r.goal;
    }
  },
};
