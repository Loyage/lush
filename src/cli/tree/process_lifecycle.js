import { intArg, jsonArg, UsageError } from '../args.js';

/**
 * The `process` verbs that change a **passive node**: start / stop, the two
 * state writers, and the hard removals. Work verbs (creating a task, waiting
 * for it, cancelling it) live in `task.js`; read-only verbs in `process.js`.
 */
export const processLifecycleChildren = {
  start: {
    command: 'start',
    method: 'process.start',
    summary: '启动或重启进程',
    cover: [
      '启动 created 的进程，重启 stopped 的进程，active 时幂等。',
      '启动只是让这个节点重新接受 task；它自己不会运行任何 agent。',
    ],
    usage: ['lush process start PID'],
    positionals: [['PID', '目标进程 PID']],
    parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
  },
  stop: {
    command: 'stop',
    method: 'process.stop',
    summary: '停止进程（节点不再接受 task）',
    cover: [
      '置为 stopped，不级联终止子节点；其活动直接子节点交给 PID 0 收养。该 PID 上的 task 会先被取消（停止一个节点就是停止它手上的活）。',
      '有活动 task 时直接拒统（提示先 `lush task cancel <id>`），避免悄悄杀掉正在跑的 agent；等它结束再用 stop。',
    ],
    usage: ['lush process stop PID'],
    positionals: [['PID', '目标进程 PID']],
    parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
  },
  delete: {
    command: 'delete',
    method: 'process.delete',
    summary: '硬删除已停止的进程，连同它的 Context、task、消息与事件',
    cover: [
      '只删 stopped 的进程；active/created 或还有活动 task 时被拒绝（-32010），提示先 stop / cancel，或改用 `lush process purge`。',
      '删除是物理删除且不可逆：该 PID 的 processes、contexts、挂载在它上面的 tasks（含 task_events）、messages、agent_calls、process_events 行在同一个事务里一起消失，之后 list / tree / inspect 都不再有它。',
      '子 task 若挂在别的进程上（父 task 被删），会变成根 task 继续存在，不会跟着消失。',
      '父进程（若还在）会收到一条 child_deleted 事件，记录被删 PID 的名字、模板与当时状态。',
    ],
    notes: [
      '有子进程时默认拒绝（删掉父行会让子进程指向不存在的行）；--recursive 在同一个事务里从叶子往上删整棵子树，回包里的 deleted 列出全部 PID。',
      '进程变量（state.params / state.vars）也在 Context 里，随进程一起消失；需要保留证据时先 `lush process inspect PID` / `lush task history` 导出。',
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
    summary: '先取消它的 task 再硬删除，一条命令清掉一个进程',
    cover: [
      '`process delete` 的强制版本：子树里活动的 task 先被取消（中断它们的 agent），活动进程再置为 stopped，随后按 delete 的规则物理删除。',
      '回包的 cancelled 列出被取消的 task，terminated 列出被停止的 PID，deleted 列出实际消失的全部 PID，rows 是按表统计的删除行数。',
    ],
    notes: [
      '与 stop 不同，purge 不把活动子节点交给 PID 0 收养：整棵子树的每个活动节点都会被终止，收养只会写出马上又要删掉的行。',
      '有子进程时同样要求 --recursive；同一条命令里取消、停止与删除在同一个事务里完成。',
      '进程若有一条终端持有的 `call --interactive` 正在跑，purge 只把那次调用标记为 interrupted 并删掉记录；你终端里的 pi 进程要自己退出（或用 `lush task agents kill`）。',
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
  'update-state': {
    command: 'update-state',
    method: 'process.update_state',
    summary: '合并进程的长期 state',
    cover: [
      '把 --patch 的顶层字段 shallow-merge 进该进程的持久 state；嵌套对象整体替换。这是这个节点跨 task 长期保存的知识。',
      '只能改结构化 state，不能覆写 pid、parent、status（RPC 方法名仍是 process.update_state）。',
    ],
    notes: [
      'state.params（不可变变量）与 state.vars（可变变量）归变量系统所有：写这两个键会被拒绝，可变变量用 `lush process update-vars`。',
      '一次工作自己的草稿写在 task 上，见 `lush task update-state`。',
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
      '只接受 active 进程（与 update-state 一致）。想知道自己有哪些可变变量，看 `lush process inspect PID` 的 variables.declarations。',
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
