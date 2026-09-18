import { intArg, next, UsageError } from '../args.js';

/**
 * The optional leading `INTENSION_ID`.
 *
 * `parse` runs while the option tokens are still in `args`, so an absent id has
 * to be detected *without* consuming anything: the parser's own call is
 * `lush intent settle --status settled --response '…'` with no id at all (the
 * row is resolved through `$LUSH_TASK_ID`), and eating `--status` as a
 * positional would reject exactly the invocation the protocol asks for.
 */
function positionalId(args) {
  const first = args[0];
  if (first === undefined || first.startsWith('-')) return {};
  return { intension_id: intArg(args.shift(), 'intension_id') };
}

/** The parsing task as the address of one row: `$LUSH_TASK_ID` is the handle an agent has. */
function parsingTask() {
  const raw = process.env.LUSH_TASK_ID;
  if (raw === undefined || raw === '') return {};
  return { from_task_id: intArg(raw, '$LUSH_TASK_ID') };
}

/**
 * The `intent` command group: the one way a human says something to Lush.
 *
 * An **intension** is the user's own words plus the service they named (or
 * none). It is not a task: it is an input row. The top-level parsing node
 * (SID 0) takes them one at a time — a service runs one task at a time, so the
 * queue is serial by construction — and decides what to make of each: arrange
 * it as work (delegating downstream), answer it directly, or, when the input
 * conflicts with the architecture or with tasks already running, ask the user
 * through a `notice` before doing anything.
 *
 * Every other entry point in Lush delegates *downstream* into an existing task
 * tree. This one is the root: `lush intent submit` is what a person types, and
 * everything else follows from it.
 */
export const intentGroup = {
  summary: 'Intension：用户输入的统一入口（由 SID 0 串行解析成 task 或答复）',
  cover: [
    'intension 是**用户输入**本身：`lush intent submit \'<原话>\'` 把你说的话逐字记下来，附上你指定的 service（可省略）。它不是 task——task 是解析之后安排出来的活。',
    '顶层解析节点（SID 0）按队列顺序一条条处理：先读一遍全局（模板树、服务树、每个节点上的活动 task、未决 intension、还没处理的 notice），判断这条输入该交给谁、和现有架构或正在跑的活有没有冲突。',
    '**串行**：解析发生在 SID 0 的一个根 task 里，而一个 service 同时只跑一个 task。所以同一时刻只有一条 intension 在被解析，其余的按先来后到排在 queued。',
    '有冲突就**问你**：解析器用 notice（kind=decision）把冲突和选项报上来，那条 intension 进入 awaiting；你 `lush notice answer` 之后它带着你的选择继续。',
    '安排完成（或拒绝）后 intension 变成 settled / rejected，resolution 里记着它派了哪些 task、或为什么没做；`lush task tree <解析 task id>` 能看到这件事在服务间怎么协作做完。',
  ],
  notes: [
    '状态：queued（排队）→ parsing（正在解析）→ awaiting（在等你裁决冲突）→ settled / rejected；settled 的 response 就是解析器给你的结论。',
    '解析失败的 task 会把这条输入放回队列重试（attempts 计数），连续失败 3 次才标成 rejected——你说过的话不会因为一次解析翻车就消失。',
    '提交时指定的 SID 只是**提示**：它必须存在（写错会立刻报错），但该不该用它、要不要新建节点，由解析器决定。',
    'agent 不能用这一组命令（$LUSH_TASK_ID 存在时会拒绝）：task 之间向上找人用 `notice`，向下派活用 `lush task construct`。',
    '冲突裁决、结果汇报都在 notice 那一边：`lush notice list` 看待处理项，`lush intent list` 看你的输入排到哪了。',
  ],
  children: {
    submit: {
      command: 'intent_submit',
      method: 'intent.submit',
      summary: '提交一条 intension（用户输入），交给顶层解析器',
      cover: [
        '把你的话逐字记下来并排队；解析很快开始（SID 0 空着的话就是立刻），返回这条 intension 的快照（id / status / 派给谁）。',
        '--sid 指出你希望它落在哪个 service 上（省略就由解析器判断）。它不是命令，只是一个提示：解析器会核对它是否存在、是否在跑别的活、是不是架构上该由它接这件事。',
        '--wait 阻塞到这条 intension 离开队列（settled / rejected），打印最终结论——脚本里的「提交并等结果」就是它。默认立即返回，用 `lush intent show` / `intent wait` 观察。',
        '--interactive 交给这个终端自己跑解析任务（pi TUI）：适合盯着解析器干活、或手工把这件事安排掉。',
        '解析器发现冲突（目标正忙、和已打开的项目/架构不符等）时会用 notice 问你，intension 进入 awaiting；处理完 `lush notice` 之后它自己接着走。',
      ],
      notes: [
        '目标 SID 不存在会直接报错（那是笔误，不是你该做的决策）；真冲突才会变成一条要你回答的 notice。',
        '--wait 可能等很久（它等到解析器把这件事安排完并结算）；长活建议不 --wait，之后用 `lush intent show` / `lush task tree` 跟。',
      ],
      usage: [
        "lush intent submit CONTENT [--sid SID] [--wait]",
        'lush intent submit CONTENT --interactive   # 在这个终端里自己当解析器',
      ],
      positionals: [['CONTENT', '你要说的话（原话，会逐字记录）']],
      options: {
        '--sid': {
          arg: 'SID',
          desc: '你希望这件事落在哪个 service（可选提示）',
          apply: (r, v) => { r.sid = intArg(v, '--sid'); },
        },
        '--wait': { arg: null, desc: '阻塞到这条 intension 结算（settled / rejected）', apply: (r) => { r.wait = true; } },
        '--interactive': {
          arg: null,
          desc: '在这个终端里自己当解析器（外部 agent pi 才支持）',
          apply: (r) => { r.interactive = true; },
        },
        '-i': { arg: null, desc: '--interactive 的简写', apply: (r) => { r.interactive = true; } },
      },
      parse: (args) => ({ content: next(args, 'content'), source: 'cli' }),
      check: (r) => {
        if (process.env.LUSH_TASK_ID !== undefined && process.env.LUSH_TASK_ID !== '') {
          throw new UsageError('inside a task, user input is not yours to submit:'
            + ' report upward with `lush notice post`, or delegate with `lush task construct`');
        }
        if (!Object.hasOwn(r, 'content')) throw new UsageError('the following arguments are required: CONTENT');
        if (r.wait && r.interactive) throw new UsageError('--wait cannot be combined with --interactive');
      },
    },
    list: {
      command: 'intent_list',
      method: 'intent.list',
      summary: '列出 intension（默认最近的在前）',
      cover: [
        '一行一条：#id、状态、你的原话（截断）、指定的 service、解析 task。',
        '--open 只看还在队列里的（queued / parsing / awaiting）——想知道「我现在说的话排到哪了」用它。',
        '--status 精确过滤一个状态；--sid 只看指定了某个 service 的（`--sid none` 只看没指定 service 的）。',
      ],
      usage: [
        'lush intent list [--open] [--status STATUS] [--sid SID|none] [--limit N]',
      ],
      options: {
        '--open': { arg: null, desc: '只看还在队列里的（queued / parsing / awaiting）', apply: (r) => { r.open = true; } },
        '--status': {
          arg: 'STATUS',
          desc: '只看某个状态：queued / parsing / awaiting / settled / rejected',
          apply: (r, v) => { r.status = v; },
        },
        '--sid': {
          arg: 'SID|none',
          desc: '只看指定了该 service 的；none 表示没指定 service 的那些',
          apply: (r, v) => {
            if (v === 'none') r.sid = null;
            else r.sid = intArg(v, '--sid');
          },
        },
        '--limit': { arg: 'N', desc: '最多返回多少条（默认 200）', apply: (r, v) => { r.limit = intArg(v, '--limit'); } },
      },
      parse: () => ({}),
    },
    show: {
      command: 'intent_show',
      method: 'intent.inspect',
      summary: '查看一条 intension：原话、解析 task、结论与相关 notice',
      cover: [
        '完整原话、状态、指定 service、解析 task、resolution（派了哪些 task / 为什么拒绝）与 response（解析器给你的结论）。',
        '还会列出与这条输入有关的所有 notice：冲突裁决的问与答都在这里。',
      ],
      usage: ['lush intent show INTENSION_ID'],
      positionals: [['INTENSION_ID', 'intension 的 id']],
      parse: (args) => ({ intension_id: intArg(args.shift(), 'intension_id') }),
    },
    context: {
      command: 'intent_context',
      method: 'intent.context',
      summary: '（解析器视角）这条输入要对照的全局事实与机械体检结果',
      cover: [
        '解析器读的就是它：模板树（能力边界与 singleton）、服务树（每个节点的状态与活动 task）、整个未决队列、已经等用户处理的 notice。',
        'precheck 是针对你指定的 service 的确定性事实：是否存在、什么状态、是不是被收养的孤儿、是不是正忙、队列里有没有重复的输入。precheck 命中只是「冲突候选」，裁定仍在解析器（必要时问你）。',
        '给人排查用：解析器说「有冲突」时，你可以读同一份事实。',
      ],
      usage: ['lush intent context INTENSION_ID', 'lush intent context --from-task TASK_ID'],
      positionals: [['INTENSION_ID', 'intension 的 id（省略时用 $LUSH_TASK_ID 找到它正在解析的那条）']],
      options: {
        '--from-task': {
          arg: 'TASK_ID',
          desc: '正在解析它的 task（缺省取 $LUSH_TASK_ID）',
          apply: (r, v) => { r.from_task_id = intArg(v, '--from-task'); },
        },
      },
      parse: (args) => ({ ...positionalId(args), ...parsingTask() }),
      check: (r) => {
        if (!Object.hasOwn(r, 'intension_id') && !Object.hasOwn(r, 'from_task_id')) {
          throw new UsageError('name the intension: pass INTENSION_ID, --from-task TASK_ID, or set $LUSH_TASK_ID');
        }
      },
    },
    settle: {
      command: 'intent_settle',
      method: 'intent.settle',
      summary: '（解析器侧）给这条输入下结论：安排好了，或拒绝/放弃',
      cover: [
        '--status settled 表示已经安排（派了哪些 task 由解析 task 的子 task 自动记录，不用你报）；rejected 表示拒绝或用户选择了放弃，--reason 是给用户看的理由。',
        '--response 是给用户看的结论原话；不调这条命令也可以——解析 task 结束时的结果就是 response。',
        '解析 task 只能给自己的输入下结论：省略 INTENSION_ID 时用 $LUSH_TASK_ID 找到它正在解析的那条。',
      ],
      notes: [
        '一条 intension 只能结算一次：已 settled / rejected 的再调用会报错。',
        '想「让那件活先跑完再解析」用 `lush intent defer`，而不是 settle。',
      ],
      usage: [
        'lush intent settle --status settled|rejected [--response TEXT] [--reason TEXT] [INTENSION_ID]',
      ],
      positionals: [['INTENSION_ID', 'intension 的 id（省略时用 $LUSH_TASK_ID 定位）']],
      options: {
        '--status': {
          arg: 'STATUS',
          desc: 'settled（已安排）或 rejected（拒绝/放弃），必填',
          apply: (r, v) => { r.status = v; },
        },
        '--response': { arg: 'TEXT', desc: '给用户看的结论原话', apply: (r, v) => { r.response = v; } },
        '--reason': { arg: 'TEXT', desc: '拒绝的理由（status=rejected 时）', apply: (r, v) => { r.reason = v; } },
        '--from-task': {
          arg: 'TASK_ID',
          desc: '正在解析它的 task（缺省取 $LUSH_TASK_ID）',
          apply: (r, v) => { r.from_task_id = intArg(v, '--from-task'); },
        },
      },
      parse: (args) => ({ ...positionalId(args), ...parsingTask() }),
      check: (r) => {
        if (r.status !== 'settled' && r.status !== 'rejected') {
          throw new UsageError("argument --status: choose from settled, rejected");
        }
        if (!Object.hasOwn(r, 'intension_id') && !Object.hasOwn(r, 'from_task_id')) {
          throw new UsageError('name the intension: pass INTENSION_ID, --from-task TASK_ID, or set $LUSH_TASK_ID');
        }
      },
    },
    defer: {
      command: 'intent_defer',
      method: 'intent.defer',
      summary: '（解析器侧）让这条输入排在另一个 task 后面，等它结束再解析',
      cover: [
        '这是冲突的四种答案之一（还有：改派其他节点、取消已有 task 后重试、放弃这次请求）；用户选「排队等它结束」时用它。',
        'intension 回到 queued，但记着 blocked_by_task_id；那个 task 结算之前它不会被重新解析，也不会占着解析节点。',
      ],
      usage: ['lush intent defer --blocked-by TASK_ID [--reason TEXT] [INTENSION_ID]'],
      positionals: [['INTENSION_ID', 'intension 的 id（省略时用 $LUSH_TASK_ID 定位）']],
      options: {
        '--blocked-by': {
          arg: 'TASK_ID',
          desc: '先让它跑完的那个 task（必填）',
          apply: (r, v) => { r.blocked_by_task_id = intArg(v, '--blocked-by'); },
        },
        '--reason': { arg: 'TEXT', desc: '为什么排在它后面', apply: (r, v) => { r.reason = v; } },
        '--from-task': {
          arg: 'TASK_ID',
          desc: '正在解析它的 task（缺省取 $LUSH_TASK_ID）',
          apply: (r, v) => { r.from_task_id = intArg(v, '--from-task'); },
        },
      },
      parse: (args) => ({ ...positionalId(args), ...parsingTask() }),
      check: (r) => {
        if (!Object.hasOwn(r, 'blocked_by_task_id')) throw new UsageError('the following arguments are required: --blocked-by');
        if (!Object.hasOwn(r, 'intension_id') && !Object.hasOwn(r, 'from_task_id')) {
          throw new UsageError('name the intension: pass INTENSION_ID, --from-task TASK_ID, or set $LUSH_TASK_ID');
        }
      },
    },
    withdraw: {
      command: 'intent_withdraw',
      method: 'intent.withdraw',
      summary: '撤回一条还没开始解析的 intension',
      cover: [
        '只对 queued 有效：还没轮到它、你想收回时说一声。已经开始解析（parsing / awaiting）的只能等它结束，或用 notice 回答冲突。',
        '撤回 = rejected，resolution 里记着 kind=withdrawn 与 --reason。',
      ],
      usage: ['lush intent withdraw INTENSION_ID [--reason TEXT]'],
      positionals: [['INTENSION_ID', 'intension 的 id']],
      options: {
        '--reason': { arg: 'TEXT', desc: '撤回理由（可选）', apply: (r, v) => { r.reason = v; } },
      },
      parse: (args) => ({ intension_id: intArg(args.shift(), 'intension_id') }),
    },
    wait: {
      command: 'intent_wait',
      method: 'intent.wait',
      summary: '阻塞到这条 intension 结算，然后打印它',
      cover: [
        '等到它离开队列（settled / rejected）为止；已经结算的立刻返回。',
        '等待期间解析器可能上报 notice 问你：那是另一条通道，用 `lush notice list` 处理（`--wait` 会一直等下去）。',
      ],
      usage: ['lush intent wait INTENSION_ID'],
      positionals: [['INTENSION_ID', 'intension 的 id']],
      parse: (args) => ({ intension_id: intArg(args.shift(), 'intension_id') }),
    },
  },
};
