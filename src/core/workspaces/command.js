import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { check } from '../types.js';

export const COMMAND_LIMITS = Object.freeze({ timeout_ms: 60000, output_bytes: 65536 });

/** No invocation capability or provider snapshot is inherited by user-authorized Shell hooks. */
export function commandEnvironment(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/^(LUSH_|PI_|CODEX_)/.test(key)
    || /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES)$/.test(key)) delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false',
    SSH_ASKPASS_REQUIRE: 'never', GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes', CI: '1' };
}

/** Output is counted and discarded, never buffered, logged or returned. Kill the whole process group. */
export function executeCommand(command, cwd, env, options = {}) {
  const timeout = Math.min(COMMAND_LIMITS.timeout_ms, Math.max(1, options.timeout_ms ?? COMMAND_LIMITS.timeout_ms));
  const limit = Math.min(COMMAND_LIMITS.output_bytes, Math.max(1, options.output_bytes ?? COMMAND_LIMITS.output_bytes));
  return new Promise(resolve => {
    let child, timer, killTimer, bytes = 0, reason = null, settled = false;
    const kill = signal => {
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
    };
    const stop = why => {
      if (reason) return;
      reason = why; kill('SIGTERM');
      killTimer = setTimeout(() => { kill('SIGKILL'); finish(null, 'SIGKILL'); }, 100);
    };
    const finish = (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      // Even a successful shell can leave grandchildren holding pipes or running in the background.
      if (child?.pid) kill('SIGKILL');
      child?.stdout?.destroy(); child?.stderr?.destroy();
      resolve({ status: !reason && code === 0 ? 'succeeded' : 'failed', exit_code: code, signal: signal ?? null,
        reason: reason ?? (code === 0 ? null : 'exit'), output_bytes: bytes, output_truncated: reason === 'output_limit' });
    };
    try { child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore','pipe','pipe'] }); }
    catch { reason = 'spawn'; finish(null, null); return; }
    const discard = chunk => { bytes += chunk.length; if (bytes > limit) stop('output_limit'); };
    child.stdout.on('data', discard); child.stderr.on('data', discard);
    child.on('error', () => { reason = 'spawn'; finish(null, null); });
    child.on('exit', (code, signal) => finish(code, signal));
    timer = setTimeout(() => stop('timeout'), timeout);
  });
}

export const methods = {
  /** guard is synchronous, runs inside the Git queue twice; started persists immediately before spawn. */
  runHookCommand(task, command, guard, options = {}) {
    return this.exclusive(async () => {
      if (!guard()) return { status: 'waiting' };
      const cwd = await this.workspaceForBranch(task.branch);
      check(cwd, 'mounted branch has no checked-out workspace');
      const actual = fs.realpathSync(cwd);
      if (task.workspace) check(actual === fs.realpathSync(task.workspace), 'mounted Worker workspace changed');
      const branch = await this.git(actual, 'symbolic-ref', '--short', 'HEAD');
      check(branch === task.branch, 'mounted Worker branch changed');
      const common = await this.git(actual, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      const projectCommon = await this.git(this.config.project, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      check(fs.realpathSync(common) === fs.realpathSync(projectCommon), 'mounted workspace belongs to another repository');
      // Attribute only this mount's branch, not unrelated refs an arbitrary Shell may touch.
      // Failed or unstarted commands must never publish a successful ref-transition receipt.
      let result;
      const noReceipt = Symbol('command did not succeed');
      try {
        return await this.trackRefWrite(`refs/heads/${task.branch}`, async () => {
          // Reading the baseline is asynchronous; recheck immediately before persisting/spawning.
          if (!guard()) { result = { status: 'waiting' }; throw noReceipt; }
          options.started?.();
          result = await executeCommand(command, actual, commandEnvironment(this.config.env), options);
          if (result.status !== 'succeeded') throw noReceipt;
          return result;
        });
      } catch (error) {
        if (error === noReceipt) return result;
        throw error;
      }
    });
  },
};
