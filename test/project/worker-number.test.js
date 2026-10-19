import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
setDefaultTimeout(30000);

test('order RPC numbers are independent of Inputs and delegated generations keep their own sequence', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const id = f.store.nextInputId();
    f.store.run('INSERT INTO inputs(id,content) VALUES (?,?)', id, 'existing history');
    const rpc = new Dispatcher(f.project);
    const first = await rpc.dispatch('order.submit', { content: 'first', start: false });
    expect(first.task.worker_number).toBe('W1');
    expect(first.task.worker_number).not.toBe(`W${first.id}`);
    expect((await rpc.dispatch('worker.lookup', { number: 'W1' })).id).toBe(first.task.id);
    const siblings = await Promise.all([f.project.spawn(first.task.id, 'child one'), f.project.spawn(first.task.id, 'child two')]);
    expect(siblings.map(row => row.worker_number)).toEqual(['W1-1', 'W1-2']);
    const grandchild = await f.project.spawn(siblings[0].id, 'grandchild');
    expect(grandchild.worker_number).toBe('W1-1-1');
    const next = await rpc.dispatch('order.submit', { content: 'new user order', branch: first.task.branch, start: false });
    expect(next.task.worker_number).toBe('W2');
    expect(next.task.parent_id).toBe(first.task.id);
  } finally { await f.close(); }
});
