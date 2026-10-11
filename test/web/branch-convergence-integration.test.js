import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { convergenceJSON } from '../../src/core/convergence-contract.js';

// Real authenticated HTTP -> socket RPC -> Project/SQLite -> Git/isolated Shell.
// Scheduling alone is controlled: no user services, live queues or model calls.
async function get(f, suffix) {
  const response = await fetch(f.url + suffix);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json();
}
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const result = await response.json();
  if (response.status !== status) throw new Error(`${method}: HTTP ${response.status}, expected ${status}: ${result.error}`);
  return result;
}
const policy = f => get(f, '/api/branch-convergence?branch=main');
const runs = f => get(f, '/api/branch-convergence/runs?branch=main');
const reference = entry => ({ command_id: entry.id, command_version: entry.version });
async function prepare(command = 'test -z "$LUSH_AGENT_TOKEN" && test -f alpha.txt && test -f beta.txt; result=$?; echo PRIVATE_VALIDATION_OUTPUT; exit "$result"') {
  const f = await setup();
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  f.project.provider = { run() { throw new Error('this HTTP integration suite must not call a model'); } };
  try {
    await repo(f.root); await f.project.bootstrapMain();
    const catalogue = await get(f, '/api/hooks');
    const saved = await post(f, 'hooks.command_save', { command: { name: 'HTTP exact validation', command,
      default_worker_id: f.store.get("SELECT id FROM tasks WHERE task_kind='main'").id },
      expected_revision: catalogue.commands.revision });
    return { ...f, entry: saved.commands.items.at(-1), baseline: await git(f.root, 'rev-parse', 'main') };
  } catch (error) { await f.close(); throw error; }
}
async function authorize(f, authorized) {
  return post(f, 'hooks.command_authorize', { id: f.entry.id, version: f.entry.version, authorized,
    expected_revision: (await get(f, '/api/hooks')).commands.revision });
}
async function configure(f, enabled) {
  const current = await policy(f);
  return post(f, 'branch.convergence_set', { branch: 'main', enabled, validation: reference(f.entry), expected_revision: current.revision });
}
async function source(f, file, content) {
  const { task } = await post(f, 'order.submit', { content: `HTTP source ${file}: ${content}`, branch: 'main', start: false });
  fs.writeFileSync(path.join(task.workspace, file), content + '\n');
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', `fixed ${file}`);
  f.store.update(task.id, { status: 'waiting', result: 'controlled source ready' });
  await post(f, 'worker.reserve', { id: task.id, kind: 'merge' });
  const fixed = f.store.task(task.id);
  expect(convergenceJSON(fixed.reservation).version).toBe(3);
  return fixed;
}
async function unchanged(f, sources) {
  for (const task of sources) {
    expect(await git(task.workspace, 'rev-parse', 'HEAD')).toBe(task.head_commit);
    expect(f.store.task(task.id).parent_id).toBe(task.parent_id);
  }
}

test('real HTTP authorization and revisions gate one validated batch without changing Worker automatic permissions', async () => {
  const f = await prepare();
  try {
    // A shortcut's default Worker must not redirect validation away from the isolated candidate.
    expect(f.entry.default_worker_id).toBe(f.store.get("SELECT id FROM tasks WHERE task_kind='main'").id);
    const initial = await policy(f);
    expect(initial).toMatchObject({ enabled: false, validation: null });
    const count = f.store.get('SELECT count(*) AS n FROM events').n;
    expect((await get(f, '/api/branch-convergence')).items[0]).toEqual(initial);
    expect((await runs(f)).items).toEqual([]);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(count);
    await post(f, 'branch.convergence_set', { branch: 'main', enabled: true, validation: reference(f.entry),
      expected_revision: initial.revision }, 400);
    expect((await policy(f)).enabled).toBe(false);
    await authorize(f, true);
    const enabled = await configure(f, true);
    expect(enabled.validation).toMatchObject({ ...reference(f.entry), authorized: true });
    await post(f, 'branch.convergence_set', { branch: 'main', enabled: false, validation: null,
      expected_revision: initial.revision }, 400);
    const sources = [await source(f, 'alpha.txt', 'alpha'), await source(f, 'beta.txt', 'beta')];
    const batch = await f.project.formConvergenceBatch(sources[0].parent_id);
    const fixed = (await runs(f)).items[0];
    expect(fixed).toMatchObject({ id: batch.id, state: 'preparing', member_count: 2 });
    expect(fixed.members.map(member => member.worker_number)).toEqual(sources.map(task => task.worker_number));
    // The toggle affects new requests only, not these fixed members.
    expect((await configure(f, false)).enabled).toBe(false);
    await f.project.prepareConvergenceRun(batch.id, 1, new AbortController().signal);
    const delivered = (await runs(f)).items[0];
    expect(delivered).toMatchObject({ state: 'integrated', validation: { state: 'passed', command_name: f.entry.name } });
    expect(delivered.commit).toBe(await git(f.root, 'rev-parse', 'main'));
    expect(await git(f.root, 'show', '-s', '--format=%P', delivered.commit)).toBe(f.baseline);
    expect(await git(f.root, 'rev-list', '--count', `${f.baseline}..main`)).toBe('1');
    expect(JSON.stringify(delivered)).not.toContain('PRIVATE_VALIDATION_OUTPUT');
    expect(JSON.stringify(f.store.all('SELECT * FROM delivery_runs'))).not.toContain('PRIVATE_VALIDATION_OUTPUT');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='worker.merge_received'").n).toBe(1);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='integration'").n).toBe(0);
    for (const task of sources) {
      expect(f.store.task(task.id)).toMatchObject({ status: 'awaiting_acceptance', integration: 'merged' });
      expect(f.project.autoMergeView(f.store.task(task.id)).enabled).toBe(false);
    }
    await unchanged(f, sources);
    const graph = await get(f, '/api/version-graph');
    const landing = graph.commits.find(row => row.commit === delivered.commit);
    expect(landing.tasks.map(task => task.id).sort()).toEqual(sources.map(task => task.id).sort());
    for (const association of landing.tasks) {
      expect(association.delivery_available).toBe(true);
      const member = sources.find(task => task.id === association.id);
      expect(await git(f.root, 'rev-parse', `${member.head_commit}^{tree}`)).not.toBe(await git(f.root, 'rev-parse', `${delivered.commit}^{tree}`));
      const nested = await get(f, `/api/version-graph?delivery=${association.delivery_id}`);
      expect(nested).toMatchObject({ scope: 'delivery', tip: member.head_commit, base: member.base_commit });
      expect(nested.commits.map(row => row.commit)).toEqual([member.head_commit]);
    }
    // Fixed graphs must not inherit the canonical repository's replace-ref view.
    await git(f.root, 'replace', sources[0].head_commit, sources[1].head_commit);
    const original = landing.tasks.find(task => task.id === sources[0].id);
    const sterile = await get(f, `/api/version-graph?delivery=${original.delivery_id}`);
    expect(sterile.commits[0]).toMatchObject({ commit: sources[0].head_commit, subject: 'fixed alpha.txt' });
    await git(f.root, 'replace', '-d', sources[0].head_commit);
    // The v3 flag alone must never bypass legacy tree equality or the exact member mapping.
    const tampered = landing.tasks[0];
    const event = f.store.get('SELECT data FROM events WHERE id=?', tampered.delivery_id);
    f.store.run('UPDATE events SET data=? WHERE id=?', JSON.stringify({ ...JSON.parse(event.data),
      source_commit: sources.find(task => task.id !== tampered.id).head_commit }), tampered.delivery_id);
    expect((await get(f, '/api/version-graph')).commits[0].tasks.find(task => task.id === tampered.id).delivery_available).toBe(false);
    const refused = await fetch(f.url + `/api/version-graph?delivery=${tampered.delivery_id}`);
    expect(refused.status).toBe(400);
  } finally { await f.close(); }
});

test('real HTTP retry keeps a revoked fixed delivery unpublished and requires current authorization plus exact run revision', async () => {
  const f = await prepare();
  try {
    await authorize(f, true); await configure(f, true);
    const sources = [await source(f, 'alpha.txt', 'alpha'), await source(f, 'beta.txt', 'beta')];
    const batch = await f.project.formConvergenceBatch(sources[0].parent_id);
    const previous = (await runs(f)).items[0];
    await authorize(f, false);
    expect(f.project.startConvergenceJob(batch.id)).toBe(true);
    await f.project.convergenceJobs.get(batch.id).promise;
    const failed = (await runs(f)).items[0];
    expect(failed.state).toBe('failed'); expect(failed.revision).not.toBe(previous.revision);
    expect((await policy(f)).validation.authorized).toBe(false);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
    expect(f.store.deliveryRun(batch.id).landing_receipt).toBeNull();
    await post(f, 'branch.convergence_retry', { id: batch.id, expected_revision: failed.revision }, 400);
    await authorize(f, true);
    await post(f, 'branch.convergence_retry', { id: batch.id, expected_revision: previous.revision }, 400);
    const retry = await post(f, 'branch.convergence_retry', { id: batch.id, expected_revision: failed.revision });
    expect(retry).toMatchObject({ id: batch.id, state: 'preparing' });
    expect(retry.revision).not.toBe(failed.revision);
    expect(f.store.deliveryRun(batch.id).generation).toBe(2);
    await f.project.prepareConvergenceRun(batch.id, 2, new AbortController().signal);
    const integrated = (await runs(f)).items[0];
    expect(integrated).toMatchObject({ state: 'integrated', validation: { state: 'passed' } });
    await post(f, 'branch.convergence_retry', { id: batch.id, expected_revision: integrated.revision }, 400);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='worker.merge_received'").n).toBe(1);
    await unchanged(f, sources);
  } finally { await f.close(); }
});

test('real HTTP shows an isolated conflict helper while a later unrelated ready batch bypasses it', async () => {
  const f = await prepare('test -f independent.txt');
  try {
    await authorize(f, true); await configure(f, true);
    const conflictSources = [await source(f, 'file.txt', 'left'), await source(f, 'file.txt', 'right')];
    const conflict = await f.project.formConvergenceBatch(conflictSources[0].parent_id);
    await f.project.prepareConvergenceRun(conflict.id, 1, new AbortController().signal);
    const waiting = (await runs(f)).items[0];
    expect(waiting).toMatchObject({ state: 'resolving', integration_worker: { status: 'queued' } });
    const helper = f.store.task(waiting.integration_worker.id);
    expect(waiting.integration_worker.worker_number).toBe(helper.worker_number);
    expect(helper.task_kind).toBe('integration'); expect(helper.workspace).not.toBe(f.root);
    expect(f.project.branchFreeze('main')).toBeNull();
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
    const independent = await source(f, 'independent.txt', 'independent');
    const ready = await f.project.formConvergenceBatch(independent.parent_id);
    expect(f.store.deliveryMembers(ready.id).map(member => member.task_id)).toEqual([independent.id]);
    await f.project.prepareConvergenceRun(ready.id, 1, new AbortController().signal);
    const history = await get(f, '/api/branch-convergence/runs?branch=main&limit=1');
    expect(history).toMatchObject({ has_more: true, next_before: ready.id });
    expect(history.items[0]).toMatchObject({ id: ready.id, state: 'integrated', validation: { state: 'passed' } });
    const older = await get(f, `/api/branch-convergence/runs?branch=main&limit=1&before=${history.next_before}`);
    expect(older.items[0]).toMatchObject({ id: conflict.id, state: 'resolving', integration_worker: { id: helper.id } });
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('base\n');
    expect(fs.readFileSync(path.join(f.root, 'independent.txt'), 'utf8')).toBe('independent\n');
    expect(f.store.task(helper.id).calls).toBe(0);
    await unchanged(f, [...conflictSources, independent]);
  } finally { await f.close(); }
});
