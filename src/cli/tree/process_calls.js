import { intArg, jsonArg, next, UsageError } from '../args.js';

/**
 * The `process` verbs that *invoke* a process: create a child, send one prompt,
 * or enter an interactive dialogue. Lifecycle changes live in
 * `process_lifecycle.js`.
 */
export const processCallChildren = {
  spawn: {
    command: 'spawn',
    method: 'process.spawn',
    summary: '创建子进程',
    cover: [
      '在 PARENT 之下按 TEMPLATE 原子创建并启动一个子进程，成功后文本只打印新 PID。',
      '模板必须在创建方的 child_templates 白名单内；singleton 模板在同一父进程下已有活动实例时拒绝创建。',
      '子进程的 goal 取自 --goal，缺省时用名称；--vars 给出该模板声明的变量值，存入新进程 state（不可变变量在 state.params，可变变量在 state.vars）。',
      '--agent 指定该进程使用的 agent profile（见 `lush agent list`），优先级高于模板的可选 agent 字段；两者都没有时用内置 default。选中的名字会写进 state，用 `process inspect` 可查。',
    ],
    notes: [
      '变量按模板的 variables 声明校验：缺少 required 变量、写了模板没声明的名字都会直接失败；带 default 的变量可以省略。',
      '`path` 变量有通用约定：必须是已存在的绝对目录，并作为该进程 agent 的工作目录（cwd）；因此它只能声明在 immutable 区。',
      '`project` 模板必须提供 variables.path，否则创建直接失败；`--args` 是 `--vars` 的旧写法，等价但已不建议使用。',
      '`--agent` 的名字必须合法且 profile 必须已存在（否则创建直接失败）；profile 属于本次 LUSH_HOME，见 `lush agent list`。',
    ],
    usage: ['lush process spawn PARENT TEMPLATE [--name NAME] [--agent AGENT] [--goal GOAL] [--vars JSON]'],
    positionals: [['PARENT', '父进程 PID'], ['TEMPLATE', '模板名，见父进程的 available_child_templates']],
    options: {
      '--name': { arg: 'NAME', desc: '进程名；省略时用模板名', apply: (r, v) => { r.name = v; } },
      '--agent': {
        arg: 'AGENT',
        desc: '该进程使用的 agent profile（见 `lush agent list`）；省略时用模板的可选 agent 字段，再否则用内置 default',
        apply: (r, v) => { r.agent = v; },
      },
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
};
