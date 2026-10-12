import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from 'bun:test';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { Store } from '../../src/persistence/store.js';

const reference = { version: 1, kind: 'text', target: {}, label: 'quote', quote: 'saved selection', location: {}, captured_at: '2026-01-01T00:00:00.000Z' };
async function setup() {
  const f = fixture(); f.project.stopping = true; f.project.kick = () => {};
  await repo(f.root); await f.project.ensureMainTask(); return f;
}
async function drain(f) { f.project.stopping = false; try { await f.project.drainInputEmissions(); } finally { f.project.stopping = true; } }
async function order(f, content = 'prerequisite') { return (await f.project.order(content, 'main', [], null, false)).task; }
function settled(f, task) {
  f.store.update(task.id, { status: 'waiting', calls: 1, result: 'done', head_commit: task.head_commit ?? task.base_commit });
  f.store.event(task.id, 'invocation.started', { run_id: 1 });
  f.store.event(task.id, 'task.idle', { run_id: 1, head_commit: f.store.task(task.id).head_commit });
  return f.store.task(task.id);
}
async function changed(f, task) {
  fs.writeFileSync(path.join(task.workspace, `change-${task.id}.txt`), `work ${task.id}\n`);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', `work ${task.id}`);
  const head = await git(task.workspace, 'rev-parse', 'HEAD');
  f.store.update(task.id, { head_commit: head, integration: 'pending' });
  return settled(f, f.store.task(task.id));
}
async function land(f, source, parent) {
  source = f.store.task(source.id);
  const dir = parent.workspace ?? f.root;
  await git(dir, 'merge', '--squash', source.branch); await git(dir, 'commit', '-m', `land ${source.id}`);
  const head = await git(dir, 'rev-parse', 'HEAD');
  f.store.update(parent.id, { head_commit: head });
  f.store.update(source.id, { status: 'awaiting_acceptance', integration: 'merged', iteration_base_commit: source.head_commit, reservation: null });
  f.store.event(source.id, 'task.merge_integrated', { source_commit: source.head_commit, commit: head, parent_id: parent.id, squash: true });
  return head;
}

test('emission mounts first, returns no fictitious Worker, dispatches latest baseline once and retains raw references', async () => {
  const f = await setup();
  try {
    const draft = await f.project.addBufferedDraft('exact text', [reference], 'main');
    const result = await f.project.emitBufferedInput({ draft_id: draft.id, expected_revision: 1, client_request_id: 'one' });
    expect(result).toMatchObject({ emitted: true, mode: 'order', draft_id: draft.id, dispatch: { state: 'queued' } });
    expect(result.task).toBeUndefined(); expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    expect(f.project.inputHistory({ status: 'emitted' }).items[0]).toMatchObject({ id: draft.id, mode: 'order', dispatch: { state: 'queued' } });
    await git(f.root, 'commit', '--allow-empty', '-m', 'new main'); const latest = await git(f.root, 'rev-parse', 'HEAD');
    await drain(f);
    const receipt = f.project.inputEmissionResult(draft.id);
    expect(receipt.dispatch.state).toBe('succeeded');
    expect(f.store.task(receipt.dispatch.worker_id).base_commit).toBe(latest);
    expect(f.store.task(receipt.dispatch.worker_id).status).toBe('queued');
    expect(f.project.inputGet('input', receipt.dispatch.input_id).references).toEqual([{ segment: 1, ...reference }]);
    expect(f.project.inputGet('draft', draft.id)).toMatchObject({ input_id: receipt.dispatch.input_id, dispatch: { state: 'succeeded' } });
    await f.project.emitBufferedInput({ draft_id: draft.id, expected_revision: 1, client_request_id: 'one' }); await drain(f);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    await expect(f.project.emitBufferedInput({ content: 'different', client_request_id: 'one' })).rejects.toThrow('different input');
  } finally { await f.close(); }
});

test('conditions require all selected Workers at a genuine settled boundary; mounts are protected and retire after signal', async () => {
  const f = await setup();
  try {
    const a = await order(f), b = await order(f);
    const result = await f.project.emitBufferedInput({ content: 'after both', conditions: [a,b].map(t => ({ kind: 'worker_settled', worker_id: t.id })) });
    const hooks = f.project.taskHooks(a.id), mount = hooks.mounts.find(m => m.kind === 'input_signal');
    expect(mount).toMatchObject({ builtin: true, locked: true, editable: false, removable: false });
    expect(() => f.project.removeTaskHook(a.id, mount.id, hooks.revision)).toThrow('input condition');
    await expect(f.project.updateTaskHook(a.id, mount.id, false, hooks.revision)).rejects.toThrow('input condition');
    await drain(f); expect(f.project.inputEmissionResult(result.draft_id).dispatch.state).toBe('waiting_conditions');
    settled(f, a); await drain(f);
    expect(f.project.inputEmissionResult(result.draft_id).dispatch.conditions.map(s => s.satisfied)).toEqual([true,false]);
    expect(f.project.taskHooks(a.id).mounts.some(m => m.kind === 'input_signal')).toBe(false);
    f.store.update(b.id, { status: 'waiting', head_commit: b.base_commit });
    // A model return without task.idle or equivalent safe delivery is insufficient.
    f.store.event(b.id, 'agent.returned', {}); await drain(f);
    expect(f.project.inputEmissionResult(result.draft_id).dispatch.state).toBe('waiting_conditions');
    settled(f, b); await drain(f);
    expect(f.project.inputEmissionResult(result.draft_id).dispatch.state).toBe('succeeded');
  } finally { await f.close(); }
});

test('already satisfied conditions do not wait for a new edge; old-round landing cannot satisfy new-round conditions', async () => {
  const f = await setup();
  try {
    const task = await changed(f, await order(f)); const main = f.project.inputRoot(task);
    await land(f, task, main);
    const first = await f.project.emitBufferedInput({ content: 'already landed', conditions: [{ kind: 'worker_merged', worker_id: task.id }] });
    await drain(f); expect(f.project.inputEmissionResult(first.draft_id).dispatch.state).toBe('succeeded');
    f.store.update(task.id, { status: 'waiting' }); f.store.event(task.id, 'task.iteration_started', { reason: 'new work' });
    f.store.event(task.id, 'task.idle', { head_commit: task.head_commit });
    const second = await f.project.emitBufferedInput({ content: 'after latest round', conditions: [{ kind: 'worker_merged', worker_id: task.id }] });
    await drain(f);
    expect(f.project.inputEmissionResult(second.draft_id).dispatch.state).toBe('waiting_conditions');
  } finally { await f.close(); }
});

test('child squash to direct parent is not a landing on main; exact upward receipt is required', async () => {
  const f = await setup();
  try {
    const parent = await order(f, 'parent'), child = await f.project.spawn(parent.id, 'child');
    await changed(f, child); await land(f, child, parent);
    const result = await f.project.emitBufferedInput({ content: 'uses child on main', conditions: [{ kind: 'worker_merged', worker_id: child.id }] });
    await drain(f); expect(f.project.inputEmissionResult(result.draft_id).dispatch.state).toBe('waiting_conditions');
    const currentParent = settled(f, f.store.task(parent.id)); await land(f, currentParent, f.project.inputRoot(parent));
    await drain(f); expect(f.project.inputEmissionResult(result.draft_id).dispatch.state).toBe('succeeded');
  } finally { await f.close(); }
});

test('quiet includes paused, failed, pending work and cancelled dirty sites, but permits cancelled clean and safe no-code results', async () => {
  const f = await setup();
  try {
    const task = await order(f);
    const result = await f.project.emitBufferedInput({ content: 'quiet-only', conditions: [{ kind: 'parent_quiet' }] });
    await drain(f); expect(f.project.inputEmissionResult(result.draft_id).dispatch.reason).toContain('paused');
    f.store.update(task.id, { status: 'failed' }); await drain(f);
    expect(f.project.inputEmissionResult(result.draft_id).dispatch.reason).toContain('failed');
    f.store.update(task.id, { status: 'cancelled' }); fs.writeFileSync(path.join(task.workspace, 'dirty.txt'), 'unfinished');
    await drain(f); expect(f.project.inputEmissionResult(result.draft_id).dispatch.reason).toContain('脏现场');
    fs.unlinkSync(path.join(task.workspace, 'dirty.txt')); settled(f, task);
    await drain(f); expect(f.project.inputEmissionResult(result.draft_id).dispatch.state).toBe('succeeded');
  } finally { await f.close(); }
});

test('parent freeze and true invocation ownership queue dispatch without fixing an early code baseline', async () => {
  const f = await setup();
  try {
    const source = await order(f);
    f.store.update(source.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: source.base_commit }) });
    const emission = await f.project.emitBufferedInput({ content: 'after freeze' }); await drain(f);
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('queued');
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    f.store.update(source.id, { reservation: null });
    const main = f.project.inputRoot(source); f.project.running.set(main.id, { controller: new AbortController(), parked: true });
    await drain(f); expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('queued');
    f.project.running.delete(main.id); await drain(f);
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('succeeded');
  } finally { await f.close(); }
});

test('exclusive creation serializes later emissions, admits its descendants, and can be explicitly released without cancelling work', async () => {
  const f = await setup();
  try {
    const exclusive = await f.project.emitBufferedInput({ content: 'wide refactor', exclusive: true });
    const following = await f.project.emitBufferedInput({ content: 'later work' });
    await drain(f);
    const dispatch = f.project.inputEmissionResult(exclusive.draft_id).dispatch;
    expect(dispatch).toMatchObject({ state: 'succeeded', exclusive_active: true, can_release_exclusive: true });
    expect(f.project.inputGet('draft', exclusive.draft_id)).toMatchObject({ kind: 'draft', input_id: dispatch.input_id,
      dispatch: { state: 'succeeded', exclusive_active: true, can_release_exclusive: true } });
    expect(f.project.inputEmissionResult(following.draft_id).dispatch.state).toBe('queued');
    const worker = f.store.task(dispatch.worker_id), child = await f.project.spawn(worker.id, 'allowed inside exclusive');
    expect(f.project.inputExclusiveReason(child)).toBeNull();
    await expect(f.project.order('bypass?', 'main', [], null, false)).rejects.toThrow('独占');
    expect(f.project.releaseInputExclusive(exclusive.draft_id, 1).dispatch).toMatchObject({ exclusive_active: false, can_release_exclusive: false });
    expect(f.store.task(worker.id).status).toBe('queued');
    await drain(f); expect(f.project.inputEmissionResult(following.draft_id).dispatch.state).toBe('succeeded');
  } finally { await f.close(); }
});

test('exclusive lease automatically releases only after safe current-round merge or no-code delivery', async () => {
  const f = await setup();
  try {
    const exclusive = await f.project.emitBufferedInput({ content: 'exclusive', exclusive: true }); await drain(f);
    const worker = f.store.task(f.project.inputEmissionResult(exclusive.draft_id).dispatch.worker_id);
    const next = await f.project.emitBufferedInput({ content: 'next' });
    f.store.update(worker.id, { status: 'failed' }); await drain(f);
    expect(f.project.inputEmissionResult(next.draft_id).dispatch.state).toBe('queued');
    await changed(f, worker); await drain(f);
    expect(f.project.inputEmissionResult(exclusive.draft_id).dispatch.exclusive_active).toBe(true);
    await land(f, worker, f.project.inputRoot(worker)); await drain(f);
    expect(f.project.inputEmissionResult(exclusive.draft_id).dispatch.exclusive_active).toBe(false);
    expect(f.project.inputEmissionResult(next.draft_id).dispatch.state).toBe('succeeded');
  } finally { await f.close(); }
});

test('append drafts preserve mode and revision, reject attachments without consumption, and emit a numbered Message not Input', async () => {
  const f = await setup();
  try {
    const task = await order(f);
    let draft = await f.project.addBufferedDraft('later input', [reference], undefined, { mode: 'append', target_id: task.id });
    expect(draft).toMatchObject({ mode: 'append', target_id: task.id, target_worker_number: task.worker_number });
    await expect(f.project.emitBufferedInput({ draft_id: draft.id, expected_revision: 1 })).rejects.toThrow('references');
    expect(f.project.inputGet('draft', draft.id)).toMatchObject({ content: 'later input', references: [reference], dispatch: null });
    draft = await f.project.updateBufferedDraft(draft.id, 'correct input', [], undefined, 1);
    const result = await f.project.emitBufferedInput({ draft_id: draft.id, expected_revision: 2 });
    await expect(f.project.updateBufferedDraft(draft.id, 'overwrite', [], undefined, 2)).rejects.toThrow('mounted');
    await drain(f);
    const receipt = f.project.inputEmissionResult(result.draft_id).dispatch;
    expect(receipt).toMatchObject({ state: 'succeeded', worker_id: task.id }); expect(receipt.input_id).toBeUndefined();
    expect(receipt.append_number).toMatch(/^A/);
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
    expect(f.project.inputGet('draft', draft.id)).toMatchObject({ status: 'sent', dispatch: { message_id: receipt.message_id } });
  } finally { await f.close(); }
});

test('conditional append honors frozen inbox and target invalidation without waking or reviving a cancelled target', async () => {
  const f = await setup();
  try {
    const target = await order(f), blocker = settled(f, await order(f));
    f.store.update(target.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'resolving', parent_id: target.parent_id, attempt_id: 'test', commit: target.base_commit }) });
    const result = await f.project.emitBufferedInput({ mode: 'append', target_id: target.id, content: 'after blocker', conditions: [{ kind: 'worker_settled', worker_id: blocker.id }] });
    await drain(f);
    const receipt = f.project.inputEmissionResult(result.draft_id).dispatch;
    expect(receipt.state).toBe('succeeded');
    expect(f.store.get('SELECT delivery_hold FROM messages WHERE id=?', receipt.message_id).delivery_hold).toBe('frozen');
    const another = await f.project.emitBufferedInput({ mode: 'append', target_id: blocker.id, content: 'cancelled later', conditions: [{ kind: 'worker_settled', worker_id: target.id }] });
    f.store.update(blocker.id, { status: 'cancelled' }); await drain(f);
    expect(f.project.inputEmissionResult(another.draft_id).dispatch.state).toBe('failed');
    expect(f.store.task(blocker.id).status).toBe('cancelled');
  } finally { await f.close(); }
});

test('cancellation detaches condition Hooks and restores editable text, preserving version protection and keyed dedupe', async () => {
  const f = await setup();
  try {
    const source = await order(f);
    const result = await f.project.emitBufferedInput({ content: 'waiting', conditions: [{ kind: 'worker_settled', worker_id: source.id }], client_request_id: 'cancel-key' });
    expect(() => f.project.cancelInputEmission(result.draft_id, 3)).toThrow('changed');
    f.project.cancelInputEmission(result.draft_id, 1);
    expect(f.project.taskHooks(source.id).mounts.some(m => m.kind === 'input_signal')).toBe(false);
    await f.project.updateBufferedDraft(result.draft_id, 'edited', [], undefined, 1);
    const retry = await f.project.emitBufferedInput({ content: 'waiting', conditions: [{ kind: 'worker_settled', worker_id: source.id }], client_request_id: 'cancel-key' });
    expect(retry.dispatch.state).toBe('cancelled'); expect(f.store.all('SELECT * FROM drafts')).toHaveLength(1);
  } finally { await f.close(); }
});

test('unknown started dispatch survives restart without replay; unstarted mounted inputs resume exactly once', async () => {
  const f = await setup();
  try {
    const unknown = await f.project.emitBufferedInput({ content: 'unknown' });
    const raw = JSON.parse(f.store.draft(unknown.draft_id).emission);
    raw.state = 'dispatching'; raw.dispatch_id = 'crashed';
    f.store.run('UPDATE drafts SET emission=? WHERE id=?', JSON.stringify(raw), unknown.draft_id);
    const pending = await f.project.emitBufferedInput({ content: 'safe waiting' });
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root), project = new Project(f.config, reopened);
    project.stopping = true; project.kick = () => {};
    try {
      project.recoverInputEmissions();
      expect(project.inputEmissionResult(unknown.draft_id).dispatch.state).toBe('unknown');
      expect(() => project.cancelInputEmission(unknown.draft_id, 1)).toThrow('unknown');
      project.stopping = false; await project.drainInputEmissions(); project.stopping = true;
      expect(project.inputEmissionResult(pending.draft_id).dispatch.state).toBe('succeeded');
      expect(reopened.all('SELECT * FROM inputs')).toHaveLength(1);
    } finally { await project.shutdown(); reopened.close(); }
  } finally { await f.close(); }
});

test('queued creation rechecks parent after waiting for Git and never dispatches across a new invocation boundary', async () => {
  const f = await setup();
  try {
    const main = await f.project.ensureMainTask();
    const emission = await f.project.emitBufferedInput({ content: 'guarded' });
    const entered = gate(), release = gate();
    const anchorInput = f.project.anchorInput.bind(f.project);
    f.project.anchorInput = async (...args) => { entered.resolve(); await release.promise; return anchorInput(...args); };
    f.project.stopping = false;
    const job = f.project.drainInputEmissions(); await entered.promise;
    f.project.running.set(main.id, { controller: new AbortController(), parked: true }); release.resolve(); await job; f.project.stopping = true;
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('queued');
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    f.project.running.delete(main.id); await drain(f);
    expect(f.project.inputEmissionResult(emission.draft_id).dispatch.state).toBe('succeeded');
  } finally { await f.close(); }
});

test('real runtime dispatch creates and starts automatically without a parent model invocation', async () => {
  const f = fixture({ async run() { return 'safe answer'; } }); f.project.stopping = true; await repo(f.root);
  try {
    const receipt = await f.project.emitBufferedInput({ content: 'automatic', client_request_id: 'runtime-once' });
    expect(f.store.all('SELECT * FROM inputs')).toHaveLength(0);
    f.project.stopping = false; f.project.kick();
    await until(() => f.project.inputEmissionResult(receipt.draft_id).dispatch.state === 'succeeded');
    const worker = f.project.inputEmissionResult(receipt.draft_id).dispatch.worker_id;
    await until(() => f.store.task(worker).result && !f.project.running.has(worker));
    expect(f.store.task(worker).calls).toBe(1);
    expect(f.store.task(f.store.task(worker).parent_id).calls).toBe(0);
  } finally { await f.close(); }
});
