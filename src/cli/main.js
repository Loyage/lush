import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Config } from '../config.js';
import { LushError, VIEW_SECTIONS } from '../core/types.js';
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

const GLOBAL_JSON = '输出机器可读 JSON；可放在命令之前或命令末尾（`lush --json process list` / `lush process list --json`）';

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
        'agent：每个进程的 agent（provider、busy、session）随进程走——tree --agents 一次看全，session 看单个。',
        '调用：call 发一次 prompt 并阻塞返回；attach 进入持续对话。',
        '派生：spawn 按模板在指定父进程下创建子进程。',
        '状态变更：start、stop、kill、reclaim、complete、update-state。',
        '不覆盖：daemon 自身启停与状态（见 `lush daemon`）。',
      ],
      notes: [
        'PID 0（lush 自身）不能 stop / kill / complete / reclaim，其生命周期由 daemon 管理。',
        'call 与 attach 只接受 running 进程；只有 Task 能 complete；只有 Service 能 stop。',
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
        inspect: {
          command: 'inspect',
          method: (args) => (args.sections ? 'process.view' : 'process.inspect'),
          summary: '查看单个进程的完整快照',
          cover: [
            '不带 --with 时返回完整 inspect：metadata、Context、agent 状态、近期调用与事件，任何状态都可查。',
            '带 --with 时改走 process.view，只返回所选 section（父节点、子节点、Call Prompt）。',
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
            '子进程的 goal 取自 --goal，缺省时用名称；state.params 原样写入 --args。',
          ],
          notes: [
            '--args 的 `path` 若出现，必须是已存在的绝对目录，并将作为该进程 agent 的工作目录（cwd）。',
            '`project` 模板必须提供 args.path，否则创建直接失败。',
          ],
          usage: ['lush process spawn PARENT TEMPLATE [--name NAME] [--goal GOAL] [--args JSON]'],
          positionals: [['PARENT', '父进程 PID'], ['TEMPLATE', '模板名，见父进程的 available_child_templates']],
          options: {
            '--name': { arg: 'NAME', desc: '进程名；省略时用模板名', apply: (r, v) => { r.name = v; } },
            '--goal': { arg: 'GOAL', desc: '目标文本，写入 state.goal', apply: (r, v) => { r.goal = v; } },
            '--args': {
              arg: 'JSON',
              desc: '模板参数对象，原样存入 state.params',
              apply: (r, v) => { r.args = jsonArg(v, '--args'); },
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
            '按 id 升序返回该进程持久化 messages 的一段；文本与 --json 都是 JSON。',
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

const META_KEYS = new Set(['command', 'json', 'node', 'help']);

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
 * Process tree, root first. `agents` adds one activity line below each process
 * that has a live worker (never a logical process: no PID, never expanded).
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
    lines.push(`${prefix}${branch}${process.name}[${process.pid}]`);
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
  if (args.command === 'agents_kill') {
    return `killed agent ${result.id} (${result.killed ? `os ${result.os_pid}` : 'no OS pid to kill; cancellation requested'})`;
  }
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
