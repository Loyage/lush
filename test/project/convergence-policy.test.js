import { test, expect } from 'bun:test';
import { fixture, repo, git, env } from '../helpers.js';
import { historicalConvergencePolicy } from '../convergence-fixtures.js';
import { convergenceRunRevision } from '../../src/core/project/convergence-policy.js';
import { CONVERGENCE_POLICY_PREFIX } from '../../src/core/convergence-contract.js';

async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  await repo(f.root); f.main = await f.project.bootstrapMain(); f.sha = await git(f.root, 'rev-parse', 'HEAD'); return f;
}
function command(f) {
  const item = f.project.saveShortcutCommand({ name: '组合测试', command: 'echo PRIVATE_COMMAND_BODY' }, f.project.shortcutCommands().revision).commands.items.at(-1);
  return { command_id: item.id, command_version: item.version };
}
async function branch(f, name, kind = 'owner') {
  await git(f.root, 'branch', name);
  const task = f.store.create({ parent_id: f.main.id, input_id: null, role: 'agent', goal: name, task_kind: kind });
  f.store.update(task.id, { branch: name, status: 'waiting', target_branch: 'main' });
  f.store.recordBranch({ branch: name, parent: 'main', task_id: task.id, created_from_commit: f.sha }); return f.store.task(task.id);
}
function member(f, name = 'delivery', delivery = 100) {
  const task = f.store.create({ parent_id: f.main.id, input_id: null, role: 'agent', goal: '公开目标', task_kind: 'child' });
  f.store.update(task.id, { branch: name, target_branch: 'main', status: 'waiting' });
  return { task_id: task.id, source_branch: name, source_commit: f.sha, base_commit: f.sha, enqueue_seq: delivery, delivery_id: delivery };
}
const makeRun = (f, source, validation = null, data = {}) => f.store.createDeliveryRun({ parent_id: f.main.id, target_branch: 'main', baseline: f.sha, members: [source], validation, data });

test('retired branch/list/history reads are pure, readonly, and revisions bind the real branch and owner', async () => {
  const f = await setup(); try {
    await branch(f, 'feature');
    const facts = ['meta', 'events'].map(table => f.store.all(`SELECT * FROM ${table}`));
    const first = await f.project.branchConvergence('main');
    expect(first).toMatchObject({ version: 1, mounted: false, enabled: false, validation: null, retired: true, editable: false,
      owner_id: f.main.id, owner_worker_number: null, counts: { preparing: 0, resolving: 0, awaiting: 0, validating: 0, ready: 0, landing: 0, failed: 0, blocked: 0 } });
    expect((await f.project.branchConvergence('main')).revision).toBe(first.revision);
    expect((await f.project.branchConvergence('feature')).revision).not.toBe(first.revision);
    const list = await f.project.branchConvergenceList();
    expect(list).toMatchObject({ count: 2, truncated: false }); expect(list.items.map(item => item.branch)).toEqual(['main', 'feature']);
    expect(await f.project.branchConvergenceRuns('main')).toEqual({ version: 1, branch: 'main', items: [], next_before: null, has_more: false });
    expect(['meta', 'events'].map(table => f.store.all(`SELECT * FROM ${table}`))).toEqual(facts);
  } finally { await f.close(); }
});

test('historical validation references follow edited names, preserve versions and remain safe when deleted', async () => {
  const f = await setup(); try {
    const ref = command(f); historicalConvergencePolicy(f, f.main, { validation: ref });
    const before = f.store.get('SELECT value FROM meta WHERE key=?', CONVERGENCE_POLICY_PREFIX + 'main').value;
    let view = await f.project.branchConvergence('main'); expect(view.validation).toEqual({ ...ref, name: '组合测试' });
    expect(view).toMatchObject({ retired: true, editable: false, enabled: true }); expect(view.validation).not.toHaveProperty('authorized');
    f.project.saveShortcutCommand({ id: ref.command_id, name: '版本二', command: 'true' }, f.project.shortcutCommands().revision);
    view = await f.project.branchConvergence('main'); expect(view.validation).toEqual({ ...ref, name: '版本二' });
    f.project.removeShortcutCommand(ref.command_id, f.project.shortcutCommands().revision);
    expect((await f.project.branchConvergence('main')).validation).toEqual({ ...ref, name: null });
    expect(f.store.get('SELECT value FROM meta WHERE key=?', CONVERGENCE_POLICY_PREFIX + 'main').value).toBe(before);
    expect(JSON.stringify(view)).not.toContain('PRIVATE_COMMAND_BODY');
  } finally { await f.close(); }
});

test('target reads reject revision expressions, tags, absent/unowned/terminal/helper/archived branches', async () => {
  const f = await setup(); try {
    await git(f.root, 'tag', 'tag-only'); await git(f.root, 'branch', 'unowned');
    const retired = await branch(f, 'retired'); f.store.update(retired.id, { status: 'completed' });
    const archived = await branch(f, 'archived'); f.store.run("UPDATE branches SET status='archived' WHERE branch=?", archived.branch);
    await branch(f, 'helper', 'integration');
    for (const name of ['main~1', 'main^{commit}', f.sha, 'tag-only', 'missing', 'unowned', 'retired', 'archived', 'helper', ' main ', '', 'main\0'])
      await expect(f.project.branchConvergence(name)).rejects.toThrow();
    expect(f.project.taskConvergenceView(f.store.task(retired.id))).toBeNull();
    expect(f.project.taskConvergenceView(archived)).toBeNull();
  } finally { await f.close(); }
});

test('owner replacement changes revision without inheriting or rewriting historical authorization', async () => {
  const f = await setup(); try {
    const first = await branch(f, 'feature', 'child'); historicalConvergencePolicy(f, first, { validation: command(f) });
    const before = await f.project.branchConvergence('feature'); f.store.update(first.id, { status: 'completed' });
    const next = f.store.create({ parent_id: f.main.id, role: 'agent', goal: 'replacement', task_kind: 'child' });
    f.store.update(next.id, { branch: 'feature', target_branch: 'main', status: 'waiting' });
    const view = await f.project.branchConvergence('feature');
    expect(view).toMatchObject({ owner_id: next.id, enabled: false, mounted: false, validation: null }); expect(view.revision).not.toBe(before.revision);
    expect(f.store.get('SELECT value FROM meta WHERE key=?', CONVERGENCE_POLICY_PREFIX + 'feature').value).toContain('"enabled":true');
  } finally { await f.close(); }
});

test('runs descending pages retain persistent counts, safe views and immutable revision evidence', async () => {
  const f = await setup(); try {
    const ref = command(f), source = member(f), runs = [];
    for (let i = 0; i < 25; i++) {
      const run = makeRun(f, { ...source, delivery_id: 100 + i, enqueue_seq: 100 + i }, ref,
        { validation_name: '已固定测试', profile: { token: 'PRIVATE_PROFILE' }, env: { SECRET: 'PRIVATE_ENV' } });
      f.store.releaseDeliveryMembers(run.id); runs.push(run);
    }
    f.store.updateDeliveryRun(runs[0].id, { state: 'integrated' });
    const last = runs.at(-1), helper = f.store.create({ parent_id: f.main.id, role: 'agent', goal: 'repair', task_kind: 'integration' });
    f.store.update(helper.id, { status: 'awaiting_acceptance' });
    f.store.updateDeliveryRun(last.id, { state: 'failed', error: 'PRIVATE_STACK', integration_worker_id: helper.id,
      validation_result: { status: 'failed', error: 'PRIVATE_RESULT', reason: 'exit', stdout: 'PRIVATE_STDOUT', started_at: '2026-01-01T00:00:00.000Z' } });
    const a = await f.project.branchConvergenceRuns('main', null, 8), b = await f.project.branchConvergenceRuns('main', a.next_before, 8);
    expect(a).toMatchObject({ has_more: true, next_before: runs.at(-8).id });
    expect(a.items.map(row => row.id)).toEqual(runs.slice(-8).reverse().map(row => row.id));
    expect(a.items.some(row => b.items.some(other => row.id === other.id))).toBe(false);
    expect((await f.project.branchConvergence('main')).counts).toMatchObject({ preparing: 23, failed: 1 });
    expect(a.items[0]).toMatchObject({ state: 'failed', member_count: 1, members_truncated: false,
      members: [{ id: source.task_id, worker_number: null, title: '公开目标', delivery_id: 124, source_commit: f.sha }],
      integration_worker: { id: helper.id, worker_number: null, status: 'awaiting_acceptance' }, validation: { state: 'failed', command_name: '已固定测试' } });
    expect(a.items[0].revision).toBe(convergenceRunRevision(f.store, f.store.deliveryRun(last.id)));
    for (const secret of ['PRIVATE_PROFILE', 'PRIVATE_ENV', 'PRIVATE_STACK', 'PRIVATE_RESULT', 'PRIVATE_STDOUT', 'PRIVATE_COMMAND_BODY']) expect(JSON.stringify(a)).not.toContain(secret);
    const final = await f.project.branchConvergenceRuns('main', runs[1].id, 8);
    expect(final).toMatchObject({ has_more: false, next_before: null }); expect(final.items.map(row => row.id)).toEqual([runs[0].id]);
    for (const limit of [0, 51, '20', 1.5]) await expect(f.project.branchConvergenceRuns('main', null, limit)).rejects.toThrow('limit');
    for (const cursor of [0, -1, '5', 1.5]) await expect(f.project.branchConvergenceRuns('main', cursor)).rejects.toThrow('cursor');
  } finally { await f.close(); }
});

test('branch list remains bounded with complete counts and never installs retired policies', async () => {
  const f = await setup(); try {
    const requests = [];
    f.store.transaction(() => {
      for (let i = 0; i < 502; i++) {
        const name = `branch-${String(i).padStart(4, '0')}`;
        const task = f.store.create({ parent_id: f.main.id, role: 'agent', goal: name, task_kind: 'owner' });
        f.store.update(task.id, { branch: name, status: 'waiting' }); requests.push(`create refs/heads/${name} ${f.sha}`);
      }
    });
    const process = Bun.spawn(['git', '-C', f.root, 'update-ref', '--stdin'], { env: env(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    process.stdin.write(requests.join('\n') + '\n'); process.stdin.end();
    const [exit, error] = await Promise.all([process.exited, new Response(process.stderr).text()]); expect(error).toBe(''); expect(exit).toBe(0);
    const list = await f.project.branchConvergenceList(); expect(list).toMatchObject({ count: 503, truncated: true });
    expect(list.items).toHaveLength(500); expect(list.items[0].branch).toBe('main'); expect(list.items.at(-1).branch).toBe('branch-0498');
    expect(f.store.get('SELECT count(*) AS n FROM meta WHERE key LIKE ?', CONVERGENCE_POLICY_PREFIX + '%').n).toBe(0);
  } finally { await f.close(); }
});

test('policy reads bind a single SQLite snapshot even when historical records change externally', async () => {
  const f = await setup(); let other;
  try {
    historicalConvergencePolicy(f, f.main);
    const { Store } = await import('../../src/persistence/store.js'); other = new Store(f.store.db.filename, f.root);
    const before = await f.project.branchConvergence('main'), original = f.project.convergencePolicy.bind(f.project); let mutate = true;
    f.project.convergencePolicy = branch => {
      const policy = original(branch);
      if (mutate) {
        mutate = false; const key = CONVERGENCE_POLICY_PREFIX + branch, data = JSON.parse(other.get('SELECT value FROM meta WHERE key=?', key).value);
        other.run('UPDATE meta SET value=? WHERE key=?', JSON.stringify({ ...data, enabled: false, generation: data.generation + 1 }), key);
      }
      return policy;
    };
    const during = await f.project.branchConvergence('main'); expect(during.enabled).toBe(before.enabled); expect(during.revision).toBe(before.revision);
    const after = await f.project.branchConvergence('main'); expect(after.revision).not.toBe(before.revision); expect(after.enabled).toBe(false);
  } finally { other?.close(); await f.close(); }
});

test('historical member titles/numbers, truncation and fixed validation names remain safe and readable', async () => {
  const f = await setup(); try {
    const ref = command(f), sources = Array.from({ length: 9 }, (_, i) => member(f, `source-${i}`, 300 + i));
    const run = f.store.createDeliveryRun({ parent_id: f.main.id, target_branch: 'main', baseline: f.sha, validation: ref, members: sources.slice(0, 8) });
    f.store.run('UPDATE tasks SET worker_number=?,display_title=?,auto_title=? WHERE id=?', 'W99-4', '用户标题', '自动标题', sources[0].task_id);
    f.store.db.exec('PRAGMA ignore_check_constraints=ON;'); const extra = sources[8];
    f.store.run('INSERT INTO delivery_members(run_id,task_id,delivery_id,enqueue_seq,source_branch,source_commit,ordinal) VALUES (?,?,?,?,?,?,8)',
      run.id, extra.task_id, extra.delivery_id, extra.enqueue_seq, extra.source_branch, extra.source_commit);
    f.store.db.exec('PRAGMA ignore_check_constraints=OFF;');
    f.store.updateDeliveryRun(run.id, { validation_result: { state: 'passed', command_name: '固定验证名称', tested_commit: f.sha } });
    f.project.saveShortcutCommand({ id: ref.command_id, name: '新版名称', command: 'true' }, f.project.shortcutCommands().revision);
    const view = (await f.project.branchConvergenceRuns('main')).items[0];
    expect(view).toMatchObject({ member_count: 9, members_truncated: true, validation: { state: 'passed', command_name: '固定验证名称' } });
    expect(view.members).toHaveLength(8); expect(view.members[0]).toMatchObject({ worker_number: 'W99-4', title: '用户标题' }); expect(view.members[1].worker_number).toBeNull();
  } finally { await f.close(); }
});
