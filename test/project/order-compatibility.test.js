import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { main } from '../../src/cli/main.js';
import { normalizeOrderRecord } from '../../src/core/order-kind.js';

setDefaultTimeout(15000);

async function historicalOrder(f, start = false) {
  const result = await f.project.order('历史原话 say 不应改写', 'main', [], null, start);
  f.store.run("UPDATE tasks SET task_kind='say',name=? WHERE id=?", `say-${result.id}`, result.task.id);
  return result;
}

function raw(f, id) { return f.store.db.query('SELECT * FROM tasks WHERE id=?').get(id); }

test('order read normalization is non-mutating and preserves unrelated rows', () => {
  const old = { task_kind: 'say', name: 'say-4', workspace: '/kept/say-4', branch: 'kept-say' };
  expect(normalizeOrderRecord(old)).toEqual({ ...old, task_kind: 'order' });
  expect(old.task_kind).toBe('say');
  expect(normalizeOrderRecord(null)).toBeNull();
  const ordinary = { task_kind: 'child' };
  expect(normalizeOrderRecord(ordinary)).toBe(ordinary);
  expect(normalizeOrderRecord({ task_kind: 'child', parent_task_kind: 'say' }))
    .toEqual({ task_kind: 'child', parent_task_kind: 'order' });
});

test('historical types project as order without changing rows, paths, names or original input', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const old = await historicalOrder(f), before = raw(f, old.task.id);
    for (const read of [f.store.task(old.task.id), f.store.tasks().find(t => t.id === old.task.id),
      f.store.summaries().find(t => t.id === old.task.id), f.project.inspect(old.task.id),
      f.project.activity(100).tasks.find(t => t.id === old.task.id)]) {
      expect(read.task_kind).toBe('order');
    }
    expect((await f.project.taskGraph()).nodes.find(t => t.id === old.task.id).task_kind).toBe('order');
    expect(f.project.inputGet('input', old.id).content).toBe('历史原话 say 不应改写');
    expect(await f.project.workspaces.ensure(f.store.task(old.task.id))).toBe(old.task.workspace);
    expect(raw(f, old.task.id)).toEqual(before);
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    try {
      expect(reopened.task(old.task.id).task_kind).toBe('order');
      expect(reopened.db.query('SELECT * FROM tasks WHERE id=?').get(old.task.id)).toEqual(before);
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('old order branches remain valid parents for drafts, new orders and delegated children', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const old = await historicalOrder(f), parent = f.store.task(old.task.id);
    expect((await f.project.inputParents()).items.some(t => t.id === parent.id)).toBe(true);
    expect(await f.project.inputParent(parent.branch)).toMatchObject({ id: parent.id, task_kind: 'order' });
    const draft = await f.project.addBufferedDraft('草稿', [], parent.branch);
    const sent = await f.project.submitBufferedDraft(draft.id, draft.revision, false);
    expect(sent.task).toMatchObject({ task_kind: 'order', parent_id: parent.id, name: `order-${sent.id}` });
    const child = await f.project.spawn(parent.id, 'child', 'agent', [], 'compat-child');
    expect(child).toMatchObject({ task_kind: 'child', parent_id: parent.id });
    expect((await f.project.taskGraph()).nodes.find(t => t.id === child.id).parent_task_kind).toBe('order');
    expect(raw(f, parent.id).task_kind).toBe('say');
    await expect(f.project.bindBranch(parent.branch, parent.base_commit)).rejects.toThrow('already has a new Worker owner');
    await expect(f.project.approveBranchMerge(parent.branch)).rejects.toThrow('legacy branch.merge');
  } finally { await f.close(); }
});

test('mixed historical/current branch owners share a unique constraint even with the old index installed', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const old = await historicalOrder(f);
    f.store.run('DROP INDEX tasks_order_branch_owner');
    f.store.run("CREATE UNIQUE INDEX tasks_new_branch_owner ON tasks(branch) WHERE task_kind IN ('main','say','owner') AND branch IS NOT NULL");
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    try {
      const current = reopened.create({ role: 'agent', goal: 'new', task_kind: 'order' });
      expect(() => reopened.update(current.id, { branch: old.task.branch })).toThrow('UNIQUE');
      reopened.update(current.id, { branch: 'current-order' });
      const other = reopened.create({ role: 'agent', goal: 'other', task_kind: 'order' });
      expect(() => reopened.update(other.id, { branch: 'current-order' })).toThrow('UNIQUE');
      expect(raw(f, old.task.id).task_kind).toBe('say');
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test('historical orders resume through the renamed scheduler and retain lifecycle notifications', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const old = await historicalOrder(f);
    await f.project.resumeTask(old.task.id);
    expect(f.store.task(old.task.id).status).toBe('queued');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(old.task.id).status === 'waiting' && !f.project.running.has(old.task.id));
    expect(f.store.task(old.task.id).calls).toBe(1);
    expect(f.store.all('SELECT id FROM notices WHERE task_id=? AND source_event_id IS NOT NULL', old.task.id)).toHaveLength(1);
    expect(raw(f, old.task.id).task_kind).toBe('say');
    expect(await git(old.task.workspace, 'symbolic-ref', '--short', 'HEAD')).toBe(old.task.branch);
  } finally { await f.close(); }
});

test('old landing events and version attribution remain readable without rewriting the audit trail', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const old = await historicalOrder(f);
    f.store.update(old.task.id, { integration: 'merged', reservation: null });
    f.store.event(old.task.id, 'task.iteration_started', {});
    f.store.event(old.task.id, 'say.integrated', {});
    expect(f.project.inputGet('input', old.id).merge_status).toBe('merged');
    const commit = await git(f.root, 'rev-parse', 'main');
    f.store.event(old.task.id, 'task.merge_integrated', { commit, parent_id: old.task.parent_id });
    const page = await f.project.branchHistory();
    expect(page.commits[0].tasks[0]).toMatchObject({ id: old.task.id, task_kind: 'order',
      input: { content: '历史原话 say 不应改写' } });
    expect(f.store.get("SELECT type FROM events WHERE type='say.integrated'").type).toBe('say.integrated');
    expect(raw(f, old.task.id).task_kind).toBe('say');
  } finally { await f.close(); }
});

test('old say public entry points are rejected; only order can create new records', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  try {
    const rpc = new Dispatcher(f.project);
    await expect(rpc.dispatch('say.submit', { content: 'old' })).rejects.toThrow('unknown method');
    await expect(main(['say', 'old'])).rejects.toThrow('unknown command: say');
    expect(f.project.say).toBeUndefined();
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.say).toBeUndefined();
    expect(pkg.scripts.order).toBe('bun ./scripts/ops.js order');
    const sent = await rpc.dispatch('order.submit', { content: '新指令', start: false });
    expect(raw(f, sent.task.id)).toMatchObject({ task_kind: 'order', name: `order-${sent.id}` });
  } finally { await f.close(); }
});
