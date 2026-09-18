import { VIEW_SECTIONS } from '../../core/types.js';
import { inspectSections, intArg } from '../args.js';
import { processLifecycleChildren } from './process_lifecycle.js';
import { processSpawnChild } from './process_spawn.js';

/**
 * The `process` command group: the passive side of Lush.
 *
 * A process holds identity (template system_prompt), variables, persistent
 * state, its place in the tree and its permissions (`child_templates`). It
 * never runs an agent and never finishes work: work lives in tasks, which are
 * created on it (`lush call`, `task spawn`) and delegated from there. This
 * group therefore covers the node itself — look at it, create children, start /
 * stop it, change its data, remove it, supervise orphans.
 */
export const processGroup = {
  summary: 'Process：被动节点（状态、变量、权限、生命周期）',
  cover: [
    '查看：list、tree、inspect、children 读取进程 metadata、层级、树位置与持久 Context（含挂载在它身上的 task）。',
    '派生：spawn 按模板在指定父进程下创建子进程，并按模板的 variables 声明校验变量；新节点是静止的，要干活得在它上面开 task（`lush call`）。',
    '状态：start 让节点重新接受 task，stop 停止它（它的 task 会先被取消）；process 不会「完成」——完成的是一次 task。',
    '数据：update-state 写这个节点跨 task 的长期 state，update-vars 改模板声明为 mutable 的变量。',
    '删除：delete 只删已停止的节点（连同它的 Context 与挂在它上面的 task），purge 先取消 task 再删；两者都不可逆。',
    '孤儿：父节点结束后，活动子节点由 PID 0 收养，`process orphans` 查看孤儿池与策略，`--sweep` 立刻按 TTL / 上限回收一次（冻结，不删除）。',
    '不覆盖：工作与 agent（task、call、agents、session）见 `lush task`；daemon 自身见 `lush daemon`。',
  ],
  notes: [
    'PID 0（lush 自身）不能 start / stop / delete / purge，其生命周期由 daemon 管理。',
    'active 的进程才能接受新 task（created 需要 start，stopped 需要先 start）。',
    '所有节点都是 process（被动）；会干活的是挂在它上面的 task，见 `lush task`。',
  ],
  children: {
    list: {
      command: 'list',
      method: 'process.list',
      summary: '列出全部进程',
      cover: [
        '列出所有逻辑进程（含 stopped）的一行摘要：PID、父 PID、状态、名称。',
        '挂载在进程上的 task 不在这一行里；用 `lush task list --pid PID` 或 `lush process inspect PID` 看它们。',
      ],
      usage: ['lush process list'],
      parse: () => ({}),
    },
    tree: {
      command: 'tree',
      method: 'process.tree',
      summary: '以树形打印进程层级，并在活跃进程上标出正在跑的 agent',
      cover: [
        '按 parent_pid 递归打印整棵树，根是 PID 0（lush）。',
        '孤儿已被 PID 0 收养，因此活动进程都会出现在某个位置。',
        '默认在「此刻有 agent 在跑」的进程下多打一行活跃度：agent 编号（`TASK.N`，TASK 是它正在做的 task）、运行时长，--interactive 的加 tty 标记；没有 agent 在跑的进程不多占一行。',
        '进程有变量时在名字后跟一段 `key=value`：不可变变量直接写名字，可变变量加 `~` 前缀，长值截断；完整变量（含模板声明）用 `process inspect`。',
      ],
      notes: [
        'agent 是运行期的东西：daemon 重启后一个都不剩（持久记录是 task 行、agent_calls 与 `task session` 的 transcript）。',
        'agent 的详情、历史和终止用 `lush task agents list|show|kill`；--json 始终带上 agent 字段，--no-agents 连 JSON 也不带。',
      ],
      usage: ['lush process tree [--no-agents]'],
      options: {
        '--no-agents': {
          arg: null,
          desc: '不附加 agent 活跃度（纯进程结构，--json 也不再带 agent 字段）',
          apply: (r) => { r.agents = false; },
        },
      },
      parse: () => ({}),
    },
    inspect: {
      command: 'inspect',
      method: (args) => (args.sections ? 'process.view' : 'process.inspect'),
      summary: '查看单个进程的完整快照',
      cover: [
        '不带 --with 时返回完整 inspect：metadata、Context、variable（不可变/可变变量的值 + 模板声明）、挂载在它身上的近期 task、近期调用与事件，任何状态都可查。',
        '带 --with 时改走 process.view，只返回所选 section（父节点、子节点、Call Prompt）。',
        '文本按「进程摘要 → context → calls → events」分节打印，时间用本地时间；`template_snapshot` 与变量声明只在 --json 里给出。',
      ],
      notes: [
        '--with 的逗号分隔列表可重复使用；重复的 section 在客户端去重，RPC 层仍拒绝重复。',
        `未知 section 报 usage 错误（退出码 2），可选值：${VIEW_SECTIONS.join(', ')}。`,
      ],
      usage: [`lush process inspect PID [--with ${VIEW_SECTIONS.join(',')}]`],
      positionals: [['PID', '要查看的进程 PID']],
      options: {
        '--with': {
          arg: 'SECTIONS',
          desc: `只返回所选 section，逗号分隔，可重复（${VIEW_SECTIONS.join(', ')}）`,
          apply: (result, value) => {
            const parts = inspectSections(['--with', value]) ?? [];
            // --with is repeatable; the RPC layer still rejects duplicates, so dedupe here.
            result.sections = [...(result.sections ?? []), ...parts].filter((s, i, all) => all.indexOf(s) === i);
          },
        },
      },
      // `--with` is repeatable, so collect every occurrence before validating.
      parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
    },
    children: {
      command: 'children',
      method: 'process.children',
      summary: '列出某个进程的直接子进程',
      cover: [
        '返回该 PID 的直接子进程（一行一个的 metadata 行）；孙节点不在里面。',
        '这是 agent 派活前要看的：子 task 只能挂在自己的直接子进程上。',
      ],
      usage: ['lush process children PID'],
      positionals: [['PID', '父进程 PID']],
      parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
    },
    orphans: {
      command: 'orphans',
      method: (args) => (args.sweep ? 'process.orphan_sweep' : 'process.orphans'),
      summary: '查看 PID 0 收养的孤儿，或立刻按策略回收一次',
      cover: [
        '孤儿是被 PID 0 收养的进程：父节点进入终态时（stop / purge），它的活动直接子节点被交给 PID 0，保留 original_parent_pid 以便追溯。PID 0 自己 spawn 的孩子不算孤儿。',
        '不带 --sweep 是只读的读模型：当前策略、活动孤儿数、超上限多少，以及每个孤儿的 busy / 闲置秒数（含已被冻结的历史行）。',
        '--sweep 立刻执行一次监督：先按 TTL 冻结闲置超时的孤儿，再按上限冻结最旧的，返回本轮报告（trigger / checked / evicted / deferred / limit / ttl_seconds）。',
        '回收是冻结而不是删除：孤儿一律置为 stopped（它手上的 task 会被取消），metadata、Context、task、消息、调用与事件全部保留（真删除只有 delete / purge）。',
        '有 agent 调用在跑的孤儿（busy）永远不会被冻结，只会出现在报告的 deferred 里。',
      ],
      notes: [
        '策略来自 daemon 启动时的环境变量，改配置必须重启 daemon：LUSH_ORPHAN_ADOPT（adopt | none | terminate）、LUSH_ORPHAN_LIMIT、LUSH_ORPHAN_TTL、LUSH_ORPHAN_SWEEP（见 README 的环境变量一节）。',
        '默认 adopt + 不限 + 不超时，与历史行为一致：此时 --sweep 什么都不会冻结。',
        'daemon 只在上限>0 或 TTL>0 且 sweep>0 时起定时器；`lush daemon status` 的 orphan_policy 与 orphans_active 能直接看到当前策略与孤儿数。',
        '被冻结的孤儿的 transition 事件里带 cause（orphan_ttl / orphan_limit），用 `lush process inspect PID` 可查。',
      ],
      usage: ['lush process orphans [--sweep]'],
      options: {
        '--sweep': {
          arg: null,
          desc: '不再只读：立刻按 TTL 与上限监督一次，并返回本轮报告',
          apply: (r) => { r.sweep = true; },
        },
      },
      parse: () => ({}),
    },
    ...processSpawnChild,
    ...processLifecycleChildren,
  },
};
