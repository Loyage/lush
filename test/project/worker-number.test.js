import { test, expect, setDefaultTimeout } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { fixture, repo, temp } from '../helpers.js';
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

test('order RPC numbers are independent of Inputs, concurrent siblings are unique, and generations keep their own sequence', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    input(f.store); input(f.store); // Existing input history must not control the W sequence.
    const rpc = new Dispatcher(f.project);
    const first = await rpc.dispatch('order.submit', { content: 'first', start: false });
    expect(first.task.worker_number).toBe('W1');
    expect(first.task.worker_number).not.toBe(`W${first.id}`);
    expect((await rpc.dispatch('worker.lookup', { number: 'W1' })).id).toBe(first.task.id);
    expect(f.store.task(first.task.parent_id).worker_number).toBeNull();
    expect(first.task.id).not.toBe(first.id); // Never confuse the two namespaces.
    const siblings = await Promise.all(Array.from({ length: 12 }, (_, i) => f.project.spawn(first.task.id, `child ${i}`, undefined, [], `child-${i}`)));
    expect(siblings.map(row => row.worker_number)).toEqual(Array.from({ length: 12 }, (_, i) => `${first.task.worker_number}-${i + 1}`));
    expect(new Set(siblings.map(row => row.worker_number)).size).toBe(12);
    const grandchildren = await Promise.all([f.project.spawn(siblings[0].id, 'grandchild'), f.project.spawn(siblings[1].id, 'other grandchild')]);
    expect(grandchildren.map(row => row.worker_number)).toEqual([`${first.task.worker_number}-1-1`, `${first.task.worker_number}-2-1`]);
    const great = await f.project.spawn(grandchildren[0].id, 'great grandchild');
    expect(great.worker_number).toBe(`${first.task.worker_number}-1-1-1`);
    const next = await rpc.dispatch('order.submit', { content: 'new user order on existing Worker', branch: first.task.branch, start: false });
    expect(next.task.worker_number).toBe('W2');
    expect(next.task.parent_id).toBe(first.task.id);
    expect(next.task.worker_number).not.toContain('-');
    expect(siblings.every(row => row.branch.includes(String(row.id)) && !row.branch.includes(row.worker_number))).toBe(true);
  } finally { await f.close(); }
});

const order = (store, extra = {}) => store.create({ role: 'agent', task_kind: 'order', goal: 'order', ...extra });
const legacy = (store, number, kind = 'say') => {
  const task = store.create({ role: 'agent', goal: 'historical' });
  store.run('UPDATE tasks SET worker_number=?,task_kind=? WHERE id=?', number, kind, task.id);
  return store.task(task.id);
};
const high = store => store.get("SELECT value FROM meta WHERE key='worker_number_high'")?.value ?? null;

test('orders without an Input or sharing an Input always get fresh W numbers; child and Valet sequences stay independent', async () => {
  const f = fixture();
  try {
    const first = order(f.store);
    const second = order(f.store, { input_id: null });
    const inputId = input(f.store);
    const third = order(f.store, { input_id: inputId });
    const fourth = order(f.store, { input_id: inputId, parent_id: first.id });
    expect([first, second, third, fourth].map(row => row.worker_number)).toEqual(['W1','W2','W3','W4']);
    expect(first.input_id).toBeNull(); expect(second.input_id).toBeNull();
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
    const firstChild = child(f.store, first);
    expect(firstChild.worker_number).toBe('W1-1');
    f.store.deleteTasks([firstChild.id]);
    const db = new Store(path.join(f.config.home, 'project.db'), f.root);
    try {
      expect(child(db, first).worker_number).toBe('W1-2');
      expect(child(db, second).worker_number).toBe('W2-1');
      expect(db.create({ role: 'manager', task_kind: 'management', goal: 'Valet' }).worker_number).toBe('V1');
      expect(order(db).worker_number).toBe('W5');
      expect(db.create({ role: 'manager', task_kind: 'management', goal: 'Valet' }).worker_number).toBe('V2');
      expect(high(db)).toBe('5');
    } finally { db.close(); }
  } finally { await f.close(); }
});

test('concurrent order submissions allocate unique monotonic top-level numbers through the existing RPC', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    input(f.store); input(f.store);
    await f.project.ensureMainTask(); // Isolate allocation from the existing first-main bootstrap race.
    const rpc = new Dispatcher(f.project);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      rpc.dispatch('order.submit', { content: `concurrent ${i}`, start: false })));
    expect(results.map(row => Number(row.task.worker_number.slice(1))).sort((a, b) => a - b)).toEqual([1,2,3,4,5,6]);
    expect(new Set(results.map(row => row.task.worker_number)).size).toBe(6);
    expect(high(f.store)).toBe('6');
    expect(results.every(row => row.task.input_id === row.id)).toBe(true);
  } finally { await f.close(); }
});

test('old databases keep historical NULLs and numbers untouched and reserve child W prefixes conservatively', () => {
  const root = temp(), file = path.join(root, 'legacy.db');
  let db = new Store(file, root);
  try {
    const unnumbered = legacy(db, null);
    // Model a database predating worker_number; the normal open adds only a nullable column.
    db.run('DROP INDEX tasks_worker_number');
    db.run('ALTER TABLE tasks DROP COLUMN worker_number');
    db.close(); db = new Store(file, root);
    expect(db.task(unnumbered.id).worker_number).toBeNull();
    expect(child(db, db.task(unnumbered.id)).worker_number).toBeNull();
    const old = legacy(db, 'W19');
    const orphan = legacy(db, 'W90-8-3', 'child');
    const snapshot = db.all('SELECT id,worker_number,task_kind FROM tasks ORDER BY id');
    db.close(); db = new Store(file, root);
    expect(db.all('SELECT id,worker_number,task_kind FROM tasks ORDER BY id')).toEqual(snapshot);
    expect(high(db)).toBeNull();
    expect(order(db).worker_number).toBe('W91');
    expect(db.task(old.id).worker_number).toBe('W19');
    expect(db.task(orphan.id).worker_number).toBe('W90-8-3');
    expect(db.task(unnumbered.id).worker_number).toBeNull();
    expect(() => db.run('UPDATE tasks SET worker_number=? WHERE id=?', 'W19', orphan.id)).toThrow('UNIQUE');
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const removal of ['deleteTasks', 'hardDeleteTasks', 'purge']) {
  test(`${removal} pins historical W prefixes even before first allocation; deletion and restart never reuse numbers`, async () => {
    const f = fixture();
    try {
      const old = legacy(f.store, 'W27');
      const orphan = legacy(f.store, 'W104-2', 'child');
      expect(high(f.store)).toBeNull();
      if (removal === 'purge') f.store.purge();
      else f.store[removal]([old.id, orphan.id]);
      expect(high(f.store)).toBe('104');
      const db = new Store(path.join(f.config.home, 'project.db'), f.root);
      try {
        const fresh = order(db);
        expect(fresh.worker_number).toBe('W105');
        if (removal === 'purge') db.purge();
        else db[removal]([fresh.id]);
        expect(high(db)).toBe('105');
      } finally { db.close(); }
      expect(order(f.store).worker_number).toBe('W106');
    } finally { await f.close(); }
  });
}

test('failed creation rolls back number allocation and preserves the saved high water mark', async () => {
  const f = fixture();
  try {
    expect(order(f.store).worker_number).toBe('W1');
    expect(() => order(f.store, { goal: null })).toThrow('NOT NULL');
    expect(high(f.store)).toBe('1');
    expect(order(f.store).worker_number).toBe('W2');
    expect(f.store.get('SELECT count(*) AS n FROM tasks').n).toBe(2);
  } finally { await f.close(); }
});

test('saved or historical W high water marks cannot overflow or silently restart at a low number', async () => {
  const f = fixture();
  try {
    for (const value of ['-1', 'invalid', '9007199254740992', String(Number.MAX_SAFE_INTEGER)]) {
      f.store.run("INSERT INTO meta(key,value) VALUES ('worker_number_high',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", value);
      expect(() => order(f.store)).toThrow('Worker number limit reached');
      expect(high(f.store)).toBe(value);
      expect(f.store.tasks()).toEqual([]);
    }
    f.store.run("DELETE FROM meta WHERE key='worker_number_high'");
    legacy(f.store, `W${Number.MAX_SAFE_INTEGER}-1`, 'child');
    expect(() => order(f.store)).toThrow('Worker number limit reached');
    expect(high(f.store)).toBeNull();
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
