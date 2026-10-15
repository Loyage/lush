import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, gate, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { tokenHash } from '../../src/core/project/internal.js';

setDefaultTimeout(30000);
const accepts = (f, row) => f.store.history(row.id).filter(event => event.type === 'task.accepted');
async function idle(f, row, status = 'awaiting_acceptance') {
  await f.project.workspaces.finish(f.store.task(row.id));
  f.store.update(row.id, { status, reservation: null, result: `result-${row.id}` });
}
async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const parent = (await f.project.order('parent batch')).task;
  f.store.update(parent.id, { status: 'waiting' });
  const child = await f.project.spawn(parent.id, 'retained child');
  f.store.update(child.id, { status: 'waiting' });
  const grandchild = await f.project.spawn(child.id, 'retained grandchild');
  await idle(f, grandchild); await idle(f, child); await idle(f, parent, 'waiting');
  return { ...f, parent, child, grandchild, rows: [parent, child, grandchild] };
}
async function deliver(f, row) {
  f.store.update(row.id, { status: 'waiting' });
  await f.project.reserveTask(row.id, 'merge');
  const kick = f.project.kick; f.project.kick = () => {}; f.project.stopping = false;
  try { await f.project.driveTaskMerge(row.parent_id); }
  finally { f.project.kick = kick; f.project.stopping = true; }
  f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', row.parent_id);
}
async function batch(f) { return f.project.acceptTask(f.parent.id); }
function intact(f) {
  for (const row of f.rows) {
    expect(fs.existsSync(row.workspace)).toBe(true);
    expect(accepts(f, row)).toHaveLength(0);
    expect(f.store.task(row.id).status).not.toBe('completed');
  }
}

test('one user acceptance settles multilevel no-code children, preserving results, sessions, messages and all acceptance hooks', async () => {
  const f = await setup();
  try {
    const configs = f.rows.map(row => f.store.task(row.id).auto_merge);
    const hooks = [], emit = f.project.emitTaskHook.bind(f.project);
    f.project.emitTaskHook = (id, trigger, ...args) => { if (trigger === 'worker.accepted') hooks.push(id); return emit(id, trigger, ...args); };
    for (const row of f.rows) {
      const file = path.join(f.config.home, 'sessions', `task-${row.id}-history.txt`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `session-${row.id}`);
      const message = f.store.message(row.id, 'historical input'); f.store.run('UPDATE messages SET consumed=1 WHERE id=?', message);
    }
    expect((await batch(f)).status).toBe('completed');
    const rootEvent = accepts(f, f.parent)[0];
    for (const [index, row] of f.rows.entries()) {
      expect(f.store.task(row.id)).toMatchObject({ status: 'completed', workspace: null, result: `result-${row.id}`, integration: 'none', auto_merge: configs[index] });
      expect(fs.existsSync(row.workspace)).toBe(false);
      expect(f.store.branch(row.branch).status).toBe('archived');
      expect(accepts(f, row)).toHaveLength(1);
      expect(accepts(f, row)[0].data).toMatchObject({ accepted_by: 'user', resources_reclaimed: true, acceptance_execution: rootEvent.data.acceptance_execution });
      if (row.id !== f.parent.id) expect(accepts(f, row)[0].data).toMatchObject({ via: 'parent_acceptance', acceptance_root_id: f.parent.id, delegator_id: row.parent_id });
      expect(fs.readFileSync(path.join(f.config.home, 'sessions', `task-${row.id}-history.txt`), 'utf8')).toBe(`session-${row.id}`);
      expect(f.store.get('SELECT count(*) AS n FROM messages WHERE task_id=?', row.id).n).toBe(1);
      expect(f.project.inspect(row.id).accepted).toBe(true);
    }
    expect(hooks.sort()).toEqual(f.rows.map(row => row.id).sort());
    await batch(f);
    expect(hooks).toHaveLength(3);
    expect(f.store.history(f.parent.id).filter(event => event.type === 'task.acceptance_started')).toHaveLength(1);
  } finally { await f.close(); }
});

test('one acceptance validates multilevel Squash deliveries before reclaiming their refs', async () => {
  const f = await setup();
  try {
    fs.writeFileSync(path.join(f.grandchild.workspace, 'nested.txt'), 'nested code\n');
    await git(f.grandchild.workspace, 'add', '.'); await git(f.grandchild.workspace, 'commit', '-m', 'nested code');
    await deliver(f, f.grandchild); await deliver(f, f.child); await deliver(f, f.parent);
    expect(await git(f.root, 'show', 'main:nested.txt')).toBe('nested code');
    await batch(f);
    for (const row of f.rows) {
      expect(f.store.task(row.id)).toMatchObject({ status: 'completed', integration: 'merged' });
      expect(accepts(f, row)).toHaveLength(1);
      expect(f.store.history(row.id).filter(event => event.type === 'task.merge_integrated')).toHaveLength(1);
    }
  } finally { await f.close(); }
});

test('delivery retains the original child for revisions until the user accepts the parent', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, messages }) {
    return task.task_kind === 'child' ? messages.some(message => message.body === 'revise') ? 'revised child' : 'first child' : 'collected';
  } });
  f.project.stopping = true; await repo(f.root);
  try {
    const parent = (await f.project.order('collect child')).task; f.store.update(parent.id, { status: 'waiting' });
    const child = await f.project.spawn(parent.id, 'answer');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).status === 'awaiting_acceptance' && f.store.task(parent.id).status === 'waiting' && !f.project.running.size);
    expect(fs.existsSync(child.workspace)).toBe(true); expect(accepts(f, child)).toHaveLength(0);
    const agentBefore = f.project.inspect(child.id).agent;
    f.project.message(child.id, 'revise');
    await until(() => f.store.task(child.id).calls === 2 && f.store.task(child.id).status === 'awaiting_acceptance' && f.store.task(parent.id).status === 'waiting' && !f.project.running.size);
    expect(f.store.task(child.id)).toMatchObject({ branch: child.branch, workspace: child.workspace, result: 'revised child' });
    expect(f.project.inspect(child.id).agent.id).toBe(agentBefore.id);
    await f.project.acceptTask(parent.id);
    expect(f.store.task(child.id)).toMatchObject({ status: 'completed', result: 'revised child' });
  } finally { await f.close(); }
});

test('Agent target permission remains direct-child-only while acceptance of that target shares batch safety', async () => {
  const f = await setup();
  try {
    const token = 'active-parent', run = { controller: new AbortController(), parked: false };
    f.store.update(f.parent.id, { status: 'running' }); f.store.armAgent(f.parent.id, tokenHash(token)); f.project.running.set(f.parent.id, run);
    const rpc = new Dispatcher(f.project), accept = id => rpc.dispatch('worker.accept', { id, _token: token });
    const order = (await f.project.order('not a delegated child', f.parent.branch)).task; await idle(f, order);
    await expect(accept(f.parent.id)).rejects.toThrow('own direct child');
    await expect(accept(f.grandchild.id)).rejects.toThrow('own direct child');
    await expect(accept(order.id)).rejects.toThrow('user-created order');
    await accept(f.child.id);
    expect(f.store.task(f.parent.id).status).toBe('running'); expect(f.store.task(f.grandchild.id).status).toBe('completed');
    expect(accepts(f, f.grandchild)[0].data).toMatchObject({ accepted_by: 'parent', parent_id: f.parent.id, delegator_id: f.child.id, acceptance_root_id: f.child.id });
    f.project.running.delete(f.parent.id);
    await expect(accept(f.child.id)).rejects.toThrow('expired agent token');
  } finally { f.project.running.clear(); await f.close(); }
});
