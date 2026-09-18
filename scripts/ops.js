#!/usr/bin/env bun
/**
 * Dispatcher behind every `bun run <name>` entry that replaced the Justfile.
 *
 * `package.json` stays the user-visible surface (`bun run tree`, `bun run
 * orphans sweep`, ...); this file owns the small argument shims the Justfile
 * used to provide, and `scripts/lib.js` owns the environment defaults
 * (repo-local LUSH_HOME, pi provider, timeouts). Sub-commands that are pure
 * pass-throughs are listed too, so a single place documents the whole mapping.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, UsageError, captureLush, need, runBin, runLush, scriptEnv } from './lib.js';
import { prune } from './prune.js';
import { reset } from './reset.js';

const [command, ...args] = process.argv.slice(2);

/** Optional boolean-style flag: the Justfile treated any non-empty value as "on". */
function opt(value, name) {
  return value !== undefined && value !== '' ? [`--${name}`] : [];
}

/** Optional valued flag: omitted when the value is missing or empty. */
function flag(value, name) {
  return value !== undefined && value !== '' ? [`--${name}`, value] : [];
}

function doctor() {
  const env = scriptEnv();
  process.stdout.write(`bun       ${Bun.version}\n`);
  process.stdout.write(`LUSH_HOME ${env.LUSH_HOME}\n`);
  process.stdout.write(`provider  ${env.LUSH_PROVIDER}\n`);
  process.stdout.write(`code      ${PACKAGE_ROOT}\n`);
  const status = captureLush(['daemon', 'status']);
  const text = `${status.out}${status.err}`.trim();
  if (text !== '') process.stdout.write(`${text}\n`);
  if (status.code !== 0) process.stdout.write('daemon    stopped\n');
  return 0;
}

function bootstrap() {
  const steps = [
    ['daemon', 'start'],
    ['service', 'construct', '0', 'project-manager', '--name', 'project-manager'],
    ['service', 'construct', '1', 'generic-task', '--name', 'implement-login', '--goal', '实现登录功能'],
    ['service', 'tree'],
  ];
  for (const step of steps) {
    const code = runLush(step);
    if (code !== 0) return code;
  }
  return 0;
}

function clean() {
  const env = scriptEnv();
  runLush(['daemon', 'stop'], { stdout: 'ignore', stderr: 'ignore' });
  const home = env.LUSH_HOME;
  if (home.startsWith(`${PACKAGE_ROOT}${path.sep}`)) {
    fs.rmSync(home, { recursive: true, force: true });
    process.stdout.write(`已删除 ${home}\n`);
  } else {
    process.stdout.write(`跳过：${home} 不在仓库内，请手动处理\n`);
  }
  return 0;
}

function log() {
  const home = scriptEnv().LUSH_HOME;
  const tail = Bun.spawnSync(['tail', '-n', '50', path.join(home, 'daemon.log')], {
    stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
  });
  return tail.exitCode ?? 0;
}

const handlers = {
  // `lush` / `lushd` stay raw (`bun run bin/lush`, `bun run bin/lushd`) on
  // purpose: they are the escape hatch the AGENTS.md warning is about, so they
  // must keep using whatever LUSH_HOME the shell already exports.
  help: () => runLush(['help']),

  // dev
  doctor,
  bootstrap,
  clean,
  reset: () => reset(args),

  // daemon
  'daemon-start': () => runLush(['daemon', 'start']),
  'daemon-stop': () => runLush(['daemon', 'stop']),
  'daemon-restart': () => runLush(['daemon', 'restart']),
  status: () => runLush(['daemon', 'status']),
  log,
  foreground: () => runBin('lushd'),
  prune: () => prune(args),

  // ui
  web: () => runBin('lush-web', [], { env: { LUSH_WEB_PORT: args[0] ?? '4318' } }),

  // services
  ps: () => runLush(['service', 'list']),
  tree: () => runLush(['service', 'tree']),
  agent: () => runLush(['agent', ...args]),
  orphans: () => runLush(['service', 'orphans', ...opt(args[0], 'sweep')]),
  inspect: () => {
    need(args, 1, 'inspect <sid> [sections]');
    return runLush(['service', 'inspect', args[0], ...flag(args[1], 'with')]);
  },
  construct: () => {
    need(args, 2, 'construct <parent> <template> [name] [goal] [vars] [agent] [title] [detail]');
    const [parent, template, name, goal, vars, agent, title, detail] = args;
    return runLush([
      'service', 'construct', parent, template,
      ...flag(name, 'name'), ...flag(goal, 'goal'), ...flag(vars, 'vars'),
      ...flag(agent, 'agent'), ...flag(title, 'title'), ...flag(detail, 'detail'),
    ]);
  },
  start: () => {
    need(args, 1, 'start <sid>');
    return runLush(['service', 'start', args[0]]);
  },
  stop: () => {
    need(args, 1, 'stop <sid>');
    return runLush(['service', 'stop', args[0]]);
  },
  delete: () => {
    need(args, 1, 'delete <sid> [recursive]');
    return runLush(['service', 'delete', args[0], ...opt(args[1], 'recursive')]);
  },
  purge: () => {
    need(args, 1, 'purge <sid> [recursive]');
    return runLush(['service', 'purge', args[0], ...opt(args[1], 'recursive')]);
  },
  'update-state': () => {
    need(args, 2, 'update-state <sid> <json>');
    return runLush(['service', 'update-state', args[0], '--patch', args[1]]);
  },
  'update-vars': () => {
    need(args, 2, 'update-vars <sid> <json>');
    return runLush(['service', 'update-vars', args[0], '--vars', args[1]]);
  },

  // tasks
  tasks: () => runLush(['task', 'list', ...flag(args[0], 'sid')]),
  'task-tree': () => runLush(['task', 'tree', ...(args[0] !== undefined ? [args[0]] : [])]),
  'task-inspect': () => {
    need(args, 1, 'task-inspect <task>');
    return runLush(['task', 'inspect', args[0]]);
  },
  result: () => {
    need(args, 1, 'result <task>');
    return runLush(['task', 'result', args[0]]);
  },
  wait: () => {
    need(args, 1, 'wait <task>');
    return runLush(['task', 'wait', args[0]]);
  },
  cancel: () => {
    need(args, 1, 'cancel <task>');
    return runLush(['task', 'cancel', args[0]]);
  },
  'task-construct': () => {
    need(args, 2, 'task-construct <sid> <goal> [parent-task-id]');
    return runLush(['task', 'construct', args[0], '--goal', args[1], ...flag(args[2], 'parent-task-id')]);
  },
  attach: () => {
    need(args, 1, 'attach <task>');
    return runLush(['task', 'attach', args[0]]);
  },
  complete: () => {
    need(args, 1, 'complete <task> [json-result]');
    return runLush(['task', 'complete', args[0], ...flag(args[1], 'result')]);
  },
  'task-state': () => {
    need(args, 2, 'task-state <task> <json>');
    return runLush(['task', 'update-state', args[0], '--patch', args[1]]);
  },
  session: () => {
    need(args, 1, 'session <task> [open]');
    return runLush(['task', 'session', args[0], ...opt(args[1], 'open')]);
  },
  agents: () => runLush(['task', 'agents', 'list', ...opt(args[0], 'all')]),
  'task-message': () => {
    need(args, 2, 'task-message <to> <body> [from]');
    return runLush(['task', 'message', args[0], '--body', args[1], ...flag(args[2], 'from')]);
  },
  inbox: () => {
    need(args, 1, 'inbox <task>');
    return runLush(['task', 'inbox', args[0]]);
  },
  trace: () => {
    need(args, 1, 'trace <task> [limit]');
    return runLush(['task', 'trace', args[0], '--limit', args[1] ?? '200']);
  },
  intent: () => {
    need(args, 1, 'intent <content> [sid] — 提交一条 intension 并等它结算');
    return runLush(['intent', 'submit', args[0], ...flag(args[1], 'sid'), '--wait']);
  },
  'intent-now': () => {
    need(args, 1, 'intent-now <content> [sid] — 只提交，不等待');
    return runLush(['intent', 'submit', args[0], ...flag(args[1], 'sid')]);
  },
  'intent-enter': () => {
    need(args, 1, 'intent-enter <content> [sid] — 在这个终端里自己当解析器');
    return runLush(['intent', 'submit', args[0], ...flag(args[1], 'sid'), '--interactive']);
  },
  intents: () => runLush(['intent', 'list', ...opt(args[0], 'open')]),
  'intent-show': () => {
    need(args, 1, 'intent-show <id>');
    return runLush(['intent', 'show', args[0]]);
  },
  'intent-context': () => {
    need(args, 1, 'intent-context <id>');
    return runLush(['intent', 'context', args[0]]);
  },
  history: () => {
    need(args, 1, 'history <task> [after] [limit]');
    return runLush(['task', 'history', args[0], '--after', args[1] ?? '0', '--limit', args[2] ?? '100']);
  },

  // notices
  notices: () => runLush(['notice', 'list', ...flag(args[0], 'status')]),
  notice: () => {
    need(args, 1, 'notice <id>');
    return runLush(['notice', 'show', args[0]]);
  },
  answer: () => {
    need(args, 1, 'answer <id> [key=value ...]');
    return runLush(['notice', 'answer', args[0], ...args.slice(1).flatMap((set) => ['--set', set])]);
  },
  'answer-text': () => {
    need(args, 2, 'answer-text <id> <text>');
    return runLush(['notice', 'answer', args[0], '--text', args[1]]);
  },
  dismiss: () => {
    need(args, 1, 'dismiss <id> [reason]');
    return runLush(['notice', 'dismiss', args[0], ...flag(args[1], 'reason')]);
  },
};

const handler = handlers[command];
if (handler === undefined) {
  process.stderr.write(`bun run: unknown script sub-command: ${command ?? '(none)'}\n`);
  process.exit(2);
}

try {
  process.exit(await handler());
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`usage: bun run ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`bun run ${command}: ${err?.message ?? err}\n`);
  process.exit(1);
}
