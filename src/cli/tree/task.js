import { intArg, jsonArg, UsageError } from '../args.js';
import { taskAgentGroup } from './task_agents.js';

/**
 * The `task` command group: the work layer of Lush.
 *
 * A service is a passive node; a task is one piece of work mounted on it, and
 * it is what has an agent. `lush call SID '...'` creates the root task of a
 * collaboration; the tasks that root opens on its child services (with
 * `task_spawn`) are how the work travels down the tree — `lush task tree`
 * shows that tree.
 */
export const taskGroup = {
  summary: 'Task：挂在 service 上的一次工作（有 agent、有 result、有子 task）',
  cover: [
    'task 是唯一会调用 agent 的东西：一个 task 有 goal、status、自己的草稿 state 和 result；它结束后 result 就是交给派活方的答案。',
    'task 只能挂在 service 上；一个 service 同时最多一个活动 task（下游正忙时派活会被拒绝）。子 task 只能挂在自己的直接子 service 上，所以 task 树总是沿着 service 树向下生长。',
    '查看：list、tree（整棵协作树）、inspect、result、history（这个 task 自己的对话）、session（它 agent 的磁盘会话）、agents（此刻在跑的 agent）。',
    '等待与取消：wait 阻塞到某个 task 及其子树结束；cancel 取消一棵子树（连它的后代一起）。',
    '结束：complete 由 task 自己的 agent（或人）在目标达成时调用，result 存进 task；有未结束的子 task 时会被拒绝。',
    '任务创建后不会等待：先派子 task（或直接干），结束本轮后 task 会自动 park；子 task 结算或收到消息时以一条 user 消息唤醒 agent。',
    '不覆盖：被动节点本身（建、启停、变量、删除）见 `lush service`；用户入口 `lush call` 是「在某个 service 上开一个根 task 并等它」。',
  ],
  notes: [
    'task 的状态：created → running →（waiting）→ completed / failed / cancelled；waiting 表示 task 已让出本次运行（在等子 task 或等消息），agent 不在跑；子 task 结算或收到消息时它会被唤醒。',
    '终结不变量：一个 task 走到终态时不会有活动的子 task——complete 要求子 task 都已结束且收件箱没有未读消息，failed / cancelled 会把子 task 一起取消。',
    'daemon 重启时，未结束的 task 会被记为 failed（agent 已经不在了），不会自动重放。',
  ],
  children: {
    list: {
      command: 'task_list',
      method: 'task.list',
      summary: '列出 task（默认最近的在前，最多 200 条）',
      cover: [
        '一行一个 task：ID、挂载的 SID、父 task、状态、goal 摘要、result 摘要。',
        '--sid 只看挂在某个 service 上的 task；--status 只看某个状态；--roots 只看根 task（用户直接开的），--children 只看派出去的子 task。',
      ],
      usage: ['lush task list [--sid SID] [--status STATUS] [--roots|--children] [--limit N]'],
      options: {
        '--sid': { arg: 'SID', desc: '只看这个 service 上的 task', apply: (r, v) => { r.sid = intArg(v, '--sid'); } },
        '--status': {
          arg: 'STATUS',
          desc: '只看某个状态（created / running / waiting / completed / failed / cancelled）',
          apply: (r, v) => { r.status = v; },
        },
        '--roots': { arg: null, desc: '只看根 task（parent_task_id 为空）', apply: (r) => { r.roots = 'roots'; } },
        '--children': { arg: null, desc: '只看子 task', apply: (r) => { r.roots = 'children'; } },
        '--limit': { arg: 'N', desc: '最多返回多少条（默认 200）', apply: (r, v) => { r.limit = intArg(v, '--limit'); } },
      },
      parse: () => ({}),
    },
    tree: {
      command: 'task_tree',
      method: 'task.tree',
      summary: '以树形打印一个 task 及其派出去的全部子 task',
      cover: [
        '每个节点一行：`#ID service-name[SID] status · goal 摘要`，下一层是它派出去的 task。这就是「一件事如何在服务之间合作完成」的视图。',
        '跑起来的 task 后面的 agent 编号（`task agents list` 的 TASK.N）也可以在 tree 里看到，方便对照谁在干活。',
      ],
      usage: ['lush task tree TASK_ID'],
      positionals: [['TASK_ID', '根 task 的 id']],
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id') }),
    },
    inspect: {
      command: 'task_inspect',
      method: 'task.inspect',
      summary: '查看一个 task 的完整快照',
      cover: [
        'task 本身（goal、status、result、error、草稿 state）、它挂载的 service、父 task、直接子 task、最近调用与事件。',
        '文本按「task 摘要 → service → 子 task → calls → events」分节打印；--json 给出完整快照。',
      ],
      usage: ['lush task inspect TASK_ID'],
      positionals: [['TASK_ID', '目标 task id']],
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id') }),
    },
    result: {
      command: 'task_result',
      method: 'task.result',
      summary: '取一个 task 的结论',
      cover: [
        '返回 status、finished、result 与 error；未结束时 finished=false（不会阻塞，要等请用 `lush task wait`）。',
      ],
      usage: ['lush task result TASK_ID'],
      positionals: [['TASK_ID', '目标 task id']],
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id') }),
    },
    wait: {
      command: 'task_wait',
      method: 'task.wait',
      summary: '阻塞到一个 task 结束，然后返回它的快照',
      cover: [
        '等到该 task 进入终态（completed / failed / cancelled）为止；因为终态 task 不会有活动子 task，所以等到它就等于等到它整棵子树。',
        '等待的时间受 CLI 的 LUSH_RPC_TIMEOUT 约束（默认调用超时 + 10 秒）；这期间 task 在 daemon 里照常跑。',
      ],
      usage: ['lush task wait TASK_ID'],
      positionals: [['TASK_ID', '目标 task id']],
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id') }),
    },
    cancel: {
      command: 'task_cancel',
      method: 'task.cancel',
      summary: '取消一个 task 及其整棵子树',
      cover: [
        '正在跑的 agent 被中断，task 记为 cancelled；它派出去的子 task 一起取消（终态不变量）。',
        '已结束的 task 幂等返回，不会复活。取消一个 service 上的活动 task 之后，才能 `lush service stop` 它。',
      ],
      usage: ['lush task cancel TASK_ID'],
      positionals: [['TASK_ID', '目标 task id']],
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id') }),
    },
    complete: {
      command: 'task_complete',
      method: 'task.complete',
      summary: '把 task 标记为完成并写入 result',
      cover: [
        '由 task 自己的 agent 调用（人的话通常用 `lush call` 等它结束，不需要手动 complete）。',
        '有未结束的子 task 时被拒绝：先 `task wait` 它们，或 `task cancel` 不需要的。',
      ],
      usage: ['lush task complete TASK_ID [--result JSON]'],
      positionals: [['TASK_ID', '目标 task id']],
      options: {
        '--result': { arg: 'JSON', desc: '完成结果，写入 task.result', apply: (r, v) => { r.result = jsonArg(v, '--result'); } },
      },
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id') }),
    },
    spawn: {
      command: 'task_spawn',
      method: 'task.spawn',
      summary: '在某个 service 上派一个 task（不等待）',
      cover: [
        '在 SID 上创建并立刻启动一个 task，返回它的 id；随后用 `task wait` / `task inspect` / `task tree` 观察。',
        '这是 agent 内部 `task_spawn` 工具的命令行等价物：--parent-task-id 给定时，SID 必须是父 task 所在 service 的直接子服务（下游委托）；不给时创建的是根 task。',
      ],
      notes: [
        '同一个 service 同时只能有一个活动 task；该 service 正忙时派活会被拒绝。',
      ],
      usage: ['lush task spawn SID --goal GOAL [--parent-task-id TASK_ID]'],
      positionals: [['SID', '挂载 task 的 service SID']],
      options: {
        '--goal': { arg: 'GOAL', desc: '要做什么（必填）', apply: (r, v) => { r.goal = v; } },
        '--parent-task-id': {
          arg: 'TASK_ID',
          desc: '派活的父 task（缺省时创建根 task）',
          apply: (r, v) => { r.parent_task_id = intArg(v, '--parent-task-id'); },
        },
      },
      parse: (args) => ({ sid: intArg(args.shift(), 'sid') }),
      check: (r) => {
        if (!Object.hasOwn(r, 'goal')) throw new UsageError('the following arguments are required: --goal');
      },
    },
    message: {
      command: 'task_message',
      method: 'task.message',
      summary: '给直接父 task 或直接子 task 发一条消息（入队，不打断对方）',
      cover: [
        '消息只在 task 树的直接边上走：接收方必须是你所在的 task 的直接父 task 或直接子 task（和 task_spawn 的“只能向下游、直接子 service”同一条边界）。',
        '它是**异步**的：消息先入接收方的收件箱，在它两次 agent invocation 之间才交给它的 agent，所以不会打断正在跑的工作；对方处于 waiting 时会立即被唤醒。',
        'agent 侧用 `task_message` 工具（内置运行时）/ `lush task message ...`（外部 agent pi）；--from 缺省取 $LUSH_TASK_ID。',
      ],
      notes: [
        '接收方已进入终态时会被拒绝（-32010）：任务已经结束，没人会读了。',
        '已经结束的 task 投递过的消息不会重投；要回顾用 `lush task inbox`。',
      ],
      usage: ['lush task message TASK_ID --body TEXT [--from TASK_ID]'],
      positionals: [['TASK_ID', '接收方 task（直接父 task 或直接子 task）']],
      options: {
        '--body': { arg: 'TEXT', desc: '消息正文（必填）', apply: (r, v) => { r.body = v; } },
        '--from': {
          arg: 'TASK_ID',
          desc: '发送方 task（缺省用 $LUSH_TASK_ID）',
          apply: (r, v) => { r.from_task_id = intArg(v, '--from'); },
        },
      },
      parse: (args) => {
        const fromEnv = process.env.LUSH_TASK_ID ?? '';
        return {
          to_task_id: intArg(args.shift(), 'task_id'),
          ...(/^\d+$/.test(fromEnv) ? { from_task_id: Number.parseInt(fromEnv, 10) } : {}),
        };
      },
      check: (r) => {
        if (!Object.hasOwn(r, 'body')) throw new UsageError('the following arguments are required: --body');
        if (!Object.hasOwn(r, 'from_task_id')) {
          throw new UsageError('sending task is required: pass --from TASK_ID or set $LUSH_TASK_ID');
        }
      },
    },
    inbox: {
      command: 'task_inbox',
      method: 'task.inbox',
      summary: '查看一个 task 的收件箱（父 / 子消息与子 task 结算）',
      cover: [
        '按 id 升序列出投给该 task 的输入：`kind` 为 message（父子消息）或 child_settled（某个子 task 结算的报告），`delivered` 说明是否已经交给它的 agent。',
        '这是只读的审计视图——actual 的注入仍由 task 层在两次 invocation 之间完成。',
      ],
      usage: ['lush task inbox TASK_ID [--after ID] [--limit N]'],
      positionals: [['TASK_ID', '目标 task id']],
      options: {
        '--after': { arg: 'ID', desc: '只返回 id 大于该值的行（默认 0）', apply: (r, v) => { r.after = intArg(v, '--after'); } },
        '--limit': { arg: 'N', desc: '最多返回多少条（默认 50）', apply: (r, v) => { r.limit = intArg(v, '--limit'); } },
      },
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id'), after: 0, limit: 50 }),
    },
    'update-state': {
      command: 'task_update_state',
      method: 'task.update_state',
      summary: '合并这个 task 自己的草稿 state',
      cover: [
        '把 --patch 的顶层字段 shallow-merge 进 task.state：这是「这一次工作」的进展记录，服务的长期 state 是另一份（`lush service update-state`）。',
      ],
      usage: ['lush task update-state TASK_ID --patch JSON'],
      positionals: [['TASK_ID', '目标 task id']],
      options: {
        '--patch': { arg: 'JSON', desc: '要合并的对象，必填', apply: (r, v) => { r.patch = jsonArg(v, '--patch'); } },
      },
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id') }),
      check: (r) => {
        if (!Object.hasOwn(r, 'patch')) throw new UsageError('the following arguments are required: --patch');
      },
    },
    history: {
      command: 'task_history',
      method: 'task.history',
      summary: '读取这个 task 自己的对话历史',
      cover: [
        '按 id 升序返回该 task 的 messages（只属于这个 task，别的 task 的对话不在里面）。',
        '文本按消息分块（头部 `#id role · 时间 · call`，正文原样换行），末尾给出 `next --after`；--json 返回 messages 数组与 next_after。',
      ],
      usage: ['lush task history TASK_ID [--after ID] [--limit N]'],
      positionals: [['TASK_ID', '目标 task id']],
      options: {
        '--after': { arg: 'ID', desc: '只返回 id 大于该值的消息（默认 0）', apply: (r, v) => { r.after = intArg(v, '--after'); } },
        '--limit': { arg: 'N', desc: '最多返回多少条（默认 100）', apply: (r, v) => { r.limit = intArg(v, '--limit'); } },
      },
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id'), after: 0, limit: 100 }),
    },
    session: {
      command: 'task_session',
      method: 'task.session',
      summary: '查看该 task 的 agent 会话，或用 --open 进入 pi TUI',
      cover: [
        '只读列出该 task 的 session-dir、session-id（`lush-task-<id>`）、磁盘文件、cwd 与 busy，任何状态都可查。',
        'task 的 agent 属于这个 task：session 按 task 分开，多个 task 即使挂在同一个 service 上也不会共用会话。',
        '--open 用带着 Lush 身份与环境（LUSH_SID / LUSH_TASK_ID）的命令把当前终端交给 pi TUI 接续该会话；内置运行时没有外部 session，会报错。',
      ],
      notes: [
        'busy 表示该 task 有调用正在运行，此时打开 TUI 可能交错写入。',
        '--open 不能与 --json 同时使用。',
      ],
      usage: ['lush task session TASK_ID [--open]'],
      positionals: [['TASK_ID', '目标 task id']],
      options: {
        '--open': { arg: null, desc: '前台启动 pi TUI 接续该 session（内置运行时报错）', apply: (r) => { r.open = true; } },
      },
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id') }),
      check: (r) => {
        // The terminal is handed to pi, so there is nothing left to serialize.
        if (r.open && r.json) throw new UsageError('--open cannot be combined with --json');
      },
    },
    attach: {
      command: 'task_attach',
      method: 'task.session',
      summary: '进入该 task 的 agent 会话（= session --open）',
      cover: [
        '把当前终端交给这个 task 的 pi 会话，之后你可以直接与它对话、看它怎么继续派活；退出 TUI 后回到 shell。',
        '仅外部 agent（pi）可用；内置运行时没有可进入的服务。',
      ],
      usage: ['lush task attach TASK_ID'],
      positionals: [['TASK_ID', '目标 task id']],
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id') }),
      check: (r) => {
        if (r.json) throw new UsageError('--json makes no sense for an interactive session; use `lush task session`');
      },
    },
    delete: {
      command: 'task_delete',
      method: 'task.delete',
      summary: '删除一个已结束的 task 记录',
      cover: [
        '只删 task 行与它的事件；messages / agent_calls 作为 service 的历史保留（task 是组织单位，历史留痕在 service 上）。',
        '有活动 task 时拒绝；有子 task 时要求 --recursive（子 task 会先被删）。子 task 的 parent_task_id 指向被删 task 时，它们会变成根 task。',
      ],
      usage: ['lush task delete TASK_ID [--recursive]'],
      positionals: [['TASK_ID', '目标 task id']],
      options: {
        '--recursive': { arg: null, desc: '连同它的子 task 一起删', apply: (r) => { r.recursive = true; } },
      },
      parse: (args) => ({ task_id: intArg(args.shift(), 'task_id') }),
    },
    agents: taskAgentGroup,
  },
};
