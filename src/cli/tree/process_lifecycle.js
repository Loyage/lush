import { intArg, jsonArg, UsageError } from '../args.js';

/**
 * The `process` verbs that *change* a process: the lifecycle transitions, the
 * two state writers, and the hard removals. Read-only verbs live in
 * `process.js`, invocation in `process_calls.js`.
 */
export const processLifecycleChildren = {
  start: {
    command: 'start',
    method: 'process.start',
    summary: '启动或重启 Service',
    cover: [
      '启动 created 的 Service，重启 stopped / failed 的 Service，running 时幂等。',
      '终态 Task 不可复活；已结束的 Service 重启后不会自动取回被收养的子节点。',
    ],
    usage: ['lush process start PID'],
    positionals: [['PID', '目标 Service PID']],
    parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
  },
  stop: {
    command: 'stop',
    method: 'process.stop',
    summary: '停止 Service',
    cover: [
      '仅 Service：置为 stopped，不级联终止子节点；其活动直接子节点交给 PID 0 收养。',
      '同样会中断该 PID 正在进行的 Agent 调用。已停止时幂等。',
    ],
    usage: ['lush process stop PID'],
    positionals: [['PID', '目标 Service PID']],
    parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
  },
  kill: {
    command: 'kill',
    method: 'process.kill',
    summary: '停止 Service / 取消 Task，并中断进行中的调用',
    cover: [
      'Service 置为 stopped；活动 Task 置为 cancelled。',
      '中断该 PID 正在运行的 Agent 调用；已终止节点幂等。',
    ],
    usage: ['lush process kill PID'],
    positionals: [['PID', '目标进程 PID']],
    parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
  },
  reclaim: {
    command: 'reclaim',
    method: 'process.reclaim',
    summary: '标记已结束的 Task 为 reclaimed',
    cover: [
      '仅 completed / failed / cancelled 的 Task 可 reclaim，保留 metadata、Context、消息与事件。',
      '这是终结归档操作；已 reclaim 的 Task 不再变化。',
    ],
    usage: ['lush process reclaim PID'],
    positionals: [['PID', '目标 Task PID']],
    parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
  },
  delete: {
    command: 'delete',
    method: 'process.delete',
    summary: '硬删除已结束的进程，连同它的 Context、消息、调用与事件',
    cover: [
      '只删已完成生命周期（非 running/created）的进程：stopped/failed Service、completed/failed/cancelled/reclaimed Task。',
      '删除是物理删除且不可逆：该 PID 的 processes、contexts、messages、agent_calls、process_events 行在同一个事务里一起消失，之后 list / tree / inspect / history 都不再有它。',
      '父进程（若还在）会收到一条 child_deleted 事件，记录被删 PID 的名字、模板与当时状态；被删 PID 自己的历史一并消失，不会留下痕迹。',
    ],
    notes: [
      '仍为 running 的进程会被拒绝，提示先 stop/kill，或改用 `lush process purge`。',
      '有子进程时默认拒绝（删掉父行会让子进程指向不存在的行）；--recursive 在同一个事务里从叶子往上删整棵子树，回包里的 deleted 列出全部 PID。',
      '进程变量（state.params / state.vars）也在 Context 里，随进程一起消失；需要保留证据时先 `lush process history` / `inspect` 导出。',
    ],
    usage: ['lush process delete PID [--recursive]'],
    positionals: [['PID', '目标进程 PID']],
    options: {
      '--recursive': {
        arg: null,
        desc: '整棵子树一起删（子进程必须先于父进程消失）',
        apply: (r) => { r.recursive = true; },
      },
    },
    parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
  },
  purge: {
    command: 'purge',
    method: 'process.purge',
    summary: '先停止/取消再硬删除，一条命令清掉一个进程',
    cover: [
      '`process delete` 的强制版本：running Service 先置为 stopped、running Task 先置为 cancelled（并中断它正在跑的 Agent 调用），随后按 delete 的规则物理删除。',
      '回包的 terminated 列出哪些 PID 因这次 purge 被停止/取消，deleted 列出实际消失的全部 PID，rows 是按表统计的删除行数。',
      '调用方是终态时与 delete 等价（terminated 为空）。',
    ],
    notes: [
      '与 kill / stop 不同，purge 不把活动子节点交给 PID 0 收养：整棵子树的每个活动节点都会被终止，收养只会写出马上又要删掉的行。',
      '有子进程时同样要求 --recursive；同一条命令里终止与删除在同一个事务里完成。',
      '进程若有一条终端持有的 `call --interactive` 正在跑，purge 只把那次调用标记为 interrupted 并删掉记录；你终端里的 pi 进程要自己退出（或用 `lush process agents kill`）。',
    ],
    usage: ['lush process purge PID [--recursive]'],
    positionals: [['PID', '目标进程 PID']],
    options: {
      '--recursive': {
        arg: null,
        desc: '整棵子树一起终止并删除',
        apply: (r) => { r.recursive = true; },
      },
    },
    parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
  },
  complete: {
    command: 'complete',
    method: 'process.complete',
    summary: '完成一个 Task',
    cover: [
      '仅 running Task：置为 completed，可把 result 存入 state；后续副作用工具被拒绝。',
      'Service 不能 complete；Task 完成时其活动直接子节点交给 PID 0 收养。',
    ],
    usage: ['lush process complete PID [--result JSON]'],
    positionals: [['PID', '目标 Task PID']],
    options: {
      '--result': { arg: 'JSON', desc: '完成结果，写入 state.result', apply: (r, v) => { r.result = jsonArg(v, '--result'); } },
    },
    parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
  },
  'update-state': {
    command: 'update-state',
    method: 'process.update_state',
    summary: '合并进程的持久 state',
    cover: [
      '把 --patch 的顶层字段 shallow-merge 进该进程的持久 state；嵌套对象整体替换。',
      '只能改结构化 state，不能覆写 pid、parent、type、status（RPC 方法名仍是 process.update_state）。',
    ],
    notes: [
      'state.params（不可变变量）与 state.vars（可变变量）归变量系统所有：写这两个键会被拒绝，可变变量用 `lush process update-vars`。',
    ],
    usage: ['lush process update-state PID --patch JSON'],
    positionals: [['PID', '目标进程 PID']],
    options: {
      '--patch': { arg: 'JSON', desc: '要合并的对象，必填', apply: (r, v) => { r.patch = jsonArg(v, '--patch'); } },
    },
    parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
    check: (r) => {
      if (!Object.hasOwn(r, 'patch')) throw new UsageError('the following arguments are required: --patch');
    },
  },
  'update-vars': {
    command: 'update-vars',
    method: 'process.update_vars',
    summary: '修改模板声明为可变（mutable）的变量',
    cover: [
      '把 --vars 的顶层字段 shallow-merge 进该进程的可变变量区（state.vars），保留未提到的变量。',
      '能改哪些名字由该进程创建时快照的模板 variables 声明决定：mutable 区的名字可改，immutable 区的名字（例如 project 的 path）拒绝，模板没声明的名字也拒绝。',
      '值立即持久化（状态与变量马上生效）；写入成功记 vars_updated 事件。',
    ],
    notes: [
      '只接受 running 进程（与 update-state 一致）。想知道自己有哪些可变变量，看 `lush process inspect PID` 的 variables.declarations。',
    ],
    usage: ['lush process update-vars PID --vars JSON'],
    positionals: [['PID', '目标进程 PID']],
    options: {
      '--vars': { arg: 'JSON', desc: '要合并的变量对象，必填', apply: (r, v) => { r.patch = jsonArg(v, '--vars'); } },
    },
    parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
    check: (r) => {
      if (!Object.hasOwn(r, 'patch')) throw new UsageError('the following arguments are required: --vars');
    },
  },
};
