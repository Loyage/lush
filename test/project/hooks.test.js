import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { attachRegisteredHook } from '../hook-registry.js';
setDefaultTimeout(20000);

test('persistent notification Hook mounts, evaluates its condition and deduplicates a source event', async () => {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  try {
    const order = await f.project.order('job', 'main', [], null, false);
    attachRegisteredHook(f.project, order.task.id, { name: '告知', trigger: 'agent.returned', mode: 'persistent', enabled: true,
      conditions: { statuses: ['paused'] }, actions: [{ type: 'notify', title: 'hook-test', body: 'done' }] });
    const source = f.store.event(order.task.id, 'test.returned', {});
    f.project.emitTaskHook(order.task.id, 'agent.returned', source); await f.project.hookQueue;
    f.project.emitTaskHook(order.task.id, 'agent.returned', source); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(1);
    f.store.update(order.task.id, { status: 'waiting' });
    f.project.emitTaskHook(order.task.id, 'agent.returned'); await f.project.hookQueue;
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='hook-test'").n).toBe(1);
  } finally { await f.close(); }
});
