import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

setDefaultTimeout(15000);

for (const method of ['acceptTask', 'resolveTask']) {
  test(`${method}: an unchanged idle answer accepts without merge, retaining result and emitting acceptance once`, async () => {
    const f = fixture(); f.project.stopping = true; await repo(f.root);
    try {
      const { task } = await f.project.order('answer only');
      f.store.update(task.id, { status: 'waiting', result: 'retained answer' });
      const parentHead = await git(f.root, 'rev-parse', 'main');
      const hooks = [];
      const emit = f.project.emitTaskHook.bind(f.project);
      f.project.emitTaskHook = (id, trigger, ...rest) => { hooks.push([id, trigger]); return emit(id, trigger, ...rest); };
      const accepted = await f.project[method](task.id);
      expect(accepted).toMatchObject({ status: 'completed', integration: 'none', result: 'retained answer',
        head_commit: task.base_commit, branch: task.branch, workspace: task.workspace });
      expect(fs.existsSync(task.workspace)).toBe(true);
      expect(await git(f.root, 'rev-parse', 'main')).toBe(parentHead);
      expect(await git(task.workspace, 'rev-parse', 'HEAD')).toBe(task.base_commit);
      expect(f.project.inspect(task.id).accepted).toBe(true);
      await f.project[method](task.id);
      expect(hooks.filter(([id, trigger]) => id === task.id && trigger === 'worker.accepted')).toHaveLength(1);
      expect(f.store.history(task.id).filter(row => row.type === 'task.accepted')).toHaveLength(1);
      expect(f.store.history(task.id).some(row => ['task.resolved', 'task.merge_integrated', 'task.merge_requested'].includes(row.type))).toBe(false);
      expect(f.project.running.size).toBe(0);
      expect(f.store.task(task.id).calls).toBe(0);
      await f.project.archiveBranch(task.branch);
      expect(fs.existsSync(task.workspace)).toBe(false);
      expect(f.store.task(task.id).result).toBe('retained answer');
      expect(await git(f.root, 'rev-parse', 'main')).toBe(parentHead);
    } finally { await f.close(); }
  });

  test(`${method}: no-code answers cannot bypass inbox, decisions, dirt, active descendants or reserved delivery`, async () => {
    const f = fixture(); f.project.stopping = true; await repo(f.root);
    try {
      const { task } = await f.project.order('unfinished answer');
      f.store.update(task.id, { status: 'waiting', result: 'answer so far' });
      const parentHead = await git(f.root, 'rev-parse', 'main');
      f.project.message(task.id, 'unprocessed follow-up');
      f.store.update(task.id, { status: 'waiting' });
      await expect(f.project[method](task.id)).rejects.toThrow('unread');
      f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
      const decision = f.project.notice(task.id, 'decision', 'need user choice');
      await expect(f.project[method](task.id)).rejects.toThrow('open decisions');
      expect(f.store.get('SELECT status FROM notices WHERE id=?', decision.id).status).toBe('open');
      f.store.run("UPDATE notices SET status='dismissed' WHERE id=?", decision.id);
      const dirty = path.join(task.workspace, 'keep.txt'); fs.writeFileSync(dirty, 'valuable');
      await expect(f.project[method](task.id)).rejects.toThrow();
      expect(fs.readFileSync(dirty, 'utf8')).toBe('valuable'); fs.unlinkSync(dirty);
      const child = await f.project.spawn(task.id, 'pending child');
      await expect(f.project[method](task.id)).rejects.toThrow('descendants');
      f.store.update(child.id, { status: 'cancelled' });
      for (const status of ['pending', 'requested', 'executing', 'resolving', 'suspended', 'blocked']) {
        f.store.update(task.id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status }) });
        await expect(f.project[method](task.id)).rejects.toThrow();
      }
      expect(f.store.task(task.id).status).toBe('waiting');
      expect(f.store.history(task.id).some(row => row.type === 'task.accepted')).toBe(false);
      expect(await git(f.root, 'rev-parse', 'main')).toBe(parentHead);
    } finally { await f.close(); }
  });
}
