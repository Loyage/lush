import { test, expect } from 'bun:test';
import { fixture, repo } from './helpers.js';
import { branchFreeze } from '../src/core/branch-freeze.js';

function bindLegacy(store, workerId) {
  store.run('CREATE TABLE runner_bindings(worker_id INTEGER PRIMARY KEY)');
  store.run('INSERT INTO runner_bindings VALUES (?)', workerId);
}

test('retired serial reservations freeze only their source unless a parent landing receipt survives', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    await repo(f.root);
    const { task } = await f.project.order('retired serial source', null, [], null, false);
    bindLegacy(f.store, task.id);
    for (const version of [1, 2]) for (const status of ['requested', 'executing', 'resolving', 'blocked']) {
      if (version === 1 && status !== 'requested') continue;
      for (const receipt of [false, true]) {
        const request = { version, kind: 'merge', status, parent_id: task.parent_id,
          ...(version === 2 ? { queue_protocol: 1 } : {}),
          ...(receipt ? { landing_receipt: { source: task.base_commit, commit: 'a'.repeat(40) } } : {}) };
        f.store.run('UPDATE tasks SET reservation=? WHERE id=?', JSON.stringify(request), task.id);
        const before = f.store.task(task.id);
        const freezes = branchFreeze(f.store);
        expect(freezes.get(task.branch)?.kind).toBe('retired_execution');
        expect(freezes.has('main')).toBe(receipt);
        if (receipt) expect(freezes.get('main').reason).toContain('不会重放');
        expect(f.store.task(task.id)).toEqual(before);
      }
    }
  } finally { await f.close(); }
});

test('retired convergence membership releases unwritten parent ownership, not recorded or missing landing evidence', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    await repo(f.root);
    const { task: old } = await f.project.order('retired convergence member', null, [], null, false);
    const { task: local } = await f.project.order('local convergence member', null, [], null, false);
    const run = f.store.createDeliveryRun({ parent_id: old.parent_id, target_branch: 'main', baseline: old.base_commit,
      members: [old, local].map((task, index) => ({ task_id: task.id, delivery_id: index + 1, enqueue_seq: index + 1,
        source_branch: task.branch, source_commit: task.base_commit })), data: { verification_mode: 'agent' } });
    const request = { version: 3, kind: 'merge', status: 'executing', parent_id: old.parent_id, run_id: run.id, generation: run.generation };
    for (const task of [old, local]) f.store.update(task.id, { reservation: JSON.stringify(request) });
    bindLegacy(f.store, old.id);
    expect(branchFreeze(f.store).has('main')).toBe(false);
    expect(branchFreeze(f.store).get(local.branch)?.kind).toBe('retired_execution');
    // State alone is intent: the protocol persists a receipt before touching parent Git.
    f.store.run("UPDATE delivery_runs SET state='landing' WHERE id=?", run.id);
    expect(branchFreeze(f.store).has('main')).toBe(false);
    // A retained receipt may represent publication whose ACK was lost.
    f.store.run('UPDATE delivery_runs SET landing_receipt=? WHERE id=?', JSON.stringify({ commit: 'b'.repeat(40) }), run.id);
    const before = f.store.deliveryRun(run.id);
    expect(branchFreeze(f.store).get('main')?.kind).toBe('retired_execution');
    expect(f.store.deliveryRun(run.id)).toEqual(before);
    // A run belonging to another parent is not evidence about this parent.
    f.store.run("UPDATE delivery_runs SET parent_id=?,state='ready',landing_receipt=NULL WHERE id=?", local.id, run.id);
    expect(branchFreeze(f.store).get('main')?.kind).toBe('retired_execution');
    // Missing or malformed old run evidence must not authorize a competing writer.
    for (const run_id of [run.id + 100, undefined, 'malformed']) {
      for (const task of [old, local]) f.store.run('UPDATE tasks SET reservation=? WHERE id=?', JSON.stringify({ ...request, run_id }), task.id);
      expect(branchFreeze(f.store).get('main')?.kind).toBe('retired_execution');
    }
  } finally { await f.close(); }
});
