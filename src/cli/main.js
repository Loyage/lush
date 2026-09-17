import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Config } from '../config.js';
import { LushError, VIEW_SECTIONS, isPlainObject } from '../core/types.js';
import { isLocked } from '../daemon/locking.js';
import { codeIdentity, codeMismatch } from '../identity.js';
import { RPCClient } from '../rpc/client.js';
import { shellEnv, shellQuote } from '../shell.js';

const DAEMON_MAIN = fileURLToPath(new URL('../daemon/main.js', import.meta.url));

class UsageError extends Error {}

/** Thrown when the user asked for help in place of a real argument. Never leaves the CLI. */
class HelpRequested extends Error {}

const FLAG_HELP = new Set(['-h', '--help']);
const HELP_TOKENS = new Set(['help', ...FLAG_HELP]);

function writeOut(value) {
  process.stdout.write(`${value}\n`);
}

function next(args, label) {
  const value = args.shift();
  if (value === undefined) throw new UsageError(`the following arguments are required: ${label}`);
  if (FLAG_HELP.has(value)) throw new HelpRequested();
  return value;
}

function intArg(value, label) {
  if (value === undefined) throw new UsageError(`the following arguments are required: ${label}`);
  if (FLAG_HELP.has(value)) throw new HelpRequested();
  if (!/^-?\d+$/.test(value)) throw new UsageError(`argument ${label}: invalid int value: '${value}'`);
  return Number.parseInt(value, 10);
}

function noMore(args) {
  if (args.length) throw new UsageError(`unrecognized arguments: ${args.join(' ')}`);
}

/** Parse a CLI JSON argument, reporting usage errors instead of stack traces. */
function jsonArg(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError(`argument ${label}: invalid JSON`);
  }
}

/**
 * `inspect --with` selects sections of the unified view. Returns null when the
 * flag is absent, which keeps plain `lush process inspect PID` on the full payload.
 */
function inspectSections(args) {
  const sections = [];
  while (args.length) {
    const flag = args.shift();
    if (flag !== '--with') throw new UsageError(`unrecognized arguments: ${flag}`);
    for (const part of next(args, '--with').split(',')) {
      const section = part.trim();
      if (!VIEW_SECTIONS.includes(section)) {
        throw new UsageError(`argument --with: invalid choice: '${section}'`
          + ` (choose from ${VIEW_SECTIONS.join(', ')})`);
      }
      // Repeating a section is harmless on the command line; the RPC layer rejects it.
      if (!sections.includes(section)) sections.push(section);
    }
  }
  return sections.length ? sections : null;
}

/** Consume every remaining token against a leaf's option spec, or fail with usage. */
function parseOptions(args, result, options) {
  while (args.length) {
    const flag = args.shift();
    if (FLAG_HELP.has(flag)) throw new HelpRequested();
    // --json is global: accepted before the command and after any leaf.
    if (flag === '--json') {
      result.json = true;
      continue;
    }
    const spec = options[flag];
    if (spec === undefined) throw new UsageError(`unrecognized arguments: ${flag}`);
    spec.apply(result, spec.arg === null ? true : next(args, flag));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Command tree
//
//  Every layer documents itself: `summary` is the one-line entry shown in the
//  parent's listing, `cover` says what the layer does and does not cover,
//  `usage` / `positionals` / `options` describe how to call it, `children`
//  holds the next layer down. Rendering and parsing both read this table, so
//  `help` can never drift from the real parser.
// ─────────────────────────────────────────────────────────────────────────────

const GLOBAL_JSON = '输出机器可读 JSON（默认是人类可读文本）；可放在命令之前或命令末尾（`lush --json process list` / `lush process list --json`）';

const ROOT = {
  summary: 'AI 的操作系统：把 AI 工作组织成持久化的逻辑 Process',
  cover: [
    'CLI 是 daemon（lushd）的客户端，通过 Unix socket 上的 JSON-RPC 操作 Lush，自身不持有状态。',
    '命令分三层：顶层 → 命令组（daemon / process）→ 具体命令，再往下是参数；每一层都有 help。',
    'daemon 未运行时，除 `lush daemon start` 外的命令都会连接失败（退出码 1）。',
  ],
  usage: ['lush [--json] <command> [args]', 'lush [--json] help [command [subcommand]]'],
  children: {
    daemon: {
      summary: 'daemon（lushd）的启动、停止与运行状态',
      cover: [
        '管理后台 daemon 的单实例生命周期：start 幂等启动，stop 中断活动调用、等锁释放后退出。',
        'status 报告 daemon PID、provider、进程数与活动调用数。',
        '不覆盖：进程自身的启停（见 `lush process start|stop|kill`）。',
      ],
      children: {
        start: {
          command: 'daemon',
          summary: '启动 daemon（幂等）',
          cover: [
            'detached 启动 daemon 并等待 RPC ready；已在运行时幂等返回现有 daemon 的状态。',
            '日志写入 `$LUSH_HOME/daemon.log`；启动超时或进程立即退出时报错并指向该日志。',
            '输出包含本次操作的 home、代码目录与指纹（cli.*）：`just` 与手动运行可能用不同的 LUSH_HOME。',
          ],
          usage: ['lush daemon start'],
          parse: () => ({ action: 'start' }),
        },
        stop: {
          command: 'daemon',
          summary: '停止 daemon 并等待单实例锁释放',
          cover: [
            '发送 system.shutdown，等待锁释放；已停止时幂等。',
            '中断 daemon 中正在进行的 Agent 调用（进程与历史都保留，重启后仍在）。',
            '只作用于本次 CLI 的 LUSH_HOME；输出里的 home 表明停的是哪一份 daemon。',
          ],
          usage: ['lush daemon stop'],
          parse: () => ({ action: 'stop' }),
        },
        status: {
          command: 'status',
          method: 'system.status',
          summary: '查看 daemon 与根进程状态',
          cover: [
            '返回 daemon_pid、provider、进程总数、活动调用数等运行状态。',
            '同时报告 daemon 自己的 home、code_dir、fingerprint、started_at，以及 CLI 侧的同样信息（cli.*，其中 cli.code_match 表示两边是否同一份代码）。',
            'daemon 是常驻进程，改完提示词或 CLI 必须重启它才生效：这里用来发现「连的不是同一个 home」或「daemon 跑的是旧代码」。',
            '要求 daemon 正在运行：未启动时失败，这是判断「daemon 是否活着」的入口。',
          ],
          usage: ['lush daemon status'],
          parse: () => ({}),
        },
      },
    },
    process: {
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
        spawn: {
          command: 'spawn',
          method: 'process.spawn',
          summary: '创建子进程',
          cover: [
            '在 PARENT 之下按 TEMPLATE 原子创建并启动一个子进程，成功后文本只打印新 PID。',
            '模板必须在创建方的 child_templates 白名单内；singleton 模板在同一父进程下已有活动实例时拒绝创建。',
            '子进程的 goal 取自 --goal，缺省时用名称；--vars 给出该模板声明的变量值，存入新进程 state（不可变变量在 state.params，可变变量在 state.vars）。',
          ],
          notes: [
            '变量按模板的 variables 声明校验：缺少 required 变量、写了模板没声明的名字都会直接失败；带 default 的变量可以省略。',
            '`path` 变量有通用约定：必须是已存在的绝对目录，并作为该进程 agent 的工作目录（cwd）；因此它只能声明在 immutable 区。',
            '`project` 模板必须提供 variables.path，否则创建直接失败；`--args` 是 `--vars` 的旧写法，等价但已不建议使用。',
          ],
          usage: ['lush process spawn PARENT TEMPLATE [--name NAME] [--goal GOAL] [--vars JSON]'],
          positionals: [['PARENT', '父进程 PID'], ['TEMPLATE', '模板名，见父进程的 available_child_templates']],
          options: {
            '--name': { arg: 'NAME', desc: '进程名；省略时用模板名', apply: (r, v) => { r.name = v; } },
            '--goal': { arg: 'GOAL', desc: '目标文本，写入 state.goal', apply: (r, v) => { r.goal = v; } },
            '--vars': {
              arg: 'JSON',
              desc: '模板声明的变量值，按 immutable / mutable 存入新进程 state',
              apply: (r, v) => { r.variables = jsonArg(v, '--vars'); },
            },
            '--args': {
              arg: 'JSON',
              desc: '--vars 的旧写法（等价，已不建议使用）',
              apply: (r, v) => { r.variables = jsonArg(v, '--args'); },
            },
          },
          parse: (args) => ({ parent_pid: intArg(args.shift(), 'parent_pid'), template: next(args, 'template') }),
        },
        call: {
          command: 'call',
          method: 'process.call',
          summary: '对进程发一次 prompt（阻塞到本次调用结束）',
          cover: [
            '调用该进程的 agent 一次，跑完整个工具循环才返回，可能很久；文本输出是 agent 的最终回复。',
            '要求目标为 running；递归调用与 busy 调用立即失败。一次 call 成功不代表 Task 完成。',
            '--interactive 改为在这个终端里执行同一次调用：daemon 照常记录这次调用并标记 busy，但 agent 跑在 pi TUI 里，由你边看边参与；pi 退出后 CLI 向 daemon 结算该次调用。',
          ],
          notes: [
            'PROMPT 也接受 `/tool process.update_state {...}` 这类直接工具调用。',
            '--dry-run 不调用 agent、不写 agent_calls / messages、不标记 busy：pi 后端打印本来要执行的命令行，内置运行时打印 command: null 与消息条数。',
            '--interactive 只适用于外部 agent（pi）：内置运行时（mock / openai）在 Lush 进程内跑，没有可进入的进程，会报错。',
            '--interactive 期间该进程是 busy（同 PID 不会出现第二个 pi），但调用由你的终端持有：kill / stop 只会把这次调用标记为 interrupted，不会关掉 TUI；最终回复留在 pi 会话里，daemon 侧的 agent_calls 只记这次调用本身。',
            '调用方中途消失（关窗口 / SIGKILL）时，daemon 在 LUSH_CALL_TIMEOUT 后把这次调用标记为 failed 并释放 busy。',
          ],
          usage: [
            'lush process call PID PROMPT [--dry-run]',
            'lush process call PID PROMPT --interactive  # 在本终端进入 pi TUI',
          ],
          positionals: [['PID', '目标进程 PID'], ['PROMPT', '发给该进程 agent 的 prompt']],
          options: {
            '--dry-run': { arg: null, desc: '只描述本来要执行的调用，不真的调用 agent', apply: (r) => { r.dry_run = true; } },
            '--interactive': {
              arg: null,
              desc: '在本终端用 pi TUI 执行这次调用（仅外部 agent）',
              apply: (r) => { r.interactive = true; },
            },
            '-i': { arg: null, desc: '--interactive 的简写', apply: (r) => { r.interactive = true; } },
          },
          parse: (args) => ({ pid: intArg(args.shift(), 'pid'), prompt: next(args, 'prompt') }),
          check: (r) => {
            if (r.interactive && r.dry_run) throw new UsageError('--interactive cannot be combined with --dry-run');
            // The terminal is handed to pi, so there is nothing left to serialize.
            if (r.interactive && r.json) throw new UsageError('--interactive cannot be combined with --json');
          },
        },
        attach: {
          command: 'attach',
          summary: '进入与进程的交互式对话',
          cover: [
            '每行输入一次 call，agent 回复后继续；持续 RPC 对话，不是独占接管锁，也不改变 Process 状态。',
            '进入前验证 running；`/exit`、`/quit` 或 Ctrl-D 退出，Ctrl-C 只退出客户端。',
          ],
          usage: ['lush process attach PID'],
          positionals: [['PID', '目标进程 PID']],
          parse: (args) => ({ pid: intArg(args.shift(), 'pid') }),
        },
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
        agents: {
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
        },
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
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Help
// ─────────────────────────────────────────────────────────────────────────────

// `sweep` / `open` style flags pick a method or a client-side path instead of
// being RPC arguments, so they never travel in `params`.
const META_KEYS = new Set(['command', 'json', 'node', 'help', 'sweep']);

function usageLines(node, commandPath) {
  const name = ['lush', ...commandPath].join(' ');
  if (node.usage) return node.usage;
  if (node.children) return [`${name} <command> [args]`, `${name} help [command]`];
  return [name];
}

function optionRows(node) {
  const rows = node.options
    ? Object.entries(node.options).map(([flag, spec]) => [spec.arg === null ? flag : `${flag} ${spec.arg}`, spec.desc])
    : [];
  rows.push(['--json', GLOBAL_JSON]);
  return rows;
}

function pushList(lines, title, items) {
  if (!items?.length) return;
  lines.push(`${title}:`);
  for (const item of items) lines.push(`  - ${item}`);
  lines.push('');
}

function pushRaw(lines, title, items) {
  if (!items?.length) return;
  lines.push(`${title}:`);
  for (const item of items) lines.push(`  ${item}`);
  lines.push('');
}

function pushTable(lines, title, rows) {
  if (!rows.length) return;
  const width = Math.max(...rows.map(([key]) => key.length));
  lines.push(`${title}:`);
  for (const [key, value] of rows) lines.push(`  ${key.padEnd(width)}  ${value}`);
  lines.push('');
}

function helpHint(node, commandPath) {
  const name = ['lush', ...commandPath].join(' ');
  if (node.children) return `用 '${name} help <command>' 或 '${name} <command> -h' 查看某个子命令的完整用法。`;
  if (commandPath.length <= 1) return `用 'lush help' 查看全部命令；用 'lush help <command>' 查看同层命令。`;
  const parent = ['lush', ...commandPath.slice(0, -1)].join(' ');
  return `用 '${parent} help' 查看同层命令，用 'lush help' 查看全部命令。`;
}

function renderHelp(node, commandPath) {
  const name = ['lush', ...commandPath].join(' ');
  const lines = [`${name} — ${node.summary}`, ''];
  pushList(lines, '覆盖范围', node.cover);
  pushRaw(lines, '用法', usageLines(node, commandPath));
  if (node.positionals) pushTable(lines, '位置参数', node.positionals);
  if (node.children) {
    const rows = Object.entries(node.children).map(([child, spec]) => [child, spec.summary]);
    rows.push(['help', '显示本层或指定子命令的帮助']);
    pushTable(lines, '子命令', rows);
  }
  pushTable(lines, '选项', optionRows(node));
  pushList(lines, '说明', node.notes);
  lines.push(helpHint(node, commandPath));
  return lines.join('\n');
}

function renderHelpJson(node, commandPath) {
  return JSON.stringify({
    command: ['lush', ...commandPath].join(' '),
    summary: node.summary,
    cover: node.cover,
    usage: usageLines(node, commandPath),
    positionals: node.positionals?.map(([positional, description]) => ({ name: positional, description })),
    options: optionRows(node).map(([flag, description]) => ({ flag, description })),
    subcommands: node.children
      ? [...Object.entries(node.children).map(([child, spec]) => ({ name: child, summary: spec.summary })),
        { name: 'help', summary: '显示本层或指定子命令的帮助' }]
      : undefined,
    notes: node.notes,
  }, null, 2);
}

/** Resolve `lush [<group>] help [<command> ...]` into the node to render. */
function helpRequest(json, node, commandPath, rest = []) {
  let target = node;
  let useJson = json;
  const targetPath = [...commandPath];
  for (const token of rest) {
    // `lush help --json process` and `lush process --json help` both work.
    if (token === '--json') {
      useJson = true;
      continue;
    }
    if (HELP_TOKENS.has(token)) continue;
    const child = target.children?.[token];
    if (child === undefined) {
      throw new UsageError(`argument command: invalid choice: '${token}'`
        + (target.children ? ` (choose from ${Object.keys(target.children).join(', ')})` : ''));
    }
    target = child;
    targetPath.push(token);
  }
  return { json: useJson, help: true, node: target, path: targetPath };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the command tree once. Group tokens descend, a leaf owns the rest of the
 * line, and `help` / `-h` / `--help` at any layer returns that layer's help.
 */
export function parseArgs(argv) {
  const args = [...argv];
  let json = false;
  let node = ROOT;
  const commandPath = [];

  for (;;) {
    const token = args.shift();
    if (token === undefined) {
      if (commandPath.length) {
        throw new UsageError(`the following arguments are required: subcommand (try 'lush ${commandPath.join(' ')} help')`);
      }
      throw new UsageError('the following arguments are required: command');
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (HELP_TOKENS.has(token)) return helpRequest(json, node, commandPath, args);

    const child = node.children?.[token];
    if (child === undefined) {
      const choices = node.children ? ` (choose from ${Object.keys(node.children).join(', ')})` : '';
      throw new UsageError(`argument command: invalid choice: '${token}'${choices}`);
    }
    commandPath.push(token);
    node = child;
    if (node.children) continue; // still a group: keep descending

    if (HELP_TOKENS.has(args[0])) {
      args.shift();
      return helpRequest(json, node, commandPath);
    }
    const result = { json, command: node.command, node };
    try {
      Object.assign(result, node.parse ? node.parse(args) : {});
      parseOptions(args, result, node.options ?? {});
    } catch (err) {
      if (err instanceof HelpRequested) return helpRequest(json, node, commandPath);
      throw err;
    }
    noMore(args);
    node.check?.(result);
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Seconds-resolution duration (`45s`, `2m07s`, `3h05m`) for agent lines. */
function duration(ms) {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
}

/**
 * One activity line: who is working for this process right now. Idle processes
 * get no line at all — the tree shows activity, not history.
 */
function agentLine(summary) {
  const running = summary?.agents ?? [];
  if (running.length === 0) return null;
  if (running.length === 1) {
    const [agent] = running;
    return `agent ${agent.id} running · ${duration(agent.elapsed_ms)}${agent.interactive ? ' · tty' : ''}`;
  }
  const shown = running.slice(0, 3).map((agent) => `${agent.id} ${duration(agent.elapsed_ms)}`);
  const more = running.length > shown.length ? ` · +${running.length - shown.length}` : '';
  return `agents ${running.length} running · ${shown.join(' · ')}${more}`;
}

/**
 * One-line variable summary for the text tree: immutable values plain, mutable
 * ones prefixed `~` (the `~` is also the reminder that they can be changed).
 */
export function variableSummary(variables) {
  const parts = [];
  for (const group of ['immutable', 'mutable']) {
    for (const [key, value] of Object.entries(variables?.[group] ?? {})) {
      parts.push(`${group === 'mutable' ? '~' : ''}${key}=${shortValue(value)}`);
    }
  }
  return parts.join(' ');
}

function shortValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Human-readable rendering
//
//  Text is for people: aligned `key value` rows, local wall-clock timestamps and
//  no JSON punctuation unless the value really is nested. `--json` is the stable
//  machine interface; these formatters are free to change.
// ─────────────────────────────────────────────────────────────────────────────

/** Local wall-clock `YYYY-MM-DD HH:MM:SS` from an ISO timestamp. */
export function stamp(iso) {
  if (typeof iso !== 'string' || iso === '') return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Indent every non-empty line by `depth` levels of two spaces. */
function indentLines(value, depth = 1) {
  const pad = '  '.repeat(depth);
  return String(value).split('\n').map((line) => (line === '' ? '' : pad + line));
}

/** Aligned `key value` rows, keys padded to the widest one. */
function alignRows(rows) {
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  return rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`);
}

/**
 * One-line form of a value: scalars as-is, compact arrays/objects as JSON.
 * `null` means "needs a block of its own" (multi-line or too long to inline).
 */
function inlineText(value) {
  if (typeof value === 'string') return value.includes('\n') ? null : value;
  if (value === null || typeof value !== 'object') return String(value);
  const json = JSON.stringify(value);
  return json.length <= 72 ? json : null;
}

/**
 * Human view of a JSON object: aligned `key  value` for scalars, a `key:` block
 * for anything nested. Shared by `inspect` (state) and `update-state`.
 */
export function objectLines(value, depth = 0) {
  const pad = '  '.repeat(depth);
  const rows = Object.entries(value).map(([key, item]) => [key, inlineText(item), item]);
  const width = rows.reduce((max, [key, text]) => (text === null ? max : Math.max(max, key.length)), 0);
  const lines = [];
  for (const [key, text, item] of rows) {
    if (text !== null) {
      lines.push(`${pad}${key.padEnd(width)}  ${text}`);
    } else if (typeof item === 'string') {
      lines.push(`${pad}${key}:`, ...indentLines(item, depth + 1));
    } else if (isPlainObject(item)) {
      lines.push(`${pad}${key}:`, ...objectLines(item, depth + 1));
    } else {
      lines.push(`${pad}${key}:`, ...indentLines(JSON.stringify(item, null, 2), depth + 1));
    }
  }
  return lines;
}

/** `pid 3 · implement-login · task · running` — one-line identity of a process row. */
function metadataTitle(row) {
  return `pid ${row.pid} · ${row.name} · ${row.type} · ${row.status}`;
}

/** One event line: `#12 state_updated · 2026-09-17 23:12:30  {"keys":[...]}`. */
function eventLine(event) {
  const data = event.data === undefined || event.data === null ? '' : `  ${JSON.stringify(event.data)}`;
  return `  #${event.id} ${event.kind} · ${stamp(event.created_at)}${data}`;
}

/**
 * Process tree, root first. `agents` adds one activity line below each process
 * that has a live worker (never a logical process: no PID, never expanded).
 * A process's variables are appended on its own line.
 */
export function treeLines(processes, { agents = true } = {}) {
  const byParent = new Map();
  for (const process of processes) {
    const siblings = byParent.get(process.parent_pid) ?? [];
    siblings.push(process);
    byParent.set(process.parent_pid, siblings);
  }
  const lines = [];
  // Iterative walk avoids recursion limits on deep logical trees. Agent rows use
  // their own key: process rows themselves carry an `agent` field.
  const stack = [...(byParent.get(null) ?? [])].reverse().map((process) => ({ process, prefix: '', branch: '' }));
  while (stack.length) {
    const node = stack.pop();
    if (node.agentRow !== undefined) {
      const line = agentLine(node.agentRow);
      if (line !== null) lines.push(`${node.prefix}${node.branch}${line}`);
      continue;
    }
    const { process, prefix, branch } = node;
    const variables = variableSummary(process.variables);
    lines.push(`${prefix}${branch}${process.name}[${process.pid}]${variables ? ` ${variables}` : ''}`);
    const children = byParent.get(process.pid) ?? [];
    const nextPrefix = prefix + (branch === '└── ' ? '    ' : branch ? '│   ' : '');
    const rows = [
      ...(agents && process.agent?.running ? [{ agentRow: process.agent }] : []),
      ...children.map((child) => ({ process: child })),
    ];
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      stack.push({
        ...rows[index],
        prefix: nextPrefix,
        branch: index === rows.length - 1 ? '└── ' : '├── ',
      });
    }
  }
  return lines;
}

/**
 * `lush process history` text output: one block per message, body verbatim so
 * long agent replies stay readable, then the pagination cursor. Roles are the
 * stored Chat-Completions ones (user / assistant / tool).
 */
export function formatHistory(result) {
  const lines = [];
  for (const message of result.messages) {
    const body = message.body ?? {};
    const tool = body.role === 'tool' && body.tool_call_id ? ` · ${body.tool_call_id}` : '';
    lines.push(`#${message.id} ${body.role} · ${stamp(message.created_at)} · call ${message.call_id}${tool}`);
    const content = typeof body.content === 'string' && body.content !== '' ? body.content.split('\n') : [];
    const calls = (body.tool_calls ?? []).map((call) => `→ ${call.function.name} ${call.function.arguments}`);
    lines.push(...(content.length || calls.length ? [...content, ...calls] : ['(empty)']), '');
  }
  if (result.messages.length === 0) lines.push('(no messages)');
  lines.push(`(${result.messages.length} messages · next --after ${result.next_after})`);
  return lines.join('\n');
}

/**
 * `lush process inspect` text output: process summary, then context, recent
 * calls and recent events. The creation-time `template_snapshot` and the
 * variable declarations stay in `--json` — they are reference material, not
 * something to read at a glance.
 */
export function formatInspect(result) {
  const { context = {}, recent_calls = [], recent_events = [], template_snapshot, variables, ...process } = result;
  const parent = process.parent_pid === null
    ? '-'
    : `${process.parent_pid}${process.original_parent_pid === process.parent_pid ? '' : ` (original ${process.original_parent_pid})`}`;
  const rows = [
    ['template', process.template],
    ['parent', parent],
    ['goal', process.goal ?? '-'],
    ['created', stamp(process.created_at)],
    ['updated', stamp(process.updated_at)],
    ['children', process.children?.length ? process.children.join(', ') : '(none)'],
  ];
  const declared = variableSummary(variables);
  if (declared) rows.push(['variables', declared]);
  if (process.agent) rows.push(['agent', `${process.agent.status} · ${process.agent.provider}`]);
  const lines = [metadataTitle(process), ...alignRows(rows).map((row) => `  ${row}`)];

  lines.push('', `context · ${context.message_count ?? 0} messages`);
  const state = context.state ?? {};
  lines.push(...(Object.keys(state).length ? ['  state', ...objectLines(state, 2)] : ['  state  (empty)']));
  if (context.system_prompt) lines.push('  system_prompt', ...indentLines(context.system_prompt, 2));
  for (const key of ['artifacts', 'references']) {
    if (context[key]?.length) lines.push(`  ${key}`, ...indentLines(JSON.stringify(context[key], null, 2), 2));
  }

  lines.push('');
  if (recent_calls.length === 0) {
    lines.push('calls  (none)');
  } else {
    lines.push(`calls · recent ${recent_calls.length}, newest first`);
    for (const call of recent_calls) {
      const window = call.finished_at === null
        ? `since ${stamp(call.started_at)}`
        : `${stamp(call.started_at)} → ${stamp(call.finished_at)}`;
      lines.push(`  #${call.id} ${call.status} · ${window}`);
      for (const key of ['prompt', 'output', 'error']) {
        if (call[key]) lines.push(`    ${key}`, ...indentLines(call[key], 3));
      }
    }
  }

  lines.push('');
  if (recent_events.length === 0) {
    lines.push('events  (none)');
  } else {
    lines.push(`events · recent ${recent_events.length}, newest first`);
    for (const event of recent_events) lines.push(eventLine(event));
  }

  if (template_snapshot !== undefined) {
    lines.push('', `# --json has the full snapshot, including template_snapshot and variable declarations`);
  }
  return lines.join('\n');
}

/** `lush process inspect --with ...`: the sections that were requested, in order. */
export function formatView(result) {
  const lines = [`pid ${result.pid}`];
  if ('parent' in result) {
    lines.push('', 'parent', `  ${result.parent === null ? '(none)' : metadataTitle(result.parent)}`);
  }
  if ('children' in result) {
    lines.push('', 'children', ...(result.children.length
      ? result.children.map((child) => `  ${metadataTitle(child)}`)
      : ['  (none)']));
  }
  if ('call_prompt' in result) {
    lines.push('', 'call_prompt', ...indentLines(result.call_prompt ?? '(none)', 1));
  }
  return lines.join('\n');
}

/** `lush process agents show AGENT_ID`: runtime facts, on-disk session, durable call. */
export function formatAgent(result) {
  const mode = result.interactive ? 'tty' : result.os_pid === null ? 'in-process' : 'pipe';
  const rows = [
    ['pid', `${result.pid}${result.name === null ? '' : ` (${result.name})`}`],
    ['provider', result.provider],
    ['status', result.status],
    ['call', `#${result.call_id}`],
    ['os-pid', result.os_pid === null ? '-' : String(result.os_pid)],
    ['mode', mode],
    ['started', stamp(result.started_at)],
    ['ended', result.ended_at === null ? '-' : stamp(result.ended_at)],
    ['elapsed', duration(result.elapsed_ms)],
  ];
  if (result.error !== null) rows.push(['error', result.error]);
  const lines = [`agent ${result.id}`, ...alignRows(rows).map((row) => `  ${row}`)];

  if (result.session) {
    lines.push('', 'session', ...alignRows([
      ['dir', result.session.session_dir],
      ['id', result.session.session_id],
      ['file', result.session.file ?? '(none yet)'],
    ]).map((row) => `  ${row}`));
  }
  if (result.call) {
    const call = result.call;
    const window = call.finished_at === null ? 'running' : `→ ${stamp(call.finished_at)}`;
    lines.push('', `call #${call.id} · ${call.status} · ${stamp(call.started_at)} ${window}`);
    for (const key of ['prompt', 'output', 'error']) {
      if (call[key]) lines.push(`  ${key}`, ...indentLines(call[key], 2));
    }
  }
  return lines.join('\n');
}

/**
 * `start` / `stop` / `kill` / `reclaim` / `complete` text output: the verb plus
 * the resulting state of the process, instead of dumping the whole metadata row.
 */
export function formatLifecycle(verb, result) {
  return `${verb} ${metadataTitle(result)}`;
}

export function rpcParams(args) {
  const params = {};
  for (const [key, value] of Object.entries(args)) {
    if (META_KEYS.has(key) || value === null || value === undefined) continue;
    params[key] = value;
  }
  return params;
}

/** `lush process agents list` text output: one row per live (or kept) worker. */
function formatAgents(rows) {
  if (rows.length === 0) return 'no running agents';
  const table = [['AGENT', 'PID', 'NAME', 'PROVIDER', 'STATUS', 'CALL', 'OS-PID', 'ELAPSED', 'MODE']];
  for (const agent of rows) {
    const mode = agent.interactive ? 'tty' : agent.os_pid === null ? 'in-process' : 'pipe';
    table.push([agent.id, String(agent.pid), agent.name, agent.provider, agent.status,
      String(agent.call_id), agent.os_pid === null ? '-' : String(agent.os_pid), duration(agent.elapsed_ms), mode]);
  }
  const width = table[0].map((_column, index) => Math.max(...table.map((row) => row[index].length)));
  return table.map((row) => row.map((cell, index) => cell.padEnd(width[index])).join('  ').trimEnd()).join('\n');
}

/** `lush process orphans` text output: the pool, or what one sweep just froze. */
export function formatOrphans(result) {
  // A sweep report is the only shape that carries `evicted`; the read model has
  // `orphans`. Both stay JSON under --json.
  if (Array.isArray(result.evicted)) {
    const lines = [
      `trigger=${result.trigger} checked=${result.checked}`
      + ` active ${result.active_before}->${result.active_after}`
      + ` evicted=${result.evicted.length} deferred=${result.deferred.length}`
      + ` (limit=${result.limit} ttl=${result.ttl_seconds}s)`,
    ];
    for (const orphan of result.evicted) {
      lines.push(`  evicted ${orphan.pid} ${orphan.type} ${orphan.from}->${orphan.to}`
        + ` reason=${orphan.reason} idle=${orphan.idle_seconds}s ${orphan.name}`);
    }
    for (const orphan of result.deferred) {
      lines.push(`  deferred ${orphan.pid} reason=${orphan.reason} (a busy orphan with a running call is never frozen)`);
    }
    return lines.join('\n');
  }
  const { policy } = result;
  const lines = [
    `policy adopt=${policy.adopt} limit=${policy.limit} ttl=${policy.ttl_seconds}s sweep=${policy.sweep_seconds}s`,
    `orphans active=${result.active_count} busy=${result.busy_count} over_limit=${result.over_limit}`,
  ];
  if (result.orphans.length === 0) {
    lines.push('  (none — nothing is currently adopted by PID 0)');
    return lines.join('\n');
  }
  const table = [['PID', 'TYPE', 'STATUS', 'IDLE', 'BUSY', 'NAME']];
  for (const orphan of result.orphans) {
    table.push([String(orphan.pid), orphan.type, orphan.status,
      duration(orphan.idle_seconds * 1000), orphan.busy ? 'yes' : 'no', orphan.name]);
  }
  const width = table[0].map((_column, index) => Math.max(...table.map((row) => row[index].length)));
  for (const row of table) lines.push(`  ${row.map((cell, index) => cell.padEnd(width[index])).join('  ').trimEnd()}`);
  return lines.join('\n');
}

/** `lush process session` text output: where the agent session lives and how to open it. */
function formatSession(result) {
  if (result.agent !== 'pi' || result.session_dir === null) {
    return `# agent ${result.agent} runs in-process; no external session to inspect.`;
  }
  const rows = [
    ['agent', result.agent],
    ['session-dir', result.session_dir],
    ['session-id', result.session_id],
    ['file', result.file ?? '(none yet)'],
    ['cwd', result.cwd],
  ];
  if (result.busy) rows.push(['busy', 'yes — a call is running; opening the session now may interleave writes']);
  rows.push(['browse', formatRun({ ...result, command: result.browse_command })]);
  const width = Math.max(...rows.map(([key]) => key.length));
  return rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n');
}

/** `cd <cwd> && ENV=... <command>` — shell line that runs `result.command`. */
function formatRun(result) {
  const prefix = [
    result.path_prefix === undefined ? '' : `PATH=${shellQuote(result.path_prefix)}:$PATH`,
    shellEnv(result.env ?? {}),
  ].filter((part) => part !== '').join(' ');
  const parts = [];
  if (result.cwd !== null && result.cwd !== undefined) parts.push(`cd ${shellQuote(result.cwd)}`);
  parts.push(prefix === '' ? result.command : `${prefix} ${result.command}`);
  return parts.join(' && ');
}

/** `lush process call --dry-run` text output: the runnable command, or what would be sent. */
function formatDryRun(result) {
  if (typeof result.command !== 'string') {
    return `# agent ${result.agent} runs in-process; no external command. Use --json for the invocation details.`;
  }
  return formatRun(result);
}

/**
 * `lush process delete|purge` text output: what disappeared, what had to be
 * terminated first, and how much of the record went with it.
 */
function formatRemoval(result) {
  const target = result.deleted.length === 1
    ? `pid ${result.pid}`
    : `pid ${result.pid} (subtree ${result.deleted.join(', ')})`;
  const terminated = result.terminated.length
    ? `, after terminating ${result.terminated.join(', ')}`
    : '';
  const rows = Object.entries(result.rows).map(([table, count]) => `${table}=${count}`).join(' ');
  return `deleted ${target}${terminated}  ${rows}`;
}

/** Lifecycle commands that answer with the updated process metadata. */
const LIFECYCLE_VERBS = {
  start: 'started',
  stop: 'stopped',
  kill: 'killed',
  reclaim: 'reclaimed',
  complete: 'completed',
};

export function format(args, result) {
  if (args.json) return JSON.stringify(result, null, 2);
  // `daemon start|stop` (command `daemon`) and `daemon status` (command `status`)
  // all report identity in `cli`, so they share the aligned line format.
  if (args.command === 'daemon' || args.command === 'status') return formatDaemon(result);
  if (args.command === 'call') return result.dry_run ? formatDryRun(result) : result.output;
  if (args.command === 'session') return formatSession(result);
  if (args.command === 'spawn') return `PID ${result.pid}`;
  if (args.command === 'tree') return treeLines(result, { agents: args.agents !== false }).join('\n');
  if (args.command === 'agents_list') return formatAgents(result);
  if (args.command === 'orphans') return formatOrphans(result);
  if (args.command === 'agents_show') return formatAgent(result);
  if (args.command === 'history') return formatHistory(result);
  if (args.command === 'inspect') return args.sections ? formatView(result) : formatInspect(result);
  // Variables are few and scalar-ish: one `key=value` line each is easier to
  // read than a JSON blob, and `--json` still gives the merged object.
  if (args.command === 'update-vars') {
    return Object.entries(result).map(([key, value]) => `${key}=${shortValue(value)}`).join('\n');
  }
  if (args.command === 'update-state') return objectLines(result).join('\n');
  if (LIFECYCLE_VERBS[args.command]) return formatLifecycle(LIFECYCLE_VERBS[args.command], result);
  if (args.command === 'agents_kill') {
    return `killed agent ${result.id} (${result.killed ? `os ${result.os_pid}` : 'no OS pid to kill; cancellation requested'})`;
  }
  if (args.command === 'delete' || args.command === 'purge') return formatRemoval(result);
  if (args.command === 'list') {
    const rows = [['PID', 'PPID', 'TYPE', 'STATUS', 'NAME']];
    for (const process of result) {
      rows.push([String(process.pid), process.parent_pid === null ? '-' : String(process.parent_pid),
        process.type, process.status, process.name]);
    }
    return rows
      .map(([pid, ppid, type, status, name]) => `${pid.padEnd(6)}${ppid.padEnd(6)}${type.padEnd(10)}${status.padEnd(12)}${name}`)
      .join('\n');
  }
  return JSON.stringify(result, null, 2);
}

/**
 * `lush daemon ...` in text mode: one aligned `key value` line per scalar
 * field, with the CLI's own view prefixed `cli.`. A daemon is long-lived, so
 * the fields that matter most are `home` (which state) and `code_dir` /
 * `fingerprint` / `started_at` (which code, from when).
 */
export function formatDaemon(result) {
  const rows = [];
  for (const [key, value] of Object.entries(result)) {
    if (key === 'cli' || value === null || typeof value === 'object') continue;
    rows.push([key, String(value)]);
  }
  for (const [key, value] of Object.entries(result.cli ?? {})) {
    if (value === null || typeof value === 'object') continue;
    rows.push([`cli.${key}`, String(value)]);
  }
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  return rows.map(([key, value]) => `${key.padEnd(width + 2)}${value}`).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The CLI's own identity plus the state location it is talking to. Reported by
 * every `lush daemon ...` command so `just daemon-restart` can be checked
 * against the daemon that is actually answering.
 */
function cliContext(config, daemon = null) {
  const code = codeIdentity();
  const context = { home: config.home, socket: config.socket, ...code };
  if (daemon !== null) context.code_match = codeMismatch(daemon, code) === null;
  return context;
}

/**
 * A daemon never re-reads its source: it answers with the guide, the CLI
 * declaration and the templates it loaded at startup. Say so on stderr when a
 * command reaches a daemon that runs different code than this CLI — the most
 * common cause is a `daemon-restart` in another LUSH_HOME, which otherwise
 * fails completely silently.
 */
async function warnOnStaleDaemon(client, config) {
  let status;
  try {
    status = await client.request('system.status');
  } catch {
    return; // no daemon yet; the command itself reports that
  }
  const mismatch = codeMismatch(status);
  if (mismatch === null) return;
  const home = status.home ?? config.home;
  process.stderr.write(`lush: warning: lushd pid=${status.daemon_pid} (home=${home}) runs different code -- ${mismatch}\n`);
  process.stderr.write(`lush: warning: restarted code only applies to the daemon you restart; run 'LUSH_HOME=${home} lush daemon restart'\n`);
}

export async function daemonCommand(config, action) {
  config.prepare();
  const client = new RPCClient(config.socket, 1);
  const logPath = path.join(config.home, 'daemon.log');

  if (action === 'stop') {
    // Trust the lock, but also handle a daemon whose lock file was removed or
    // written by an older implementation: ask the socket before giving up.
    let live = isLocked(config.home);
    if (!live && fs.existsSync(config.socket)) {
      try {
        await client.request('system.status');
        live = true;
      } catch {
        /* stale socket, daemon is gone */
      }
    }
    if (!live) return { stopped: true, already_stopped: true, cli: cliContext(config) };
    await client.request('system.shutdown');
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (!isLocked(config.home)) return { stopped: true, cli: cliContext(config) };
      await Bun.sleep(100);
    }
    throw new LushError('daemon shutdown still pending; inspect daemon.log');
  }

  try {
    const status = await client.request('system.status');
    return { started: true, already_running: true, ...status, cli: cliContext(config, status) };
  } catch {
    /* not running yet */
  }

  const env = { ...process.env, LUSH_HOME: config.home };
  const fd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = cp.spawn(process.execPath, [DAEMON_MAIN], {
      stdio: ['ignore', fd, fd], env, cwd: config.home, detached: true,
    });
  } finally {
    fs.closeSync(fd);
  }
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  child.unref();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const status = await client.request('system.status');
      return { started: true, ...status, cli: cliContext(config, status) };
    } catch {
      if (exited !== null && !isLocked(config.home)) {
        throw new LushError(`lushd exited (${exited}); see ${logPath}`);
      }
      await Bun.sleep(100);
    }
  }
  // Terminate only the child we launched, never a daemon owned by another start.
  if (exited === null) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  throw new LushError(`lushd startup timed out; see ${logPath}`);
}

/**
 * `lush process session PID --open`: hand the terminal to pi on that process's
 * session. The CLI process is replaced by pi; the daemon is untouched.
 */
async function openSession(client, pid) {
  const info = await client.request('process.session', { pid });
  if (info.agent !== 'pi' || !Array.isArray(info.argv)) {
    throw new LushError(`agent ${info.agent} runs in-process; there is no external session to open`);
  }
  if (info.busy) {
    process.stderr.write(`lush: warning: ${info.name}[${pid}] has a call running; the pi session is shared\n`);
  }
  if (!info.file) process.stderr.write('lush: no session file yet; pi will create one\n');
  const [command, ...rest] = info.argv;
  const env = {
    ...process.env,
    ...(info.env ?? {}),
    PATH: info.path_prefix ? `${info.path_prefix}${path.delimiter}${process.env.PATH ?? ''}` : process.env.PATH,
  };
  const child = cp.spawnSync(command, rest, { cwd: info.cwd ?? undefined, env, stdio: 'inherit' });
  if (child.error) throw new LushError(`could not start ${command}: ${child.error.message}`);
  if (child.signal) throw new LushError(`pi was interrupted (${child.signal})`);
  process.exitCode = child.status ?? 0;
}

/**
 * `lush process call PID PROMPT --interactive`: the daemon opens the call (user
 * message + busy) and this terminal runs the same pi session in its TUI — the
 * only difference from a plain call is that `--print` is missing, so pi hands
 * the terminal to the agent instead of answering once and exiting. The daemon
 * settles the call with whatever this process reports back.
 */
async function interactiveCall(client, pid, prompt) {
  const opened = await client.request('process.call_begin', { pid, prompt });
  if (!Array.isArray(opened.argv)) {
    throw new LushError(`agent ${opened.agent} runs in-process; there is no external agent to enter`);
  }
  process.stderr.write(`lush: entering ${opened.agent} for pid ${pid} (call ${opened.call_id}, agent ${opened.agent_id}); leave the TUI to settle the call\n`);
  const [command, ...rest] = opened.argv;
  const env = {
    ...process.env,
    ...(opened.env ?? {}),
    PATH: opened.path_prefix ? `${opened.path_prefix}${path.delimiter}${process.env.PATH ?? ''}` : process.env.PATH,
  };
  // Spawn instead of spawnSync: the agent space needs this process's OS pid
  // while it is still running, so `process agents show/kill` can reach it.
  const child = cp.spawn(command, rest, { cwd: opened.cwd ?? undefined, env, stdio: 'inherit' });
  if (Number.isInteger(child.pid)) {
    // Not fatal if the call already ended (kill, timeout): the report is a hint.
    await client.request('process.call_os_pid', { pid, call_id: opened.call_id, os_pid: child.pid }).catch(() => null);
  }
  const { code, signal, error } = await new Promise((resolve) => {
    child.on('error', (err) => resolve({ code: null, signal: null, error: err }));
    child.on('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal, error: null }));
  });
  const failure = error
    ? `could not start ${command}: ${error.message}`
    : signal
      ? `${opened.agent} was interrupted (${signal})`
      : code === 0
        ? null
        : `${opened.agent} exited ${code}`;
  // Report even a signalled child: the daemon must not stay busy until timeout.
  const settled = await client.request('process.call_end', {
    pid,
    call_id: opened.call_id,
    status: failure === null ? 'succeeded' : 'failed',
    ...(failure === null ? {} : { error: failure }),
  });
  if (failure !== null) process.stderr.write(`lush: ${failure}\n`);
  if (!settled.settled) {
    process.stderr.write(`lush: call ${opened.call_id} was already ${settled.status} in the daemon; this round was not recorded\n`);
  }
  if (failure !== null || !settled.settled) process.exitCode = 1;
}

async function attach(client, pid) {
  const info = await client.request('process.inspect', { pid });
  if (info.status !== 'running') {
    throw new LushError(`process ${pid} is ${info.status}; use inspect/history`);
  }
  writeOut(`attached to ${info.name} [${pid}]\n/exit or Ctrl-D to detach`);
  const prompt = `lush:${pid}> `;
  const rl = createInterface({ input: process.stdin, terminal: false });
  // Only this CLI event loop blocks on input; the daemon is independent.
  process.stdout.write(prompt);
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '/exit' || trimmed === '/quit') return;
      if (trimmed !== '') {
        try {
          const result = await client.request('process.call', { pid, prompt: line });
          writeOut(`agent> ${result.output}`);
        } catch (err) {
          process.stderr.write(`error> ${err.message}\n`);
        }
      }
      process.stdout.write(prompt);
    }
    writeOut('');
  } finally {
    rl.close();
  }
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    writeOut(args.json ? renderHelpJson(args.node, args.path) : renderHelp(args.node, args.path));
    return;
  }

  const config = Config.fromEnv();
  let timeout = config.callTimeout + 10;
  if (process.env.LUSH_RPC_TIMEOUT !== undefined) {
    timeout = Number.parseFloat(process.env.LUSH_RPC_TIMEOUT);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new LushError(`invalid LUSH_RPC_TIMEOUT: ${process.env.LUSH_RPC_TIMEOUT}`);
    }
  }
  const client = new RPCClient(config.socket, timeout);
  await warnOnStaleDaemon(client, config);

  if (args.command === 'daemon') {
    writeOut(format(args, await daemonCommand(config, args.action)));
    return;
  }
  if (args.command === 'attach') {
    await attach(client, args.pid);
    return;
  }
  if (args.command === 'session' && args.open) {
    await openSession(client, args.pid);
    return;
  }
  if (args.command === 'call' && args.interactive) {
    await interactiveCall(client, args.pid, args.prompt);
    return;
  }
  const { node } = args;
  const method = typeof node.method === 'function' ? node.method(args) : node.method;
  const result = await client.request(method, rpcParams(args));
  // `daemon status` is the one read that must also say which home and which
  // code answer it; every other read is about the processes themselves.
  writeOut(format(args, method === 'system.status' ? { ...result, cli: cliContext(config, result) } : result));
}

export async function main(argv = process.argv.slice(2)) {
  process.on('SIGINT', () => {
    process.stderr.write('\ndetached (daemon calls may still be running)\n');
    process.exit(130);
  });
  try {
    await run(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${usageLines(ROOT, []).join('\n')}\nlush: error: ${err.message}\n`);
      process.stderr.write("lush: run 'lush help' for the command tree\n");
      process.exit(2);
    }
    process.stderr.write(`lush: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
