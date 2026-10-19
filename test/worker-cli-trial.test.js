import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, env, until, gate, temp } from './helpers.js';
import { setup, fetch } from './web/harness.js';
import { parseWorkerCLI, runWorkerCLI, WORKER_CLI_LIMITS } from '../src/core/worker-cli.js';
import { PARAMS, USER_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { HANDLERS } from '../src/rpc/dispatcher.js';
import { managementPolicy } from '../src/rpc/management-policy.js';

async function trialFixture() {
  const f = await setup(); await repo(f.root);
  const created = await f.project.order('CLI isolated test', null, [], null, false);
  const task = f.store.task(created.task.id);
  // Explicit start:false creates the dedicated checkout without invoking a Provider.
  const post = async (method, params, suffix = '', extra = {}) => {
    const response = await fetch(f.url + '/api/action' + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params, ...extra }) });
    return { code: response.status, value: await response.json() };
  };
  const preview = async command => {
    const result = await post('worker.cli_preview', { id: task.id, command });
    if (result.code !== 200) throw new Error(JSON.stringify(result));
    return result.value;
  };
  const execute = async (value, confirm) => post('worker.cli_execute', { id: task.id, command: value.command,
    revision: value.revision, ...(confirm === undefined ? {} : { confirm }) });
  return { ...f, task, post, preview, execute };
}

test('Worker CLI registers user-only methods with unavailable Valet policy and strict argv grammar', () => {
  for (const method of ['worker.cli_preview','worker.cli_execute']) {
    expect(PARAMS[method]).toContain('command'); expect(USER_ONLY.has(method)).toBe(true);
    expect(typeof HANDLERS[method]).toBe('function');
    expect(() => assertAllowed(method, {}, 5)).toThrow('user approval');
    expect(managementPolicy(method).access).toBe('unavailable');
  }
  expect(parseWorkerCLI('lush worker rename W1 "literal ; $(no) | text"')).toMatchObject({ path: 'worker rename', kind: 'write',
    requires_confirmation: true, argv: ['worker','rename','W1','literal ; $(no) | text'] });
  expect(parseWorkerCLI('lush --json worker list')).toMatchObject({ path: 'worker list', requires_confirmation: false });
  expect(parseWorkerCLI('lush daemon stop --help')).toMatchObject({ path: 'help', kind: 'local-read', requires_confirmation: false });
  expect(parseWorkerCLI('lush worker message W1 "same text"')).toMatchObject({
    command: 'lush worker message W1 "same text"', path: 'worker message', kind: 'agent', requires_confirmation: true });
  for (const command of ['sh -c true', '/bin/lush status', 'LUSH_AGENT_TOKEN=x lush status', 'lush status; echo no',
    'lush status | cat', 'lush status $(id)', 'lush --project /tmp status', 'lush status --project=/tmp',
    'lushw worker rename W1 no', 'lush worker wait W1', 'lush worker watch W1', 'lush daemon restart',
    'lush host start', 'lush agent sources login x', 'lush status\nhelp', 'lush "unfinished', 'lush status --env=x'])
    expect(() => parseWorkerCLI(command)).toThrow();
  expect(() => parseWorkerCLI('lush ' + 'x'.repeat(8192))).toThrow('8192');
});

test('real HTTP → user RPC → fixed lush/lushw CLI → daemon → bounded result; help executes locally', async () => {
  const f = await trialFixture();
  try {
    expect(fs.existsSync(f.task.workspace)).toBe(true);
    // An untrusted checkout cannot inject invocation identity or a Bun preload into the fixed bin.
    f.config.env.LUSH_AGENT_TOKEN = 'inherited-agent-secret'; f.config.env.LUSH_TASK_ID = '999999';
    f.config.env.PI_SESSION_ID = 'inherited-session'; f.config.env.NODE_OPTIONS = '--require=/missing-preload';
    fs.writeFileSync(path.join(f.task.workspace, '.env'), 'LUSH_AGENT_TOKEN=stolen\nLUSH_HOME=/wrong\n');
    fs.writeFileSync(path.join(f.task.workspace, 'bunfig.toml'), 'preload = ["./evil.js"]\n');
    fs.writeFileSync(path.join(f.task.workspace, 'evil.js'), 'throw new Error("CHECKOUT PRELOAD EXECUTED")');
    for (const command of ['lush --json worker list', 'lush --json worker inspect ' + f.task.id, 'lushw help']) {
      const p = await f.preview(command);
      expect(p).toMatchObject({ id: f.task.id, workspace: f.task.workspace, command, requires_confirmation: false });
      expect(p.revision).toHaveLength(64);
      const result = await f.execute(p);
      expect(result.code).toBe(200);
      expect(result.value).toMatchObject({ command, workspace: f.task.workspace, exit_code: 0, signal: null,
        timed_out: false, truncated: false, status: 'succeeded' });
      expect(result.value.stdout.length).toBeGreaterThan(10);
      expect(result.value.stdout + result.value.stderr).not.toContain('stolen');
      expect(result.value.stdout + result.value.stderr).not.toContain('inherited-agent-secret');
      expect(result.value.stdout + result.value.stderr).not.toContain('CHECKOUT PRELOAD EXECUTED');
      expect(Buffer.byteLength(result.value.stdout + result.value.stderr)).toBeLessThanOrEqual(WORKER_CLI_LIMITS.output_bytes);
    }
    const p = await f.preview(`lush worker rename ${f.task.id} 'CLI title ; $(literal)'`);
    expect(p).toMatchObject({ kind: 'write', requires_confirmation: true });
    expect((await f.execute(p)).code).not.toBe(200);
    expect(f.store.task(f.task.id).display_title).toBeNull();
    const result = await f.execute(p, true);
    expect(result.value).toMatchObject({ status: 'succeeded', exit_code: 0 });
    expect(f.store.task(f.task.id).display_title).toBe('CLI title ; $(literal)');
    expect((await f.execute(p, true)).code).not.toBe(200);
    // A fresh preview of the same command is an explicit fresh action, not a stuck deterministic revision.
    expect((await f.execute(await f.preview(p.command), true)).value.status).toBe('succeeded');
    const invalid = await f.execute(await f.preview('lush worker rename'), true);
    expect(invalid.value).toMatchObject({ status: 'failed', exit_code: 1 });
    // Parent's new --kind info stays a confirmed write through the shared
    // catalogue, private CLI correlation and real user-authorized notice RPC.
    const info = await f.preview(`lush --json notice post 'CLI info' --worker ${f.task.worker_number} --kind info --body 'CLI result'`);
    expect(info).toMatchObject({ path: 'notice post', kind: 'write', requires_confirmation: true });
    expect((await f.execute(info)).code).not.toBe(200);
    const reported = await f.execute(info, true);
    expect(reported.value).toMatchObject({ status: 'succeeded', exit_code: 0 });
    expect(JSON.parse(reported.value.stdout)).toMatchObject({ task_id: f.task.id, kind: 'info', status: 'sent', body: 'CLI result' });
    expect(f.store.task(f.task.id).status).toBe('paused');
  } finally { await f.close(); }
});

test('isolated separate daemon and authenticated HTTP bridge execute real query and confirmed mutation', async () => {
  const root = temp(); await repo(root);
  const { cli } = await import('./integration/harness.js');
  const { Config } = await import('../src/config.js');
  const { startTestWeb } = await import('./web/auth-fixture.js');
  let web;
  try {
    const daemon = await cli(root, ['start']); expect(daemon.pid).not.toBe(process.pid);
    const config = new Config({ project: root, env: env() }); web = startTestWeb(config, 0);
    const url = `http://127.0.0.1:${web.port}/api/action`;
    const post = async (method, params, options = {}) => {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }), ...options });
      return { code: response.status, value: response.status === 200 ? await response.json() : null };
    };
    const created = await post('order.submit', { content: 'separate-daemon CLI', start: false });
    const id = created.value.task.id;
    expect((await post('worker.cli_preview', { id, command: 'lush status' }, { anonymous: true })).code).toBe(401);
    expect((await post('worker.cli_preview', { id, command: 'lush status' }, { headers: { 'Content-Type': 'application/json', Origin: 'http://evil.invalid' } })).code).toBe(403);
    for (const command of ['lush --json worker list', 'lushw --json self inspect', 'lushw --json parent inspect',
      'lushw --json children list', `lush worker rename ${id} actual-cli`, "lushw --json self notice post 'user write' --kind info"]) {
      const preview = await post('worker.cli_preview', { id, command }); expect(preview.code).toBe(200);
      const result = await post('worker.cli_execute', { id, command, revision: preview.value.revision, confirm: true });
      expect(result.code).toBe(200); expect(result.value).toMatchObject({ status: 'succeeded', exit_code: 0 });
      expect(result.value.workspace).toBe(created.value.task.workspace);
    }
    const { UIClient } = await import('../src/ui/client.js');
    expect((await new UIClient(config).request('worker.inspect', { id })).display_title).toBe('actual-cli');
    const saved = await post('worker.cli_history', { id });
    expect(saved.value.entries).toHaveLength(6);
    await cli(root, ['stop']);
    // A durable pre-spawn placeholder is intentionally never retried after daemon restart.
    const { beginCLIHistory } = await import('../src/core/worker-cli-history.js');
    const pending = beginCLIHistory({ config, store: { task: () => ({ id, task_kind: 'order' }) } }, id, 'interrupted before acknowledgement', created.value.task.workspace);
    await cli(root, ['start']);
    const restored = await post('worker.cli_history', { id });
    expect(restored.code).toBe(200); expect(restored.value.entries.slice(0, 6)).toEqual(saved.value.entries);
    expect(restored.value.entries.at(-1)).toMatchObject({ id: pending.history_id, status: 'unknown', exit_code: null });
    expect((await post('worker.cli_history_clear', { id })).value).toEqual({ cleared: true });
    expect((await post('worker.cli_history', { id })).value).toEqual({ entries: [], before: null, has_more: false });
  } finally { if (web) await web.stop(true); await cli(root, ['stop']).catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});

test('HTTP rejects credentials, overrides, unknown envelope/query fields and non-POST trial access', async () => {
  const f = await trialFixture();
  try {
    for (const params of [
      { id: f.task.id, command: 'lush status', _token: '' },
      { id: f.task.id, command: 'lush status', _cli_trial: 'fake' },
      { id: f.task.id, command: 'lush status', cwd: f.root },
      { id: f.task.id, command: 'lush status --project /tmp' },
      { id: 1, command: 'lush status' },
    ]) expect((await f.post('worker.cli_preview', params)).code).not.toBe(200);
    expect((await f.post('worker.cli_preview', { id: f.task.id, command: 'lush status' }, '?a=b')).code).not.toBe(200);
    expect((await f.post('worker.cli_preview', { id: f.task.id, command: 'lush status' }, '', { env: {} })).code).not.toBe(200);
    expect((await fetch(f.url + `/api/worker/${f.task.id}/cli-preview`)).status).toBe(404);
    const token = 'trial-agent-token'; f.project.running.set(f.task.id, { token, controller: new AbortController() });
    f.store.update(f.task.id, { status: 'running' });
    const { tokenHash } = await import('../src/core/project/internal.js'); f.store.armAgent(f.task.id, tokenHash(token));
    for (const method of ['worker.cli_preview','worker.cli_execute'])
      await expect(f.rpc.dispatcher.dispatch(method, { id: f.task.id, command: 'lush status', _token: token })).rejects.toThrow('user approval');
    f.project.running.clear(); f.store.update(f.task.id, { status: 'paused' });
  } finally { f.project.running.clear(); await f.close(); }
});

test('worktree identity, stale revisions, active/frozen modifications and missing checkout fail closed', async () => {
  const f = await trialFixture();
  try {
    const command = `lush worker rename ${f.task.id} changed`, p = await f.preview(command);
    f.store.update(f.task.id, { status: 'queued' });
    expect((await f.post('worker.cli_preview', { id: f.task.id, command })).value.error).toContain('active');
    f.store.update(f.task.id, { status: 'paused' });
    f.project.running.set(f.task.id, { controller: new AbortController() });
    expect((await f.post('worker.cli_preview', { id: f.task.id, command })).code).not.toBe(200);
    // Read-only queries remain usable while the Worker is active.
    expect((await f.execute(await f.preview('lush worker list'))).value.status).toBe('succeeded');
    f.project.running.clear();
    f.store.update(f.task.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'requested',
      queue_protocol: 1, parent_id: f.task.parent_id, commit: await git(f.task.workspace, 'rev-parse', 'HEAD') }) });
    expect(f.project.branchFreeze(f.task.branch)).toBeTruthy();
    expect((await f.post('worker.cli_preview', { id: f.task.id, command })).value.error).toContain('frozen');
    f.store.update(f.task.id, { reservation: f.task.reservation });
    await git(f.task.workspace, 'commit', '--allow-empty', '-m', 'new head');
    expect((await f.execute(p, true)).value.error).toContain('changed');
    await git(f.task.workspace, 'checkout', '--detach');
    expect((await f.post('worker.cli_preview', { id: f.task.id, command: 'lush status' })).code).not.toBe(200);
    await git(f.task.workspace, 'checkout', f.task.branch);
    const saved = f.task.workspace + '-saved'; fs.renameSync(f.task.workspace, saved);
    try {
      expect((await f.post('worker.cli_preview', { id: f.task.id, command: 'lush status' })).value.error).toContain('no longer exists');
      fs.symlinkSync(f.root, f.task.workspace);
      expect((await f.post('worker.cli_preview', { id: f.task.id, command: 'lush status' })).code).not.toBe(200);
      fs.unlinkSync(f.task.workspace);
    } finally { fs.renameSync(saved, f.task.workspace); }
  } finally { f.project.running.clear(); await f.close(); }
});

test('mutation lease prevents concurrency/reclamation/scheduling while preserving actual CLI RPC permissions', async () => {
  const f = await trialFixture();
  const pending = gate(), entered = gate(); const original = f.project.renameTask;
  try {
    f.project.renameTask = async function (...args) { entered.resolve(); await pending.promise; return original.apply(this, args); };
    const p = await f.preview(`lush worker rename ${f.task.id} leased`);
    const job = f.execute(p, true); await entered.promise;
    expect(f.project.cliMutation).toBeTruthy(); expect(f.project.maintenanceView().ready_to_restart).toBe(false);
    const marker = f.project.cliRunning.keys().next().value;
    await expect(f.rpc.dispatcher.dispatch('worker.message', { id: f.task.id, body: 'cannot broaden catalog permissions', _cli_trial: marker })).rejects.toThrow('invalid CLI execution context');
    await expect(f.rpc.dispatcher.dispatch('worker.rename', { id: f.task.id, title: 'forged', _cli_trial: 'fake' })).rejects.toThrow('invalid CLI execution context');
    f.project.scheduleTaskMerge(f.task.parent_id);
    expect(f.project.taskMergeWakePending.has(f.task.parent_id)).toBe(true);
    await expect(f.rpc.dispatcher.dispatch('worker.rename', { id: f.task.id, title: 'racer' })).rejects.toThrow('CLI execution');
    await expect(f.rpc.dispatcher.dispatch('worker.cleanup', { id: f.task.id })).rejects.toThrow('CLI');
    expect((await f.execute(p, true)).code).not.toBe(200);
    await expect(f.project.workspaces.exclusive(() => {})).rejects.toThrow('CLI');
    f.project.pump(); expect(f.project.running.size).toBe(0);
    pending.resolve(); expect((await job).value.status).toBe('succeeded');
    expect(f.project.cliMutation).toBeNull(); expect(f.project.cliRunning.size).toBe(0);
    await until(() => !f.project.taskMergeWakePending.has(f.task.parent_id));
    // The CLI does not acquire an Agent-only identity just because the executable is lushw.
    const agentOnly = await f.post('worker.cli_preview', { id: f.task.id, command: 'lushw self auto-title forbidden' });
    expect(agentOnly.code).toBe(400);
    expect(agentOnly.value.error).toContain('Agent invocation only');
  } finally { pending.resolve(); await f.close(); }
});

test('read-only CLI lease protects its cwd at the actual Git removal boundary without pausing Agents', async () => {
  const f = await trialFixture(), entered = gate(), release = gate(), original = f.project.branchArchivability;
  try {
    f.project.branchArchivability = async function (...args) { entered.resolve(); await release.promise; return original.apply(this, args); };
    const p = await f.preview(`lush --json worker inspect ${f.task.id}`), job = f.execute(p);
    await entered.promise;
    expect(f.project.cliMutation).toBeUndefined();
    await expect(f.project.workspaces.git(f.root, 'worktree', 'remove', f.task.workspace)).rejects.toThrow('CLI still uses');
    await expect(f.rpc.dispatcher.dispatch('worker.cleanup', { id: f.task.id })).rejects.toThrow('CLI still uses');
    expect(fs.existsSync(f.task.workspace)).toBe(true);
    release.resolve(); expect((await job).value.status).toBe('succeeded');
  } finally { release.resolve(); await f.close(); }
});

test('read-only trial leaves concurrent Agent RPC permissions intact; busy mutation refuses before taking admission', async () => {
  const f = await trialFixture(), entered = gate(), release = gate(), original = f.project.branchArchivability;
  try {
    const active = (await f.project.order('concurrent active Agent', null, [], null, false)).task;
    const token = 'isolated-read-lease-agent-token';
    f.store.update(active.id, { status: 'running' });
    const { tokenHash } = await import('../src/core/project/internal.js'); f.store.armAgent(active.id, tokenHash(token));
    f.project.running.set(active.id, { token, controller: new AbortController() });
    const { UIClient } = await import('../src/ui/client.js'); const agent = new UIClient(f.config, token);
    f.project.branchArchivability = async function (...args) { entered.resolve(); await release.promise; return original.apply(this, args); };
    const preview = await f.preview(`lush --json worker inspect ${f.task.id}`), job = f.execute(preview);
    await entered.promise;
    const marker = f.project.cliRunning.keys().next().value;
    expect(f.project.cliMutation).toBeUndefined(); expect(f.project.maintenancePaused()).toBe(false);
    expect((await agent.request('context.inspect')).id).toBe(active.id);
    expect((await agent.request('progress.plan', { steps: [{ key: 'normal', label: 'Normal Agent progress' }] })).task_id).toBe(active.id);
    expect((await agent.request('notice.post', { title: 'Concurrent Agent notice', body: 'Read-only trial does not block this RPC.' })).task_id).toBe(active.id);
    // Knowing a read correlation does not change an Agent into a user or broaden the catalog RPC set.
    await expect(agent.request('worker.rename', { id: active.id, title: 'forbidden', _cli_trial: marker })).rejects.toThrow('user approval');
    await expect(agent.request('worker.inspect', { id: active.id, _cli_trial: marker })).rejects.toThrow('invalid CLI execution context');
    expect(f.project.running.get(active.id).controller.signal.aborted).toBe(false);
    release.resolve(); expect((await job).value.status).toBe('succeeded');
    const modifying = await f.preview(`lush worker rename ${f.task.id} blocked`);
    const rejected = await f.execute(modifying, true);
    expect(rejected.code).not.toBe(200); expect(rejected.value.error).toContain('project has active calls');
    expect(f.project.cliMutation).toBeUndefined(); expect(f.project.cliRunning.size).toBe(0);
    expect((await agent.request('progress.complete', { step: 'normal' })).task_id).toBe(active.id);
    expect(f.store.task(f.task.id).display_title).toBeNull();
  } finally { release.resolve(); f.project.running.clear(); await f.close(); }
});

test('confirmed destructive CLI on another Worker uses original lifecycle gates and serialized Git', async () => {
  const f = await trialFixture();
  try {
    const other = (await f.project.order('other CLI target', null, [], null, false)).task;
    const cleanup = `lush worker cleanup ${other.id} --keep-branch`;
    const refused = await f.execute(await f.preview(cleanup), true);
    expect(refused.value).toMatchObject({ status: 'failed', exit_code: 1 });
    expect(refused.value.stderr).toContain('worker must have stopped');
    expect((await f.execute(await f.preview(`lush worker cancel ${other.id}`), true)).value.status).toBe('succeeded');
    expect((await f.execute(await f.preview(cleanup), true)).value.status).toBe('succeeded');
    expect(fs.existsSync(other.workspace)).toBe(false); expect(fs.existsSync(f.task.workspace)).toBe(true);
    expect((await f.execute(await f.preview(`lush worker cleanup ${f.task.id}`), true)).value.stderr).toContain('CLI still uses');
  } finally { await f.close(); }
});

test('execution limits, closed stdin, disconnect semantics and redaction are bounded and never retried', async () => {
  const cwd = temp();
  try {
    let result = await runWorkerCLI(['-e', 'console.log(await Bun.stdin.text())'], cwd, env());
    expect(result.status).toBe('succeeded'); expect(result.stdout).toBe('\n');
    result = await runWorkerCLI(['-e', 'console.log("secret-token"); setInterval(()=>{},1000)'], cwd,
      env({ SOME_TOKEN: 'secret-token' }), { timeout_ms: 40 });
    expect(result).toMatchObject({ status: 'unknown', timed_out: true }); expect(result.stdout).not.toContain('secret-token');
    result = await runWorkerCLI(['-e', 'process.stdout.write("x".repeat(100000))'], cwd, env(), { output_bytes: 100 });
    expect(result).toMatchObject({ status: 'unknown', truncated: true }); expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(100);
    result = await runWorkerCLI(['-e', 'process.exit(75)'], cwd, env());
    expect(result.status).toBe('unknown');
    // Real CLI talking to a bridge which accepts then disconnects, never a mocked command result.
    const socket = path.join(cwd, 'rpc.sock'), home = path.join(cwd, '.lush'); fs.mkdirSync(home);
    let requests = 0;
    const server = Bun.listen({ unix: socket, socket: { data(s) { requests++; s.terminate(); } } });
    try {
      const { ROOT } = await import('../src/identity.js');
      // Config socket is fixed under .lush; point the temporary project's socket there.
      const { Config } = await import('../src/config.js'); const config = new Config({ project: cwd, env: env() });
      fs.symlinkSync(socket, config.socket);
      result = await runWorkerCLI([path.join(ROOT, 'bin/lush'), 'status'], cwd,
        { ...env(), LUSH_PROJECT: cwd, LUSH_HOME: home, LUSH_CLI_TRIAL: 'private-correlation' });
      expect(result.status).toBe('unknown'); expect(requests).toBe(1);
      expect(result.stderr).not.toContain('private-correlation');
    } finally {
      server.stop(true);
      const { Config } = await import('../src/config.js'); fs.rmSync(new Config({ project: cwd, env: env() }).socket, { force: true });
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('unknown mutation keeps lease until already dispatched handler settles; revision cannot replay', async () => {
  const f = await trialFixture(), entered = gate(), release = gate(); const original = f.project.renameTask;
  try {
    f.project.workerCLIOptions = { timeout_ms: 1000 };
    f.project.renameTask = async function (...args) { entered.resolve(); await release.promise; return original.apply(this, args); };
    const p = await f.preview(`lush worker rename ${f.task.id} eventual`), job = f.execute(p, true);
    await entered.promise;
    const result = await job;
    expect(result.value).toMatchObject({ status: 'unknown', timed_out: true });
    const { workerCLIHistory, clearWorkerCLIHistory } = await import('../src/core/worker-cli-history.js');
    expect(workerCLIHistory(f.project, { id: f.task.id }).entries.at(-1)).toMatchObject({ id: result.value.history_id, status: 'unknown', timed_out: true });
    expect(() => clearWorkerCLIHistory(f.project, { id: f.task.id })).toThrow('in progress');
    expect(f.project.cliMutation).toBeTruthy();
    const lifetime = f.project.cliMutation.promise; let drained = false; void lifetime.then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    expect((await f.execute(p, true)).code).not.toBe(200);
    release.resolve(); await lifetime; expect(drained).toBe(true); await until(() => !f.project.cliMutation);
    expect(f.store.task(f.task.id).display_title).toBe('eventual');
    expect((await f.execute(p, true)).code).not.toBe(200);
  } finally { release.resolve(); await f.close(); }
});
