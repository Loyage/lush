import { test, expect } from 'bun:test';
import { fixture, repo, git } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

test('showcase runtime and reservation APIs are removed without changing merge or Git state', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const order = await f.project.order('ordinary work');
    const head = await git(f.root, 'rev-parse', 'main');
    const count = f.store.all('SELECT id FROM tasks').length;
    const rpc = new Dispatcher(f.project);
    await expect(rpc.dispatch('worker.reserve', { id: order.task.id, kind: 'showcase' })).rejects.toThrow('only merge delivery is supported');
    for (const method of ['showcase.start', 'showcase.list', 'showcase.preview', 'showcase.stop', 'branch.reserve_showcase'])
      await expect(rpc.dispatch(method, { id: order.task.id, branch: order.task.branch })).rejects.toThrow('unknown method');
    for (const method of ['bookShowcase', 'signalReservedShowcase', 'startReservedShowcase', 'settleReservedShowcase',
      'startShowcase', 'showcaseEligibility', 'reserveShowcase', 'showcases', 'startShowcasePreview', 'retryShowcase'])
      expect(f.project[method]).toBeUndefined();
    expect(f.store.all('SELECT id FROM tasks')).toHaveLength(count);
    expect(f.store.task(order.task.id).reservation).toBeNull();
    expect(await git(f.root, 'rev-parse', 'main')).toBe(head);
    const graph = await f.project.graph();
    expect(graph.nodes.filter(node => node.kind === 'branch').every(node => !('showcase' in node))).toBe(true);
    expect((await f.project.reserveTask(order.task.id, 'merge')).reservation.kind).toBe('merge');
  } finally { await f.close(); }
});

test('historical showcase rows remain readable but never schedule or retry a provider', async () => {
  let calls = 0;
  const f = fixture({ run: async () => { calls++; return 'unexpected'; } });
  f.project.stopping = true;
  try {
    // Import historical storage directly: no public API can create this role anymore.
    f.store.run("INSERT INTO tasks(id,role,goal,task_kind,showcase,status) VALUES (100,'showcase','old report','showcase',?,'queued')",
      JSON.stringify({ branch: 'old-feature', commit: 'a'.repeat(40) }));
    const original = f.store.task(100);
    f.project.stopping = false;
    f.project.pump();
    expect(calls).toBe(0);
    expect(f.store.task(100)).toEqual(original);
    expect(f.project.inspect(100)).toMatchObject({ id: 100, role: 'showcase', report: null });
    f.store.update(100, { status: 'failed' });
    const failed = f.store.task(100);
    expect(() => f.project.retry(100)).toThrow('functionality has been removed');
    expect(f.store.task(100)).toEqual(failed);
  } finally { await f.close(); }
});
