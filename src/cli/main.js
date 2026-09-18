/**
 * The `lush` entry point: dispatch one command line to the daemon over the
 * JSON-RPC socket and print the answer.
 *
 * The pieces it is built from are one directory over: `args.js` (argument
 * primitives), `parse.js` (the token walk), `help.js` (help rendering),
 * `tree/` (the declaration the parser and help both read), `format/` (text
 * output) and `session.js` (the commands that own the terminal). This file
 * keeps what only an entry point can do — talk to the daemon, and turn errors
 * into exit codes — and re-exports the public names the CLI has always
 * exported.
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Config } from '../config.js';
import { LushError } from '../core/types.js';
import { isLocked } from '../daemon/locking.js';
import { codeIdentity, codeMismatch } from '../identity.js';
import { RPCClient } from '../rpc/client.js';
import { UsageError } from './args.js';
import { parseArgs } from './parse.js';
import { usageLines, renderHelp, renderHelpJson } from './help.js';
import { ROOT } from './tree/index.js';
import { format } from './format/index.js';
import { writeOut } from './io.js';
import { attach, interactiveCall, openSession } from './session.js';

const DAEMON_MAIN = fileURLToPath(new URL('../daemon/main.js', import.meta.url));

export { parseArgs } from './parse.js';
export { variableSummary, stamp, objectLines, treeLines } from './format/primitives.js';
export {
  formatHistory, formatInspect, formatView, formatAgent, formatLifecycle, formatOrphans,
} from './format/process.js';
export { formatDaemon } from './format/daemon.js';
export { format } from './format/index.js';

// `sweep` / `open` style flags pick a method or a client-side path instead of
// being RPC arguments, so they never travel in `params`.
const META_KEYS = new Set(['command', 'json', 'node', 'help', 'sweep']);

function rpcParams(args) {
  const params = {};
  for (const [key, value] of Object.entries(args)) {
    if (META_KEYS.has(key) || value === null || value === undefined) continue;
    params[key] = value;
  }
  return params;
}

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

async function stopDaemon(config, client) {
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

async function startDaemon(config, client) {
  const logPath = path.join(config.home, 'daemon.log');
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
 * `daemon start` is idempotent, so a `restart` must stop first: the lock is the
 * only thing that keeps a second daemon from being started, and only the daemon
 * holding it can release it. Waiting for the lock (done by `stopDaemon`) is
 * what makes `was_running` meaningful and the new daemon the one answering.
 */
export async function daemonCommand(config, action) {
  config.prepare();
  const client = new RPCClient(config.socket, 1);
  if (action === 'restart') {
    const stopped = await stopDaemon(config, client);
    const started = await startDaemon(config, client);
    return { restarted: true, was_running: !stopped.already_stopped, ...started };
  }
  if (action === 'stop') return stopDaemon(config, client);
  return startDaemon(config, client);
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    writeOut(args.json ? renderHelpJson(args.node, args.path) : renderHelp(args.node, args.path));
    return;
  }

  const config = Config.fromEnv();
  // `agent` is the one command group that never talks to the daemon: it reads and
  // writes `$LUSH_HOME/agents/*.json` directly, so it must work while lushd is
  // stopped. Everything else needs a client (and a stale-daemon warning).
  if (typeof args.node.local === 'function') {
    writeOut(format(args, await args.node.local(config, args)));
    return;
  }
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
    // -32602 is the JSON-RPC equivalent of a bad command line: a rejected
    // argument value (an undeclared variable, a variable that does not match
    // its declared pattern, a missing required one). It gets the same exit
    // code as a parse error, which is what the agent guide promises: exit 2
    // means "fix the arguments", not "something went wrong".
    if (err instanceof LushError && err.code === -32602) {
      process.stderr.write(`lush: error: ${err.message}\n`);
      process.stderr.write("lush: exit 2 = usage error: fix the arguments; run 'lush help' (or a command's -h) for the contract\n");
      process.exit(2);
    }
    process.stderr.write(`lush: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
