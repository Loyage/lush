import { test, expect } from 'bun:test';
import { fixture, repo, git, env } from '../helpers.js';
import policy, { convergenceRunRevision } from '../../src/core/project/convergence-policy.js';
import { CONVERGENCE_POLICY_PREFIX } from '../../src/core/convergence-contract.js';

async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  Object.assign(f.project, policy); f.project.convergenceNotifications = [];
  f.project.scheduleConvergence = id => f.project.convergenceNotifications.push(id);
  await repo(f.root); f.main = await f.project.bootstrapMain(); f.sha = await git(f.root, 'rev-parse', 'HEAD');
  return f;
}
function command(f, authorized = true) {
  const item = f.project.saveShortcutCommand({ name: '组合测试', command: 'echo PRIVATE_COMMAND_BODY' }, f.project.shortcutCommands().revision).commands.items.at(-1);
  if (authorized) f.project.authorizeShortcutCommand(item.id, item.version, true, f.project.shortcutCommands().revision);
  return { command_id: item.id, command_version: item.version };
}
async function branch(f, name, kind = 'owner') {
  await git(f.root, 'branch', name);
  const task = f.store.create({ parent_id: f.main.id, input_id: null, role: 'agent', goal: name, task_kind: kind });
  f.store.update(task.id, { branch: name, status: 'waiting', target_branch: 'main' });
  f.store.recordBranch({ branch: name, parent: 'main', task_id: task.id, created_from_commit: f.sha });
  return f.store.task(task.id);
}
function member(f, parent = f.main, name = 'delivery', delivery = 100) {
  const task = f.store.create({ parent_id: parent.id, input_id: null, role: 'agent', goal: '公开目标', task_kind: 'child' });
  f.store.update(task.id, { branch: name, target_branch: parent.branch, status: 'waiting' });
  return { task_id: task.id, source_branch: name, source_commit: f.sha, base_commit: f.sha, enqueue_seq: delivery, delivery_id: delivery };
}
const makeRun = (f, source, validation = null, parent = f.main, data = {}) => f.store.createDeliveryRun({ parent_id: parent.id, target_branch: parent.branch,
  baseline: f.sha, members: [source], validation, data });

test('unconfigured branch reads/list/history are pure and revisions bind the real branch and owner', async () => {
  const f = await setup(); try {
    await branch(f, 'feature');
    const n = f.store.get('SELECT count(*) AS n FROM meta').n, events = f.store.get('SELECT count(*) AS n FROM events').n;
    const first = await f.project.branchConvergence('main'), again = await f.project.branchConvergence('main');
    expect(first).toMatchObject({ version: 1, enabled: false, validation: null, editable: true, owner_id: f.main.id, owner_worker_number: null,
      counts: { preparing: 0, resolving: 0, awaiting: 0, validating: 0, ready: 0, landing: 0, failed: 0, blocked: 0 } });
    expect(again.revision).toBe(first.revision);
    expect((await f.project.branchConvergence('feature')).revision).not.toBe(first.revision);
    const list = await f.project.branchConvergenceList();
    expect(list).toMatchObject({ count: 2, truncated: false }); expect(list.items.map(item => item.branch)).toEqual(['main', 'feature']);
    expect(await f.project.branchConvergenceRuns('main')).toEqual({ version: 1, branch: 'main', items: [], next_before: null, has_more: false });
    expect(f.store.get('SELECT count(*) AS n FROM meta').n).toBe(n); expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(events);
    expect(f.project.convergenceNotifications).toEqual([]);
  } finally { await f.close(); }
});

test('agent-mode internal policies may omit optional validation metadata without breaking safe Hook reads', async () => {
  const f = await setup();
  try {
    f.project.convergencePolicy = () => ({ version: 1, mounted: true, enabled: true, generation: 1 });
    f.project.resolveShortcutCommand = () => { throw new Error('agent policy read must not resolve a command'); };
    const view = await f.project.branchConvergence('main');
    expect(view).toMatchObject({ mounted: true, enabled: true, validation: null });
    expect(f.project.taskHooks(f.main.id).convergence).toEqual(view);
  } finally { await f.close(); }
});

test('policy enable accepts legacy references without authorization, persists per branch, and does not rewrite already-fixed deliveries', async () => {
  const f = await setup(); try {
    await branch(f, 'feature'); const ref = command(f, false), old = await f.project.branchConvergence('main');
    const source = member(f); f.store.update(source.task_id, { reservation: '{"version":2,"kind":"merge","status":"requested"}' });
    const before = f.store.task(source.task_id).reservation;
    f.project.authorizeShortcutCommand(ref.command_id, ref.command_version, true, f.project.shortcutCommands().revision);
    const set = await f.project.setBranchConvergence('main', true, ref, old.revision);
    expect(set.validation).toEqual({ ...ref, name: '组合测试', authorized: true }); expect(set.enabled).toBe(true);
    expect((await f.project.branchConvergence('feature')).enabled).toBe(false);
    expect(f.store.task(source.task_id).reservation).toBe(before); expect(f.project.convergenceNotifications).toEqual([f.main.id]);
    await expect(f.project.setBranchConvergence('main', false, ref, old.revision)).rejects.toThrow('revision changed');
    await expect(f.project.setBranchConvergence('feature', false, null, set.revision)).rejects.toThrow('revision changed');
    f.store.update(source.task_id, { reservation: '{"version":3,"kind":"merge","status":"requested"}' });
    await f.project.setBranchConvergence('main', false, ref, set.revision);
    expect(f.store.task(source.task_id).reservation).toContain('"version":3');
    expect(JSON.stringify(f.store.all("SELECT * FROM events WHERE type='branch.convergence_configured'"))).not.toContain('PRIVATE_COMMAND_BODY');
  } finally { await f.close(); }
});

test('revocation/edit/delete never upgrades stored versions, but off can retain an obsolete reference', async () => {
  const f = await setup(); try {
    const ref = command(f), initial = await f.project.branchConvergence('main');
    await f.project.setBranchConvergence('main', true, ref, initial.revision);
    f.project.authorizeShortcutCommand(ref.command_id, 1, false, f.project.shortcutCommands().revision);
    let view = await f.project.branchConvergence('main'); expect(view.validation.authorized).toBe(false);
    view = await f.project.setBranchConvergence('main', true, undefined, view.revision);
    expect(view.validation).toEqual({ ...ref, name: '组合测试', authorized: false });
    f.project.saveShortcutCommand({ id: ref.command_id, name: '版本二', command: 'true' }, f.project.shortcutCommands().revision);
    view = await f.project.branchConvergence('main'); expect(view.validation).toEqual({ ...ref, name: null, authorized: false });
    view = await f.project.setBranchConvergence('main', false, ref, view.revision); expect(view.validation.command_version).toBe(1);
    f.project.removeShortcutCommand(ref.command_id, f.project.shortcutCommands().revision);
    const off = await f.project.setBranchConvergence('main', false, ref, view.revision); expect(off.validation.authorized).toBe(false);
    const missing = await f.project.setBranchConvergence('main', true, { command_id: '00000000-0000-0000-0000-000000000001', command_version: 1 }, off.revision);
    expect(missing.validation.authorized).toBe(false);
    expect((await f.project.setBranchConvergence('main', false, null, missing.revision)).validation).toBeNull();
  } finally { await f.close(); }
});

test('target lookup rejects revision expressions, tags, absent/unowned/retired/helper branches and malformed setters', async () => {
  const f = await setup(); try {
    await git(f.root, 'tag', 'tag-only'); await git(f.root, 'branch', 'unowned');
    const retired = await branch(f, 'retired'); f.store.update(retired.id, { status: 'completed' });
    await branch(f, 'helper', 'integration');
    for (const name of ['main~1', 'main^{commit}', f.sha, 'tag-only', 'missing', 'unowned', 'retired', 'helper', ' main ', '', 'main\0'])
      await expect(f.project.branchConvergence(name)).rejects.toThrow();
    const current = await f.project.branchConvergence('main');
    for (const ref of [{ command_id: 'bad', command_version: 1 }, { command_id: '00000000-0000-0000-0000-000000000001', command_version: '1' },
      { command_id: '00000000-0000-0000-0000-000000000001', command_version: 1, command: 'true' }, []])
      await expect(f.project.setBranchConvergence('main', false, ref, current.revision)).rejects.toThrow('reference');
    await expect(f.project.setBranchConvergence('main', 'yes', null, current.revision)).rejects.toThrow('boolean');
    await expect(f.project.setBranchConvergence('main', false, null, null)).rejects.toThrow('revision');
    f.project.clearing = true;
    expect(await f.project.branchConvergence('main')).toMatchObject({ editable: false, reason: '项目清理中' });
    await expect(f.project.setBranchConvergence('main', false, null, current.revision)).rejects.toThrow('clear');
    f.project.clearing = false;
  } finally { await f.close(); }
});

test('branch owner changes invalidate revisions and cannot inherit an older owner policy', async () => {
  const f = await setup(); try {
    const first = await branch(f, 'feature', 'child'), ref = command(f);
    const initial = await f.project.branchConvergence('feature'); await f.project.setBranchConvergence('feature', true, ref, initial.revision);
    const before = await f.project.branchConvergence('feature'); f.store.update(first.id, { status: 'completed' });
    const next = f.store.create({ parent_id: f.main.id, input_id: null, role: 'agent', goal: 'replacement', task_kind: 'child' });
    f.store.update(next.id, { branch: 'feature', target_branch: 'main', status: 'waiting' });
    const view = await f.project.branchConvergence('feature');
    expect(view).toMatchObject({ owner_id: next.id, enabled: false, validation: null }); expect(view.revision).not.toBe(before.revision);
    await expect(f.project.setBranchConvergence('feature', false, null, before.revision)).rejects.toThrow('revision changed');
    expect(f.store.get('SELECT value FROM meta WHERE key=?', CONVERGENCE_POLICY_PREFIX + 'feature').value).toContain('"enabled":true');
  } finally { await f.close(); }
});

test('setter rechecks live ownership after asynchronous Git admission without requiring command authorization', async () => {
  const f = await setup(); try {
    const ref = command(f), before = await f.project.branchConvergence('main');
    const original = f.project.workspaces.git.bind(f.project.workspaces); let revoke = true;
    f.project.workspaces.git = async (...args) => {
      const value = await original(...args);
      if (revoke && args.includes('for-each-ref')) { revoke = false; f.project.authorizeShortcutCommand(ref.command_id, 1, false, f.project.shortcutCommands().revision); }
      return value;
    };
    const enabled = await f.project.setBranchConvergence('main', true, ref, before.revision);
    expect(enabled).toMatchObject({ mounted: true, enabled: true, validation: { ...ref, authorized: false } });
    f.project.workspaces.git = original; await branch(f, 'feature'); const view = await f.project.branchConvergence('feature');
    const own = f.store.get("SELECT id FROM tasks WHERE branch='feature'"); let closeOwner = true;
    f.project.workspaces.git = async (...args) => {
      const result = await original(...args); if (closeOwner) { closeOwner = false; f.store.update(own.id, { status: 'completed' }); } return result;
    };
    await expect(f.project.setBranchConvergence('feature', false, null, view.revision)).rejects.toThrow('active branch owner');
  } finally { await f.close(); }
});

test('runs descending cursor pages have full persistent counts, safe views and immutable revision evidence', async () => {
  const f = await setup(); try {
    const ref = command(f), source = member(f); const runs = [];
    for (let i = 0; i < 25; i++) {
      const run = makeRun(f, { ...source, delivery_id: 100 + i, enqueue_seq: 100 + i }, ref, f.main,
        { validation_name: '已固定测试', profile: { token: 'PRIVATE_PROFILE' }, env: { SECRET: 'PRIVATE_ENV' } });
      f.store.releaseDeliveryMembers(run.id); runs.push(run);
    }
    f.store.updateDeliveryRun(runs[0].id, { state: 'integrated' });
    const last = runs.at(-1), helper = f.store.create({ parent_id: f.main.id, input_id: null, role: 'agent', goal: 'repair', task_kind: 'integration' });
    f.store.update(helper.id, { status: 'awaiting_acceptance' });
    f.store.updateDeliveryRun(last.id, { state: 'failed', error: 'PRIVATE_STACK_AND_OUTPUT', integration_worker_id: helper.id,
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
    const text = JSON.stringify(a); for (const secret of ['PRIVATE_PROFILE','PRIVATE_ENV','PRIVATE_STACK','PRIVATE_RESULT','PRIVATE_STDOUT','PRIVATE_COMMAND_BODY']) expect(text).not.toContain(secret);
    const final = await f.project.branchConvergenceRuns('main', runs[1].id, 8);
    expect(final).toMatchObject({ has_more: false, next_before: null }); expect(final.items.map(row => row.id)).toEqual([runs[0].id]);
    for (const limit of [0, 51, '20', 1.5]) await expect(f.project.branchConvergenceRuns('main', null, limit)).rejects.toThrow('limit');
    for (const cursor of [0, -1, '5', 1.5]) await expect(f.project.branchConvergenceRuns('main', cursor)).rejects.toThrow('cursor');
  } finally { await f.close(); }
});

test('list bounds rows at 500, keeps main first and reports the full eligible count', async () => {
  const f = await setup(); try {
    const requests = [];
    f.store.transaction(() => {
      for (let i = 0; i < 502; i++) {
        const name = `branch-${String(i).padStart(4, '0')}`;
        const task = f.store.create({ parent_id: f.main.id, input_id: null, role: 'agent', goal: name, task_kind: 'owner' });
        f.store.update(task.id, { branch: name, status: 'waiting' }); requests.push(`create refs/heads/${name} ${f.sha}`);
      }
    });
    const process = Bun.spawn(['git','-C',f.root,'update-ref','--stdin'], { env: env(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    process.stdin.write(requests.join('\n') + '\n'); process.stdin.end();
    const [exit, error] = await Promise.all([process.exited, new Response(process.stderr).text()]); expect(error).toBe(''); expect(exit).toBe(0);
    const list = await f.project.branchConvergenceList(); expect(list).toMatchObject({ count: 503, truncated: true });
    expect(list.items).toHaveLength(500); expect(list.items[0].branch).toBe('main'); expect(list.items[1].branch).toBe('branch-0000');
    expect(list.items.at(-1).branch).toBe('branch-0498');
    expect(f.store.get('SELECT count(*) AS n FROM meta WHERE key LIKE ?', CONVERGENCE_POLICY_PREFIX + '%').n).toBe(1);
  } finally { await f.close(); }
});

test('concurrent policy writes with one revision admit exactly one and policy reads bind a single SQLite snapshot', async () => {
  const f = await setup(); let other;
  try {
    const { Store } = await import('../../src/persistence/store.js');
    other = new Store(f.store.db.filename, f.root);
    const ref = command(f), initial = await f.project.branchConvergence('main');
    const results = await Promise.allSettled([f.project.setBranchConvergence('main', true, ref, initial.revision),
      f.project.setBranchConvergence('main', false, null, initial.revision)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const before = await f.project.branchConvergence('main'), original = f.project.convergencePolicy.bind(f.project); let mutate = true;
    f.project.convergencePolicy = branch => {
      const policy = original(branch);
      if (mutate) {
        mutate = false; const key = CONVERGENCE_POLICY_PREFIX + branch;
        const data = JSON.parse(other.get('SELECT value FROM meta WHERE key=?', key).value);
        other.run('UPDATE meta SET value=? WHERE key=?', JSON.stringify({ ...data, enabled: false, generation: data.generation + 1 }), key);
      }
      return policy;
    };
    const during = await f.project.branchConvergence('main');
    expect(during.enabled).toBe(before.enabled); expect(during.revision).toBe(before.revision);
    const after = await f.project.branchConvergence('main'); expect(after.revision).not.toBe(before.revision);
    expect(after.enabled).toBe(false);
  } finally { other?.close(); await f.close(); }
});

test('run members retain real numbers and title precedence, and oversized historical lists signal truncation', async () => {
  const f = await setup(); try {
    const sources = Array.from({ length: 9 }, (_, i) => member(f, f.main, `source-${i}`, 300 + i));
    const run = f.store.createDeliveryRun({ parent_id: f.main.id, target_branch: 'main', baseline: f.sha, validation: null, members: sources.slice(0, 8) });
    f.store.run('UPDATE tasks SET worker_number=?,display_title=?,auto_title=? WHERE id=?', 'W99-4', '用户标题', '自动标题', sources[0].task_id);
    // A future or externally-corrupted database must not make a bounded view claim completeness.
    f.store.db.exec('PRAGMA ignore_check_constraints=ON;');
    const extra = sources[8];
    f.store.run(`INSERT INTO delivery_members(run_id,task_id,delivery_id,enqueue_seq,source_branch,source_commit,ordinal)
      VALUES (?,?,?,?,?,?,8)`, run.id, extra.task_id, extra.delivery_id, extra.enqueue_seq, extra.source_branch, extra.source_commit);
    f.store.db.exec('PRAGMA ignore_check_constraints=OFF;');
    const view = (await f.project.branchConvergenceRuns('main')).items[0];
    expect(view).toMatchObject({ member_count: 9, members_truncated: true }); expect(view.members).toHaveLength(8);
    expect(view.members[0]).toMatchObject({ worker_number: 'W99-4', title: '用户标题' });
    expect(view.members[1].worker_number).toBeNull();
  } finally { await f.close(); }
});

test('validation summaries keep the fixed evidence command name when its registered version has changed', async () => {
  const f = await setup(); try {
    const ref = command(f), run = makeRun(f, member(f), ref);
    f.store.updateDeliveryRun(run.id, { validation_result: { state: 'passed', command_name: '固定验证名称', tested_commit: f.sha } });
    f.project.saveShortcutCommand({ id: ref.command_id, name: '新版名称', command: 'true' }, f.project.shortcutCommands().revision);
    expect((await f.project.branchConvergenceRuns('main')).items[0].validation).toMatchObject({ state: 'passed', command_name: '固定验证名称' });
  } finally { await f.close(); }
});
