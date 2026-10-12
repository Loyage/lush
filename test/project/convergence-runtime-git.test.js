import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { convergenceJSON } from '../../src/core/convergence-contract.js';
import { taskDeliveryState } from '../../src/core/project/iteration.js';

/** Assembled Project/Store/Workspaces, real merge-tree/CAS and real isolated Shell; no helper/provider claim. */
async function setup(count = 2, command = 'test -z "$LUSH_AGENT_TOKEN" && case "$PWD" in */.lush/convergence-validation/*) test -f alpha.txt && test -f beta.txt ;; *) exit 21 ;; esac', mode = 'command') {
  const f = fixture(); f.project.kick = () => {};
  // Control scheduling, not the coordinator/Git/command methods: fixed calls below run completely.
  f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  try {
  await repo(f.root); await f.project.bootstrapMain();
  const entry = f.project.saveShortcutCommand({ name: '隔离验收', command }, f.project.shortcutCommands().revision).commands.items.at(-1);
  f.project.authorizeShortcutCommand(entry.id, 1, true, f.project.shortcutCommands().revision);
  const before = await f.project.branchConvergence('main');
  expect(before.enabled).toBe(false);
  await f.project.setBranchConvergence('main', true, { command_id: entry.id, command_version: 1 }, before.revision);
  const sources = [];
  for (let i = 0; i < count; i++) {
    const { task } = await f.project.order(`source ${i}`);
    fs.writeFileSync(path.join(task.workspace, i === 0 ? 'alpha.txt' : 'beta.txt'), `source ${i}\n`);
    await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', `source ${i}`);
    f.store.update(task.id, { status: 'waiting' });
    await f.project.requestTaskMerge(task.id);
    expect(convergenceJSON(f.store.task(task.id).reservation)).toMatchObject({ version: 3, verification_mode: 'agent', validation: null });
    // Simulate already-fixed historical v3 requests; new booking never chooses command verification.
    if (mode === 'command') pinLegacy(f, task.id, entry);
    sources.push(f.store.task(task.id));
  }
  const baseline = await git(f.root, 'rev-parse', 'main');
  const run = await f.project.formConvergenceBatch(sources[0].parent_id);
  return { ...f, sources, baseline, run, entry };
  } catch (error) { await f.close(); throw error; }
}

function pinLegacy(f, taskId, entry) {
  const { verification_mode, ...booking } = convergenceJSON(f.store.task(taskId).reservation);
  f.store.update(taskId, { reservation: JSON.stringify({ ...booking, validation: { command_id: entry.id, command_version: 1 } }) });
}

test('two real fixed deliveries converge, validate exact isolated single-parent object, land once, and retain source refs', async () => {
  const f = await setup(); try {
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const run = f.store.deliveryRun(f.run.id), receipt = convergenceJSON(run.landing_receipt);
    expect(run.state).toBe('integrated');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(run.candidate_commit);
    expect((await git(f.root, 'show', '-s', '--format=%P', run.candidate_commit)).split(' ')).toEqual([f.baseline]);
    expect(convergenceJSON(run.validation_result)).toMatchObject({ state: 'passed', tested_commit: run.candidate_commit, tested_tree: run.candidate_tree });
    expect(fs.readFileSync(path.join(f.root, 'alpha.txt'), 'utf8')).toBe('source 0\n');
    expect(fs.readFileSync(path.join(f.root, 'beta.txt'), 'utf8')).toBe('source 1\n');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='worker.merge_received'", run.parent_id).n).toBe(1);
    expect(f.store.deliveryMembers(run.id, true)).toHaveLength(0);
    expect(await git(f.root, 'rev-parse', receipt.evidence.ref)).toBe(receipt.evidence.commit);
    const keeper = convergenceJSON(f.store.get('SELECT value FROM meta WHERE key=?', `convergence_evidence:${run.id}:1`).value);
    expect(keeper).toMatchObject({ root_commit: convergenceJSON(run.data).root_commit, commit: receipt.evidence.commit, member_ids: f.sources.map(source => source.id) });
    const registration = convergenceJSON(f.store.get('SELECT value FROM meta WHERE key=?', `convergence_validation:${run.id}:1`).value);
    expect(registration.state).toBe('removed'); expect(registration.result.commit).toBe(run.candidate_commit);
    expect(fs.existsSync(registration.checkout.path)).toBe(false);
    for (const source of f.sources) {
      expect(f.store.task(source.id)).toMatchObject({ status: 'awaiting_acceptance', integration: 'merged', parent_id: run.parent_id });
      expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(source.head_commit);
      expect(await f.project.workspaces.commitTree(source.head_commit)).not.toBe(run.candidate_tree);
      expect(await f.project.workspaces.squashedLanded(source.branch, run.candidate_commit)).toBe(true);
    }
    await git(f.root, 'reflog', 'expire', '--expire=now', '--all'); await git(f.root, 'gc', '--prune=now');
    for (const source of f.sources) expect(await f.project.workspaces.squashedLanded(source.branch, run.candidate_commit)).toBe(true);
    // A second source-side increment must not replay/remove the other member's first-round change.
    const again = f.sources[0];
    fs.writeFileSync(path.join(again.workspace, 'alpha.txt'), 'source 0 round two\n');
    await git(again.workspace, 'add', '.'); await git(again.workspace, 'commit', '-m', 'second increment');
    await f.project.requestTaskMerge(again.id);
    pinLegacy(f, again.id, f.entry);
    const second = await f.project.formConvergenceBatch(run.parent_id);
    expect(second.id).not.toBe(run.id); expect(f.store.deliveryMembers(second.id)).toHaveLength(1);
    expect(f.store.deliveryMembers(second.id)[0].base_commit).toBe(again.head_commit);
    await f.project.prepareConvergenceRun(second.id, 1, new AbortController().signal);
    const landedAgain = f.store.deliveryRun(second.id);
    expect(landedAgain.state).toBe('integrated');
    expect(fs.readFileSync(path.join(f.root, 'alpha.txt'), 'utf8')).toBe('source 0 round two\n');
    expect(fs.readFileSync(path.join(f.root, 'beta.txt'), 'utf8')).toBe('source 1\n');
    expect(await taskDeliveryState(f.project, f.store.task(again.id))).toBe('merged');
    await f.project.syncTaskParent(f.sources[1].id);
    expect(fs.readFileSync(path.join(f.sources[1].workspace, 'alpha.txt'), 'utf8')).toBe('source 0 round two\n');
    expect(fs.readFileSync(path.join(f.sources[1].workspace, 'beta.txt'), 'utf8')).toBe('source 1\n');
  } finally { await f.close(); }
});

test('a parent baseline change reuses the fixed aggregate as a two-input refresh and revalidates the new exact candidate', async () => {
  const f = await setup(1, 'test -f alpha.txt'); try {
    const actual = f.project.workspaces.runConvergenceValidation.bind(f.project.workspaces);
    let validations = 0;
    f.project.workspaces.runConvergenceValidation = async (...args) => {
      const result = await actual(...args); validations++;
      if (validations === 1) await f.project.workspaces.exclusive(async () => {
        fs.writeFileSync(path.join(f.root, 'parent.txt'), 'concurrent parent increment\n');
        await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'parent advances during isolated validation');
      });
      return result;
    };
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const refreshed = f.store.deliveryRun(f.run.id), data = convergenceJSON(refreshed.data);
    expect(refreshed).toMatchObject({ generation: 2, state: 'preparing', candidate_commit: null });
    expect(data.plan).toMatchObject({ variant: 'baseline_refresh' });
    expect(data.plan.nodes).toHaveLength(1);
    const oldRoot = f.store.deliveryNodes(f.run.id, 1)[0], oldOutput = convergenceJSON(oldRoot.result);
    expect(data.plan.nodes[0]).toMatchObject({ base: f.baseline, left: refreshed.baseline, right: oldOutput.commit });
    await f.project.prepareConvergenceRun(f.run.id, 2, new AbortController().signal);
    const landed = f.store.deliveryRun(f.run.id), finalRoot = convergenceJSON(landed.data).root_commit;
    expect(landed.state).toBe('integrated'); expect(validations).toBe(2);
    expect(await f.project.workspaces.isAncestor(f.root, oldOutput.commit, finalRoot)).toBe(true);
    expect(await git(f.root, 'show', '-s', '--format=%P', landed.candidate_commit)).toBe(refreshed.baseline);
    expect(fs.readFileSync(path.join(f.root, 'parent.txt'), 'utf8')).toBe('concurrent parent increment\n');
    expect(fs.readFileSync(path.join(f.root, 'alpha.txt'), 'utf8')).toBe('source 0\n');
  } finally { await f.close(); }
});

test('a lost DB finalization reconciles the exact landed batch without replaying Git or Shell', async () => {
  const f = await setup(1, 'test -f alpha.txt'); try {
    const original = f.project.finalizeConvergence.bind(f.project);
    f.project.finalizeConvergence = () => { throw new Error('controlled DB finalization interruption'); };
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const interrupted = f.store.deliveryRun(f.run.id);
    expect(interrupted.state).toBe('blocked'); expect(interrupted.landing_receipt).not.toBeNull();
    expect(await git(f.root, 'rev-parse', 'main')).toBe(interrupted.candidate_commit);
    f.project.finalizeConvergence = original;
    f.project.workspaces.applyConvergencePublishUnsafe = () => { throw new Error('must not replay Git'); };
    f.project.workspaces.runConvergenceValidation = () => { throw new Error('must not replay Shell'); };
    expect(await f.project.publishConvergence(interrupted.id)).toBe(true);
    expect(f.store.deliveryRun(interrupted.id).state).toBe('integrated');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='worker.merge_received'").n).toBe(1);
    expect(await f.project.publishConvergence(interrupted.id)).toBe(false);
    const receipt = convergenceJSON(f.store.deliveryRun(interrupted.id).landing_receipt);
    // An equivalent source/tree cannot substitute for lost immutable batch evidence.
    await git(f.root, 'update-ref', receipt.evidence.ref, f.sources[0].head_commit, receipt.evidence.commit);
    expect(await taskDeliveryState(f.project, f.store.task(f.sources[0].id))).toBe('pending');
    expect(await f.project.workspaces.squashedLanded(f.sources[0].branch, interrupted.candidate_commit)).toBe(false);
  } finally { await f.close(); }
});

test('revocation after the real command returns invalidates the attempt, cleans only its exact resource and never publishes', async () => {
  const f = await setup(1, 'test -f alpha.txt'); try {
    const actual = f.project.workspaces.runConvergenceValidation.bind(f.project.workspaces);
    f.project.workspaces.runConvergenceValidation = async (...args) => {
      const result = await actual(...args);
      expect(result.status).toBe('succeeded');
      f.project.authorizeShortcutCommand(f.entry.id, 1, false, f.project.shortcutCommands().revision);
      return result;
    };
    expect(f.project.startConvergenceJob(f.run.id)).toBe(true);
    await f.project.convergenceJobs.get(f.run.id).promise;
    const run = f.store.deliveryRun(f.run.id);
    expect(run.state).toBe('failed'); expect(run.landing_receipt).toBeNull();
    expect(convergenceJSON(run.validation_result).state).toBe('unknown');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
    expect(f.store.task(f.sources[0].id).integration).not.toBe('merged');
    const registration = convergenceJSON(f.store.get('SELECT value FROM meta WHERE key=?', `convergence_validation:${run.id}:1`).value);
    expect(registration).toMatchObject({ state: 'removed', result: { status: 'succeeded' } });
    expect(fs.existsSync(registration.checkout.path)).toBe(false);
    expect(await git(f.root, 'rev-parse', '--verify', `refs/lush/convergence-evidence/${run.id}/1`).catch(() => null)).toBeNull();
  } finally { await f.close(); }
});

test('real v2 and v3 share enqueue priority and parent ownership, while switching off preserves fixed v3 delivery', async () => {
  const f = await setup(); try {
    const publish = f.project.publishConvergence.bind(f.project);
    f.project.publishConvergence = async () => false;
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    f.project.publishConvergence = publish;
    expect(f.store.deliveryRun(f.run.id).state).toBe('ready');
    await f.project.setBranchConvergence('main', false, null, (await f.project.branchConvergence('main')).revision);
    const { task: older } = await f.project.order('ordinary v2 later arrival');
    fs.writeFileSync(path.join(older.workspace, 'gamma.txt'), 'ordinary source\n');
    await git(older.workspace, 'add', '.'); await git(older.workspace, 'commit', '-m', 'ordinary arrival');
    f.store.update(older.id, { status: 'waiting' }); await f.project.requestTaskMerge(older.id);
    expect(convergenceJSON(f.store.task(older.id).reservation).version).toBe(2);
    await f.project.driveTaskMerge(f.run.parent_id);
    expect(convergenceJSON(f.store.task(older.id).reservation).status).toBe('requested');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
    expect(await f.project.publishConvergence(f.run.id)).toBe(true);
    expect(f.store.deliveryRun(f.run.id).state).toBe('integrated');
    const firstLanding = await git(f.root, 'rev-parse', 'main');
    await f.project.driveTaskMerge(f.run.parent_id);
    expect(convergenceJSON(f.store.task(older.id).reservation).status).toBe('resolving');
    expect(f.project.activeTaskMerge(f.run.parent_id).id).toBe(older.id);
    await f.project.setBranchConvergence('main', true, { command_id: f.entry.id, command_version: 1 }, (await f.project.branchConvergence('main')).revision);
    const next = f.sources[0];
    fs.writeFileSync(path.join(next.workspace, 'alpha.txt'), 'independent next round\n');
    await git(next.workspace, 'add', '.'); await git(next.workspace, 'commit', '-m', 'next fixed round');
    f.store.update(next.id, { status: 'waiting' }); await f.project.requestTaskMerge(next.id);
    pinLegacy(f, next.id, f.entry);
    const blocked = await f.project.formConvergenceBatch(f.run.parent_id);
    await f.project.prepareConvergenceRun(blocked.id, 1, new AbortController().signal);
    expect(f.store.deliveryRun(blocked.id).state).toBe('ready');
    expect(await f.project.publishConvergence(blocked.id)).toBe(false);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(firstLanding);
    expect(f.project.activeTaskMerge(f.run.parent_id).id).toBe(older.id);
  } finally { await f.close(); }
});
