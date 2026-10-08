import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, until } from '../helpers.js';
import { setup, fetch } from './harness.js';
setDefaultTimeout(20000);

const get = async (f, route) => (await fetch(f.url + route)).json();
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url },
    body: JSON.stringify({ method, params }) });
  const value = await response.json(); expect(response.status).toBe(status); return value;
}
const hooks = (f, id) => get(f, `/api/worker/${id}/hooks`);
async function configure(f, id, level) {
  const read = await hooks(f, id);
  return post(f, 'worker.completion', { id, level, expected_revision: read.revision });
}
function privateAbsent(value, authorization) {
  const json = JSON.stringify(value);
  expect(json).not.toContain('"authorization"'); expect(json).not.toContain('"executions"');
  if (authorization) expect(json).not.toContain(authorization);
}
async function prepared() {
  const f = await setup(); f.project.stopping = true; f.calls = 0;
  f.project.provider = { resolve() { return { agent: 'mock' }; }, async run({ task }) {
    f.calls++; fs.writeFileSync(path.join(task.workspace, 'completion-http.txt'), 'controlled result');
    await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'controlled completion'); return 'done';
  } };
  await repo(f.root); return f;
}

for (const level of ['off', 'merge', 'accept', 'archive']) test(`real HTTP/RPC/Git completion ${level} follows ordered stages and only reminds the next human step`, async () => {
  const f = await prepared();
  try {
    const { task } = await post(f, 'order.submit', { content: `HTTP ${level}`, start: false });
    const mounted = await configure(f, task.id, level); expect(mounted.completion.level).toBe(level);
    expect(mounted.mounts.slice(0, 3).map(item => item.id)).toEqual(['auto-merge', 'auto-accept', 'auto-archive']);
    privateAbsent(mounted);
    f.project.stopping = false; await post(f, 'worker.resume', { id: task.id });
    const desired = level === 'off' ? 'waiting' : level === 'merge' ? 'awaiting_acceptance' : 'completed';
    await until(() => f.store.task(task.id).status === desired && !f.project.running.has(task.id)
      && !f.project.taskMergeBusy?.size && !f.project.completionQueued?.size
      && (level !== 'archive' || f.store.branch(task.branch).status === 'archived'), 15000);
    const read = await hooks(f, task.id), inspected = await get(f, `/api/worker/${task.id}`);
    expect(read.completion).toEqual(inspected.completion);
    expect((await get(f, '/api/worker-graph')).nodes.find(item => item.id === task.id).completion).toEqual(read.completion);
    const authorization = JSON.parse(f.store.task(task.id).auto_merge).completion?.authorization;
    privateAbsent(read, authorization); privateAbsent(inspected, authorization);
    expect(f.calls).toBe(1); // Acceptance/archival never call a quality-review model.
    const events = f.store.history(task.id), merged = events.find(item => item.type === 'task.merge_integrated');
    const accepted = events.find(item => item.type === 'task.accepted'), archived = events.find(item => item.type === 'branch.archive');
    expect(Boolean(merged)).toBe(level !== 'off'); expect(Boolean(accepted)).toBe(['accept', 'archive'].includes(level));
    if (accepted) { expect(accepted.id).toBeGreaterThan(merged.id); expect(accepted.data.via).toBe('completion_hook'); }
    if (archived) expect(archived.id).toBeGreaterThan(accepted.id);
    const notices = f.store.all("SELECT * FROM notices WHERE task_id=? AND kind='info'", task.id);
    expect(notices).toHaveLength(level === 'archive' ? 0 : 1);
    if (level === 'merge') expect(notices[0].title).toContain('待验收');
    if (level === 'accept') expect(notices[0].title).toContain('待归档');
    expect(fs.existsSync(task.workspace)).toBe(level !== 'archive');
    if (level !== 'off') expect(await git(f.root, 'show', 'main:completion-http.txt')).toBe('controlled result');
    const previousCount = events.length;
    for (let i = 0; i < 3; i++) { await hooks(f, task.id); await get(f, `/api/worker/${task.id}`); }
    f.project.scheduleTaskCompletion(task.id); await f.project.completionQueue;
    expect(f.store.history(task.id)).toHaveLength(previousCount);
  } finally { await f.close(); }
});

test('real HTTP manual acceptance then higher archive authorization resumes only the tail and hides raw receipts', async () => {
  const f = await prepared();
  try {
    const { task } = await post(f, 'order.submit', { content: 'HTTP upgrade', start: false });
    const mounted = await configure(f, task.id, 'merge'); f.project.stopping = false;
    await post(f, 'worker.resume', { id: task.id });
    await until(() => f.store.task(task.id).status === 'awaiting_acceptance' && !f.project.taskMergeBusy?.size
      && !f.project.completionQueued?.size, 15000);
    await post(f, 'worker.completion', { id: task.id, level: 'archive', expected_revision: mounted.revision }, 400);
    const accepted = await post(f, 'worker.accept', { id: task.id });
    expect(accepted.status).toBe('completed'); expect(typeof accepted.auto_merge).not.toBe('string'); privateAbsent(accepted);
    await f.project.completionQueue;
    const upgraded = await configure(f, task.id, 'archive'); expect(upgraded.completion.level).toBe('archive');
    await until(() => f.store.branch(task.branch).status === 'archived' && !f.project.completionQueued?.size, 15000);
    const history = f.store.history(task.id);
    expect(history.filter(item => item.type === 'task.merge_integrated')).toHaveLength(1);
    expect(history.filter(item => item.type === 'task.accepted')).toHaveLength(1);
    expect(history.find(item => item.type === 'task.accepted').data.accepted_by).toBe('user');
    expect(f.calls).toBe(1); privateAbsent(await hooks(f, task.id));
  } finally { await f.close(); }
});

test('real HTTP locks child flow Hooks without inheriting parent level and rejects custom builtin-only actions', async () => {
  const f = await prepared();
  try {
    const { task } = await post(f, 'order.submit', { content: 'HTTP parent', start: false });
    await configure(f, task.id, 'archive');
    const child = await post(f, 'worker.spawn', { parent: task.id, goal: 'independent child' });
    const childHooks = await hooks(f, child.id);
    expect(childHooks.completion).toMatchObject({ level: 'merge', min_level: 'merge', locked: true, editable: false });
    expect(childHooks.mounts.slice(0, 3).every(item => item.locked && !item.editable && !item.removable)).toBe(true);
    const original = f.store.task(child.id), history = f.store.history(child.id);
    for (const level of ['off', 'merge', 'accept', 'archive']) {
      const error = await post(f, 'worker.completion', { id: child.id, level, expected_revision: childHooks.revision }, 400);
      expect(error.error).toContain('锁定');
    }
    for (const enabled of [false, true]) {
      expect((await post(f, 'worker.auto_merge', { id: child.id, enabled }, 400)).error).toContain('锁定');
      await post(f, 'worker.hook_update', { id: child.id, hook_id: 'auto-merge', enabled, expected_revision: childHooks.revision }, 400);
    }
    for (const hook_id of ['auto-merge', 'auto-accept', 'auto-archive']) {
      await post(f, 'worker.hook_remove', { id: child.id, hook_id, expected_revision: childHooks.revision }, 400);
    }
    expect((await hooks(f, child.id)).revision).toBe(childHooks.revision);
    expect(f.store.task(child.id).auto_merge).toBe(original.auto_merge);
    expect(f.store.task(child.id).reservation).toBe(original.reservation);
    expect(f.store.history(child.id)).toEqual(history);
    expect((await get(f, `/api/worker/${child.id}`)).completion).toEqual(childHooks.completion);
    expect((await get(f, '/api/worker-graph')).nodes.find(item => item.id === child.id).completion).toEqual(childHooks.completion);
    // A user order on another Worker's branch is not a delegated child.
    const nested = await post(f, 'order.submit', { content: 'user-created nested order', branch: task.branch, start: false });
    expect((await configure(f, nested.task.id, 'accept')).completion).toMatchObject({ level: 'accept', editable: true, locked: false });
    const custom = await post(f, 'worker.hook_attach', { id: child.id, expected_revision: childHooks.revision,
      hook: { name: 'non-flow notification', mode: 'once', enabled: true, trigger: 'agent.returned', actions: [{ type: 'notify', title: 'Notice', body: 'Result' }] } });
    expect(custom.mounts.find(item => !item.builtin).editable).toBe(true);
    for (const [type, trigger] of [['accept_worker', 'delivery.integrated'], ['archive_worker', 'worker.accepted']]) {
      const current = await hooks(f, task.id);
      const error = await post(f, 'worker.hook_attach', { id: task.id, expected_revision: current.revision,
        hook: { name: 'invalid bypass', mode: 'persistent', enabled: true, trigger, actions: [{ type }] } }, 400);
      expect(error.error).toContain('built-in');
    }
    expect(f.calls).toBe(0);
  } finally { await f.close(); }
});
