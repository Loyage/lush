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

test('persistent sibling high-water survives deletion, reopen, parent deletion and purge; identity stays immutable', async () => {
  const f = fixture(); f.project.stopping = true;
  let other;
  try {
    const parent = f.store.create({ input_id: input(f.store), role: 'agent', task_kind: 'order', goal: 'parent' });
    const a = child(f.store, parent), b = child(f.store, parent);
    f.store.update(b.id, { status: 'failed', error: 'fork failed' });
    f.store.hardDeleteTasks([b.id]);
    expect(() => f.store.lookupWorker(b.worker_number)).toThrow('not found');
    other = new Store(path.join(f.config.home, 'project.db'), f.root);
    const c = child(other, parent);
    expect(c.worker_number).toBe(`${parent.worker_number}-3`);
    expect(() => other.update(c.id, { worker_number: 'W999' })).toThrow('invalid task patch');
    expect(() => other.run('UPDATE tasks SET worker_number=? WHERE id=?', a.worker_number, c.id)).toThrow('UNIQUE');
    expect(() => other.create({ input_id: parent.input_id, role: 'agent', task_kind: 'order', goal: 'duplicate root' })).toThrow('UNIQUE');
    expect(child(other, parent).worker_number).toBe(`${parent.worker_number}-4`);
    f.store.hardDeleteTasks(f.store.tasks().map(row => row.id), [parent.input_id]);
    expect(f.store.get('SELECT value FROM meta WHERE key=?', `worker_child_high:${parent.id}`).value).toBe('4');
    f.store.purge();
    expect(f.store.get('SELECT value FROM meta WHERE key=?', `worker_child_high:${parent.id}`).value).toBe('4');
    const newRoot = other.create({ input_id: input(other), role: 'agent', task_kind: 'order', goal: 'new root' });
    expect(newRoot.id).toBeGreaterThan(c.id);
    expect(newRoot.worker_number).not.toBe(parent.worker_number);
  } finally { other?.close(); await f.close(); }
});

test('old schema upgrades without renaming or backfilling historical Workers or their new descendants', async () => {
  const f = fixture(); f.project.stopping = true;
  let reopened;
  try {
    const inputId = input(f.store);
    f.store.run("INSERT INTO tasks(id,input_id,role,goal,name,task_kind,branch,workspace) VALUES (99,?,'agent','old','old-name','order','legacy-branch','/old/worktree')", inputId);
    f.store.run('DROP INDEX tasks_worker_number');
    f.store.run('ALTER TABLE tasks DROP COLUMN worker_number');
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    const old = reopened.task(99);
    expect(old).toMatchObject({ worker_number: null, name: 'old-name', branch: 'legacy-branch', workspace: '/old/worktree' });
    const freshChild = child(reopened, old);
    expect(freshChild.worker_number).toBeNull();
    expect(child(reopened, freshChild).worker_number).toBeNull();
    const freshOrder = reopened.create({ parent_id: old.id, input_id: input(reopened), role: 'agent', task_kind: 'order', goal: 'new input' });
    expect(freshOrder.worker_number).toBe(`W${freshOrder.input_id}`);
    expect(reopened.task(old.id)).toEqual(old);
    expect(reopened.get('SELECT value FROM meta WHERE key=?', `worker_child_high:${old.id}`)).toBeNull();
  } finally { reopened?.close(); await f.close(); }
});

test('a created child whose Git fork fails consumes its number, while a rolled-back insertion does not leak a Worker', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const root = (await f.project.order('parent', null, [], null, false)).task;
    const fork = f.project.workspaces.forkTaskUnsafe;
    f.project.workspaces.forkTaskUnsafe = async () => { throw new Error('synthetic Git failure'); };
    await expect(f.project.spawn(root.id, 'fails')).rejects.toThrow('fork failed');
    const failed = f.store.children(root.id)[0];
    expect(failed).toMatchObject({ status: 'failed', worker_number: `${root.worker_number}-1` });
    f.project.workspaces.forkTaskUnsafe = fork;
    expect((await f.project.spawn(root.id, 'works')).worker_number).toBe(`${root.worker_number}-2`);
    const before = f.store.tasks().length;
    expect(() => f.store.create({ parent_id: root.id, input_id: 987654, task_kind: 'child', role: 'agent', goal: 'bad FK' })).toThrow('FOREIGN KEY');
    expect(f.store.tasks().length).toBe(before);
    expect((await f.project.spawn(root.id, 'after rollback')).worker_number).toBe(`${root.worker_number}-3`);
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
    f.project.running.set(task.id, { controller: new AbortController() });
    expect(await rpc.dispatch('worker.lookup', { number: ownChild.worker_number, _token: token })).toEqual({ id: ownChild.id, worker_number: ownChild.worker_number });
    await expect(rpc.dispatch('worker.spawn', { parent: ownChild.id, goal: 'not own', _token: token })).rejects.toThrow('own worker');
    await expect(rpc.dispatch('worker.cancel', { id: ownChild.id, _token: token })).rejects.toThrow('requires user approval');
    f.project.running.delete(task.id);
    await expect(rpc.dispatch('worker.lookup', { number: ownChild.worker_number, _token: token })).rejects.toThrow('invalid or expired');
  } finally { f.project.running.clear(); await f.close(); }
});

test('Worker read models expose numbers while references and association identities remain integers', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const task = (await f.project.order('parent', null, [], null, false)).task;
    const offspring = await f.project.spawn(task.id, 'child');
    const rpc = new Dispatcher(f.project);
    for (const method of ['worker.list','worker.activity','worker.graph']) {
      const result = await rpc.dispatch(method);
      const rows = Array.isArray(result) ? result : result.tasks ?? result.nodes;
      expect(rows.find(row => row.id === offspring.id).worker_number).toBe(offspring.worker_number);
    }
    expect((await rpc.dispatch('worker.tree', { id: task.id })).children[0]).toMatchObject({ worker_number: offspring.worker_number,
      parent_worker_number: task.worker_number });
    expect((await rpc.dispatch('worker.inspect', { id: offspring.id })).parent_worker_number).toBe(task.worker_number);
    expect((await rpc.dispatch('worker.inspect', { id: task.id })).children[0]).toMatchObject({ worker_number: offspring.worker_number,
      parent_worker_number: task.worker_number });
    expect(agentView(offspring).task_worker_number).toBe(offspring.worker_number);
    expect((await rpc.dispatch('worker.activity')).tasks.find(row => row.id === offspring.id).parent_worker_number).toBe(task.worker_number);
    f.store.update(offspring.id, { status: 'completed' });
    expect((await rpc.dispatch('worker.page')).tasks.find(row => row.id === offspring.id)).toMatchObject({ worker_number: offspring.worker_number,
      parent_worker_number: task.worker_number });
    const context = await f.project.invocationContext(offspring, { recordId: 1 });
    expect(context.parent.worker_number).toBe(task.worker_number);
    expect((await f.project.invocationContext(task, { recordId: 1 })).children[0].worker_number).toBe(offspring.worker_number);
    expect((await f.project.inputParents()).items.find(row => row.id === task.id).worker_number).toBe(task.worker_number);
    expect(f.project.inputGet('input', task.input_id).task_worker_number).toBe(task.worker_number);
    const draft = await f.project.addBufferedDraft('draft', [], task.branch);
    expect(draft.parent_worker_number).toBe(task.worker_number);
    const notice = f.project.notify(task.id, 'new notice');
    expect(notice.task_worker_number).toBe(task.worker_number);
    expect((await rpc.dispatch('notice.page')).notices.find(row => row.id === notice.id).task_worker_number).toBe(task.worker_number);
    const messageId = f.store.message(task.id, 'body unchanged', offspring.id);
    expect(f.project.inspect(task.id).messages.find(row => row.id === messageId)).toMatchObject({ sender_id: offspring.id,
      sender_worker_number: offspring.worker_number, task_worker_number: task.worker_number, body: 'body unchanged' });
    f.store.event(task.id, 'task.signal', { message_id: messageId });
    expect(f.store.history(task.id).find(row => row.data.message_id === messageId).message.sender_worker_number).toBe(offspring.worker_number);
    const snapshot = { kind: 'task', target: { task_id: task.id }, label: `old #${task.id}`, quote: 'parent', location: { task_id: task.id } };
    const referenced = await f.project.order('referenced', null, [snapshot], null, false);
    const resolved = await f.project.resolveInputReferences(referenced.id);
    expect(resolved[0].reference.label).toBe(snapshot.label);
    expect(resolved[0].reference.target.task_id).toBe(task.id);
    expect(resolved[0].current.worker_number).toBe(task.worker_number);
    expect(f.store.inputReferences(referenced.id)[0].label).toBe(snapshot.label);
    f.store.update(offspring.id, { status: 'cancelled' });
    expect((await f.project.deleteTaskPreview(offspring.id)).workers[0].worker_number).toBe(offspring.worker_number);
  } finally { await f.close(); }
});
