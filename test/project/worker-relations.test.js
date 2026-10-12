import { expect, test } from 'bun:test';
import { fixture } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { tokenHash } from '../../src/core/project/internal.js';

const create = (f, parent = null, extra = {}) => f.store.create({ parent_id: parent, role: 'agent', task_kind: parent ? 'child' : 'order', goal: 'relation worker', ...extra });

test('relations returns only the direct parent and direct children across every status/type, with safe titles and IDs', async () => {
  const f = fixture();
  try {
    const root = create(f, null, { task_kind: 'main' }), parent = create(f, root.id), selected = create(f, parent.id);
    create(f, parent.id, { goal: 'sibling' });
    const one = create(f, selected.id), two = create(f, selected.id, { role: 'planner', task_kind: null });
    create(f, one.id, { goal: 'grandchild' });
    f.store.run('UPDATE tasks SET worker_number=?,display_title=?,auto_title=? WHERE id=?', 'W227', '父标题', '自动父标题', parent.id);
    f.store.update(parent.id, { status: 'running', interrupt_state: 'requested',
      retry_profile: JSON.stringify({ env: { KEY: 'never-expose-private' }, system_prompt: 'never-expose-private' }), hooks: 'never-expose-private' });
    f.store.run('UPDATE tasks SET worker_number=?,display_title=?,auto_title=? WHERE id=?', 'W227-1', '子标题', '自动子标题', one.id);
    f.store.update(one.id, { status: 'failed' });
    f.store.update(two.id, { status: 'cancelled', integration: 'merged' });
    const before = f.store.all('SELECT * FROM events');
    f.project.workspaces.git = () => { throw new Error('must not read Git'); };
    const result = await new Dispatcher(f.project).dispatch('worker.relations', { id: selected.id });
    expect(result.parent).toMatchObject({ id: parent.id, worker_number: 'W227', display_title: '父标题', auto_title: '自动父标题', status: 'running', interrupt_state: 'requested' });
    expect(result.children).toMatchObject({ total: 2, cursor: two.id, has_more: false, limit: 50 });
    expect(result.children.items.map(item => item.id)).toEqual([one.id, two.id]);
    expect(result.children.items[0]).toMatchObject({ worker_number: 'W227-1', status: 'failed', display_title: '子标题', auto_title: '自动子标题' });
    expect(result.children.items[1]).toMatchObject({ worker_number: null, role: 'planner', status: 'cancelled', integration: 'merged' });
    expect(JSON.stringify(result)).not.toContain('never-expose-private');
    for (const row of [result.parent, ...result.children.items]) {
      for (const key of ['retry_profile','env','hooks','credential','workspace','result','reservation']) expect(key in row).toBe(false);
    }
    expect(f.project.taskRelations(parent.id).parent).toMatchObject({ id: root.id, task_kind: 'main' });
    expect(f.project.taskRelations(root.id).parent).toBeNull();
    expect(f.project.taskRelations(two.id).children).toEqual({ items: [], total: 0, cursor: 0, has_more: false, limit: 50 });
    expect(f.store.all('SELECT * FROM events')).toEqual(before);
    expect(f.project.running.size).toBe(0);
  } finally { await f.close(); }
});

test('SQL keyset pages fully traverse more children than the old 100KB inspect preview; no duplicates or skipped statuses', async () => {
  const f = fixture();
  try {
    const selected = create(f), expected = [];
    f.store.transaction(() => {
      for (let i = 0; i < 380; i++) {
        const row = create(f, selected.id, { goal: '关系目标'.repeat(300) }); expected.push(row.id);
        f.store.setTaskDisplayTitle(row.id, '长标题'.repeat(66));
        f.store.update(row.id, { status: ['running','failed','cancelled','awaiting_acceptance'][i % 4], integration: i % 4 === 3 ? 'merged' : 'none' });
      }
    });
    expect(f.project.inspect(selected.id).children.length).toBeLessThan(expected.length);
    const pages = [], ids = []; let after = 0;
    do {
      const result = f.project.taskRelations(selected.id, { after, limit: 200 });
      pages.push(result.children); ids.push(...result.children.items.map(row => row.id));
      expect(result.children.total).toBe(expected.length);
      expect(result.children.items.every(row => row.goal.length === 200)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result.children.items))).toBeLessThanOrEqual(200000);
      expect(result.children.cursor).toBeGreaterThan(after); after = result.children.cursor;
      if (!result.children.has_more) break;
    } while (true);
    expect(ids).toEqual(expected); expect(new Set(ids).size).toBe(expected.length); expect(pages.length).toBeGreaterThan(1);
    expect(f.project.taskRelations(selected.id, { after, limit: 10 }).children).toEqual({ items: [], total: 380, cursor: after, has_more: false, limit: 10 });
  } finally { await f.close(); }
});

test('RPC relations strictly validates identities/options and is user-only, with no legacy namespace', async () => {
  const f = fixture();
  try {
    const task = create(f), rpc = new Dispatcher(f.project);
    for (const id of [0,-1,1.5,'W227','bad',999999]) await expect(rpc.dispatch('worker.relations', { id })).rejects.toThrow();
    for (const after of [-1,1.5,Number.MAX_SAFE_INTEGER + 1,'bad','',null,false]) await expect(rpc.dispatch('worker.relations', { id: task.id, after })).rejects.toThrow('cursor');
    for (const limit of [0,201,-1,1.5,'bad','',null,true]) await expect(rpc.dispatch('worker.relations', { id: task.id, limit })).rejects.toThrow('limit');
    await expect(rpc.dispatch('worker.relations', { id: task.id, force: true })).rejects.toThrow('unknown parameter');
    await expect(rpc.dispatch('task.relations', { id: task.id })).rejects.toThrow('unknown method');
    expect((await rpc.dispatch('worker.relations', { id: String(task.id), after: '0', limit: '1' })).children.limit).toBe(1);
    const token = 'relations-test-token';
    f.store.update(task.id, { status: 'running' }); f.store.armAgent(task.id, tokenHash(token));
    f.project.running.set(task.id, { controller: new AbortController() });
    await expect(rpc.dispatch('worker.relations', { id: task.id, _token: token })).rejects.toThrow('requires user approval');
    f.project.running.delete(task.id);
  } finally { await f.close(); }
});
