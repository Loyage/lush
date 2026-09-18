/**
 * The commands that own the terminal: `intent submit --interactive` (the human
 * is the parser for one input) and `task session --open` / `task attach`. They
 * hand stdio to pi (so a human can watch and steer the same agent), while the
 * daemon stays the authority on the task and its call; the CLI settles the call
 * back into it when pi exits.
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
  const info = await client.taskSession(taskId);
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
 * `lush intent submit CONTENT --interactive`: the daemon records the intension
 * and creates its parse task *without starting it*; this terminal then runs that
 * task's agent (the pi TUI), so the human is the parser for this one input. The
 * daemon learns the outcome only when this terminal reports back — or, if the
 * terminal never came back, when the hang timeout frees the slot.
 */
export async function interactiveIntension(client, args) {
  const submitted = await client.submitInteractiveIntension(args.content, args.sid ?? null);
  const opened = submitted.interactive;
  process.stderr.write(
    `lush: intension #${submitted.intension.id} is yours to parse: entering ${opened.agent} `
    + `for task #${opened.task_id} (call ${opened.call_id}, agent ${opened.agent_id}); leave the TUI to settle it\n`,
  );
  const [command, ...rest] = opened.argv;
  // Spawn instead of spawnSync: the agent space needs this process's OS PID
  // while it is still running, so `task agents show/kill` can reach it.
  const child = cp.spawn(command, rest, { cwd: opened.cwd ?? undefined, env: childEnv(opened), stdio: 'inherit' });
  if (Number.isInteger(child.pid)) {
    // Not fatal if the call already ended (kill, timeout): the report is a hint.
    await client.recordInteractivePid(opened.task_id, opened.call_id, child.pid).catch(() => null);
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
  const settled = await client.settleInteractiveTask(
    opened.task_id,
    opened.call_id,
    failure === null ? 'succeeded' : 'failed',
    failure === null ? {} : { error: failure },
  );
  if (failure !== null) process.stderr.write(`lush: ${failure}\n`);
  if (!settled.settled) {
    process.stderr.write(`lush: call ${opened.call_id} was already ${settled.status} in the daemon; this round was not recorded\n`);
  }
  if (failure !== null || !settled.settled) process.exitCode = 1;
}
