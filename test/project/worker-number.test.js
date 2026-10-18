import { test, expect, setDefaultTimeout } from 'bun:test';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { tokenHash, agentView } from '../../src/core/project/internal.js';
import { workerNumber } from '../../src/core/worker-number.js';
setDefaultTimeout(30000);

function input(store) {
  const id = store.nextInputId();
  store.run('INSERT INTO inputs(id,content) VALUES (?,?)', id, `input ${id}`);
  return id;
}
const child = (store, parent) => store.create({ parent_id: parent.id, input_id: parent.input_id,
  role: 'agent', task_kind: 'child', goal: 'child' });

test('orders follow Inputs, concurrent siblings are unique, and each generation has its own sequence', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const first = await f.project.order('first', null, [], null, false);
    expect(first.task.worker_number).toBe(`W${first.id}`);
    expect(f.store.task(first.task.parent_id).worker_number).toBeNull();
    expect(first.task.id).not.toBe(first.id); // Never confuse the two namespaces.
    const siblings = await Promise.all(Array.from({ length: 12 }, (_, i) => f.project.spawn(first.task.id, `child ${i}`, undefined, [], `child-${i}`)));
    expect(siblings.map(row => row.worker_number)).toEqual(Array.from({ length: 12 }, (_, i) => `${first.task.worker_number}-${i + 1}`));
    expect(new Set(siblings.map(row => row.worker_number)).size).toBe(12);
    const grandchildren = await Promise.all([f.project.spawn(siblings[0].id, 'grandchild'), f.project.spawn(siblings[1].id, 'other grandchild')]);
    expect(grandchildren.map(row => row.worker_number)).toEqual([`${first.task.worker_number}-1-1`, `${first.task.worker_number}-2-1`]);
    const great = await f.project.spawn(grandchildren[0].id, 'great grandchild');
    expect(great.worker_number).toBe(`${first.task.worker_number}-1-1-1`);
    const next = await f.project.order('new user order on existing Worker', first.task.branch, [], null, false);
    expect(next.task.worker_number).toBe(`W${next.id}`);
    expect(next.task.parent_id).toBe(first.task.id);
    expect(next.task.worker_number).not.toContain('-');
    expect(siblings.every(row => row.branch.includes(String(row.id)) && !row.branch.includes(row.worker_number))).toBe(true);
  } finally { await f.close(); }
});

test('lookup is strict, read-only and does not alter original integer RPC authority or Artifact IDs', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const task = (await f.project.order('parent', null, [], null, false)).task;
    const ownChild = await f.project.spawn(task.id, 'child');
    const rpc = new Dispatcher(f.project);
    expect(await rpc.dispatch('worker.lookup', { number: ownChild.worker_number })).toEqual({ id: ownChild.id, worker_number: ownChild.worker_number });
    expect((await rpc.dispatch('worker.inspect', { id: ownChild.id })).id).toBe(ownChild.id);
    const revision = f.project.overviewRevision();
    await rpc.dispatch('worker.lookup', { number: ownChild.worker_number });
    expect(f.project.overviewRevision()).toBe(revision);
    for (const number of ['W0','W01','w1','W1-0','W1-01','W1--1','W1-','W9007199254740992','W1-9007199254740992', '1', 'W1\n', 1, null]) {
      expect(() => workerNumber(number)).toThrow('worker number');
      await expect(rpc.dispatch('worker.lookup', { number })).rejects.toThrow('worker number');
    }
    await expect(rpc.dispatch('worker.lookup', { number: 'W999999' })).rejects.toThrow('not found');
    await expect(rpc.dispatch('worker.lookup', { number: task.worker_number, id: task.id })).rejects.toThrow('unknown parameter');
    await expect(rpc.dispatch('worker.inspect', { id: task.worker_number })).rejects.toThrow('positive integer');
    await expect(rpc.dispatch('worker.artifact', { id: task.worker_number })).rejects.toThrow('positive integer');
    const token = 'fixture-agent';
    f.store.update(task.id, { status: 'running' }); f.store.armAgent(task.id, tokenHash(token));
    f.project.running.set(task.id, { token, controller: new AbortController() });
    expect(await rpc.dispatch('worker.lookup', { number: ownChild.worker_number, _token: token })).toEqual({ id: ownChild.id, worker_number: ownChild.worker_number });
    await expect(rpc.dispatch('worker.spawn', { parent: ownChild.id, goal: 'not own', _token: token })).rejects.toThrow('own worker');
    await expect(rpc.dispatch('worker.cancel', { id: ownChild.id, _token: token })).rejects.toThrow('requires user approval');
    f.project.running.delete(task.id);
    await expect(rpc.dispatch('worker.lookup', { number: ownChild.worker_number, _token: token })).rejects.toThrow('invalid or expired');
  } finally { f.project.running.clear(); await f.close(); }
});
