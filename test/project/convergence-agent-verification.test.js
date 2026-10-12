import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { convergenceJSON } from '../../src/core/convergence-contract.js';

// Assembled SQL/Git/runtime. Only branch-policy mounting is a fixed seam (owned by a sibling).
async function setup(count = 2) {
  const f = fixture();
  f.project.kick = () => {};
  f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  f.project.convergencePolicy = () => ({ enabled: true, generation: 1, mounted: true });
  f.project.resolveShortcutCommand = () => { throw new Error('new delivery must not resolve a command'); };
  f.project.workspaces.createConvergenceValidationUnsafe = () => { throw new Error('new delivery must not create validation checkout'); };
  f.project.workspaces.runConvergenceValidation = () => { throw new Error('new delivery must not run Shell validation'); };
  try {
    await repo(f.root); await f.project.bootstrapMain();
    const baseline = await git(f.root, 'rev-parse', 'main'), sources = [];
    for (let i = 0; i < count; i++) {
      const { task } = await f.project.order(`agent verified source ${i}`);
      fs.writeFileSync(path.join(task.workspace, `source-${i}.txt`), `source ${i}\n`);
      await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', `source ${i}`);
      f.store.update(task.id, { status: 'waiting' });
      await f.project.requestTaskMerge(task.id);
      sources.push(f.store.task(task.id));
      expect(convergenceJSON(sources.at(-1).reservation)).toMatchObject({ version: 3, verification_mode: 'agent', validation: null });
    }
    return { ...f, baseline, sources, parentId: sources[0].parent_id };
  } catch (error) { await f.close(); throw error; }
}

async function prepare(f, run) {
  await f.project.prepareConvergenceRun(run.id, run.generation, new AbortController().signal);
  return f.store.deliveryRun(run.id);
}
function assertNoCommandEvidence(f, run) {
  expect(run).toMatchObject({ validation: null, validation_result: null });
  expect(convergenceJSON(run.data).verification_mode).toBe('agent');
  expect(f.store.all("SELECT key FROM meta WHERE key LIKE 'convergence_validation:%'")).toHaveLength(0);
}

test('new fixed deliveries publish one single-parent batch with no command/catalog/checkout and preserve multi-round increments', async () => {
  const f = await setup(); try {
    const run = await f.project.formConvergenceBatch(f.parentId), landed = await prepare(f, run);
    expect(landed.state).toBe('integrated'); assertNoCommandEvidence(f, landed);
    expect(await git(f.root, 'show', '-s', '--format=%P', landed.candidate_commit)).toBe(f.baseline);
    expect((await f.project.branchConvergenceRuns('main')).items[0].validation).toBeNull();
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='integration'").n).toBe(0);
    const source = f.sources[0];
    fs.writeFileSync(path.join(source.workspace, 'source-0.txt'), 'round two\n');
    await git(source.workspace, 'add', '.'); await git(source.workspace, 'commit', '-m', 'new increment');
    await f.project.requestTaskMerge(source.id);
    const next = await f.project.formConvergenceBatch(f.parentId), second = await prepare(f, next);
    expect(second.state).toBe('integrated'); assertNoCommandEvidence(f, second);
    expect(f.store.deliveryMembers(next.id)[0].base_commit).toBe(source.head_commit);
    expect(fs.readFileSync(path.join(f.root, 'source-0.txt'), 'utf8')).toBe('round two\n');
    expect(fs.readFileSync(path.join(f.root, 'source-1.txt'), 'utf8')).toBe('source 1\n');
    await f.project.syncTaskParent(f.sources[1].id);
    expect(fs.readFileSync(path.join(f.sources[1].workspace, 'source-0.txt'), 'utf8')).toBe('round two\n');
  } finally { await f.close(); }
});

test('parent change refreshes fixed aggregate on a new generation without repeating or claiming Shell verification', async () => {
  const f = await setup(1); try {
    const run = await f.project.formConvergenceBatch(f.parentId);
    const publish = f.project.publishConvergence.bind(f.project); f.project.publishConvergence = async () => false;
    const ready = await prepare(f, run); expect(ready.state).toBe('ready'); assertNoCommandEvidence(f, ready);
    const oldRoot = convergenceJSON(f.store.deliveryNodes(run.id, 1)[0].result);
    fs.writeFileSync(path.join(f.root, 'parent.txt'), 'new parent intent\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'parent advances');
    f.project.publishConvergence = publish;
    expect(await publish(run.id)).toBe(false);
    const refreshed = f.store.deliveryRun(run.id);
    expect(refreshed).toMatchObject({ generation: 2, state: 'preparing', candidate_commit: null });
    expect(convergenceJSON(refreshed.data).plan).toMatchObject({ variant: 'baseline_refresh' });
    const final = await prepare(f, refreshed); expect(final.state).toBe('integrated'); assertNoCommandEvidence(f, final);
    expect(await f.project.workspaces.isAncestor(f.root, oldRoot.commit, convergenceJSON(final.data).root_commit)).toBe(true);
    expect(await git(f.root, 'show', '-s', '--format=%P', final.candidate_commit)).toBe(refreshed.baseline);
    expect(fs.readFileSync(path.join(f.root, 'parent.txt'), 'utf8')).toBe('new parent intent\n');
  } finally { await f.close(); }
});

test('old policy validation version changes and revocation cannot block a new agent delivery or retry', async () => {
  const f = await setup(1); try {
    const run = await f.project.formConvergenceBatch(f.parentId);
    f.project.convergencePolicy = () => ({ enabled: false, generation: 99, validation: { command_id: 'removed', command_version: 2 } });
    f.store.updateDeliveryRun(run.id, { state: 'failed', error: 'controlled preparation interruption' });
    const view = (await f.project.branchConvergenceRuns('main')).items[0];
    const retry = await f.project.retryBranchConvergence(run.id, view.revision);
    expect(retry.state).toBe('preparing');
    const final = await prepare(f, f.store.deliveryRun(run.id));
    expect(final.state).toBe('integrated'); assertNoCommandEvidence(f, final);
  } finally { await f.close(); }
});

test('legacy command and new agent requests never share a batch, even when ready together', async () => {
  const f = await setup(); try {
    const legacySource = f.sources[0], reference = { command_id: '00000000-0000-4000-8000-000000000001', command_version: 1 };
    const { verification_mode, ...booking } = convergenceJSON(legacySource.reservation);
    f.store.update(legacySource.id, { reservation: JSON.stringify({ ...booking, validation: reference }) });
    const legacy = await f.project.formConvergenceBatch(f.parentId), agent = await f.project.formConvergenceBatch(f.parentId);
    expect(f.store.deliveryMembers(legacy.id).map(member => member.task_id)).toEqual([legacySource.id]);
    expect(convergenceJSON(legacy.data).verification_mode).toBe('command');
    expect(convergenceJSON(legacy.validation)).toEqual(reference);
    expect(f.store.deliveryMembers(agent.id).map(member => member.task_id)).toEqual([f.sources[1].id]);
    assertNoCommandEvidence(f, agent);
    expect(() => f.project.assertConvergenceAuthorization(legacy)).toThrow('must not resolve');
    expect(f.project.assertConvergenceAuthorization(agent)).toBeNull();
  } finally { await f.close(); }
});

for (const damage of ['missing_mode', 'unknown_mode', 'missing_validation', 'command_reference', 'member_mode', 'fake_passed']) {
  test(`damaged ${damage} never authorizes command-free publication or retry`, async () => {
    const f = await setup(1); try {
      const run = await f.project.formConvergenceBatch(f.parentId);
      const publish = f.project.publishConvergence.bind(f.project); f.project.publishConvergence = async () => false;
      await prepare(f, run); f.project.publishConvergence = publish;
      const ready = f.store.deliveryRun(run.id), data = convergenceJSON(ready.data);
      if (damage === 'missing_mode') { delete data.verification_mode; f.store.updateDeliveryRun(run.id, { data }); }
      if (damage === 'unknown_mode') f.store.updateDeliveryRun(run.id, { data: { ...data, verification_mode: 'skip' } });
      // Deliberate storage corruption bypasses Store's immutable validation reference API.
      if (damage === 'missing_validation') f.store.run('UPDATE delivery_runs SET validation=? WHERE id=?', '{}', run.id);
      if (damage === 'command_reference') f.store.run('UPDATE delivery_runs SET validation=? WHERE id=?',
        JSON.stringify({ command_id: '00000000-0000-4000-8000-000000000001', command_version: 1 }), run.id);
      if (damage === 'member_mode') {
        const booking = convergenceJSON(f.store.task(f.sources[0].id).reservation); delete booking.verification_mode;
        f.store.update(f.sources[0].id, { reservation: JSON.stringify(booking) });
      }
      if (damage === 'fake_passed') f.store.updateDeliveryRun(run.id, { validation_result: { state: 'passed', tested_commit: ready.candidate_commit, tested_tree: ready.candidate_tree } });
      expect(await publish(run.id)).toBe(false);
      expect(f.store.deliveryRun(run.id)).toMatchObject({ state: 'failed', landing_receipt: null });
      expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
      if (damage !== 'fake_passed') {
        const view = (await f.project.branchConvergenceRuns('main')).items[0];
        await expect(f.project.retryBranchConvergence(run.id, view.revision)).rejects.toThrow();
      }
    } finally { await f.close(); }
  });
}

test('agent withdrawal rebuilds remaining members, recovery prepares them without Shell or fake passed result', async () => {
  const f = await setup(); try {
    const run = await f.project.formConvergenceBatch(f.parentId);
    expect(f.project.withdrawConvergenceMember(f.sources[0].id)).toMatchObject({ changed: true, withdrawal_pending: false });
    f.project.recoverConvergence();
    const next = f.store.deliveryRun(run.id); expect(next).toMatchObject({ generation: 2, state: 'preparing' });
    const final = await prepare(f, next); expect(final.state).toBe('integrated'); assertNoCommandEvidence(f, final);
    expect(fs.existsSync(path.join(f.root, 'source-0.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(f.root, 'source-1.txt'), 'utf8')).toBe('source 1\n');
  } finally { await f.close(); }
});

test('an unassigned v3 request with missing mode and validation cannot silently form an agent batch', async () => {
  const f = await setup(1); try {
    const booking = convergenceJSON(f.sources[0].reservation); delete booking.verification_mode;
    f.store.update(f.sources[0].id, { reservation: JSON.stringify(booking) });
    await expect(f.project.formConvergenceBatch(f.parentId)).rejects.toThrow('legacy convergence requires');
    expect(f.store.deliveryRuns(f.parentId)).toHaveLength(0);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
  } finally { await f.close(); }
});

test('recovery rejects an impossible agent validating state without manufacturing unknown or passed command evidence', async () => {
  const f = await setup(1); try {
    const run = await f.project.formConvergenceBatch(f.parentId);
    f.store.updateDeliveryRun(run.id, { state: 'validating' });
    f.project.recoverConvergence();
    const recovered = f.store.deliveryRun(run.id);
    expect(recovered.state).toBe('failed'); assertNoCommandEvidence(f, recovered);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
  } finally { await f.close(); }
});

test('agent publication recovery verifies exact landing once without reapplying or creating command evidence', async () => {
  const f = await setup(1); try {
    const run = await f.project.formConvergenceBatch(f.parentId), finalize = f.project.finalizeConvergence.bind(f.project);
    f.project.finalizeConvergence = () => { throw new Error('controlled DB interruption after Git'); };
    const blocked = await prepare(f, run); expect(blocked.state).toBe('blocked'); assertNoCommandEvidence(f, blocked);
    f.project.finalizeConvergence = finalize;
    f.project.workspaces.applyConvergencePublishUnsafe = () => { throw new Error('must not replay publication'); };
    f.project.recoverConvergence();
    expect(await f.project.publishConvergence(run.id)).toBe(true);
    const final = f.store.deliveryRun(run.id); expect(final.state).toBe('integrated'); assertNoCommandEvidence(f, final);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='worker.merge_received'").n).toBe(1);
  } finally { await f.close(); }
});
