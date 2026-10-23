import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { CLI_COMMANDS, CLI_EXECUTABLES, commandExecutables } from '../cli/catalog.js';
import { parseCLI, validateCLIParameters } from '../cli/parser.js';
import { isOptionIndex } from '../cli/args.js';
import { ROOT } from '../identity.js';
import { check, TERMINAL } from './types.js';
import { workerCLIIdentity } from './worker-cli-identity.js';
import { commandEnvironment } from './workspaces/command.js';
import { beginCLIHistory, finishCLIHistory } from './worker-cli-history.js';

export const WORKER_CLI_LIMITS = Object.freeze({ command_bytes: 8192, arguments: 128, timeout_ms: 15000, output_bytes: 65536 });
const context = new AsyncLocalStorage();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reclamation = new Set(['worker.accept','worker.accept_force','worker.cleanup','worker.delete','worker.sync_parent','branch.archive']);
function usesWorkspace(project, source, method, params) {
  if (method === 'branch.archive') {
    const seen = new Set();
    for (let branch = source.branch; branch && !seen.has(branch); branch = project.store.branch(branch)?.parent) {
      if (branch === params.branch) return true; seen.add(branch);
    }
    return false;
  }
  const seen = new Set();
  for (let task = project.store.task(source.taskId); task && !seen.has(task.id); task = task.parent_id ? project.store.task(task.parent_id) : null) {
    if (task.id === Number(params.id)) return true; seen.add(task.id);
  }
  return false;
}

/** A small argv lexer, NOT a shell: quotes group literal arguments; expansions/operators never execute. */
export function parseWorkerCLI(command) {
  check(typeof command === 'string' && Buffer.byteLength(command) <= WORKER_CLI_LIMITS.command_bytes,
    'CLI command must be a string of at most 8192 bytes');
  check(!/[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(command), 'CLI command must be a single line without control characters');
  const words = []; let word = '', quote = null, started = false;
  for (let index = 0; index < command.length; index++) {
    const ch = command[index];
    if (ch === '\\' && quote !== "'") { check(index + 1 < command.length, 'unfinished CLI escape'); word += command[++index]; started = true; }
    else if (quote) { if (ch === quote) quote = null; else word += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) { words.push(word); word = ''; started = false; } }
    else { check(!/[;|&<>`$]/.test(ch), 'shell syntax is not supported'); word += ch; started = true; }
  }
  check(!quote, 'unfinished CLI quote'); if (started) words.push(word);
  check(words.length > 0 && words.length <= WORKER_CLI_LIMITS.arguments, 'invalid CLI argument count');
  const executable = words.shift();
  check(CLI_EXECUTABLES.includes(executable), 'only lush and lushw are supported');
  const separator = words.indexOf('--'), options = words.slice(0, separator < 0 ? words.length : separator);
  check(!options.some(value => /^--(?:project|cwd|env|executable|token)(?:=|$)/.test(value)), 'CLI project, environment and executable overrides are forbidden');
  // Preview and execution share the exact argv/global/literal/schema parser.
  const parsed = parseCLI(words, CLI_COMMANDS), help = parsed.help;
  const directory = !parsed.entry && CLI_COMMANDS.find(item => item.directory && isOptionIndex(parsed.args, parsed.args.length - 1) && item.path === parsed.args.join(' '));
  const entry = help || directory ? CLI_COMMANDS.find(item => item.path === 'help') : parsed.entry;
  check(entry && commandExecutables(entry).includes(executable), 'command is not available from this CLI entry point');
  if (!help && !directory) validateCLIParameters(parsed.args, entry);
  check(help || directory || !entry.rpc.some(method => method.startsWith('context.')) || entry.user_context_rpc,
    'command is Agent invocation only; no user-equivalent operation');
  check(help || !/^(daemon|host) (start|stop|restart)$/.test(entry.path),
    'command requires an interactive or persistent terminal and is not supported here');
  // Never permit an argument to select a second executable; the fixed bin parses every remaining value.
  return { command, executable, argv: words, path: entry.path, kind: entry.kind,
    requires_confirmation: !['read','local-read'].includes(entry.kind), rpc: help ? [] : [...entry.rpc, ...(entry.user_context_rpc ? [entry.user_context_rpc] : [])],
    user_context_rpc: help ? null : entry.user_context_rpc, context_method: help ? null : entry.rpc.find(method => method.startsWith('context.')) ?? null };
}

export function cliLeaseBlocks(project) {
  return Boolean(project.cliMutation && context.getStore() !== project.cliMutation);
}

/** The private correlation is not an Agent identity. It can only narrow this already user-authorized CLI call. */
export async function dispatchWorkerCLI(project, method, params, actor, run) {
  const marker = params._cli_trial;
  const lease = marker && project.cliRunning?.get(marker);
  check(marker === undefined || typeof marker === 'string' && /^[a-f0-9]{64}$/.test(marker)
    && actor === null && lease && !lease.closed && lease.rpc.includes(method)
    && (!lease.userRPC || method === lease.contextMethod || method === lease.userRPC && context.getStore() === lease),
  'invalid CLI execution context');
  check(!cliLeaseBlocks(project) || lease === project.cliMutation, 'Worker CLI execution is in progress; inspect before retrying');
  if (reclamation.has(method)) for (const running of project.cliRunning?.values() ?? [])
    check(!usesWorkspace(project, running, method, params), 'Worker CLI still uses this workspace; reclamation or synchronization must wait');
  if (!lease) return run();
  const promise = context.run(lease, run);
  lease.pending.add(promise);
  try { return await promise; } finally { lease.pending.delete(promise); }
}

function executionTask(project, taskId, mutating) {
  const task = workerCLIIdentity(project.store, taskId);
  check(!project.workerDeleteIds?.has(task.id), 'Worker deletion is in progress; CLI execution is unavailable');
  check(!project.store.executionRetired(task.id), 'retired Worker has no executable worktree');
  const branch = project.store.branch(task.branch);
  if (task.task_kind === 'main') {
    // ensureMainTask registers ownership in tasks; the optional branches row is
    // immutable genealogy, not an automatically refreshed worktree registry.
    check(!TERMINAL.has(task.status), 'main Worker has ended');
    check(!branch || !['archived','deleted'].includes(branch.status)
      && (branch.task_id === null || branch.task_id === task.id) && branch.parent === null,
    'main branch registration conflicts with its real owner');
  } else {
    check(task.workspace && task.branch, 'CLI requires an order/child dedicated worktree');
    check(branch && !['archived','deleted'].includes(branch.status), 'Worker branch has been archived');
    check(branch.task_id === task.id && branch.worktree === task.workspace && task.branch !== 'main'
      && task.branch !== task.target_branch, 'Worker does not own this dedicated worktree');
  }
  if (mutating) {
    check(!project.running.has(task.id) && !['running','queued'].includes(task.status), 'Worker workspace is active; modifications are forbidden');
    check(!project.branchFreeze(task.branch) && !project.activeTaskMerge(task.id), 'Worker workspace is frozen; modifications are forbidden');
    project.assertWritable('execute Worker CLI');
    check(!project.taskSyncBusy?.has(task.id) && !project.workspaces.busy.has(task.id)
      && !project.commandHookRunning?.has(task.id) && !project.acceptanceBusy?.has(task.id), 'Worker workspace is busy');
  }
  return task;
}

function workspace(project, taskId, mutating, checkedOut) {
  const task = executionTask(project, taskId, mutating);
  const main = task.task_kind === 'main', directory = main ? checkedOut : task.workspace;
  check(typeof directory === 'string' && directory.length > 0, 'Worker branch is not checked out; CLI has no execution directory');
  let actual, stat;
  try { actual = fs.realpathSync(directory); stat = fs.statSync(actual); } catch { check(false, 'Worker worktree no longer exists'); }
  check(stat.isDirectory() && actual === path.resolve(directory)
    && (main || actual !== fs.realpathSync(project.config.project)),
  'CLI requires the real owning worktree, never a symlink or a fallback directory');
  if (main) check(!task.workspace || path.resolve(task.workspace) === actual, 'main Worker workspace conflicts with its real checkout');
  return { task, actual, identity: [stat.dev, stat.ino] };
}

async function preview(project, params) {
  const parsed = parseWorkerCLI(params.command), source = executionTask(project, params.id, parsed.requires_confirmation);
  // Resolve main from its actual Git checkout, never assume canonical is on main.
  const checkedOut = await project.workspaces.workspaceForBranch(source.branch);
  const { task, actual, identity } = workspace(project, params.id, parsed.requires_confirmation, checkedOut);
  check(task.branch === source.branch, 'Worker branch identity changed');
  // Read-only Git identity checks go through the existing Workspaces boundary. There is no fallback cwd.
  const [current, common, projectCommon, head] = await Promise.all([
    project.workspaces.git(actual, 'symbolic-ref', '--short', 'HEAD'),
    project.workspaces.git(actual, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    project.workspaces.git(project.config.project, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    project.workspaces.git(actual, 'rev-parse', 'HEAD'),
  ]);
  check(checkedOut && fs.realpathSync(checkedOut) === actual && current === task.branch
    && fs.realpathSync(common) === fs.realpathSync(projectCommon), 'Worker worktree identity changed');
  const live = workspace(project, params.id, parsed.requires_confirmation, checkedOut);
  check(live.task.branch === task.branch && live.task.task_kind === task.task_kind
    && live.actual === actual && JSON.stringify(live.identity) === JSON.stringify(identity), 'Worker worktree identity changed');
  const { status, workspace: directory, branch, reservation, interrupt_state } = live.task;
  const revision = hash({ parsed, id: task.id, task_kind: task.task_kind, actual, identity, head, status, directory, branch, reservation, interrupt_state,
    registration: project.store.branch(branch),
    freeze: project.branchFreeze(task.branch) });
  return { ...parsed, id: task.id, workspace: actual, revision, limits: WORKER_CLI_LIMITS };
}

export async function previewWorkerCLI(project, params) {
  const { rpc: _rpc, user_context_rpc: _userRPC, context_method: _contextMethod, ...value } = await preview(project, params);
  const previews = project.cliPreviews ??= new Map(), revision = randomBytes(32).toString('hex');
  previews.set(revision, { state: value.revision, expires: Date.now() + 300000 });
  if (previews.size > 128) previews.delete(previews.keys().next().value);
  return { ...value, revision };
}

function environment(project, marker) {
  const env = commandEnvironment(project.config.env);
  // Runtime preload/debug options can execute arbitrary code before the fixed CLI bin.
  for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|BUN_OPTIONS|BUN_INSPECT|LD_|DYLD_)/.test(key)) delete env[key];
  return { ...env, LUSH_PROJECT: project.config.project, LUSH_HOME: project.config.home,
    // Device selection stays the daemon's fixed selection, never a user override.
    ...(project.config.env.LUSH_GLOBAL_CONFIG ? { LUSH_GLOBAL_CONFIG: project.config.env.LUSH_GLOBAL_CONFIG } : {}),
    LUSH_CLI_TRIAL: marker, NO_COLOR: '1', TERM: 'dumb' };
}

/** Fixed executable/argv, closed stdin, process-group teardown and a shared stdout+stderr byte budget. */
export function runWorkerCLI(argv, cwd, env, options = {}) {
  const timeout = Math.max(1, Math.min(WORKER_CLI_LIMITS.timeout_ms, options.timeout_ms ?? WORKER_CLI_LIMITS.timeout_ms));
  const limit = Math.max(1, Math.min(WORKER_CLI_LIMITS.output_bytes, options.output_bytes ?? WORKER_CLI_LIMITS.output_bytes));
  return new Promise(resolve => {
    const start = Date.now(); let child, timer, killTimer, bytes = 0, reason = null, settled = false;
    const chunks = { stdout: [], stderr: [] };
    const kill = signal => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
    const finish = (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (child?.pid) kill('SIGKILL'); child?.stdout?.destroy(); child?.stderr?.destroy();
      let stdout = Buffer.concat(chunks.stdout).toString('utf8'), stderr = Buffer.concat(chunks.stderr).toString('utf8');
      // Neither inherited invocation secrets nor the short-lived transport correlation may escape in errors/output.
      for (const [key, secret] of Object.entries(env)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:API|ACCESS|PRIVATE)[_-]?KEY|AUTHORIZATION|LUSH_CLI_TRIAL/i.test(key) && secret) {
        stdout = stdout.replaceAll(secret, '[redacted]'); stderr = stderr.replaceAll(secret, '[redacted]');
      }
      const boundedOut = Buffer.from(stdout), boundedErr = Buffer.from(stderr);
      const truncated = reason === 'output_limit' || boundedOut.length + boundedErr.length > limit;
      stdout = new TextDecoder().decode(boundedOut.subarray(0, limit), { stream: true });
      stderr = new TextDecoder().decode(boundedErr.subarray(0, Math.max(0, limit - Buffer.byteLength(stdout))), { stream: true });
      resolve({ stdout, stderr, exit_code: code, signal: signal ?? null, timed_out: reason === 'timeout',
        truncated, duration_ms: Date.now() - start,
        status: reason && reason !== 'spawn' || signal || code === 75 || truncated ? 'unknown' : code === 0 ? 'succeeded' : 'failed' });
    };
    const stop = why => { if (reason || settled) return; reason = why; kill('SIGTERM'); killTimer = setTimeout(() => { kill('SIGKILL'); finish(null, 'SIGKILL'); }, 100); };
    const onAbort = () => stop('aborted');
    try { child = spawn(process.execPath, ['--no-env-file', '--no-macros', '--config=/dev/null', ...argv],
      { cwd, env, detached: true, stdio: ['ignore','pipe','pipe'] }); }
    catch { reason = 'spawn'; finish(null, null); return; }
    const collect = stream => chunk => {
      const available = Math.max(0, limit - bytes);
      if (available) chunks[stream].push(chunk.subarray(0, available)); bytes += chunk.length;
      if (bytes > limit) stop('output_limit');
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('error', () => { reason = 'spawn'; finish(null, null); });
    child.on('close', (code, signal) => finish(code, signal));
    timer = setTimeout(() => stop('timeout'), timeout);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) stop('aborted');
  });
}

export async function executeWorkerCLI(project, params) {
  check(typeof params.revision === 'string' && /^[a-f0-9]{64}$/.test(params.revision), 'CLI requires a preview revision');
  check(params.confirm === undefined || typeof params.confirm === 'boolean', 'confirm must be boolean');
  check(!project.cliRunning?.size, 'another Worker CLI execution is in progress');
  check(!project.workspaces.pending && !project.workspaces.busy.size && !project.workerDeleteIds?.size
    && !project.acceptanceBusy?.size && !project.taskSyncBusy?.size, 'Git, synchronization or reclamation is in progress; CLI execution must wait');
  const initial = parseWorkerCLI(params.command);
  check(!initial.requires_confirmation || params.confirm === true, 'CLI modification requires explicit confirmation');
  if (initial.requires_confirmation) check(project.maintenanceView().ready_to_restart, 'project has active calls or background work; modifications must wait');
  // Claim BEFORE asynchronous identity checks. No queueing/retry: each preview is consumed once.
  const source = executionTask(project, params.id, initial.requires_confirmation);
  const lease = { rpc: initial.rpc, contextMethod: initial.context_method, userRPC: initial.user_context_rpc,
    taskId: source.id, branch: source.branch, workspace: null,
    pending: new Set(), controller: new AbortController() }, marker = randomBytes(32).toString('hex');
  (project.cliRunning ??= new Map()).set(marker, lease);
  if (initial.requires_confirmation) project.cliMutation = lease;
  let finishLease;
  lease.promise = new Promise(resolve => { finishLease = resolve; });
  const job = context.run(lease, async () => {
    const value = await preview(project, params);
    const record = project.cliPreviews?.get(params.revision);
    check(record && record.expires > Date.now() && value.revision === record.state,
      'CLI preview expired, changed or was already executed; inspect before previewing again');
    const { actual } = workspace(project, params.id, initial.requires_confirmation, value.workspace);
    lease.workspace = actual;
    // Consume BEFORE spawn, including unknown outcomes. A fresh preview is an explicit new action, not a retry.
    project.cliPreviews.delete(params.revision);
    // Persist unknown BEFORE spawn: a crash must never make execution disappear or suggest a retry.
    const history = beginCLIHistory(project, source.id, value.command, actual);
    const result = await runWorkerCLI([path.join(ROOT, 'bin', value.executable), '--project', project.config.project, ...value.argv],
      actual, environment(project, marker), { ...project.workerCLIOptions, signal: lease.controller.signal });
    let history_error;
    try { finishCLIHistory(project, source.id, history.history_id, result); }
    catch { history_error = 'CLI executed but history result could not be saved; inspect the outcome, do not replay'; }
    return { command: value.command, workspace: actual, ...result, ...history, ...(history_error ? { history_error } : {}) };
  });
  const release = () => {
    project.cliRunning.delete(marker); if (project.cliMutation === lease) project.cliMutation = null;
    try {
      project.kick(); project.scheduleTaskHooks(); project.scheduleTaskCompletion(); project.armScheduledHookTimer();
      if (!project.stopping) {
        for (const parentId of project.taskMergeWakePending ?? []) project.scheduleTaskMerge(parentId);
        for (const parentId of project.convergenceWakePending ?? []) project.scheduleConvergence(parentId);
      }
    } finally { finishLease(); }
  };
  try { return await job; } finally {
    lease.closed = true;
    // Killing a CLI does not cancel an already dispatched daemon mutation. Keep its safety lease until it settles.
    if (lease.pending.size) void Promise.allSettled([...lease.pending]).then(release);
    else release();
  }
}
