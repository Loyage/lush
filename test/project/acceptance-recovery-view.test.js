import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo } from '../helpers.js';
import { iterationViews } from '../../src/core/project/iteration.js';

setDefaultTimeout(20000);
async function setup() {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const { task } = await f.project.order('recoverable acceptance');
  await f.project.workspaces.finish(task); f.store.update(task.id, { status: 'waiting', reservation: null });
  return { ...f, task: f.store.task(task.id) };
}
function receipt(f, task) {
  return f.store.event(task.id, 'task.acceptance_started', { head_commit: task.head_commit,
    tips: { [task.branch]: task.head_commit }, branches: [task.branch], task_ids: [task.id] });
}
async function projections(f, task = f.task) {
  return [f.project.inspect(task.id), f.project.decorate([{ id: task.id, status: f.store.task(task.id).status }])[0],
    (await f.project.taskGraph()).nodes.find(node => node.id === task.id),
    (await f.project.taskGraph({ details: false })).nodes.find(node => node.id === task.id)];
}
async function expectRecovery(f, expected, task) {
  for (const view of await projections(f, task)) expect(view.acceptance_recovery).toBe(expected);
}

test('inspect, sparse lists and both graph projections offer audited partial acceptance recovery, then clear after success', async () => {
  const f = await setup();
  try {
    await expectRecovery(f, false);
    const original = f.project.workspaces.git.bind(f.project.workspaces); let fail = true;
    f.project.workspaces.git = async (cwd, ...args) => {
      if (fail && args[0] === 'update-ref' && args[1] === '-d') throw new Error('synthetic ref removal failure');
      return original(cwd, ...args);
    };
    await expect(f.project.acceptTask(f.task.id)).rejects.toThrow('reclamation incomplete');
    expect(f.store.task(f.task.id).workspace).toBeNull(); await expectRecovery(f, true);
    for (const graph of (await projections(f)).slice(2)) {
      expect(graph.archived).toBe(false); expect(graph.waiting_reason).toContain('显式续办');
    }
    fail = false; await f.project.acceptTask(f.task.id); await expectRecovery(f, false);
    expect(f.project.inspect(f.task.id).accepted).toBe(true);
  } finally { await f.close(); }
});

for (const historical of [false, true]) test(`an archived subtree root with incomplete children stays visible and recoverable (historical=${historical})`, async () => {
  const f = await setup();
  try {
    const child = await f.project.spawn(f.task.id, 'old confirmed child');
    await f.project.workspaces.finish(child);
    f.store.update(child.id, { status: 'completed', reservation: null });
    f.store.event(child.id, 'task.accepted', { head_commit: f.store.task(child.id).head_commit });
    if (historical) {
      f.store.update(f.task.id, { status: 'completed' });
      f.store.event(f.task.id, 'task.accepted', { head_commit: f.task.head_commit });
    }
    const original = f.project.workspaces.git.bind(f.project.workspaces); let removes = 0;
    f.project.workspaces.git = async (cwd, ...args) => {
      if (args[0] === 'worktree' && args[1] === 'remove' && ++removes === 2) throw new Error('subtree removal failure');
      return original(cwd, ...args);
    };
    await expect(f.project.acceptTask(f.task.id)).rejects.toThrow('reclamation incomplete');
    expect(f.store.branch(f.task.branch).status).toBe('archived'); await expectRecovery(f, true);
    for (const graph of (await projections(f)).slice(2)) {
      expect(graph.archived).toBe(false); expect(graph.branch_info.archived).toBe(true); // Preserve resource facts.
    }
    await f.project.acceptTask(f.task.id); await expectRecovery(f, false);
    for (const graph of (await projections(f)).slice(2)) expect(graph.archived).toBe(true);
  } finally { await f.close(); }
});

test('missing paths and failure events alone never imply recovery; fixed current-round receipts and completion boundaries determine it', async () => {
  const f = await setup();
  try {
    f.store.update(f.task.id, { workspace: null });
    f.store.event(f.task.id, 'task.acceptance_failed', { acceptance_execution: 99999 });
    await expectRecovery(f, false); // No filesystem inference.
    f.store.update(f.task.id, { workspace: f.task.workspace });
    for (const boundary of ['task.accepted', 'task.acceptance_reclaimed', 'task.reopened', 'task.iteration_started', 'retry']) {
      receipt(f, f.task); await expectRecovery(f, true);
      f.store.event(f.task.id, boundary, {}); await expectRecovery(f, false);
    }
    receipt(f, f.task); await expectRecovery(f, true);
    f.store.update(f.task.id, { head_commit: 'f'.repeat(40) }); await expectRecovery(f, false);
    f.store.update(f.task.id, { head_commit: f.task.head_commit });
    for (const status of ['queued', 'running', 'paused', 'failed', 'cancelled']) {
      f.store.update(f.task.id, { status }); await expectRecovery(f, false);
    }
    f.store.update(f.task.id, { status: 'waiting' });
    f.store.run("INSERT INTO events(task_id,type,data) VALUES (?,'task.acceptance_started','invalid')", f.task.id);
    expect(iterationViews(f.store, [f.store.task(f.task.id)]).get(f.task.id).acceptance_recovery).toBe(false);
    receipt(f, f.task);
    f.store.event(f.task.id, 'task.acceptance_started', { head_commit: f.task.head_commit,
      tips: { [f.task.branch]: f.task.head_commit }, branches: ['another-branch'], task_ids: [f.task.id] });
    await expectRecovery(f, false);
  } finally { await f.close(); }
});
