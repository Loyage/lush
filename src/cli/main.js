import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Config } from '../config.js';
import { LushError } from '../core/types.js';
import { isLocked } from '../daemon/locking.js';
import { RPCClient } from '../rpc/client.js';

const DAEMON_MAIN = fileURLToPath(new URL('../daemon/main.js', import.meta.url));

const USAGE = 'usage: lush [--json] {daemon,status,ps,tree,inspect,call,attach,spawn,start,stop,kill,reclaim,history} ...';
const JSON_COMMANDS = new Set(['inspect', 'history', 'status', 'daemon', 'start', 'stop', 'kill', 'reclaim']);
const PID_COMMANDS = new Set(['inspect', 'attach', 'start', 'stop', 'kill', 'reclaim']);

class UsageError extends Error {}

function writeOut(value) {
  process.stdout.write(`${value}\n`);
}

function next(args, label) {
  const value = args.shift();
  if (value === undefined) throw new UsageError(`the following arguments are required: ${label}`);
  return value;
}

function intArg(value, label) {
  if (value === undefined) throw new UsageError(`the following arguments are required: ${label}`);
  if (!/^-?\d+$/.test(value)) throw new UsageError(`argument ${label}: invalid int value: '${value}'`);
  return Number.parseInt(value, 10);
}

function noMore(args) {
  if (args.length) throw new UsageError(`unrecognized arguments: ${args.join(' ')}`);
}

export function parseArgs(argv) {
  const args = [...argv];
  let json = false;
  if (args[0] === '--json') {
    json = true;
    args.shift();
  }
  const command = args.shift();
  if (command === undefined) throw new UsageError('the following arguments are required: command');

  if (command === 'daemon') {
    const action = next(args, 'action');
    if (action !== 'start' && action !== 'stop') {
      throw new UsageError(`argument action: invalid choice: '${action}' (choose from 'start', 'stop')`);
    }
    noMore(args);
    return { json, command, action };
  }
  if (['status', 'ps', 'tree'].includes(command)) {
    noMore(args);
    return { json, command };
  }
  if (PID_COMMANDS.has(command)) {
    const pid = intArg(args.shift(), 'pid');
    noMore(args);
    return { json, command, pid };
  }
  if (command === 'call') {
    const pid = intArg(args.shift(), 'pid');
    const prompt = next(args, 'prompt');
    noMore(args);
    return { json, command, pid, prompt };
  }
  if (command === 'spawn') {
    const parentPid = intArg(args.shift(), 'parent_pid');
    const template = next(args, 'template');
    const result = { json, command, parent_pid: parentPid, template };
    while (args.length) {
      const flag = args.shift();
      if (flag === '--name') result.name = next(args, '--name');
      else if (flag === '--goal') result.goal = next(args, '--goal');
      else throw new UsageError(`unrecognized arguments: ${flag}`);
    }
    return result;
  }
  if (command === 'history') {
    const pid = intArg(args.shift(), 'pid');
    const result = { json, command, pid, after: 0, limit: 100 };
    while (args.length) {
      const flag = args.shift();
      if (flag === '--after') result.after = intArg(args.shift(), '--after');
      else if (flag === '--limit') result.limit = intArg(args.shift(), '--limit');
      else throw new UsageError(`unrecognized arguments: ${flag}`);
    }
    return result;
  }
  throw new UsageError(`argument command: invalid choice: '${command}'`);
}

export function treeLines(processes) {
  const byParent = new Map();
  for (const process of processes) {
    const siblings = byParent.get(process.parent_pid) ?? [];
    siblings.push(process);
    byParent.set(process.parent_pid, siblings);
  }
  const lines = [];
  // Iterative walk avoids recursion limits on deep logical trees.
  const stack = [...(byParent.get(null) ?? [])].reverse().map((process) => ({ process, prefix: '', branch: '' }));
  while (stack.length) {
    const { process, prefix, branch } = stack.pop();
    lines.push(`${prefix}${branch}${process.name}[${process.pid}]`);
    const children = byParent.get(process.pid) ?? [];
    const nextPrefix = prefix + (branch === '└── ' ? '    ' : branch ? '│   ' : '');
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        process: children[index],
        prefix: nextPrefix,
        branch: index === children.length - 1 ? '└── ' : '├── ',
      });
    }
  }
  return lines;
}

export function rpcParams(args) {
  const params = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'command' || key === 'json' || value === null || value === undefined) continue;
    params[key] = value;
  }
  return params;
}

export function format(args, result) {
  if (args.json || JSON_COMMANDS.has(args.command)) return JSON.stringify(result, null, 2);
  if (args.command === 'call') return result.output;
  if (args.command === 'spawn') return `PID ${result.pid}`;
  if (args.command === 'tree') return treeLines(result).join('\n');
  if (args.command === 'ps') {
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
    if (!live) return { stopped: true, already_stopped: true };
    await client.request('system.shutdown');
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (!isLocked(config.home)) return { stopped: true };
      await Bun.sleep(100);
    }
    throw new LushError('daemon shutdown still pending; inspect daemon.log');
  }

  try {
    const status = await client.request('system.status');
    return { started: true, already_running: true, ...status };
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
      return { started: true, ...status };
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
  const config = Config.fromEnv();
  let timeout = config.callTimeout + 10;
  if (process.env.LUSH_RPC_TIMEOUT !== undefined) {
    timeout = Number.parseFloat(process.env.LUSH_RPC_TIMEOUT);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new LushError(`invalid LUSH_RPC_TIMEOUT: ${process.env.LUSH_RPC_TIMEOUT}`);
    }
  }
  const client = new RPCClient(config.socket, timeout);

  if (args.command === 'daemon') {
    writeOut(format(args, await daemonCommand(config, args.action)));
    return;
  }
  if (args.command === 'attach') {
    await attach(client, args.pid);
    return;
  }
  const method = { status: 'system.status', ps: 'process.list', tree: 'process.tree' }[args.command]
    ?? `process.${args.command}`;
  writeOut(format(args, await client.request(method, rpcParams(args))));
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
      process.stderr.write(`${USAGE}\nlush: error: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`lush: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
