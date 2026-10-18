import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';

for (const race of ['none', 'before', 'after']) test(`one-shot integration ${race === 'none' ? 'consumes exact conditional source evidence' : race === 'before' ? 'final guarded publication rejects changed condition' : 'reconciles already-written exact receipt after new dependency input'}`, async () => {
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
    // Hold ordinary source submission, not any Git or condition safety gate.
    p.scheduleMergeConditions = () => {};
    p.mergeTaskAfter(a.id, [{ kind: 'worker_settled', worker_id: b.id }], p.taskMergeConditions(a.id).revision);
    expect(await p.refreshMergeConditions(a.id)).toBe(true);
    const plan = await p.branchIntegratePlan('main');
    expect(plan.members.map(m => m.id)).toEqual([a.id]);
    if (race !== 'none') {
      const apply = p.workspaces.applyConvergencePublishUnsafe.bind(p.workspaces);
      p.workspaces.applyConvergencePublishUnsafe = async (receipt, guard) => {
        if (race === 'after') await apply(receipt, guard);
        p.message(b.id, 'new work arrived at publication');
        if (race === 'after') throw new Error('controlled crash after Git before DB');
        return apply(receipt, guard);
      };
    }
    const operation = await p.branchIntegrateStart('main', plan.revision);
    p.pump();
    await until(() => ['integrated','blocked','failed'].includes(f.store.deliveryRun(operation.id).state), 12000);
    const run = f.store.deliveryRun(operation.id);
    if (race !== 'none') {
      expect(run.state).toBe('blocked');
      expect(run.landing_receipt).toBeTruthy();
      expect(p.taskMergeConditions(a.id).state).toBe('stale');
      if (race === 'before') expect(await git(f.root, 'show', 'main:conditional-source.txt').catch(() => null)).toBeNull();
      else {
        expect(await git(f.root, 'show', 'main:conditional-source.txt')).toBe('source');
        p.workspaces.applyConvergencePublishUnsafe = () => { throw new Error('must never replay an exact written publication'); };
        await until(() => !p.convergenceJobs?.size);
        expect(await p.publishConvergence(operation.id)).toBe(true);
        expect(p.taskMergeConditions(a.id).state).toBe('consumed');
        expect(f.store.task(a.id).integration).toBe('merged');
      }
    } else {
      expect(run.state).toBe('integrated');
      expect(p.taskMergeConditions(a.id).state).toBe('consumed');
      expect(f.store.task(a.id).integration).toBe('merged');
      expect(await git(f.root, 'show', 'main:conditional-source.txt')).toBe('source');
    }
  } finally { await f.close(); }
});
