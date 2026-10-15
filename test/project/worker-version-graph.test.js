import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { Workspaces } from '../../src/core/workspaces.js';
import { historicalConvergencePolicy, pinHistoricalConvergence } from '../convergence-fixtures.js';

async function world() {
  const f = fixture(); f.project.stopping = true; f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); const { task } = await f.project.order('original order');
  f.task = task; f.base = task.base_commit; f.main = f.store.task(task.parent_id); return f;
}
async function commit(workspace, name) {
  fs.writeFileSync(path.join(workspace, name + '.txt'), name);
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', name); return git(workspace, 'rev-parse', 'HEAD');
}
async function deliver(f, task = f.task) {
  f.store.update(task.id, { status: 'waiting', result: 'tested' });
  f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
  await f.project.reserveTask(task.id, 'merge'); f.project.stopping = false; await f.project.driveTaskMerge(task.parent_id);
  expect(f.store.task(task.id).integration).toBe('merged');
  return f.store.get("SELECT id,data FROM events WHERE task_id=? AND type='task.merge_integrated' ORDER BY id DESC LIMIT 1", task.id);
}

test('unlanded current Worker snapshot is compact, baseline/ref bound and excludes unrelated synchronized parent commits', async () => {
  const f = await world();
  try {
    const own = await commit(f.task.workspace, 'own'); const unrelated = await commit(f.root, 'parent-work');
    await git(f.task.workspace, 'merge', 'main', '-m', 'parent join'); const join = await git(f.task.workspace, 'rev-parse', 'HEAD');
    f.store.update(f.task.id, { head_commit: unrelated, iteration_base_commit: unrelated });
    const first = await f.project.workerVersionGraph({ id: f.task.id, limit: 1 });
    expect(first).toMatchObject({ scope: 'current', delivery: null, base: f.base, tip: join,
      worker: { id: f.task.id, worker_number: f.task.worker_number }, has_more: true });
    expect(first.commits[0].parents).toEqual([own, unrelated]);
    expect(first.commits[0].tasks[0]).toMatchObject({ id: f.task.id, evidence: 'worker.source', delivery_id: null });
    expect(JSON.stringify(first)).not.toContain('original order'); expect(first.commits[0].tasks[0].goal).toBeUndefined();
    const advanced = await commit(f.task.workspace, 'advance');
    const second = await f.project.workerVersionGraph({ id: f.task.id, cursor: first.cursor });
    expect(second.tip).toBe(join); expect(second.snapshot).toBe(first.snapshot); expect(second.commits.map(c => c.commit)).toEqual([own]);
    expect((await f.project.workerVersionGraph({ id: f.task.id })).tip).toBe(advanced);
    const detail = await f.project.workerVersionCommit({ id: f.task.id, snapshot: first.snapshot, commit: own });
    expect(detail.commit.tasks[0].goal).toBe('original order'); expect(detail.commit.tasks[0].input.content).toBe('original order');
    for (const sha of [unrelated, f.base, advanced]) await expect(f.project.workerVersionCommit({ id: f.task.id, snapshot: first.snapshot, commit: sha })).rejects.toThrow('outside');
    expect(await f.project.workerVersionDeliveries({ id: f.task.id })).toMatchObject({ deliveries: [], has_more: false });
  } finally { await f.close(); }
});
