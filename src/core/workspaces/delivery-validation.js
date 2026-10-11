import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { check } from '../types.js';
import { CONVERGENCE_LIMITS, convergenceJSON } from '../convergence-contract.js';
import { convergenceOID as oid } from './delivery-objects.js';
import { convergenceWriteGuard } from './delivery-publish.js';
import { commandEnvironment } from './command.js';

const PREFIX = 'convergence_validation:';
const positive = value => Number.isSafeInteger(value) && value > 0;
const key = checkout => `${PREFIX}${checkout.id}:${checkout.generation}`;

function descriptor(workspaces, value) {
  check(value && positive(value.id) && positive(value.generation) && oid(value.commit), 'invalid convergence validation resource');
  const branch = `lush/${workspaces.namespace}/convergence-validation/${value.id}-${value.generation}`;
  const result = { id: value.id, generation: value.generation, commit: value.commit,
    path: path.join(workspaces.config.home, 'convergence-validation', `${value.id}-${value.generation}`), ref: `refs/heads/${branch}` };
  check((value.path === undefined || value.path === result.path) && (value.ref === undefined || value.ref === result.ref),
    'validation resource identity changed');
  return Object.freeze(result);
}

function registration(workspaces, checkout) {
  const row = convergenceJSON(workspaces.store.get('SELECT value FROM meta WHERE key=?', key(checkout))?.value);
  check(row?.version === 1 && JSON.stringify(row.checkout) === JSON.stringify(checkout), 'validation resource is not exactly registered');
  return row;
}

function record(workspaces, checkout, state, result = null) {
  workspaces.store.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key(checkout), JSON.stringify({ version: 1, checkout, state, result }));
}

async function identity(workspaces, checkout) {
  registration(workspaces, checkout);
  check(fs.existsSync(checkout.path) && !fs.lstatSync(checkout.path).isSymbolicLink()
    && fs.realpathSync(checkout.path) === checkout.path, 'validation checkout path changed');
  const branch = checkout.ref.slice('refs/heads/'.length);
  check(await workspaces.workspaceForBranch(branch) === checkout.path, 'validation checkout is not the registered worktree');
  check(fs.realpathSync(await workspaces.git(checkout.path, 'rev-parse', '--show-toplevel')) === checkout.path,
    'validation checkout is not a worktree root');
  const common = await workspaces.git(checkout.path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const expected = await workspaces.git(workspaces.config.project, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  check(fs.realpathSync(common) === fs.realpathSync(expected), 'validation checkout belongs to another repository');
  check(await workspaces.git(checkout.path, 'symbolic-ref', '--quiet', 'HEAD') === checkout.ref
    && await workspaces.git(checkout.path, 'rev-parse', 'HEAD') === checkout.commit
    && await workspaces.git(workspaces.config.project, 'rev-parse', '--verify', `${checkout.ref}^{commit}`) === checkout.commit,
  'validation fixed commit/ref changed');
  await workspaces.assertCleanBranches([branch]);
  check(!await workspaces.gitOutput(checkout.path, '--no-optional-locks', 'status', '--porcelain=v1', '-z',
    '--untracked-files=all', '--ignore-submodules=none'), 'validation checkout is dirty');
  // Re-read after asynchronous cleanliness checks.
  check(await workspaces.git(checkout.path, 'symbolic-ref', '--quiet', 'HEAD') === checkout.ref
    && await workspaces.git(checkout.path, 'rev-parse', 'HEAD') === checkout.commit, 'validation checkout identity drifted');
}

export function convergenceValidationEnvironment(source) {
  const env = commandEnvironment(source);
  // Do not copy the invocation provider's ambient credentials or endpoint snapshot.
  for (const name of Object.keys(env)) if (/^(OPENAI_|ANTHROPIC_|OPENROUTER_|GEMINI_|GOOGLE_GENERATIVE_AI_|AZURE_OPENAI_|GROQ_|XAI_|MISTRAL_|DEEPSEEK_|COHERE_|PERPLEXITY_|TOGETHER_|ZAI_)/.test(name)) delete env[name];
  return env;
}

/** Output is drained and counted only. Always terminate background descendants, including on exit 0. */
export function executeConvergenceValidation(command, cwd, env, options = {}) {
  const bound = (value, maximum) => typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(1, value)) : maximum;
  const timeout = bound(options.timeout_ms, CONVERGENCE_LIMITS.validation_timeout_ms);
  const limit = bound(options.output_bytes, CONVERGENCE_LIMITS.validation_output_bytes);
  if (options.signal?.aborted) return Promise.resolve({ status: 'failed', exit_code: null, signal: null,
    reason: 'cancelled', output_bytes: 0, output_truncated: false });
  return new Promise(resolve => {
    let child, timer, killTimer, bytes = 0, reason = null, settled = false;
    const kill = signal => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
    };
    const finish = (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      kill('SIGKILL'); child?.stdout?.destroy(); child?.stderr?.destroy();
      resolve({ status: !reason && code === 0 ? 'succeeded' : 'failed', exit_code: code ?? null,
        signal: signal ?? null, reason: reason ?? (code === 0 ? null : 'exit'),
        output_bytes: bytes, output_truncated: reason === 'output_limit' });
    };
    const stop = why => {
      if (settled || reason) return;
      reason = why; kill('SIGTERM');
      killTimer = setTimeout(() => { kill('SIGKILL'); }, 100);
    };
    const abort = () => stop('cancelled');
    try { child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reason = 'spawn'; finish(null, null); return; }
    const discard = chunk => { bytes += chunk.length; if (bytes > limit) stop('output_limit'); };
    child.stdout.on('data', discard); child.stderr.on('data', discard);
    child.on('error', () => { reason = 'spawn'; finish(null, null); });
    child.on('exit', () => { kill('SIGKILL'); }); // Pipes can be held open by grandchildren.
    child.on('close', finish); // Drain complete output before reporting success.
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    timer = setTimeout(() => stop('timeout'), timeout);
  });
}

export const methods = {
  /** Caller holds the Git serial gate. Register before branch/worktree creation, never adopt unknown disk state. */
  async createConvergenceValidationUnsafe(value) {
    const checkout = descriptor(this, value), existing = this.store.get('SELECT value FROM meta WHERE key=?', key(checkout));
    if (existing) {
      const row = registration(this, checkout);
      check(['creating', 'ready', 'validated'].includes(row.state), 'validation resource is running, removed or needs inspection');
      await identity(this, checkout);
      if (row.state === 'creating') record(this, checkout, 'ready');
      return checkout;
    }
    check(await this.git(this.config.project, 'rev-parse', '--verify', `${checkout.commit}^{commit}`) === checkout.commit,
      'validation requires an exact commit');
    check(!fs.existsSync(checkout.path), 'validation resource path already exists; inspect it before continuing');
    check(!await this.git(this.config.project, 'branch', '--list', checkout.ref.slice('refs/heads/'.length)),
      'validation resource ref already exists; inspect it before continuing');
    record(this, checkout, 'creating');
    fs.mkdirSync(path.dirname(checkout.path), { recursive: true });
    await this.git(this.config.project, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b',
      checkout.ref.slice('refs/heads/'.length), checkout.path, checkout.commit);
    await identity(this, checkout);
    record(this, checkout, 'ready');
    return checkout;
  },

  /** No Git queue across Shell. Caller supplies the exact current authorization/generation guard. */
  async runConvergenceValidation(value, command, guard, options = {}) {
    const checkout = descriptor(this, value);
    check(typeof command === 'string' && command.trim() && command.length <= 65536, 'invalid convergence validation command');
    check(typeof guard === 'function', 'validation requires a synchronous authorization guard');
    const row = registration(this, checkout);
    check(row.state === 'ready', 'validation execution already started or finished; unknown effects are not replayed');
    let started_at = null, result;
    const failure = reason => ({ status: 'failed', exit_code: null, signal: null, reason, output_bytes: 0, output_truncated: false });
    try { await identity(this, checkout); } catch { return failure('identity'); }
    if (options.signal?.aborted) return failure('cancelled');
    try { convergenceWriteGuard(guard); } catch { return failure('authorization'); }
    // No await between claim, final authorization check and process creation.
    const latest = registration(this, checkout);
    check(latest.state === 'ready', 'concurrent validation execution already claimed this resource');
    record(this, checkout, 'running');
    try {
      if (options.started) convergenceWriteGuard(() => options.started());
      convergenceWriteGuard(guard);
      started_at = new Date().toISOString();
      result = await executeConvergenceValidation(command, checkout.path, convergenceValidationEnvironment(this.config.env), options);
    } catch { result = failure('authorization'); }
    try { await identity(this, checkout); } catch { result = { ...result, status: 'failed', reason: 'identity' }; }
    // Revoke/edit can arrive during the asynchronous post-command identity checks too.
    try { convergenceWriteGuard(guard); } catch { result = { ...result, status: 'failed', reason: 'authorization' }; }
    // A stale resource registration must not be overwritten by an old invocation.
    check(registration(this, checkout).state === 'running', 'validation registration changed during execution');
    result = { ...result, commit: checkout.commit, started_at, finished_at: new Date().toISOString() };
    record(this, checkout, 'validated', result);
    return result;
  },

  /** No force: failures and partial cleanup retain exact registration and disk evidence. */
  async removeConvergenceValidationUnsafe(value) {
    const checkout = descriptor(this, value), row = registration(this, checkout);
    check(['ready', 'validated'].includes(row.state), 'validation resource is active or cleanup needs inspection');
    await identity(this, checkout);
    record(this, checkout, 'removing', row.result);
    await this.git(this.config.project, '-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', checkout.path);
    check(!await this.checkedOut(checkout.ref.slice('refs/heads/'.length)), 'validation ref is still checked out');
    await this.git(this.config.project, '-c', 'core.hooksPath=/dev/null', 'update-ref', '-d', checkout.ref, checkout.commit);
    record(this, checkout, 'removed', row.result);
    return { removed: true };
  },
};
