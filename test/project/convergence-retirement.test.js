import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { historicalConvergencePolicy } from '../convergence-fixtures.js';

for (const kind of ['main', 'owner', 'order', 'child']) for (const automatic of [false, true]) {
  test(`new ${automatic ? 'automatic' : 'explicit'} delivery to historical enabled ${kind} stays v2 serial and lands once`, async () => {
    const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
    try {
      await repo(f.root); let parent = await f.project.bootstrapMain();
      if (kind === 'owner') {
        await git(f.root, 'branch', 'owner'); parent = await f.project.bindBranch('owner', await git(f.root, 'rev-parse', 'HEAD'));
      } else if (kind !== 'main') {
        parent = (await f.project.order('receiving order', 'main', [], null, false)).task;
        if (kind === 'child') parent = await f.project.spawn(parent.id, 'receiving child');
        f.store.update(parent.id, { status: 'waiting' }); f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', parent.id);
      }
      const policy = historicalConvergencePolicy(f, parent, { generation: 8,
        validation: { command_id: '00000000-0000-0000-0000-000000000001', command_version: 99 } });
      const task = kind === 'child' ? await f.project.spawn(parent.id, 'ordinary source')
        : (await f.project.order('ordinary source', parent.branch, [], null, false)).task;
      f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
      fs.writeFileSync(path.join(task.workspace, 'ordinary.txt'), 'serial source\n');
      await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'ordinary source');
      const source = await git(task.workspace, 'rev-parse', 'HEAD');
      f.store.update(task.id, { status: 'waiting' });
      f.project.workspaces.taskSyncBase = () => { throw new Error('ordinary request must not compute a convergence delta'); };
      if (automatic) {
        f.project.stopping = true;
        if (task.task_kind !== 'child') await f.project.setTaskCompletion(task.id, 'merge', f.project.taskHooks(task.id).revision);
        await f.project.settleQueuedMerge(task.id);
      } else await f.project.requestTaskMerge(task.id);
      const request = JSON.parse(f.store.task(task.id).reservation);
      expect(request).toMatchObject({ version: 2, queue_protocol: 1, status: 'requested', parent_id: parent.id, commit: source });
      for (const key of ['verification_mode', 'validation', 'convergence_policy_generation', 'run_id', 'base_commit']) expect(request).not.toHaveProperty(key);
      const event = f.store.get('SELECT data FROM events WHERE id=?', request.handler_operation_id);
      expect(JSON.parse(event.data)).toMatchObject({ strategy: 'serial', policy_generation: policy.generation });
      expect(f.project.convergencePolicy(parent.branch)).toMatchObject({ enabled: true, mounted: true, generation: 8 });
      f.project.stopping = false; await f.project.driveTaskMerge(parent.id);
      expect(f.store.task(task.id)).toMatchObject({ integration: 'merged', status: 'awaiting_acceptance', parent_id: parent.id });
      const landed = await git(f.root, 'rev-parse', parent.branch);
      expect(await git(task.workspace, 'rev-parse', 'HEAD')).toBe(source);
      await f.project.driveTaskMerge(parent.id); expect(await git(f.root, 'rev-parse', parent.branch)).toBe(landed);
      expect(f.store.all('SELECT * FROM delivery_runs')).toHaveLength(0);
      expect(f.store.all("SELECT id FROM tasks WHERE task_kind IN ('integration','merge')")).toHaveLength(0);
    } finally { await f.close(); }
  });
}
