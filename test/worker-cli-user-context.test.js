import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, gate } from './helpers.js';
import { setup, fetch } from './web/harness.js';
import { PARAMS, USER_ONLY, AGENT_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { CLI_COMMANDS } from '../src/cli/catalog.js';
import { cliCatalog } from '../src/rpc/cli-catalog.js';
import { parseWorkerCLI } from '../src/core/worker-cli.js';
import { managementPolicy } from '../src/rpc/management-policy.js';
import { tokenHash } from '../src/core/project/internal.js';

async function fixture() {
  const f = await setup(); await repo(f.root); f.project.kick = () => {};
  const task = (await f.project.order('user context CLI', null, [], null, false)).task;
  const post = async (method, params, options = {}) => {
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }), ...options });
    const text = await response.text(); let value;
    try { value = JSON.parse(text); } catch { value = text; }
    return { code: response.status, value };
  };
  const preview = async command => {
    const result = await post('worker.cli_preview', { id: task.id, command });
    expect(result.code).toBe(200); return result.value;
  };
  const execute = async p => post('worker.cli_execute', { id: task.id, command: p.command, revision: p.revision, confirm: true });
  const run = async command => { const result = await execute(await preview(command)); expect(result.code).toBe(200); return result.value; };
  return { ...f, task, post, preview, execute, run };
}

test('catalog registration, preview classification and exposed user-context callable set agree', () => {
  const catalog = cliCatalog().commands;
  for (const entry of CLI_COMMANDS.filter(entry => !entry.directory && entry.rpc.some(method => method.startsWith('context.')))) {
    const publicEntry = catalog.find(item => item.path === `lushw ${entry.path}`);
    expect(publicEntry.user_context_rpc).toBe(entry.user_context_rpc);
    const command = entry.example.replace(/^lush /, 'lushw ');
    if (entry.user_context_rpc) {
      expect(Object.hasOwn(PARAMS, entry.user_context_rpc)).toBe(true);
      expect(AGENT_ONLY.has(entry.user_context_rpc)).toBe(false);
      const parsed = parseWorkerCLI(command);
      expect(parsed.rpc).toContain(entry.user_context_rpc);
      expect(parsed.kind).toBe(entry.kind);
      expect(parsed.requires_confirmation).toBe(!['read','local-read'].includes(entry.kind));
    } else expect(() => parseWorkerCLI(command)).toThrow('Agent invocation only');
  }
});

test('HTTP user-context real fixed lushw self/parent/children and confirmed user-equivalent write; no Agent identity', async () => {
  const f = await fixture();
  try {
    const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: f.task.id, goal: 'direct child' });
    f.store.update(child.id, { status: 'paused' });
    const unrelated = f.store.create({ role: 'agent', task_kind: 'order', goal: 'unrelated' });
    for (const [command, id] of [['lushw --json self inspect', f.task.id], ['lushw --json parent inspect', f.task.parent_id],
      [`lushw --json children inspect ${child.id}`, child.id]]) {
      const result = await f.run(command); expect(result.status).toBe('succeeded'); expect(JSON.parse(result.stdout).id).toBe(id);
      expect(result.history_id).toBeGreaterThan(0); expect(typeof result.created_at).toBe('string');
    }
    const list = await f.run('lushw --json children list --limit 1');
    expect(JSON.parse(list.stdout).items.map(row => row.id)).toEqual([child.id]);
    const bad = await f.run(`lushw --json children inspect ${unrelated.id}`);
    expect(bad.status).toBe('failed'); expect(bad.stderr).toContain('direct children');
    const notice = await f.run("lushw --json self notice post 'User context' --kind info --body 'lease bound'");
    expect(notice.status).toBe('succeeded');
    expect(JSON.parse(notice.stdout)).toMatchObject({ task_id: f.task.id, kind: 'info', body: 'lease bound' });
    expect(f.store.task(f.task.id).auto_title).toBeNull();
    for (const command of ['lushw self auto-title nope', 'lushw self progress plan x']) {
      const result = await f.post('worker.cli_preview', { id: f.task.id, command });
      expect(result.code).toBe(400); expect(result.value.error).toContain('Agent invocation only');
    }
    await expect(f.rpc.dispatcher.dispatch('context.inspect', { _cli_trial: 'a'.repeat(64) })).rejects.toThrow('invalid CLI');
    await expect(f.rpc.dispatcher.dispatch('context.inspect')).rejects.toThrow('agent only');
  } finally { await f.close(); }
});

test('context correlation cannot bypass relation validation, expand RPC set, become Agent/Valet, or replay after lease closes', async () => {
  const f = await fixture(), entered = gate(), release = gate(), original = f.project.branchArchivability;
  try {
    const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: f.task.id, goal: 'direct' });
    const stranger = f.store.create({ role: 'agent', task_kind: 'order', goal: 'stranger' });
    f.project.branchArchivability = async function (...args) { entered.resolve(); await release.promise; return original.apply(this, args); };
    const p = await f.preview('lushw --json self inspect'), job = f.execute(p); await entered.promise;
    const marker = f.project.cliRunning.keys().next().value;
    await expect(f.rpc.dispatcher.dispatch('worker.inspect', { id: stranger.id, _cli_trial: marker })).rejects.toThrow('invalid CLI');
    await expect(f.rpc.dispatcher.dispatch('context.inspect', { relation: 'child', child: stranger.id, _cli_trial: marker })).rejects.toThrow('direct children');
    await expect(f.rpc.dispatcher.dispatch('context.message', { relation: 'child', child: child.id, body: 'forged', _cli_trial: marker })).rejects.toThrow('invalid CLI');
    await expect(f.rpc.dispatcher.dispatch('context.inspect', { _cli_trial: marker })).rejects.toThrow('already dispatched');
    await expect(f.rpc.dispatcher.dispatch('context.inspect', { relation: 'self', child: child.id, _cli_trial: marker })).rejects.toThrow('only for');
    await expect(f.rpc.dispatcher.dispatch('context.inspect', { _token: '', _cli_trial: marker })).rejects.toThrow('Agent credentials');
    for (const kind of ['order','management']) {
      const actor = f.store.create({ role: kind === 'management' ? 'manager' : 'agent', task_kind: kind, goal: 'active credential' });
      const token = `private-${kind}`; f.store.update(actor.id, { status: 'running' }); f.store.armAgent(actor.id, tokenHash(token));
      f.project.running.set(actor.id, { token, controller: new AbortController() });
      await expect(f.rpc.dispatcher.dispatch('context.inspect', { _token: token, _cli_trial: marker })).rejects.toThrow('Agent credentials');
      await expect(f.rpc.dispatcher.dispatch('worker.cli_history', { id: f.task.id, _token: token })).rejects.toThrow('user approval');
      f.project.running.delete(actor.id); f.store.update(actor.id, { status: 'paused' });
    }
    release.resolve(); expect((await job).value.status).toBe('succeeded');
    await expect(f.rpc.dispatcher.dispatch('context.inspect', { _cli_trial: marker })).rejects.toThrow('invalid CLI');
    expect((await f.execute(p)).code).toBe(400);
  } finally { release.resolve(); f.project.running.clear(); await f.close(); }
});

test('real encrypted CLI history integrates with confirmed deletion without removing another Worker history or shared key', async () => {
  const f = await fixture();
  try {
    const first = await f.run('lushw --json self inspect');
    const other = (await f.project.order('retained history', null, [], null, false)).task;
    const { beginCLIHistory } = await import('../src/core/worker-cli-history.js');
    beginCLIHistory(f.project, other.id, 'retained command', other.workspace);
    f.store.update(f.task.id, { status: 'failed' });
    const file = path.join(f.config.home, 'worker-cli-history', `${f.task.id}.json`), keyFile = path.join(f.config.home, 'worker-cli-history.key');
    const key = fs.readFileSync(keyFile);
    const history = await f.post('worker.cli_history', { id: f.task.id });
    expect(history.value.entries[0].id).toBe(first.history_id);
    const preview = await fetch(f.url + `/api/worker/${f.task.id}/delete-preview`);
    expect(preview.status).toBe(200);
    const plan = await preview.json();
    expect(plan.can_delete).toBe(true); expect(plan.resources.files).toContain(file);
    const deleted = await f.post('worker.delete', { id: f.task.id, confirm: true, revision: plan.revision });
    expect(deleted.code).toBe(200); expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(keyFile)).toEqual(key);
    expect((await f.post('worker.cli_history', { id: other.id })).value.entries[0].command).toBe('retained command');
    for (const method of ['worker.cli_history','worker.cli_history_clear']) expect((await f.post(method, { id: f.task.id })).code).toBe(400);
    expect(fs.existsSync(file)).toBe(false);
  } finally { await f.close(); }
});

test('HTTP lifecycle rejects deleting/non-order targets and preserves archived history without requiring an executable worktree', async () => {
  const f = await fixture();
  try {
    const first = await f.run('lushw --json self inspect');
    const p = await f.preview('lushw --json self inspect');
    const file = path.join(f.config.home, 'worker-cli-history', `${f.task.id}.json`), saved = fs.readFileSync(file);
    f.project.workerDeleteIds = new Set([f.task.id]);
    for (const method of ['worker.cli_history','worker.cli_history_clear']) {
      const response = await f.post(method, { id: f.task.id });
      expect(response.code).toBe(400); expect(response.value.error).toContain('deletion is in progress');
    }
    expect((await f.post('worker.cli_preview', { id: f.task.id, command: p.command })).value.error).toContain('deletion is in progress');
    expect((await f.execute(p)).code).toBe(400); expect(fs.readFileSync(file)).toEqual(saved);
    f.project.workerDeleteIds = null;
    for (const id of [f.task.parent_id, 999999]) for (const method of ['worker.cli_history','worker.cli_history_clear'])
      expect((await f.post(method, { id })).code).toBe(400);
    // Resource archival leaves the persistent Worker identity and its history readable.
    f.store.update(f.task.id, { status: 'completed', workspace: null });
    f.store.markBranchArchived(f.task.branch);
    const history = await f.post('worker.cli_history', { id: f.task.id });
    expect(history.code).toBe(200); expect(history.value.entries[0].id).toBe(first.history_id);
    expect((await f.post('worker.cli_preview', { id: f.task.id, command: p.command })).code).toBe(400);
    expect((await f.post('worker.cli_history_clear', { id: f.task.id })).value).toEqual({ cleared: true });
  } finally { f.project.workerDeleteIds = null; await f.close(); }
});

test('history HTTP is user-only, strict, authenticated and Origin protected; encrypted outputs survive result persistence failure', async () => {
  const f = await fixture(), entered = gate(), release = gate();
  try {
    for (const method of ['worker.cli_history','worker.cli_history_clear']) {
      expect(PARAMS[method]).toContain('id'); expect(USER_ONLY.has(method)).toBe(true);
      expect(managementPolicy(method).access).toBe('unavailable');
      expect(() => assertAllowed(method, { id: f.task.id }, 2)).toThrow('user approval');
      expect((await f.post(method, { id: f.task.id }, { anonymous: true })).code).toBe(401);
      expect((await f.post(method, { id: f.task.id }, { headers: { 'Content-Type': 'application/json', Origin: 'http://evil.invalid' } })).code).toBe(403);
      for (const params of [{ id: '1' }, { id: f.task.id, _token: '' }, { id: f.task.id, _cli_trial: '' }, { id: f.task.id, extra: 1 }])
        expect((await f.post(method, params)).code).toBe(400);
    }
    for (const params of [{ id: f.task.id, limit: 0 }, { id: f.task.id, limit: 21 }, { id: f.task.id, before: 0 },
      { id: f.task.id, before: null }, { id: f.task.id, limit: '2' }]) expect((await f.post('worker.cli_history', params)).code).toBe(400);
    const initial = await f.run('lushw --json self inspect');
    expect((await f.post('worker.cli_history', { id: f.task.id })).value.entries[0]).toMatchObject({ id: initial.history_id, command: initial.command, stdout: initial.stdout });
    const file = path.join(f.config.home, 'worker-cli-history', `${f.task.id}.json`);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('self inspect');
    const original = f.project.renameTask;
    f.project.renameTask = async function (...args) {
      entered.resolve(); await release.promise;
      const result = await original.apply(this, args);
      fs.writeFileSync(file, 'corrupt', { mode: 0o600 }); return result;
    };
    const p = await f.preview(`lush worker rename ${f.task.id} executed-once`), job = f.execute(p); await entered.promise;
    expect((await f.post('worker.cli_history_clear', { id: f.task.id })).code).toBe(400);
    release.resolve(); const result = await job;
    expect(result.value).toMatchObject({ status: 'succeeded', exit_code: 0 });
    expect(result.value.history_error).toContain('do not replay'); expect(f.store.task(f.task.id).display_title).toBe('executed-once');
    expect((await f.execute(p)).code).toBe(400);
    expect((await f.post('worker.cli_history', { id: f.task.id })).code).toBe(400);
    expect(fs.readFileSync(file, 'utf8')).toBe('corrupt');
  } finally { release.resolve(); await f.close(); }
});
