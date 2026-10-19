import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';

test('one-shot integration consumes exact conditional source evidence and publishes its code', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task, cwd, context }) {
    if (task.task_kind === 'integration') {
      for (const member of context.integration.members) await git(cwd, 'merge', '--no-ff', member.source_commit, '-m', 'combine exact source');
    } else if (task.goal === 'source') {
      fs.writeFileSync(path.join(cwd, 'conditional-source.txt'), 'source\n');
      await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'source');
    }
    return 'verified controlled integration';
  } });
  try {
    const p = f.project; p.kick = () => {}; await repo(f.root); await p.bootstrapMain();
    const a = (await p.order('source')).task, b = (await p.order('dependency')).task;
    p.pump(); await until(() => !p.running.size && f.store.task(a.id).status === 'waiting' && f.store.task(b.id).status === 'waiting', 12000);
    // Hold ordinary submission while selecting the integration path, not a production safety gate.
    p.scheduleMergeConditions = () => {};
    p.mergeTaskAfter(a.id, [{ kind: 'worker_settled', worker_id: b.id }], p.taskMergeConditions(a.id).revision);
    expect(await p.refreshMergeConditions(a.id)).toBe(true);
    const plan = await p.branchIntegratePlan('main');
    expect(plan.members.map(m => m.id)).toEqual([a.id]);
    const operation = await p.branchIntegrateStart('main', plan.revision);
    p.pump();
    await until(() => ['integrated','blocked','failed'].includes(f.store.deliveryRun(operation.id).state), 12000);
    expect(f.store.deliveryRun(operation.id).state).toBe('integrated');
    expect(p.taskMergeConditions(a.id).state).toBe('consumed');
    expect(f.store.task(a.id).integration).toBe('merged');
    expect(await git(f.root, 'show', 'main:conditional-source.txt')).toBe('source');
  } finally { await f.close(); }
});
