import { test, expect } from 'bun:test';
import { fixture, gate, until, repo } from '../helpers.js';

test('草稿引用随输入持久化，并将快照与当前状态注入真实调用上下文', async () => {
  const entered = gate(), finish = gate();
  const f = fixture({ async run(options) { entered.resolve(options); await finish.promise; return 'done'; } });
  await repo(f.root);
  try {
    const target = f.store.create({ role: 'agent', goal: '研究 Web UI' });
    f.store.update(target.id, { status: 'completed', result: '现有结论' });
    const reference = { version: 1, kind: 'task', target: { task_id: target.id }, label: '引用任务', quote: target.goal,
      location: { view: 'task-tree', task_id: target.id }, captured_at: '2026-01-01T00:00:00.000Z' };
    const draft = f.project.draft('请解释这一项', [reference]);
    expect(f.project.drafts()[0].references).toHaveLength(1);
    const order = await f.project.order(undefined, null, [], draft.id);
    const call = await entered.promise;
    expect(f.project.inputGet('input', order.id).references).toMatchObject([{ segment: 1, quote: target.goal }]);
    expect(call.context.referenced_context).toHaveLength(1);
    expect(call.context.referenced_context[0]).toMatchObject({ reference: { quote: target.goal }, current: { result: '现有结论' }, stale: false });
    finish.resolve(); await until(() => !f.project.running.has(order.task.id));
  } finally { finish.resolve(); await f.close(); }
});
