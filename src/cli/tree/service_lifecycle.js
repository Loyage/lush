import { intArg, jsonArg, UsageError } from '../args.js';

/**
 * The `service` verbs that change a **passive node**: start / stop, the two
 * state writers, and the hard removals. Work verbs (creating a task, waiting
 * for it, cancelling it) live in `task.js`; read-only verbs in `service.js`.
 */
export const serviceLifecycleChildren = {
  start: {
    command: 'start',
    method: 'service.start',
    summary: '启动或重启服务',
    cover: [
      '启动 created 的服务，重启 stopped 的服务，active 时幂等。',
      '启动只是让这个节点重新接受 task；它自己不会运行任何 agent。',
    ],
    usage: ['lush service start SID'],
    positionals: [['SID', '目标服务 SID']],
    parse: (args) => ({ sid: intArg(args.shift(), 'sid') }),
  },
  stop: {
    command: 'stop',
    method: 'service.stop',
    summary: '停止服务（节点不再接受 task）',
    cover: [
      '置为 stopped，不级联终止子节点；其活动直接子节点交给 SID 0 收养。该 SID 上的 task 会先被取消（停止一个节点就是停止它手上的活）。',
      '有活动 task 时直接拒统（提示先 `lush task cancel <id>`），避免悄悄杀掉正在跑的 agent；等它结束再用 stop。',
    ],
    usage: ['lush service stop SID'],
    positionals: [['SID', '目标服务 SID']],
    parse: (args) => ({ sid: intArg(args.shift(), 'sid') }),
  },
  delete: {
    command: 'delete',
    method: 'service.delete',
    summary: '硬删除已停止的服务，连同它的 Context、task、消息与事件',
    cover: [
      '只删 stopped 的服务；active/created 或还有活动 task 时被拒绝（-32010），提示先 stop / cancel，或改用 `lush service purge`。',
      '删除是物理删除且不可逆：该 SID 的 services、contexts、挂载在它上面的 tasks（含 task_events）、messages、agent_calls、service_events 行在同一个事务里一起消失，之后 list / tree / inspect 都不再有它。',
      '子 task 若挂在别的服务上（父 task 被删），会变成根 task 继续存在，不会跟着消失。',
      '父服务（若还在）会收到一条 child_deleted 事件，记录被删 SID 的名字、模板与当时状态。',
    ],
    notes: [
      '有子服务时默认拒绝（删掉父行会让子服务指向不存在的行）；--recursive 在同一个事务里从叶子往上删整棵子树，回包里的 deleted 列出全部 SID。',
      '服务变量（state.params / state.vars）也在 Context 里，随服务一起消失；需要保留证据时先 `lush service inspect SID` / `lush task history` 导出。',
    ],
    usage: ['lush service delete SID [--recursive]'],
    positionals: [['SID', '目标服务 SID']],
    options: {
      '--recursive': {
        arg: null,
        desc: '整棵子树一起删（子服务必须先于父服务消失）',
        apply: (r) => { r.recursive = true; },
      },
    },
    parse: (args) => ({ sid: intArg(args.shift(), 'sid') }),
  },
  purge: {
    command: 'purge',
    method: 'service.purge',
    summary: '先取消它的 task 再硬删除，一条命令清掉一个服务',
    cover: [
      '`service delete` 的强制版本：子树里活动的 task 先被取消（中断它们的 agent），活动服务再置为 stopped，随后按 delete 的规则物理删除。',
      '回包的 cancelled 列出被取消的 task，terminated 列出被停止的 SID，deleted 列出实际消失的全部 SID，rows 是按表统计的删除行数。',
    ],
    notes: [
      '与 stop 不同，purge 不把活动子节点交给 SID 0 收养：整棵子树的每个活动节点都会被终止，收养只会写出马上又要删掉的行。',
      '有子服务时同样要求 --recursive；同一条命令里取消、停止与删除在同一个事务里完成。',
      '服务若有一条终端持有的 `call --interactive` 正在跑，purge 只把那次调用标记为 interrupted 并删掉记录；你终端里的 pi 服务要自己退出（或用 `lush task agents kill`）。',
    ],
    usage: ['lush service purge SID [--recursive]'],
    positionals: [['SID', '目标服务 SID']],
    options: {
      '--recursive': {
        arg: null,
        desc: '整棵子树一起终止并删除',
        apply: (r) => { r.recursive = true; },
      },
    },
    parse: (args) => ({ sid: intArg(args.shift(), 'sid') }),
  },
  'update-state': {
    command: 'update-state',
    method: 'service.update_state',
    summary: '合并服务的长期 state',
    cover: [
      '把 --patch 的顶层字段 shallow-merge 进该服务的持久 state；嵌套对象整体替换。这是这个节点跨 task 长期保存的知识。',
      '只能改结构化 state，不能覆写 sid、parent、status（RPC 方法名仍是 service.update_state）。',
    ],
    notes: [
      'state.params（不可变变量）与 state.vars（可变变量）归变量系统所有：写这两个键会被拒绝，可变变量用 `lush service update-vars`。',
      '一次工作自己的草稿写在 task 上，见 `lush task update-state`。',
    ],
    usage: ['lush service update-state SID --patch JSON'],
    positionals: [['SID', '目标服务 SID']],
    options: {
      '--patch': { arg: 'JSON', desc: '要合并的对象，必填', apply: (r, v) => { r.patch = jsonArg(v, '--patch'); } },
    },
    parse: (args) => ({ sid: intArg(args.shift(), 'sid') }),
    check: (r) => {
      if (!Object.hasOwn(r, 'patch')) throw new UsageError('the following arguments are required: --patch');
    },
  },
  'update-vars': {
    command: 'update-vars',
    method: 'service.update_vars',
    summary: '修改模板声明为可变（mutable）的变量',
    cover: [
      '把 --vars 的顶层字段 shallow-merge 进该服务的可变变量区（state.vars），保留未提到的变量。',
      '能改哪些名字由该服务创建时快照的模板 variables 声明决定：mutable 区的名字可改，immutable 区的名字（例如 project 的 path）拒绝，模板没声明的名字也拒绝。',
      '值立即持久化（状态与变量马上生效）；写入成功记 vars_updated 事件。',
    ],
    notes: [
      '只接受 active 服务（与 update-state 一致）。想知道自己有哪些可变变量，看 `lush service inspect SID` 的 variables.declarations。',
    ],
    usage: ['lush service update-vars SID --vars JSON'],
    positionals: [['SID', '目标服务 SID']],
    options: {
      '--vars': { arg: 'JSON', desc: '要合并的变量对象，必填', apply: (r, v) => { r.patch = jsonArg(v, '--vars'); } },
    },
    parse: (args) => ({ sid: intArg(args.shift(), 'sid') }),
    check: (r) => {
      if (!Object.hasOwn(r, 'patch')) throw new UsageError('the following arguments are required: --vars');
    },
  },
};
