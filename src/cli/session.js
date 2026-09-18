/**
 * The commands that own the terminal: `call --interactive`, `task session
 * --open` and `task attach`. They hand stdio to pi (so a human can watch and
 * steer the same agent), while the daemon stays the authority on the task and
 * its call; the CLI settles the call back into it when pi exits.
 */
import cp from 'node:child_process';
import path from 'node:path';
import { LushError } from '../core/types.js';

/** Extra environment a pi invocation needs: Lush identity plus the bundled `lush` on PATH. */
function childEnv(info) {
  return {
    ...process.env,
    ...(info.env ?? {}),
    PATH: info.path_prefix ? `${info.path_prefix}${path.delimiter}${process.env.PATH ?? ''}` : process.env.PATH,
  };
}

/**
 * `lush task session TASK_ID --open` (and `lush task attach TASK_ID`): hand the
 * terminal to pi on that task's session. The CLI service is replaced by pi; the
 * daemon is untouched.
 */
export async function openSession(client, taskId) {
  const info = await client.request('task.session', { task_id: taskId });
  if (info.agent !== 'pi' || !Array.isArray(info.argv)) {
    throw new LushError(`agent ${info.agent} runs in-service; there is no external session to open`);
  }
  if (info.busy) {
    process.stderr.write(`lush: warning: task #${taskId} has a call running; the pi session is shared\n`);
  }
  if (!info.file) process.stderr.write('lush: no session file yet; pi will create one\n');
  const [command, ...rest] = info.argv;
  const child = cp.spawnSync(command, rest, { cwd: info.cwd ?? undefined, env: childEnv(info), stdio: 'inherit' });
  if (child.error) throw new LushError(`could not start ${command}: ${child.error.message}`);
  if (child.signal) throw new LushError(`pi was interrupted (${child.signal})`);
  process.exitCode = child.status ?? 0;
}

/**
 * `lush call SID GOAL --interactive`: the daemon creates the root task and opens
 * its call (user message + busy), and this terminal runs the same pi session in
 * its TUI — the only difference from a plain call is that `--print` is missing,
 * so pi hands the terminal to the agent instead of answering once and exiting.
 * The daemon finishes or fails the task with whatever this service reports back.
 */
export async function interactiveCall(client, args) {
  const opened = await client.request('call', { sid: args.sid, goal: args.goal, interactive: true });
  if (!Array.isArray(opened.argv)) {
    throw new LushError(`agent ${opened.agent} runs in-service; there is no external agent to enter`);
  }
  process.stderr.write(
    `lush: entering ${opened.agent} for task #${opened.task_id} on sid ${opened.sid} `
    + `(call ${opened.call_id}, agent ${opened.agent_id}); leave the TUI to settle it\n`,
  );
  const [command, ...rest] = opened.argv;
  // Spawn instead of spawnSync: the agent space needs this process's OS PID
  // while it is still running, so `task agents show/kill` can reach it.
  const child = cp.spawn(command, rest, { cwd: opened.cwd ?? undefined, env: childEnv(opened), stdio: 'inherit' });
  if (Number.isInteger(child.pid)) {
    // Not fatal if the call already ended (kill, timeout): the report is a hint.
    await client.request('call.os_pid', { task_id: opened.task_id, call_id: opened.call_id, os_pid: child.pid })
      .catch(() => null);
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
  const settled = await client.request('call.end', {
    task_id: opened.task_id,
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
