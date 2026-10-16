import { test, expect } from 'bun:test';
import { runnerProjectFixture } from './runner-delivery-harness.js';
import { fixture, repo, gate } from '../helpers.js';

test('remote-safe-point integration leaves local no-change admission responsive to late input', async () => {
  const f = fixture(), entered = gate(), release = gate();
  f.project.stopping = true;
  try {
    await repo(f.root);
    const { task: parent } = await f.project.order('parent');
    const child = await f.project.spawn(parent.id, 'no-change child');
    f.store.update(child.id, { status: 'waiting' });
    const branchState = f.project.workspaces.branchState.bind(f.project.workspaces);
    f.project.workspaces.branchState = async branch => {
      const value = await branchState(branch); entered.resolve(); await release.promise; return value;
    };
    const settlement = f.project.settleQueuedMerge(child.id);
    await entered.promise;
    f.project.message(child.id, 'late input'); release.resolve();
    expect(await settlement).toBe(false);
    expect(f.store.task(child.id).status).toBe('queued');
    expect(JSON.parse(f.store.task(child.id).reservation).status).toBe('pending');
    expect(f.store.history(child.id).some(row => row.type === 'task.delivered')).toBe(false);
  } finally { release.resolve(); await f.close(); }
});

test('shutdown owns an admitted merge driver while its remote proof is outside the Git queue', async () => {
  const f = await runnerProjectFixture(), entered = gate(), release = gate();
  let driving, shutdown;
  try {
    const worker = await f.worker(); await f.commit(worker);
    await f.project.reserveTask(worker.id, 'merge');
    const connect = f.service.connect.bind(f.service);
    f.service.connect = async (...args) => { entered.resolve(); await release.promise; return connect(...args); };
    f.project.stopping = false; f.project.kick = () => {};
    driving = f.project.driveTaskMerge(f.main.id);
    await entered.promise;
    expect(f.project.workspaces.pending).toBe(0);
    expect(f.project.taskMergeJobs.has(driving)).toBe(true);
    let ended = false;
    shutdown = f.project.shutdown().then(value => { ended = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(ended).toBe(false);
    release.resolve(); await driving; await shutdown;
    expect(f.project.taskMergeJobs.size).toBe(0);
    expect(f.project.taskMergeBusy.size).toBe(0);
    expect(f.store.task(worker.id)).toBeDefined();
  } finally { release.resolve(); await driving?.catch(() => {}); await shutdown?.catch(() => {}); await f.close(); }
});
