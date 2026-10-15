import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { convergenceJSON as parse } from '../../src/core/convergence-contract.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { RPCServer } from '../../src/rpc/server.js';
import { RPCClient } from '../../src/rpc/client.js';
import { createSignal } from '../../src/signal.js';
import { PiProvider } from '../../src/agent/provider.js';
import { Project } from '../../src/core/project.js';
import { fileURLToPath } from 'node:url';

async function setup(count = 2, provider = null, kind = 'main') {
  const f = fixture(provider ?? { run: combine }, { LUSH_CONCURRENCY: '1' });
  const kick = f.project.kick.bind(f.project), merge = f.project.scheduleTaskMerge.bind(f.project), converge = f.project.scheduleConvergence.bind(f.project);
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  try {
    await repo(f.root); let owner = await f.project.bootstrapMain();
    if (kind === 'owner') {
      await git(f.root, 'branch', 'owned'); owner = await f.project.bindBranch('owned', await git(f.root, 'rev-parse', 'owned'));
      owner = f.store.task(owner.id ?? owner.task_id);
    } else if (kind !== 'main') {
      owner = (await f.project.order('target order')).task;
      if (kind === 'child') { f.store.update(owner.id, { status: 'waiting' }); owner = await f.project.spawn(owner.id, 'target child'); }
      f.store.update(owner.id, { status: 'waiting', reservation: null }); owner = f.store.task(owner.id);
    }
    const sources = [];
    for (let i = 0; i < count; i++) {
      const source = ['main','owner'].includes(owner.task_kind) ? (await f.project.order(`source ${i}`, owner.branch)).task : await f.project.spawn(owner.id, `source ${i}`);
      fs.writeFileSync(path.join(source.workspace, `source-${i}.txt`), `value ${i}\n`);
      await git(source.workspace, 'add', '.'); await git(source.workspace, 'commit', '-m', `source ${i}`);
      await f.project.workspaces.finish(f.store.task(source.id));
      f.store.update(source.id, { status: 'waiting', result: `source ${i} tested report`, reservation: null });
      sources.push(f.store.task(source.id));
    }
    const baseline = await git(f.root, 'rev-parse', owner.branch);
    return { ...f, sources, owner, baseline,
      start() { f.project.kick = kick; f.project.scheduleTaskMerge = merge; f.project.scheduleConvergence = converge; kick(); },
      stop() { f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {}; } };
  } catch (error) { await f.close(); throw error; }
}

async function combine({ task, cwd, context, api, token }) {
  expect(task.task_kind).toBe('integration');
  expect(context.integration.operation_mode).toBe('one_shot');
  expect(context.integration.autonomy).toContain('Agent chooses');
  expect(context.integration.members.every(member => member.base_commit && member.report.includes('tested report'))).toBe(true);
  const rpc = new Dispatcher(api);
  expect(await rpc.dispatch('worker.inspect', { _token: token, id: task.id })).toMatchObject({ id: task.id, task_kind: 'integration' });
  await expect(rpc.dispatch('worker.spawn', { _token: token, goal: 'forbidden' })).rejects.toThrow('integration agents can only');
  await rpc.dispatch('progress.plan', { _token: token, steps: [{ key: 'verify', label: 'verify exact combined tree' }] });
  const fixed = context.integration;
  if (fixed.tests_invalidated) await git(cwd, 'merge', '--no-edit', fixed.baseline);
  for (const member of fixed.members) {
    if (await git(cwd, 'merge-base', '--is-ancestor', member.source_commit, 'HEAD').then(() => true, () => false)) continue;
    // The controlled Agent chooses a real merge for a common baseline, and an exact
    // delta for later Squash rounds whose source baseline is not on the target.
    if (await git(cwd, 'merge-base', '--is-ancestor', member.base_commit, fixed.baseline).then(() => true, () => false)) {
      await git(cwd, 'merge', '--no-edit', member.source_commit); continue;
    }
    const patch = await git(cwd, 'diff', '--binary', member.base_commit, member.source_commit);
    if (patch) {
      const proc = Bun.spawn(['git', '-C', cwd, 'apply', '--3way', '-'], { stdin: new TextEncoder().encode(patch + '\n'), stdout: 'pipe', stderr: 'pipe' });
      const error = await new Response(proc.stderr).text(); expect(await proc.exited, error).toBe(0);
      if (await git(cwd, 'diff', '--cached', '--name-only')) await git(cwd, 'commit', '-m', `apply increment ${member.task_id}`);
    }
    await git(cwd, 'merge', '-s', 'ours', '--no-edit', member.source_commit);
  }
  // A controlled real command on the final combination, not fabricated runtime verification.
  const result = Bun.spawnSync(['git', '-C', cwd, 'diff', '--exit-code'], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  await rpc.dispatch('progress.complete', { _token: token, step: 'verify' });
  return 'controlled Agent applied exact increments; git diff --exit-code passed; no production-model quality claim';
}

async function landed(f, operation) {
  await until(() => ['integrated', 'failed', 'blocked'].includes(f.store.deliveryRun(operation.id).state), 12000);
  const run = f.store.deliveryRun(operation.id);
  expect(run.state, run.error).toBe('integrated');
  return f.project.branchIntegration(operation.id);
}
async function sourcesUnchanged(f) {
  for (const source of f.sources) {
    const task = f.store.task(source.id);
    expect(task.parent_id).toBe(source.parent_id); expect(task.target_branch).toBe(source.target_branch);
    expect(task.branch).toBe(source.branch); expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(source.head_commit);
  }
}

test('one-shot fixes all nine sources, always invokes one autonomous Agent, then publishes exactly one Squash', async () => {
  let calls = 0;
  const f = await setup(9, { run: async args => { calls++; return combine(args); } });
  try {
    f.project.workspaces.mergeConvergenceObjects = () => { throw new Error('runtime must not choose pairings or merge source objects'); };
    const before = f.store.get('SELECT count(*) AS n FROM events').n;
    const rpc = new Dispatcher(f.project);
    const plan = await rpc.dispatch('branch.integrate_plan', { branch: 'main' });
    expect(plan).toMatchObject({ ready: true, count: 9, active: null }); expect(plan.members).toHaveLength(9);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before); // Read-only preflight.
    const operation = await rpc.dispatch('branch.integrate_start', { branch: 'main', expected_revision: plan.revision });
    expect(operation.member_count).toBe(9); expect(operation.members_truncated).toBe(false); expect(operation.worker.id).toBeTruthy();
    expect((await Promise.all([f.project.branchIntegrateStart('main', plan.revision), f.project.branchIntegrateStart('main', plan.revision)]))
      .map(item => item.id)).toEqual([operation.id, operation.id]);
    expect(f.project.inspect(operation.worker.id).merge_operation.id).toBe(operation.id);
    expect(f.project.inspect(f.sources[0].id).merge_operation.id).toBe(operation.id);
    expect(f.project.inspect(f.owner.id).merge_operation.id).toBe(operation.id);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
    f.start(); const result = await landed(f, operation);
    expect(calls).toBe(1); expect(result.worker.status).toBe('awaiting_acceptance');
    expect(await git(f.root, 'rev-list', '--count', `${f.baseline}..main`)).toBe('1');
    expect(await git(f.root, 'show', '-s', '--format=%P', result.commit)).toBe(f.baseline);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='worker.merge_received'").n).toBe(1);
    expect(f.store.deliveryRun(operation.id).validation_result).toBeNull();
    expect(f.store.deliveryMembers(operation.id)).toHaveLength(9); await sourcesUnchanged(f);
    for (let i = 0; i < 9; i++) expect(fs.readFileSync(path.join(f.root, `source-${i}.txt`), 'utf8')).toBe(`value ${i}\n`);
    expect((await rpc.dispatch('branch.integration', { id: operation.id })).state).toBe('integrated');
    expect(f.project.inspect(f.sources[0].id).merge_operation.state).toBe('integrated');
    const legacy = (await f.project.branchConvergenceRuns('main')).items[0];
    expect(legacy).toMatchObject({ member_count: 9, members_truncated: true }); expect(legacy.members).toHaveLength(8);
    const graph = await rpc.dispatch('worker.graph', {});
    expect(graph.nodes.find(node => node.id === operation.worker.id).merge_operation.state).toBe('integrated');
    expect(graph.nodes.find(node => node.id === f.owner.id).merge_operation.state).toBe('integrated');
  } finally { await f.close(); }
});

test('plan excludes dirty, unread, active descendants and executing ordinary requests, and revisions reject races', async () => {
  const f = await setup(5);
  try {
    fs.writeFileSync(path.join(f.sources[0].workspace, 'dirty'), 'uncommitted');
    f.store.message(f.sources[1].id, 'unread user input');
    const child = await f.project.spawn(f.sources[2].id, 'unsettled descendant');
    f.store.update(child.id, { status: 'waiting' });
    f.store.update(f.sources[3].id, { reservation: JSON.stringify({ version: 2, kind: 'merge', status: 'executing', parent_id: f.owner.id,
      attempt_id: 101, commit: f.sources[3].head_commit, baseline: f.baseline }) });
    const plan = await f.project.branchIntegratePlan('main');
    expect(plan.count).toBe(1); expect(plan.excluded).toHaveLength(4);
    f.store.message(f.sources[4].id, 'new input after plan');
    await expect(f.project.branchIntegrateStart('main', plan.revision)).rejects.toThrow('revision changed');
    expect(f.store.get('SELECT count(*) AS n FROM delivery_runs').n).toBe(0);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
  } finally { await f.close(); }
});

test('multi-round exact member baselines do not replay already-squashed source contributions', async () => {
  const f = await setup(2);
  try {
    let plan = await f.project.branchIntegratePlan('main'), op = await f.project.branchIntegrateStart('main', plan.revision);
    f.start(); await landed(f, op); f.stop();
    // A later main adaptation must survive the next source increment.
    fs.writeFileSync(path.join(f.root, 'source-0.txt'), 'target adapted old contribution\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'target adaptation');
    const source = f.sources[0];
    fs.writeFileSync(path.join(source.workspace, 'second-round.txt'), 'new increment\n');
    await git(source.workspace, 'add', '.'); await git(source.workspace, 'commit', '-m', 'source next increment');
    await f.project.workspaces.finish(f.store.task(source.id));
    f.store.update(source.id, { reservation: null, status: 'waiting', result: 'next round tested report' });
    plan = await f.project.branchIntegratePlan('main'); expect(plan.count).toBe(1);
    expect(plan.members[0].base_commit).toBe(source.head_commit);
    op = await f.project.branchIntegrateStart('main', plan.revision); f.start(); await landed(f, op);
    expect(fs.readFileSync(path.join(f.root, 'source-0.txt'), 'utf8')).toBe('target adapted old contribution\n');
    expect(fs.readFileSync(path.join(f.root, 'second-round.txt'), 'utf8')).toBe('new increment\n');
  } finally { await f.close(); }
});

test('cancellation invalidates a running candidate, waits for actual exit and retains every source', async () => {
  const entered = gate(), release = gate();
  const f = await setup(2, { run: async args => { entered.resolve(); await release.promise; return 'ignored obsolete output'; } });
  try {
    const plan = await f.project.branchIntegratePlan('main'), op = await f.project.branchIntegrateStart('main', plan.revision);
    f.start(); await entered.promise;
    const cancelled = await f.project.branchIntegrateCancel(op.id, f.project.branchIntegration(op.id).revision);
    expect(cancelled.state).toBe('awaiting'); expect(f.store.deliveryMembers(op.id, true)).toHaveLength(2);
    release.resolve();
    await until(() => f.store.deliveryRun(op.id).state === 'withdrawn');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline); await sourcesUnchanged(f);
    expect(fs.existsSync(f.store.task(op.worker.id).workspace)).toBe(true);
    expect(f.store.deliveryMembers(op.id, true)).toHaveLength(0);
    const fresh = await f.project.branchIntegratePlan('main');
    expect(fresh.ready).toBe(true); expect(fresh.revision).not.toBe(plan.revision);
    f.stop();
    const again = await f.project.branchIntegrateStart('main', fresh.revision);
    expect(again.id).not.toBe(op.id);
  } finally { release.resolve(); await f.close(); }
});

test('target movement invalidates prior evidence and reuses the same Agent for semantic adaptation and fresh verification', async () => {
  let calls = 0, helperId, originalCreation, oldInvocation;
  const f = await setup(2, { run: async args => {
    calls++; helperId ??= args.task.id; expect(args.task.id).toBe(helperId);
    const creation = args.api.store.get("SELECT data FROM events WHERE task_id=? AND type='convergence.integration_created'", helperId).data;
    if (calls === 1) { originalCreation = creation; oldInvocation = args.context.invocation.run_id; }
    if (calls === 2) {
      expect(args.context.integration).toMatchObject({ tests_invalidated: true, reason: 'baseline_changed' });
      expect(creation).toBe(originalCreation);
      expect(fs.readFileSync(path.join(args.cwd, 'paid-adaptation.txt'), 'utf8')).toBe('retained semantic repair\n');
      await expect(args.api.completeConvergenceIntegration(helperId, oldInvocation)).rejects.toThrow('active attempt');
    }
    const result = await combine(args);
    if (calls === 1) {
      fs.writeFileSync(path.join(args.cwd, 'paid-adaptation.txt'), 'retained semantic repair\n');
      await git(args.cwd, 'add', '.'); await git(args.cwd, 'commit', '-m', 'paid semantic adaptation');
    }
    if (calls === 1) await args.api.workspaces.trackRefWrite('refs/heads/main', async () => {
      fs.writeFileSync(path.join(f.root, 'target-new.txt'), 'semantic migration\n');
      await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'tracked target change');
    });
    return result;
  } });
  try {
    const plan = await f.project.branchIntegratePlan('main'), op = await f.project.branchIntegrateStart('main', plan.revision);
    f.start(); const result = await landed(f, op);
    expect(calls).toBe(2); expect(result.generation).toBe(2);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='integration'").n).toBe(1);
    expect(fs.readFileSync(path.join(f.root, 'target-new.txt'), 'utf8')).toBe('semantic migration\n');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='integration.baseline_invalidated'").n).toBe(1);
    expect(f.store.all("SELECT data FROM events WHERE task_id=? AND type='integration.attempt_fixed' ORDER BY id", helperId)
      .map(row => parse(row.data).generation)).toEqual([1, 2]);
    expect(fs.readFileSync(path.join(f.root, 'paid-adaptation.txt'), 'utf8')).toBe('retained semantic repair\n');
  } finally { await f.close(); }
});

test('failed Agent leaves target unchanged; explicit revision retry uses the same retained private identity', async () => {
  let calls = 0;
  const f = await setup(1, { run: async args => { if (++calls === 1) throw new Error('controlled failure'); return combine(args); } });
  try {
    const plan = await f.project.branchIntegratePlan('main'), op = await f.project.branchIntegrateStart('main', plan.revision);
    f.start(); await until(() => f.store.deliveryRun(op.id).state === 'failed' && !f.project.running.has(op.worker.id));
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
    await expect(f.project.branchIntegrateRetry(op.id, 'stale')).rejects.toThrow('revision changed');
    await f.project.branchIntegrateRetry(op.id, f.project.branchIntegration(op.id).revision);
    const result = await landed(f, op); expect(calls).toBe(2); expect(result.worker.id).toBe(op.worker.id);
  } finally { await f.close(); }
});

for (const kind of ['owner', 'order', 'child']) test(`one-shot supports the real direct ${kind} target without reparenting`, async () => {
  const f = await setup(1, null, kind);
  try {
    const plan = await f.project.branchIntegratePlan(f.owner.branch);
    expect(plan.target.id).toBe(f.owner.id); expect(plan.count).toBe(1);
    const op = await f.project.branchIntegrateStart(f.owner.branch, plan.revision);
    f.start(); const result = await landed(f, op);
    expect(result.target.id).toBe(f.owner.id); await sourcesUnchanged(f);
    if (kind !== 'owner') expect(await git(f.root, 'rev-parse', 'main')).not.toBe(result.commit);
  } finally { await f.close(); }
});

test('Git-landed/DB-unsettled recovery proves the exact receipt and never replays publication', async () => {
  const f = await setup(1);
  const finish = f.project.finalizeConvergence.bind(f.project), apply = f.project.workspaces.applyConvergencePublishUnsafe.bind(f.project.workspaces);
  let writes = 0;
  f.project.workspaces.applyConvergencePublishUnsafe = async (...args) => { writes++; return apply(...args); };
  f.project.finalizeConvergence = () => { throw new Error('controlled DB settlement interruption'); };
  try {
    const plan = await f.project.branchIntegratePlan('main'), op = await f.project.branchIntegrateStart('main', plan.revision);
    f.start(); await until(() => f.store.deliveryRun(op.id).state === 'blocked' && !f.project.convergenceJobs?.has(op.id), 12000);
    f.stop(); const landedCommit = await git(f.root, 'rev-parse', 'main');
    expect(landedCommit).not.toBe(f.baseline); expect(writes).toBe(1);
    await expect(f.project.branchIntegrateRetry(op.id, f.project.branchIntegration(op.id).revision)).rejects.toThrow('unknown');
    f.project.finalizeConvergence = finish; f.project.recoverConvergence();
    // Recreate the recovery event under the real dispatcher rather than re-running an Agent.
    f.start(); f.project.scheduleConvergence(f.owner.id);
    await until(() => f.store.deliveryRun(op.id).state === 'integrated', 12000); await landed(f, op);
    expect(writes).toBe(1); expect(await git(f.root, 'rev-parse', 'main')).toBe(landedCommit);
    expect(f.store.task(op.worker.id).calls).toBe(1);
  } finally { await f.close(); }
});

test('real Pi Provider subprocess uses the registered lushc RPC bridge with integration permissions and returns one Git landing', async () => {
  const f = await setup(1);
  const cli = fileURLToPath(new URL('../../bin/lushc', import.meta.url));
  const executable = path.join(f.config.home, 'controlled-pi');
  const script = `#!/usr/bin/env bun
import fs from 'node:fs';
const args = process.argv.slice(2), prompt = args.find(arg => arg.startsWith('@'));
const input = JSON.parse(fs.readFileSync(prompt.slice(1), 'utf8')), cwd = process.cwd();
function run(argv) { const p = Bun.spawnSync(argv, { cwd, stdout:'pipe', stderr:'pipe' });
  return { code:p.exitCode, out:new TextDecoder().decode(p.stdout), error:new TextDecoder().decode(p.stderr) }; }
const bridge = (...argv) => run([process.execPath, ${JSON.stringify(cli)}, ...argv, '--json']);
const own = bridge('worker','inspect',String(input.task.id));
if (own.code || JSON.parse(own.out).task_kind !== 'integration') throw Error('real bridge inspection failed: ' + own.error);
const denied = bridge('worker','spawn','forbidden','--parent',String(input.task.id));
if (!denied.code || !denied.error.includes('integration agents can only')) throw Error('integration permission escaped');
if (bridge('progress','plan','combine:combine').code) throw Error('bridge progress unavailable');
for (const member of input.integration.members) {
  const merge = run(['git','merge','--no-edit',member.source_commit]);
  if (merge.code) throw Error(merge.error);
}
if (run(['git','diff','--exit-code']).code) throw Error('controlled combined validation failed');
if (bridge('progress','complete','combine').code) throw Error('bridge completion unavailable');
console.log('real controlled Pi + lushc bridge: final combined git diff --exit-code passed');
`;
  fs.writeFileSync(executable, script, { mode: 0o755 });
  f.config.env.LUSH_PI_COMMAND = executable;
  const profile = { agent: 'pi', config_mode: 'pi', model: '', thinking: '', extensions: [], skills: [], default_prompt: '', append_prompt: '', soft_budget: {} };
  f.project.provider = { resolve: () => profile, reportsInputDelivery: true, run: options => new PiProvider(f.config).run(options) };
  const server = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {}));
  await server.start();
  try {
    const client = new RPCClient(f.config.socket);
    const plan = await client.request('branch.integrate_plan', { branch: 'main' });
    const op = await client.request('branch.integrate_start', { branch: 'main', expected_revision: plan.revision });
    f.start(); await landed(f, op);
    expect((await client.request('branch.integration', { id: op.id })).state).toBe('integrated');
    expect(f.store.task(op.worker.id).result).toContain('real controlled Pi + lushc bridge');
    expect(f.store.task(op.worker.id).progress_plan).not.toBeNull();
    expect(f.store.task(op.worker.id).agent_token_hash).toBeNull();
    expect(await git(f.root, 'rev-list', '--count', `${f.baseline}..main`)).toBe('1');
    await sourcesUnchanged(f);
  } finally { await server.close(); await f.close(); }
});

test('a pending decision never partially publishes and resumes the same autonomous Worker after the answer', async () => {
  let calls = 0;
  const f = await setup(2, { run: async args => {
    if (++calls > 1) return combine(args);
    await new Dispatcher(args.api).dispatch('notice.post', { _token: args.token, title: '固定组合语义确认', body: '', questions: [
      { header: '适配', question: '是否保留固定来源的全部意图？', options: [
        { label: '保留并继续', description: '继续固定组合的语义适配和验证' },
        { label: '暂不继续', description: '保留来源与私有代码' },
      ] },
    ] });
    return 'awaiting user';
  } });
  try {
    const plan = await f.project.branchIntegratePlan('main'), op = await f.project.branchIntegrateStart('main', plan.revision);
    f.start(); await until(() => f.store.deliveryRun(op.id).state === 'awaiting' && !f.project.running.has(op.worker.id));
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline); await sourcesUnchanged(f);
    await expect(f.project.branchIntegrateRetry(op.id, f.project.branchIntegration(op.id).revision)).rejects.toThrow('decisions');
    const notice = f.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", op.worker.id);
    f.project.answer(notice.id, { answers: [{ selected: [0], custom: '' }] });
    const result = await landed(f, op); expect(result.worker.id).toBe(op.worker.id); expect(calls).toBe(2);
  } finally { await f.close(); }
});

test('a target advance after actual Agent exit requires another adaptation invocation, not a mechanical publish', async () => {
  let calls = 0;
  const f = await setup(1, { run: async args => {
    calls++;
    const result = await combine(args);
    if (calls === 1) args.api.scheduleConvergence = () => {};
    else expect(args.context.integration.tests_invalidated).toBe(true);
    return result;
  } });
  try {
    const plan = await f.project.branchIntegratePlan('main'), op = await f.project.branchIntegrateStart('main', plan.revision);
    f.start();
    await until(() => f.store.deliveryRun(op.id).state === 'preparing' && !f.project.running.has(op.worker.id));
    fs.writeFileSync(path.join(f.root, 'post-exit.txt'), 'new target after output\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'target advances after actual output exit');
    const moved = await git(f.root, 'rev-parse', 'main');
    await f.project.prepareConvergenceRun(op.id, 1, new AbortController().signal);
    expect(f.store.deliveryRun(op.id).candidate_commit).toBeNull(); expect(await git(f.root, 'rev-parse', 'main')).toBe(moved);
    f.start(); const result = await landed(f, op);
    expect(calls).toBe(2); expect(result.generation).toBe(2);
    expect(fs.readFileSync(path.join(f.root, 'post-exit.txt'), 'utf8')).toBe('new target after output\n');
  } finally { await f.close(); }
});

test('a fixed operation never absorbs a late source or divides its original collection into multiple landings', async () => {
  const f = await setup(2);
  try {
    const plan = await f.project.branchIntegratePlan('main'), op = await f.project.branchIntegrateStart('main', plan.revision);
    const late = (await f.project.order('late source', 'main', [], null, false)).task;
    fs.writeFileSync(path.join(late.workspace, 'late-source.txt'), 'not in the fixed collection\n');
    await git(late.workspace, 'add', '.'); await git(late.workspace, 'commit', '-m', 'late source');
    await f.project.workspaces.finish(f.store.task(late.id)); f.store.update(late.id, { status: 'waiting', result: 'late tested report' });
    expect(f.project.branchIntegration(op.id).members.map(member => member.id)).toEqual(f.sources.map(source => source.id));
    f.start(); await landed(f, op);
    expect(fs.existsSync(path.join(f.root, 'late-source.txt'))).toBe(false);
    expect(await git(f.root, 'rev-list', '--count', `${f.baseline}..main`)).toBe('1');
    const next = await f.project.branchIntegratePlan('main'); expect(next.members.map(member => member.id)).toEqual([late.id]);
  } finally { await f.close(); }
});

test('ordinary resolving, blocked, attempted and unknown-landing requests can never be stolen by start', async () => {
  const f = await setup(1);
  try {
    const base = { version: 2, kind: 'merge', parent_id: f.owner.id, commit: f.sources[0].head_commit };
    for (const extra of [{ status: 'resolving' }, { status: 'blocked' }, { status: 'requested', attempt_id: 123 },
      { status: 'requested', landing_receipt: { commit: f.baseline } }]) {
      f.store.update(f.sources[0].id, { reservation: JSON.stringify({ ...base, ...extra }) });
      const plan = await f.project.branchIntegratePlan('main'); expect(plan.count).toBe(0); expect(plan.excluded).toHaveLength(1);
      await expect(f.project.branchIntegrateStart('main', plan.revision)).rejects.toThrow();
    }
    expect(f.store.all('SELECT id FROM delivery_runs')).toHaveLength(0);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
  } finally { await f.close(); }
});

test('bounded merge_operation summaries explicitly truncate while the operation read retains all 20 fixed members', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    await repo(f.root); const parent = await f.project.bootstrapMain();
    const members = [];
    for (let i = 0; i < 20; i++) {
      const source = f.store.create({ parent_id: parent.id, role: 'agent', task_kind: 'order', goal: `source ${i}` });
      f.store.update(source.id, { branch: `synthetic/${i}`, target_branch: 'main', status: 'waiting' });
      members.push({ task_id: source.id, source_branch: `synthetic/${i}`, source_commit: parent.head_commit, base_commit: parent.head_commit,
        delivery_id: 1000 + i, enqueue_seq: 1000 + i });
    }
    const run = f.store.createDeliveryRun({ parent_id: parent.id, target_branch: 'main', baseline: parent.head_commit,
      validation: null, data: { operation_mode: 'one_shot', verification_mode: 'agent' }, members });
    const helper = f.store.create({ parent_id: parent.id, role: 'agent', task_kind: 'integration', goal: 'synthetic private identity' });
    f.store.updateDeliveryRun(run.id, { integration_worker_id: helper.id });
    const full = f.project.branchIntegration(run.id), summary = f.project.taskMergeOperation(f.store.task(members[19].task_id));
    expect(full).toMatchObject({ member_count: 20, members_truncated: false }); expect(full.members).toHaveLength(20);
    expect(summary).toMatchObject({ member_count: 20, members_truncated: true }); expect(summary.members).toHaveLength(16);
    expect(f.project.taskMergeOperation(helper)).toEqual(summary);
    expect(() => f.store.run('DELETE FROM tasks WHERE id=?', members[19].task_id)).toThrow('active integration');
    expect(f.store.deliveryHistoryBlockers([members[19].task_id])).toHaveLength(1);
  } finally { await f.close(); }
});

test('a fresh Project recovery fails an orphan invocation instead of replaying unknown Agent side effects', async () => {
  let calls = 0;
  const f = await setup(1, { run: async () => { calls++; return 'must not replay'; } });
  let restarted;
  try {
    const plan = await f.project.branchIntegratePlan('main'), op = await f.project.branchIntegrateStart('main', plan.revision);
    f.store.update(op.worker.id, { status: 'running', calls: 1 });
    restarted = new Project(f.config, f.store, { run: async () => { calls++; return 'must not replay'; } });
    restarted.kick = () => {}; restarted.scheduleConvergence = () => {};
    restarted.recover(); restarted.pump();
    expect(restarted.branchIntegration(op.id).state).toBe('failed');
    expect(f.store.task(op.worker.id).status).toBe('failed'); expect(calls).toBe(0);
    expect(f.store.deliveryMembers(op.id, true)).toHaveLength(1);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline); await sourcesUnchanged(f);
  } finally { await restarted?.shutdown(); await f.close(); }
});
