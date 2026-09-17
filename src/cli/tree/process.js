import { VIEW_SECTIONS } from '../../core/types.js';
import { inspectSections, intArg, UsageError } from '../args.js';
import { processAgentGroup } from './process_agents.js';
import { processCallChildren } from './process_calls.js';
import { processLifecycleChildren } from './process_lifecycle.js';

/**
 * The `process` command group: the group's own documentation plus the read-only
 * verbs (list / tree / orphans / inspect / history / session). The mutating and
 * invoking verbs are declared in sibling modules and spread back in, so the
 * help output keeps listing every child in one stable order.
 */
export const processGroup = {
  summary: '逻辑进程：查看、调用、派生与生命周期',
  cover: [
    '查看：list、tree、inspect、history 读取进程 metadata、层级、Context 与消息历史。',
    '孤儿：父节点结束后的活动子节点由 PID 0 收养，`process orphans` 查看孤儿池与策略，`process orphans --sweep` 立刻按 TTL / 上限回收一次（冻结，不删除）。',
    'agent：每个进程的 agent（provider、busy、session）随进程走——tree --agents 一次看全，session 看单个。',
    '调用：call 发一次 prompt 并阻塞返回；attach 进入持续对话。',
    '派生：spawn 按模板在指定父进程下创建子进程，并按模板的 variables 声明校验变量。',
    '状态变更：start、stop、kill、reclaim、complete、update-state（持久 state）、update-vars（可变变量）。',
    '删除：delete 只删已结束的进程，purge 先停止/取消再删；两者都是不可逆的硬删除（该 PID 的记录连同 Context、消息、调用与事件一起消失）。',
    '不覆盖：daemon 自身启停与状态（见 `lush daemon`）。',
  ],
  notes: [
    'PID 0（lush 自身）不能 stop / kill / complete / reclaim / delete / purge，其生命周期由 daemon 管理。',
    'call 与 attach 只接受 running 进程；只有 Task 能 complete；只有 Service 能 stop；reclaim 只用于 Task，删除对两者都适用。',
    '删除会把该 PID 的 Context、messages、agent_calls 与 process_events 一并物理删除，被删记录不再出现在 list / tree / inspect / history 里；父进程会收到一条 child_deleted 事件。',
  ],
  children: {
    list: {
      command: 'list',
      method: 'process.list',
      summary: '列出全部进程',
      cover: [
        '列出所有逻辑进程（含 stopped / completed / reclaimed 等终态）的一行摘要：PID、父 PID、类型、状态、名称。',
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
        '默认在「此刻有 agent 在跑」的进程下多打一行活跃度：agent 编号（`PID.N`）、运行时长，--interactive 的加 tty 标记；没有 agent 在跑的进程不多占一行。',
        '进程有变量时在名字后跟一段 `key=value`：不可变变量直接写名字，可变变量加 `~` 前缀，长值截断；完整变量（含模板声明）用 `process inspect`。',
      ],
      notes: [
        'agent 是运行期的东西：daemon 重启后一个都不剩（持久记录是 agent_calls 与 `process session` 的 transcript）。',
        'agent 的详情、历史和终止用 `lush process agents list|show|kill`；--json 始终带上 agent 字段，--no-agents 连 JSON 也不带。',
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
    orphans: {
      command: 'orphans',
      method: (args) => (args.sweep ? 'process.orphan_sweep' : 'process.orphans'),
      summary: '查看 PID 0 收养的孤儿，或立刻按策略回收一次',
      cover: [
        '孤儿是被 PID 0 收养的进程：父节点进入终态时（Service 停止、Task 完成或取消），它的活动直接子节点被交给 PID 0，保留 original_parent_pid 以便追溯。PID 0 自己 spawn 的孩子不算孤儿。',
        '不带 --sweep 是只读的读模型：当前策略、活动孤儿数、超上限多少，以及每个孤儿的 busy / 闲置秒数（含已被冻结的历史行）。',
        '--sweep 立刻执行一次监督：先按 TTL 冻结闲置超时的孤儿，再按上限冻结最旧的，返回本轮报告（trigger / checked / evicted / deferred / limit / ttl_seconds）。',
        '回收是冻结而不是删除：Service → stopped、Task → cancelled，metadata、Context、消息、调用与事件全部保留（真删除只有 delete / purge）。',
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
    inspect: {
      command: 'inspect',
      method: (args) => (args.sections ? 'process.view' : 'process.inspect'),
      summary: '查看单个进程的完整快照',
      cover: [
        '不带 --with 时返回完整 inspect：metadata、Context、agent 状态、variables（不可变/可变变量的值 + 模板声明）、近期调用与事件，任何状态都可查。',
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
    ...processCallChildren,
    history: {
      command: 'history',
      method: 'process.history',
      summary: '读取进程的消息历史',
      cover: [
        '按 id 升序返回该进程持久化 messages 的一段。',
        '文本按消息分块（头部 `#id role · 时间 · call`，正文原样换行），末尾给出 `next --after`；--json 返回 messages 数组与 next_after。',
        '历史可以读取终态进程，但不会重新调用它们。',
      ],
      usage: ['lush process history PID [--after ID] [--limit N]'],
      positionals: [['PID', '目标进程 PID']],
      options: {
        '--after': { arg: 'ID', desc: '只返回 id 大于该值的消息（默认 0）', apply: (r, v) => { r.after = intArg(v, '--after'); } },
        '--limit': { arg: 'N', desc: '最多返回多少条（默认 100）', apply: (r, v) => { r.limit = intArg(v, '--limit'); } },
      },
      parse: (args) => ({ pid: intArg(args.shift(), 'pid'), after: 0, limit: 100 }),
    },
    ...processLifecycleChildren,
    agents: processAgentGroup,
    session: {
      command: 'session',
      method: 'process.session',
      summary: '查看该进程 agent 的 session，或用 --open 进入 pi TUI',
      cover: [
        '只读列出该进程 agent 的 session-dir、session-id、磁盘上的 session 文件、cwd 与 busy，任何状态都可查（含终态 Task 与 reclaimed）。',
        'agent 属于它所在的进程：由 daemon 的 provider 决定形态（`pi` 子进程 / `mock`、`openai` 内置），进程归档后 session 仍可查。',
        '--open 用带着 Lush 身份的命令把当前终端交给 pi TUI 接续该会话；内置运行时没有外部 session，会报错。',
      ],
      notes: [
        'busy 表示该进程有 call 正在运行，此时打开 TUI 可能交错写入。',
        '一个 session-id 可以对应多个回话文件（历史轮次）；`lush process tree --agents` 可一次看完所有进程的 agent 与文件数。',
        '--open 不能与 --json 同时使用。',
      ],
      usage: ['lush process session PID [--open]', 'lush process session PID --open  # 把终端交给 pi'],
      positionals: [['PID', '目标进程 PID']],
      options: {
        '--open': { arg: null, desc: '前台启动 pi TUI 接续该 session（内置运行时报错）', apply: (r) => { r.open = true; } },
      },
      parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
      check: (r) => {
        if (r.open && r.json) throw new UsageError('--open cannot be combined with --json');
      },
    },
  },
};
