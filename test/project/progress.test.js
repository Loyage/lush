import { test, expect } from 'bun:test';
import { fixture, gate, repo, until } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';

test('live invocation plans, completes and replans progress while retaining completed stable keys', async () => {
  const entered = gate(), finish = gate();
  const f = fixture({ async run() { entered.resolve(); await finish.promise; return 'done'; } });
  await repo(f.root);
  try {
    const task = (await f.project.order('coordinate progress')).task;
    await entered.promise;
    const token = f.project.running.get(task.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    const planned = await rpc.dispatch('progress.plan', { _token: token, steps: [
      { key: 'inspect', label: '确认现状' }, { key: 'implement', label: '实现' },
    ] });
    expect(planned).toMatchObject({ task_id: task.id, progress: { version: 1 } });
    const completed = await rpc.dispatch('progress.complete', { _token: token, step: 'inspect' });
    expect(completed.progress.items[0]).toMatchObject({ key: 'inspect', status: 'completed' });
    expect(completed.progress.items[0].duration_ms).toBeGreaterThanOrEqual(0);
    await rpc.dispatch('progress.plan', { _token: token, steps: [
      { key: 'inspect', label: '复核现状' }, { key: 'test', label: '测试' },
    ] });
    expect(f.project.inspect(task.id).progress.items).toMatchObject([
      { key: 'inspect', label: '复核现状', status: 'completed', completed_at: completed.progress.items[0].completed_at },
      { key: 'test', status: 'pending' },
    ]);
    expect(f.store.history(task.id, 0).map(event => event.type)).toContain('progress.completed');
    finish.resolve(); await until(() => !f.project.running.has(task.id));
  } finally { finish.resolve(); await f.close(); }
});
