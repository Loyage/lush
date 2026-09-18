import { VIEW_SECTIONS } from '../../core/types.js';
import { inspectSections, intArg } from '../args.js';
import { serviceLifecycleChildren } from './service_lifecycle.js';
import { serviceConstructChild } from './service_construct.js';

/**
 * The `service` command group: the passive side of Lush.
 *
 * A service holds identity (template system_prompt), variables, persistent
 * state, its place in the tree and its permissions (`child_templates`). It
 * never runs an agent and never finishes work: work lives in tasks, which are
 * created on it (by the parser, or by `task construct`) and delegated from there. This
 * group therefore covers the node itself — look at it, create children, start /
 * stop it, change its data, remove it, supervise orphans.
 */
export const serviceGroup = {
  summary: 'Service：被动节点（状态、变量、权限、生命周期）',
  cover: [
    '查看：list、tree、inspect、children 读取服务 metadata、层级、树位置与持久 Context（含挂载在它身上的 task）。',
    '派生：construct 按模板在指定父服务下构造子服务，并按模板的 variables 声明校验变量；新节点是静止的（建它不影响任何 task）。平时不用手工建：解析器会把活安排给合适的节点；手工建只用于你确定要调整架构时。',
    '状态：start 让节点重新接受 task，stop 停止它（它的 task 会先被取消）；service 不会「完成」——完成的是一次 task。',
    '数据：update-state 写这个节点跨 task 的长期 state，update-vars 改模板声明为 mutable 的变量。',
    '删除：delete 只删已停止的节点（连同它的 Context 与挂在它上面的 task），purge 先取消 task 再删；两者都不可逆。',
    '孤儿：父节点结束后，活动子节点由 SID 0 收养，`service orphans` 查看孤儿池与策略，`--sweep` 立刻按 TTL / 上限回收一次（冻结，不删除）。',
    '不覆盖：工作与 agent（task、call、agents、session）见 `lush task`；daemon 自身见 `lush daemon`。',
  ],
  notes: [
    'SID 0（lush 自身）不能 start / stop / delete / purge，其生命周期由 daemon 管理。',
    'active 的服务才能接受新 task（created 需要 start，stopped 需要先 start）。',
    '所有节点都是 service（被动）；会干活的是挂在它上面的 task，见 `lush task`。',
  ],
  children: {
    list: {
      command: 'list',
      method: 'service.list',
      summary: '列出全部服务',
      cover: [
        '列出所有逻辑服务（含 stopped）的一行摘要：SID、父 SID、状态、名称。',
        '挂载在服务上的 task 不在这一行里；用 `lush task list --sid SID` 或 `lush service inspect SID` 看它们。',
      ],
      usage: ['lush service list'],
      parse: () => ({}),
    },
    tree: {
      command: 'tree',
      method: 'service.tree',
      summary: '以树形打印服务层级，并在活跃服务上标出正在跑的 agent',
      cover: [
        '按 parent_sid 递归打印整棵树，根是 SID 0（lush）。',
        '孤儿已被 SID 0 收养，因此活动服务都会出现在某个位置。',
        '默认在「此刻有 agent 在跑」的服务下多打一行活跃度：agent 编号（`TASK.N`，TASK 是它正在做的 task）、运行时长，--interactive 的加 tty 标记；没有 agent 在跑的服务不多占一行。',
        '服务有变量时在名字后跟一段 `key=value`：不可变变量直接写名字，可变变量加 `~` 前缀，长值截断；完整变量（含模板声明）用 `service inspect`。',
      ],
      notes: [
        'agent 是运行期的东西：daemon 重启后一个都不剩（持久记录是 task 行、agent_calls 与 `task session` 的 transcript）。',
        'agent 的详情、历史和终止用 `lush task agents list|show|kill`；--json 始终带上 agent 字段，--no-agents 连 JSON 也不带。',
      ],
      usage: ['lush service tree [--no-agents]'],
      options: {
        '--no-agents': {
          arg: null,
          desc: '不附加 agent 活跃度（纯服务结构，--json 也不再带 agent 字段）',
          apply: (r) => { r.agents = false; },
        },
      },
      parse: () => ({}),
    },
    inspect: {
      command: 'inspect',
      method: (args) => (args.sections ? 'service.view' : 'service.inspect'),
      summary: '查看单个服务的完整快照',
      cover: [
        '不带 --with 时返回完整 inspect：metadata、Context、variable（不可变/可变变量的值 + 模板声明）、挂载在它身上的近期 task、近期调用与事件，任何状态都可查。',
        '带 --with 时改走 service.view，只返回所选 section：description（这个节点是什么、能力边界在哪）、parent、children、prompt（call_prompt，即创建在它上面的 task 的 agent 收到的提示词）、templates（它现在还能创建哪些子模板，每项带 name / singleton / description / construct_prompt）。',
        'description、templates 与 prompt 是上级节点派活前要问的三件事：它能做什么、能建什么、在它上面开 task 会用哪段提示词；三者在同一节点上永远与 agent 自己 Context 里的 available_child_templates 一致。',
        '文本按「服务摘要 → context → calls → events」分节打印，时间用本地时间；`template_snapshot` 与变量声明只在 --json 里给出。',
      ],
      notes: [
        '--with 的逗号分隔列表可重复使用；重复的 section 在客户端去重，RPC 层仍拒绝重复。',
        `未知 section 报 usage 错误（退出码 2），可选值：${VIEW_SECTIONS.join(', ')}。`,
      ],
      usage: [`lush service inspect SID [--with ${VIEW_SECTIONS.join(',')}]`],
      positionals: [['SID', '要查看的服务 SID']],
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
      parse: (args) => ({ sid: intArg(args.shift(), 'sid') }),
    },
    children: {
      command: 'children',
      method: 'service.children',
      summary: '列出某个服务的直接子服务',
      cover: [
        '返回该 SID 的直接子服务（一行一个的 metadata 行）；孙节点不在里面。',
        '这是 agent 派活前要看的：子 task 只能挂在自己的直接子服务上。',
      ],
      usage: ['lush service children SID'],
      positionals: [['SID', '父服务 SID']],
      parse: (args) => ({ sid: intArg(args.shift(), 'sid') }),
    },
    orphans: {
      command: 'orphans',
      method: (args) => (args.sweep ? 'service.orphan_sweep' : 'service.orphans'),
      summary: '查看 SID 0 收养的孤儿，或立刻按策略回收一次',
      cover: [
        '孤儿是被 SID 0 收养的服务：父节点进入终态时（stop / purge），它的活动直接子节点被交给 SID 0，保留 original_parent_sid 以便追溯。SID 0 自己 construct 的孩子不算孤儿。',
        '不带 --sweep 是只读的读模型：当前策略、活动孤儿数、超上限多少，以及每个孤儿的 busy / 闲置秒数（含已被冻结的历史行）。',
        '--sweep 立刻执行一次监督：先按 TTL 冻结闲置超时的孤儿，再按上限冻结最旧的，返回本轮报告（trigger / checked / evicted / deferred / limit / ttl_seconds）。',
        '回收是冻结而不是删除：孤儿一律置为 stopped（它手上的 task 会被取消），metadata、Context、task、消息、调用与事件全部保留（真删除只有 delete / purge）。',
        '有 agent 调用在跑的孤儿（busy）永远不会被冻结，只会出现在报告的 deferred 里。',
      ],
      notes: [
        '策略来自 daemon 启动时的环境变量，改配置必须重启 daemon：LUSH_ORPHAN_ADOPT（adopt | none | terminate）、LUSH_ORPHAN_LIMIT、LUSH_ORPHAN_TTL、LUSH_ORPHAN_SWEEP（见 README 的环境变量一节）。',
        '默认 adopt + 不限 + 不超时，与历史行为一致：此时 --sweep 什么都不会冻结。',
        'daemon 只在上限>0 或 TTL>0 且 sweep>0 时起定时器；`lush daemon status` 的 orphan_policy 与 orphans_active 能直接看到当前策略与孤儿数。',
        '被冻结的孤儿的 transition 事件里带 cause（orphan_ttl / orphan_limit），用 `lush service inspect SID` 可查。',
      ],
      usage: ['lush service orphans [--sweep]'],
      options: {
        '--sweep': {
          arg: null,
          desc: '不再只读：立刻按 TTL 与上限监督一次，并返回本轮报告',
          apply: (r) => { r.sweep = true; },
        },
      },
      parse: () => ({}),
    },
    ...serviceConstructChild,
    ...serviceLifecycleChildren,
  },
};
