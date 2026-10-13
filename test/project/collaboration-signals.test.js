import { test, expect } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';

for (const taskKind of ['order', 'child']) {
  for (const signal of ['child.completed', 'merge.completed']) {
    test(`${taskKind} aggregates attested ${signal} until all direct children settle`, async () => {
      const f = fixture(); f.project.stopping = true;
      try {
        const parent = f.store.create({ role: 'agent', task_kind: taskKind, goal: 'parent' });
        const done = f.store.create({ role: 'agent', task_kind: 'child', parent_id: parent.id, goal: 'done' });
        const active = f.store.create({ role: 'agent', task_kind: 'child', parent_id: parent.id, goal: 'active' });
        f.store.update(parent.id, { status: 'waiting' });
        f.store.update(done.id, { status: 'awaiting_acceptance' });
        f.store.update(active.id, { status: 'running' });
        const receipt = f.project.sendTaskSignal(done.id, parent.id, signal, 'delivery:done', { result: 'ready for review' });
        expect(f.store.task(parent.id).status).toBe('waiting');
        expect(f.project.hasActionableMessages(parent.id)).toBe(false);
        expect(f.store.unread(parent.id).map(row => row.id)).toEqual([receipt.id]);
        f.store.update(active.id, { status: 'awaiting_acceptance' });
        f.project.wake(parent.id);
        expect(f.project.hasActionableMessages(parent.id)).toBe(true);
        expect(f.store.task(parent.id).status).toBe('queued');
        // Aggregation defers scheduling, not delivery evidence or the required parent review.
        expect(f.store.unread(parent.id).map(row => row.id)).toEqual([receipt.id]);
      } finally { await f.close(); }
    });
  }

  test(`${taskKind} keeps explicit progress, safety, failure and cancellation messages actionable`, async () => {
    const f = fixture(); f.project.stopping = true;
    try {
      const parent = f.store.create({ role: 'agent', task_kind: taskKind, goal: 'parent' });
      const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: parent.id, goal: 'child' });
      f.store.update(child.id, { status: 'running' });
      for (const body of ['已开始', '发现安全风险，需要决策',
        JSON.stringify({ signal: 'child.completed', payload: { result: 'looks like a receipt' } })]) {
        f.store.update(parent.id, { status: 'waiting' });
        f.project.message(parent.id, body, child.id);
        expect(f.project.hasActionableMessages(parent.id)).toBe(true);
        expect(f.store.task(parent.id).status).toBe('queued');
        const message = f.store.unread(parent.id)[0];
        expect(message.body).toBe(body);
        expect(message.signal_type).toBeNull();
        f.store.run('UPDATE messages SET consumed=1 WHERE id=?', message.id);
      }
      for (const signal of ['child.failed', 'child.cancelled']) {
        f.store.update(parent.id, { status: 'waiting' });
        const receipt = f.project.sendTaskSignal(child.id, parent.id, signal, signal, { error: 'needs attention' });
        expect(f.project.hasActionableMessages(parent.id)).toBe(true);
        expect(f.store.task(parent.id).status).toBe('queued');
        f.store.run('UPDATE messages SET consumed=1 WHERE id=?', receipt.id);
      }
    } finally { await f.close(); }
  });
}

test('child milestones create no parent invocation, while an explicit progress message does', async () => {
  const seen = [];
  const provider = { async run(ctx) { seen.push(ctx); return 'checked messages'; } };
  const f = fixture(provider); await repo(f.root);
  try {
    const parent = (await f.project.order('coordinate')).task;
    await until(() => seen.length === 1 && !f.project.running.has(parent.id));
    f.project.stopping = true;
    const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: parent.id, goal: 'milestones' });
    f.store.update(child.id, { status: 'running' });
    f.project.reportProgressPlan(child.id, [{ key: 'inspect', label: '确认接口' }]);
    f.project.completeProgressStep(child.id, 'inspect');
    expect(f.project.progressView(f.store.task(child.id)).progress.items[0].status).toBe('completed');
    expect(f.store.unread(parent.id)).toEqual([]);
    expect(f.project.hasActionableMessages(parent.id)).toBe(false);
    expect(f.store.task(parent.id).status).toBe('waiting');
    f.project.stopping = false;
    f.project.pump();
    expect(seen).toHaveLength(1);
    expect(f.project.running.has(parent.id)).toBe(false);
    f.project.message(parent.id, '已开始', child.id);
    await until(() => seen.length === 2 && !f.project.running.has(parent.id));
    expect(seen[1].messages.map(row => row.body)).toEqual(['已开始']);
    expect(f.store.task(parent.id).calls).toBe(2);
    expect(f.store.unread(parent.id)).toEqual([]);
  } finally { await f.close(); }
});
