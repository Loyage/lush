import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture, repo, git, gate } from '../helpers.js';
import { publicDispatch } from '../../src/core/project/input-emission-data.js';

test('exclusive release capability is an explicit boolean and never enables release during dispatch', () => {
  for (const state of ['waiting_conditions','queued','dispatching','failed','cancelled'])
    expect(publicDispatch({ state, exclusive_active: true, signals: [] }).can_release_exclusive).toBe(false);
  expect(publicDispatch({ state: 'succeeded', signals: [] })).toMatchObject({ exclusive_active: false, can_release_exclusive: false });
  expect(publicDispatch({ state: 'succeeded', exclusive_active: 'true', signals: [] })).toMatchObject({ exclusive_active: false, can_release_exclusive: false });
  expect(publicDispatch({ state: 'unknown', exclusive_active: true, signals: [] })).toMatchObject({ exclusive_active: true, can_release_exclusive: true });
});

async function setup() {
  const f = fixture(); f.project.stopping = true; f.project.kick = () => {};
  await repo(f.root); await f.project.ensureMainTask(); return f;
}
async function drain(f) { f.project.stopping = false; try { await f.project.drainInputEmissions(); } finally { f.project.stopping = true; } }
async function worker(f) {
  const task = (await f.project.order('existing work', 'main', [], null, false)).task;
  f.store.update(task.id, { status: 'waiting', calls: 1, result: 'safe answer', head_commit: task.base_commit });
  f.store.event(task.id, 'invocation.started', {}); f.store.event(task.id, 'task.idle', { head_commit: task.base_commit });
  return f.store.task(task.id);
}

test('exclusive implicit quietness counts toward the condition limit before persisting drafts or Hooks', async () => {
  const f = await setup();
  try {
    const main = f.store.get("SELECT id FROM tasks WHERE task_kind='main'");
    const blockers = Array.from({ length: 8 }, (_, n) => f.store.create({ parent_id: main.id, role: 'agent', task_kind: 'child', goal: `blocker ${n}` }));
    const conditions = blockers.flatMap(worker => ['worker_settled','worker_merged'].map(kind => ({ kind, worker_id: worker.id })));
    await expect(f.project.emitBufferedInput({ content: 'over limit', exclusive: true, conditions })).rejects.toThrow('16 conditions');
    await expect(f.project.addBufferedDraft('over limit', [], 'main', { exclusive: true, conditions })).rejects.toThrow('16 conditions');
    expect(f.store.all('SELECT * FROM drafts')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM tasks WHERE hooks IS NOT NULL')).toHaveLength(0);
    const draft = await f.project.addBufferedDraft('within limit', [], 'main', { exclusive: true, conditions: conditions.slice(0, 15) });
    expect(draft.conditions).toHaveLength(16); expect(draft.conditions.at(-1).kind).toBe('parent_quiet');
    await expect(f.project.updateBufferedDraft(draft.id, 'invalid replacement', undefined, undefined, draft.revision,
      { exclusive: true, conditions })).rejects.toThrow('16 conditions');
    expect(f.project.inputGet('draft', draft.id).content).toBe('within limit');
    const explicit = await f.project.addBufferedDraft('explicit quiet', [], 'main', { exclusive: true,
      conditions: [...conditions.slice(0, 15), { kind: 'parent_quiet' }] });
    expect(explicit.conditions).toHaveLength(16); // No double counting the same quiet condition.
  } finally { await f.close(); }
});

test('concurrent keyed direct submissions share one durable emission and refuse revised definitions', async () => {
  const f = await setup();
  try {
    const results = await Promise.all([1,2,3].map(() => f.project.emitBufferedInput({ content: 'same request', client_request_id: 'shared' })));
    expect(new Set(results.map(r => r.draft_id)).size).toBe(1);
    expect(f.store.all('SELECT * FROM drafts')).toHaveLength(1);
    await drain(f); expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    await expect(f.project.emitBufferedInput({ content: 'revised', client_request_id: 'shared' })).rejects.toThrow('different');
  } finally { await f.close(); }
});

test('same draft retries cannot silently replace its saved runtime profile or condition authorization', async () => {
  const f = await setup();
  try {
    const draft = await f.project.addBufferedDraft('saved config', [], 'main');
    const params = { draft_id: draft.id, expected_revision: 1, profile: { agent: 'pi', model: 'one', env: { PRIVATE_VALUE: 'secret' } } };
    await f.project.emitBufferedInput(params); await f.project.emitBufferedInput(params);
    await expect(f.project.emitBufferedInput({ ...params, profile: { agent: 'pi', model: 'two' } })).rejects.toThrow('parameters changed');
    const publicViews = [f.project.inputGet('draft', draft.id), f.project.inputHistory(), f.project.inputEmissionResult(draft.id)];
    expect(JSON.stringify(publicViews)).not.toContain('PRIVATE_VALUE'); expect(JSON.stringify(publicViews)).not.toContain('secret');
    await expect(f.project.updateBufferedDraft(draft.id, 'overwrite', [], undefined, 1)).rejects.toThrow('mounted');
  } finally { await f.close(); }
});

test('a new input arriving during async Git proof prevents latching the preceding settled round', async () => {
  const f = await setup();
  try {
    const source = await worker(f);
    const emission = await f.project.emitBufferedInput({ content: 'after safe work', conditions: [{ kind: 'worker_settled', worker_id: source.id }] });
    const entered = gate(), release = gate(), clean = f.project.inputWorkspaceClean.bind(f.project);
    f.project.inputWorkspaceClean = async task => { entered.resolve(); await release.promise; return clean(task); };
    const proving = f.project.satisfyInputSignal(emission.draft_id, 0); await entered.promise;
    f.project.message(source.id, 'new user requirement'); release.resolve(); await proving;
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.conditions[0].satisfied).toBe(false);
    expect(f.store.task(source.id).status).toBe('queued');
  } finally { await f.close(); }
});

test('condition signal refuses unstored Git HEAD advances and cancelled prerequisites fail visibly', async () => {
  const f = await setup();
  try {
    const source = await worker(f);
    const emission = await f.project.emitBufferedInput({ content: 'after worker', conditions: [{ kind: 'worker_settled', worker_id: source.id }] });
    await git(source.workspace, 'commit', '--allow-empty', '-m', 'unrecorded advance'); await drain(f);
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('waiting_conditions');
    f.store.update(source.id, { status: 'cancelled' }); await drain(f);
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('failed');
    expect(f.project.inputGet('draft', emission.draft_id).content).toBe('after worker');
  } finally { await f.close(); }
});

test('failed multi-condition mount rolls back prior Hooks and refuses custom installation of protected signal actions', async () => {
  const f = await setup();
  try {
    const a = await worker(f), b = await worker(f);
    const hooks = { version: 1, observed: {}, mounts: Array.from({ length: 32 }, (_, n) => ({ id: `full-${n}`, name: 'full', trigger: 'agent.returned', mode: 'once', enabled: false, conditions: {}, actions: [{ type: 'notify', title: 'x', body: '' }], state: 'idle' })) };
    f.store.update(b.id, { hooks: JSON.stringify(hooks) });
    await expect(f.project.emitBufferedInput({ content: 'too many mounts', conditions: [a,b].map(t => ({ kind: 'worker_settled', worker_id: t.id })) })).rejects.toThrow('too many');
    expect(f.project.taskHooks(a.id).mounts.some(m => m.kind === 'input_signal')).toBe(false);
    expect(f.store.all('SELECT * FROM drafts WHERE emission IS NOT NULL')).toHaveLength(0);
    expect(() => f.project.attachTaskHook(a.id, { name: 'bypass', trigger: 'worker.delivery_ready', mode: 'once', enabled: true,
      actions: [{ type: 'input_signal', draft_id: 999, condition_index: 0 }] }, f.project.taskHooks(a.id).revision)).toThrow('built-in only');
  } finally { await f.close(); }
});

test('quiet conditions mount visibly on main and clean cancellation permits dispatch without fake merging', async () => {
  const f = await setup();
  try {
    const source = await worker(f); f.store.update(source.id, { status: 'cancelled' });
    const emission = await f.project.emitBufferedInput({ content: 'after quiet', conditions: [{ kind: 'parent_quiet' }] });
    expect(f.project.taskHooks(source.parent_id).mounts.some(m => m.kind === 'input_signal')).toBe(true);
    await drain(f); expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('succeeded');
    expect(f.project.taskHooks(source.parent_id).mounts.some(m => m.kind === 'input_signal')).toBe(false);
  } finally { await f.close(); }
});

test('exclusive starts only after other explicitly bound branch work is also quiet', async () => {
  const f = await setup();
  try {
    await git(f.root, 'branch', 'other'); const head = await git(f.root, 'rev-parse', 'HEAD');
    await f.project.bindBranch('other', head);
    const other = (await f.project.order('other branch work', 'other', [], null, false)).task;
    const emission = await f.project.emitBufferedInput({ content: 'whole-project exclusive', exclusive: true }); await drain(f);
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('waiting_conditions');
    f.store.update(other.id, { status: 'cancelled' }); await drain(f);
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('succeeded');
  } finally { await f.close(); }
});

test('conditional append waits for sync, blocks acceptance while mounted, and ends as one real Message', async () => {
  const f = await setup();
  try {
    const target = await worker(f), blocker = await worker(f);
    f.store.update(blocker.id, { status: 'paused' });
    f.project.taskSyncBusy = new Set([target.id]);
    const draft = await f.project.addBufferedDraft('future append', [], undefined, { mode: 'append', target_id: target.id,
      conditions: [{ kind: 'worker_settled', worker_id: blocker.id }] });
    const emission = await f.project.emitBufferedInput({ draft_id: draft.id, expected_revision: 1 });
    f.project.taskSyncBusy.clear();
    await expect(f.project.acceptTask(target.id)).rejects.toThrow('mounted append');
    f.store.update(blocker.id, { status: 'waiting' }); f.store.event(blocker.id, 'task.idle', { head_commit: blocker.head_commit });
    f.project.taskSyncBusy.add(target.id); await drain(f);
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('queued');
    f.project.taskSyncBusy.clear(); await drain(f);
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('succeeded');
    expect(f.store.draftCount()).toBe(0); expect(f.store.openDrafts()).toHaveLength(0);
    expect(f.project.inputHistory({ status: 'sent' }).items[0].dispatch.append_number).toMatch(/^A/);
  } finally { await f.close(); }
});

test('draft editing raced by a mounted emission does not overwrite its snapshot; invalid direct profiles create no draft', async () => {
  const f = await setup();
  try {
    const draft = await f.project.addBufferedDraft('original', [], 'main');
    const original = f.project.inputParent.bind(f.project), entered = gate(), release = gate();
    f.project.inputParent = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
    const editing = f.project.updateBufferedDraft(draft.id, 'stale edit', [], 'main', 1); await entered.promise;
    await f.project.emitBufferedInput({ draft_id: draft.id, expected_revision: 1 }); release.resolve();
    await expect(editing).rejects.toThrow('mounted while editing');
    expect(f.project.inputGet('draft', draft.id).content).toBe('original');
    await expect(f.project.emitBufferedInput({ content: 'invalid', profile: { agent: 'not-a-provider' } })).rejects.toThrow();
    expect(f.store.all('SELECT * FROM drafts')).toHaveLength(1);
  } finally { await f.close(); }
});

test('waiting mounts survive restart and proof loss on main never masquerades as successful merge', async () => {
  const f = await setup();
  try {
    const task = await worker(f);
    fs.writeFileSync(path.join(task.workspace, 'work.txt'), 'changed'); await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'change');
    const source = await git(task.workspace, 'rev-parse', 'HEAD');
    f.store.update(task.id, { head_commit: source });
    await git(f.root, 'merge', '--squash', task.branch); await git(f.root, 'commit', '-m', 'land');
    const landed = await git(f.root, 'rev-parse', 'HEAD');
    f.store.update(task.id, { status: 'awaiting_acceptance', integration: 'merged', reservation: null, iteration_base_commit: source });
    f.store.event(task.id, 'task.merge_integrated', { source_commit: source, commit: landed, parent_id: task.parent_id });
    // Test-only destructive reset of this temporary main demonstrates receipt reachability validation.
    await git(f.root, 'reset', '--hard', task.base_commit);
    const emission = await f.project.emitBufferedInput({ content: 'needs exact landing', conditions: [{ kind: 'worker_merged', worker_id: task.id }] });
    f.project.recoverInputEmissions(); await drain(f);
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('waiting_conditions');
    expect(f.store.get('SELECT hooks FROM tasks WHERE id=?', task.id).hooks).toContain('input_signal');
  } finally { await f.close(); }
});
