import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, gate, until } from '../helpers.js';

setDefaultTimeout(20000);

async function commit(cwd, name) {
  fs.writeFileSync(path.join(cwd, `${name}.txt`), name);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', name);
}

// A parent may continue its own work while two children have requested delivery.
// Once it exits, a designated child repair must run even with a single Agent slot;
// neither the parent's pending upward reservation nor held ordinary input may
// turn the writer freeze into a parent/child circular wait.
for (const concurrency of [1, 3]) test(`nested deliveries progress after parent exit and buffered input (${concurrency} slots)`, async () => {
  const firstParent = gate(), secondParent = gate(), thirdParent = gate(), repairReturn = gate();
  const calls = [], repairs = [];
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run(ctx) {
    calls.push({ id: ctx.task.id, call: ctx.task.calls, messages: ctx.messages.map(row => row.body) });
    if (ctx.task.task_kind === 'order') {
      if (ctx.task.calls === 1) {
        await commit(ctx.cwd, 'parent');
        await firstParent.promise;
      } else if (ctx.task.calls === 2) await secondParent.promise;
      else if (ctx.task.calls === 3) await thirdParent.promise;
      return 'parent safe boundary';
    }
    const signal = ctx.messages.find(row => row.signal_type === 'merge.repair');
    expect(signal).toBeDefined();
    const fixed = JSON.parse(signal.body).payload;
    await git(ctx.cwd, 'merge', '--no-edit', fixed.parent_commit);
    repairs.push({ id: ctx.task.id, attempt: fixed.attempt_id });
    if (repairs.length === 1) await repairReturn.promise;
    return 'fixed parent absorbed';
  } }, { LUSH_CONCURRENCY: String(concurrency) });
  f.project.stopping = true;
  const booking = task => JSON.parse(f.store.task(task.id).reservation);
  try {
    await repo(f.root);
    const parent = (await f.project.order('parent with pending upward intent')).task;
    await f.project.setTaskAutoMerge(parent.id, true);
    const one = await f.project.spawn(parent.id, 'first source');
    const two = await f.project.spawn(parent.id, 'second source');
    for (const [task, name] of [[one, 'one'], [two, 'two']]) {
      await commit(task.workspace, name);
      f.store.update(task.id, { status: 'waiting', result: 'source ready' });
      await f.project.settleQueuedMerge(task.id);
    }
    expect(booking(one).status).toBe('requested');
    expect(booking(two).status).toBe('requested');
    expect(f.project.hasActionableMessages(parent.id)).toBe(false);
    f.project.stopping = false; f.project.kick();
    await until(() => calls.some(row => row.id === parent.id && row.call === 1));
    f.project.message(parent.id, 'finish parent followup first');
    firstParent.resolve();
    await until(() => calls.some(row => row.id === parent.id && row.call === 2));
    await f.project.driveTaskMerge(parent.id);
    expect(booking(one).attempt_id).toBeUndefined();
    expect(booking(two).attempt_id).toBeUndefined();
    secondParent.resolve();
    await until(() => repairs.length === 1, 12000);
    expect(repairs[0].id).toBe(one.id);
    expect(f.project.activeTaskMerge(parent.id)?.id).toBe(one.id);
    expect(booking(parent).status).toBe('pending');
    expect(booking(two).attempt_id).toBeUndefined();
    expect(f.store.task(parent.id).status).toBe('waiting');
    expect(f.project.running.has(parent.id)).toBe(false);
    expect(f.project.message(parent.id, 'buffered parent followup').input_queue.buffered).toBe(1);
    const attempt = booking(one).attempt_id;
    repairReturn.resolve();
    await until(() => calls.some(row => row.id === parent.id && row.call === 3), 12000);
    expect(f.store.task(one.id).integration).toBe('merged');
    expect(booking(one).attempt_id).toBe(attempt);
    expect(calls.find(row => row.id === parent.id && row.call === 3).messages).toContain('buffered parent followup');
    expect(booking(two).attempt_id).toBeUndefined();
    thirdParent.resolve();
    await until(() => f.store.task(two.id).integration === 'merged', 12000);
    await until(() => calls.some(row => row.id === parent.id && row.call === 4), 12000);
    await until(() => !f.project.running.size && f.store.unread(parent.id).length === 0, 12000);
    expect(repairs.map(row => row.id)).toEqual([one.id, two.id]);
    expect(await git(parent.workspace, 'show', 'HEAD:one.txt')).toBe('one');
    expect(await git(parent.workspace, 'show', 'HEAD:two.txt')).toBe('two');
    expect(f.project.activeTaskMerge(parent.id)).toBeNull();
    expect(f.store.history(parent.id).some(row => ['invocation.target_branch_moved', 'merge.queue_failed'].includes(row.type))).toBe(false);
    for (const task of [one, two]) {
      expect(f.store.history(task.id).some(row => row.type === 'merge.attempt_suspended')).toBe(false);
      expect(f.store.task(task.id).status).toBe('awaiting_acceptance');
    }
  } finally {
    firstParent.resolve(); secondParent.resolve(); thirdParent.resolve(); repairReturn.resolve();
    await f.close();
  }
});
