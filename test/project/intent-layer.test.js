import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';

function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once:true });
    return done.promise;
  } };
}

test('raw Intent persists, planner stays in control plane, and mock Plan compiles without scheduler', async () => {
  const f = fixture(); await repo(f.root);
  try {
    const input = await f.project.submit('  原话\n保留  ');
    expect(input.content).toBe('  原话\n保留  ');
    await until(() => f.store.ap(input.ap.id).status === 'completed');
    await until(() => f.store.specs({ planner_ap_id: input.ap.id })[0]?.status === 'planned');
    expect(f.store.children(input.ap.id)).toEqual([]);
    expect(f.store.ap(input.ap.id).layer).toBe('intent');
    expect(f.store.get("SELECT count(*) AS n FROM aps WHERE role='scheduler'").n).toBe(0);
    const work = f.store.summaries('work');
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ role: 'research', input_id: input.id, parent_id: null });
    expect(f.project.tree().map(ap => ap.id)).toEqual([work[0].id]);
    expect(f.project.inputs()[0]).toMatchObject({ id: input.id, ap_id: input.ap.id, specs_planned: 1,
      scheduler_id: null, scheduler_status: null, work_aps: 1 });
  } finally { await f.close(); }
});

test('planner is hidden from execution tree while compiled root work remains visible', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '4' }); await repo(f.root);
  try {
    const planner = (await f.project.submit('做一件事')).ap;
    const spec = f.project.addSpec(planner.id, { goal: '写点东西', role: 'worker', name: 'write-something' });
    await until(() => provider.calls.some(call => call.ap.id === planner.id));
    provider.calls.find(call => call.ap.id === planner.id).done.resolve('planned');
    await until(() => f.store.spec(spec.id).status === 'planned');
    const worker = f.store.ap(f.store.spec(spec.id).ap_id);
    expect(worker.parent_id).toBeNull();
    expect(f.project.tree().map(ap => ap.id)).toEqual([worker.id]);
    expect(f.store.summaries('intent').map(ap => ap.id)).toContain(planner.id);
    expect(f.store.summaries('work').map(ap => ap.id)).toContain(worker.id);
    expect(f.project.inspect(planner.id).layer).toBe('intent');
    expect(f.project.timeline().aps.map(ap => ap.role)).not.toContain('planner');
    expect(f.project.inputs()[0]).toMatchObject({ ap_id: planner.id, specs_pending: 0, specs_planned: 1,
      scheduler_id: null, scheduler_status: null, work_aps: 1 });
  } finally { await f.close(); }
});
