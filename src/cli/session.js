/**
 * The commands that own the terminal: `call --interactive`, `session --open`,
 * and `attach`. They either hand stdio to pi (so a human can watch and steer
 * the same tool loop) or drive a REPL of `call`s; the daemon stays a client
 * either way, and every call these paths open is settled back into it.
 */
import cp from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { LushError } from '../core/types.js';
import { writeOut } from './io.js';

/**
 * `lush process session PID --open`: hand the terminal to pi on that process's
 * session. The CLI process is replaced by pi; the daemon is untouched.
 */
export async function openSession(client, pid) {
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
export async function interactiveCall(client, pid, prompt) {
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

/** `lush process attach PID`: a REPL of `call`s against one running process. */
export async function attach(client, pid) {
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
