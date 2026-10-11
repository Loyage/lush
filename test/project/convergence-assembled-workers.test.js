import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { convergenceJSON } from '../../src/core/convergence-contract.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';

/** Fully assembled scheduler/factory/SQL/Git/real validation, in-process controlled provider only. */
async function setup(provider, command = "test \"$(cat file.txt)\" = 'left plus right'", nested = false) {
  const f = fixture(provider, { LUSH_CONCURRENCY: '1' });
  const kick = f.project.kick.bind(f.project), mergeWake = f.project.scheduleTaskMerge.bind(f.project),
    convergenceWake = f.project.scheduleConvergence.bind(f.project);
  f.project.kick = () => {};
  f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  try {
    await repo(f.root); await f.project.bootstrapMain();
    const entry = f.project.saveShortcutCommand({ name: '组合验证', command }, f.project.shortcutCommands().revision).commands.items.at(-1);
    f.project.authorizeShortcutCommand(entry.id, 1, true, f.project.shortcutCommands().revision);
    const owner = nested ? (await f.project.order('collect nested sources')).task : null;
    if (owner) f.store.update(owner.id, { status: 'waiting' });
    const target = owner?.branch ?? 'main';
    const view = await f.project.branchConvergence(target);
    await f.project.setBranchConvergence(target, true, { command_id: entry.id, command_version: 1 }, view.revision);
    const sources = [];
    for (const text of ['left', 'right']) {
      const task = owner ? await f.project.spawn(owner.id, text) : (await f.project.order(text)).task;
      fs.writeFileSync(path.join(task.workspace, 'file.txt'), text + '\n');
      await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', text);
      f.store.update(task.id, { status: 'waiting' }); await f.project.requestTaskMerge(task.id);
      sources.push(f.store.task(task.id));
    }
    const baseline = await git(f.root, 'rev-parse', target);
    const run = await f.project.formConvergenceBatch(sources[0].parent_id);
    return { ...f, owner, sources, baseline, run, start() { f.project.kick = kick; kick(); }, stopScheduling() { f.project.kick = () => {}; },
      drive() { f.project.kick = kick; f.project.scheduleTaskMerge = mergeWake; f.project.scheduleConvergence = convergenceWake;
        convergenceWake(run.parent_id); } };
  } catch (error) { await f.close(); throw error; }
}
async function exited(f, id) {
  await until(() => !f.project.running.has(id) && ['awaiting_acceptance', 'failed', 'awaiting'].includes(f.store.task(id).status));
}
async function unchanged(f) {
  for (const source of f.sources) expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(source.head_commit);
}

test('assembled content-conflict helper repairs only its private checkout and promotes after actual exit/token revocation', async () => {
  let token, helperId;
  const f = await setup({ run: async ({ task, cwd, context, token: credential, api }) => {
    token = credential; helperId = task.id;
    expect(task.task_kind).toBe('integration'); expect(context.integration.reason).toBe('conflict');
    expect(context.integration.members).toHaveLength(2);
    expect(api.running.has(task.id)).toBe(true);
    const rpc = new Dispatcher(api), auth = { _token: credential };
    expect(await rpc.dispatch('worker.inspect', { ...auth, id: task.id })).toMatchObject({ id: task.id, task_kind: 'integration' });
    await expect(rpc.dispatch('worker.spawn', { ...auth, goal: 'forbidden' })).rejects.toThrow('integration agents can only');
    await expect(rpc.dispatch('branch.convergence_list', auth)).rejects.toThrow('requires user approval');
    await expect(rpc.dispatch('notice.post', { ...auth, task: f.sources[0].id, title: 'forged source question' })).rejects.toThrow('only for their own worker');
    await rpc.dispatch('progress.plan', { ...auth, steps: [{ key: 'repair', label: 'Repair' }, { key: 'verify', label: 'Verify' }] });
    await rpc.dispatch('progress.complete', { ...auth, step: 'repair' });
    expect(api.store.task(task.id).progress_plan).not.toBeNull();
    expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toContain('<<<<<<<');
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'left plus right\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'controlled combined repair');
    return 'private combination repaired';
  } });
  try {
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const repairing = f.store.deliveryRun(f.run.id);
    expect(repairing.state).toBe('resolving'); helperId = repairing.integration_worker_id;
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline); await unchanged(f);
    expect(f.project.branchFreeze('main')).toBeNull();
    f.start(); await exited(f, helperId); f.stopScheduling();
    expect(token).toBeTruthy(); expect(f.store.task(helperId).agent_token_hash).toBeNull();
    await expect(new Dispatcher(f.project).dispatch('worker.inspect', { id: helperId, _token: token })).rejects.toThrow('invalid or expired');
    expect(f.store.task(helperId).status).toBe('awaiting_acceptance');
    expect(f.store.task(helperId).integration).not.toBe('merged');
    const ready = f.store.deliveryRun(f.run.id), node = f.store.deliveryNodes(ready.id, 1).find(row => row.helper_id === helperId);
    expect(ready.state).toBe('preparing'); expect(node.state).toBe('ready');
    expect(convergenceJSON(node.result).via).toBe('integration');
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline); await unchanged(f);
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    expect(f.store.deliveryRun(f.run.id).state).toBe('integrated');
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('left plus right\n');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='worker.merge_received'").n).toBe(1);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='integration'").n).toBe(1);
    await unchanged(f);
    await f.project.acceptTask(f.sources[0].id);
    expect(f.store.task(helperId).status).toBe('awaiting_acceptance');
    expect(fs.existsSync(f.store.task(helperId).workspace)).toBe(true);
    expect(f.store.task(f.sources[1].id).status).toBe('awaiting_acceptance');
    const deletion = await f.project.deleteTaskPreview(f.sources[0].id);
    expect(deletion.can_delete).toBe(true);
    await f.project.deleteTask(f.sources[0].id, { revision: deletion.revision, confirm: true });
    expect(f.store.get('SELECT id FROM tasks WHERE id=?', f.sources[0].id)).toBeNull();
    expect(f.store.deliveryMembers(f.run.id)).toHaveLength(2);
    expect((await f.project.branchConvergenceRuns('main')).items[0].members[0].id).toBe(f.sources[0].id);
    await f.project.acceptTask(f.sources[1].id);
    expect(f.store.task(helperId)).toMatchObject({ status: 'completed', branch: null, workspace: null });
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.accepted'", helperId).n).toBe(0);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='convergence.helper_reclaimed'", helperId).n).toBe(1);
  } finally { await f.close(); }
});

test('assembled event-driven coordinator automatically prepares, repairs, validates and publishes without a parent Agent', async () => {
  const invoked = [];
  const f = await setup({ run: async ({ task, cwd }) => {
    invoked.push(task.task_kind);
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'left plus right\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'automatic controlled repair');
    return 'ready';
  } });
  try {
    f.drive();
    await until(() => f.store.deliveryRun(f.run.id).state === 'integrated', 10000);
    expect(invoked).toEqual(['integration']);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='worker.merge_received'").n).toBe(1);
    expect(f.store.deliveryMembers(f.run.id, true)).toHaveLength(0);
    await unchanged(f);
  } finally { await f.close(); }
});

test('assembled questionnaire releases the helper invocation and resumes the same fixed identity only on answer', async () => {
  let calls = 0, firstToken;
  const f = await setup({ run: async ({ task, api, cwd, token }) => {
    calls++;
    if (calls === 1) {
      firstToken = token;
      await new Dispatcher(api).dispatch('notice.post', { _token: token, title: '组合行为确认', body: '', questions: [
        { header: '语义', question: '保留双方行为？', options: [
          { label: '保留双方', description: '固定组合继续修复' }, { label: '暂不修复', description: '保留现场' },
        ] },
      ] });
      return 'awaiting decision';
    }
    expect(token).not.toBe(firstToken);
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'left plus right\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'repair after controlled answer');
    return 'repaired';
  } });
  try {
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const helperId = f.store.deliveryRun(f.run.id).integration_worker_id;
    f.start(); await exited(f, helperId); f.stopScheduling();
    expect(f.store.task(helperId).status).toBe('awaiting'); expect(f.store.task(helperId).agent_token_hash).toBeNull();
    expect(f.store.deliveryRun(f.run.id).state).toBe('awaiting'); expect(f.project.branchFreeze('main')).toBeNull();
    const notice = f.store.get("SELECT id FROM notices WHERE task_id=? AND status='open'", helperId);
    f.project.answer(notice.id, { answers: [{ selected: [0] }] });
    f.start(); await exited(f, helperId); f.stopScheduling();
    expect(f.store.deliveryRun(f.run.id)).toMatchObject({ generation: 1, state: 'preparing', integration_worker_id: helperId });
    expect(f.store.task(helperId).calls).toBe(2);
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    expect(f.store.deliveryRun(f.run.id).state).toBe('integrated'); expect(calls).toBe(2);
    await unchanged(f);
  } finally { await f.close(); }
});

test('source cancellation invalidates generation before abort and retains helper resources until actual exit', async () => {
  const entered = gate(), leave = gate();
  const f = await setup({ run: async ({ task, signal }) => {
    signal.addEventListener('abort', () => leave.resolve(), { once: true });
    entered.resolve(task.id); await leave.promise;
    return 'cancelled helper did not deliver';
  } });
  try {
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const helperId = f.store.deliveryRun(f.run.id).integration_worker_id;
    f.start(); expect(await entered.promise).toBe(helperId);
    f.project.cancel(f.sources[0].id, 'controlled source withdrawal');
    expect(f.store.deliveryRun(f.run.id).generation).toBe(2);
    expect(f.project.running.has(helperId)).toBe(true);
    expect(f.store.deliveryMembers(f.run.id, true)).toHaveLength(2);
    await until(() => !f.project.running.has(helperId)); f.stopScheduling();
    expect(f.store.task(helperId).status).toBe('cancelled'); expect(f.store.task(helperId).agent_token_hash).toBeNull();
    expect(fs.existsSync(f.store.task(helperId).workspace)).toBe(true);
    expect(f.store.deliveryMembers(f.run.id, true).map(member => member.task_id)).toEqual([f.sources[1].id]);
    expect(f.store.task(f.sources[0].id).reservation).toBeNull();
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline); await unchanged(f);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='convergence.integration_ready'", helperId).n).toBe(0);
  } finally { leave.resolve(); await f.close(); }
});

test('real validation failure creates a second fixed generation/helper and passes only after its repair', async () => {
  let calls = 0;
  const f = await setup({ run: async ({ cwd, context }) => {
    calls++;
    if (calls === 1) {
      expect(context.integration.reason).toBe('conflict');
      fs.writeFileSync(path.join(cwd, 'file.txt'), 'left plus right\n');
    } else {
      expect(context.integration).toMatchObject({ reason: 'validation', generation: 2 });
      fs.writeFileSync(path.join(cwd, 'validation-fix.txt'), 'fixed\n');
    }
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', `controlled repair ${calls}`);
    return 'fixed private output';
  } }, "test \"$(cat file.txt)\" = 'left plus right' && test -f validation-fix.txt");
  try {
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const firstHelper = f.store.deliveryRun(f.run.id).integration_worker_id;
    f.start(); await exited(f, firstHelper); f.stopScheduling();
    const originalNode = f.store.deliveryNodes(f.run.id, 1).find(node => node.helper_id === firstHelper);
    const originalContext = f.store.get("SELECT data FROM events WHERE task_id=? AND type='convergence.integration_created'", firstHelper).data;
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const second = f.store.deliveryRun(f.run.id), secondHelper = second.integration_worker_id;
    expect(second).toMatchObject({ generation: 2, state: 'resolving' }); expect(secondHelper).not.toBe(firstHelper);
    expect(f.store.deliveryNode(originalNode.id)).toEqual(originalNode);
    expect(f.store.get("SELECT data FROM events WHERE task_id=? AND type='convergence.integration_created'", firstHelper).data).toBe(originalContext);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
    f.start(); await exited(f, secondHelper); f.stopScheduling();
    await f.project.prepareConvergenceRun(f.run.id, 2, new AbortController().signal);
    const final = f.store.deliveryRun(f.run.id);
    expect(final.state).toBe('integrated'); expect(calls).toBe(2);
    expect(convergenceJSON(final.validation_result).state).toBe('passed');
    expect(fs.readFileSync(path.join(f.root, 'validation-fix.txt'), 'utf8')).toBe('fixed\n');
    const root = convergenceJSON(final.data).root_commit;
    expect(await f.project.workspaces.isAncestor(f.root, f.store.task(firstHelper).head_commit, root)).toBe(true);
    await unchanged(f);
  } finally { await f.close(); }
});

test('published infrastructure does not block parent upward delivery and closes only with related child acceptance', async () => {
  const f = await setup({ run: async ({ task, cwd }) => {
    expect(task.task_kind).toBe('integration');
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'left plus right\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'nested private repair');
    return 'private child aggregation';
  } }, undefined, true);
  try {
    expect(f.project.hasActionableMessages(f.owner.id)).toBe(false);
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const helperId = f.store.deliveryRun(f.run.id).integration_worker_id;
    f.start(); await exited(f, helperId); f.stopScheduling();
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    expect(f.store.deliveryRun(f.run.id).state).toBe('integrated');
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', f.owner.id); // controlled parent has checked its child output
    await f.project.workspaces.finish(f.store.task(f.owner.id));
    f.store.update(f.owner.id, { status: 'waiting', result: 'controlled parent checked its children' });
    await f.project.requestTaskMerge(f.owner.id);
    await f.project.driveTaskMerge(f.owner.parent_id);
    expect(f.store.task(f.owner.id).integration).toBe('merged');
    expect(f.store.task(helperId).integration).not.toBe('merged');
    expect(f.sources.every(source => f.store.task(source.id).status === 'awaiting_acceptance')).toBe(true);
    expect(fs.readFileSync(path.join(f.root, 'file.txt'), 'utf8')).toBe('left plus right\n');
    await f.project.acceptTask(f.owner.id);
    for (const source of f.sources) expect(f.store.task(source.id).status).toBe('completed');
    expect(f.store.task(helperId).status).toBe('completed');
    expect(f.store.branch(f.store.task(helperId).branch).status).toBe('archived');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.accepted'", helperId).n).toBe(0);
  } finally { await f.close(); }
});

test('last source acceptance retains partial helper cleanup and explicitly resumes without publication or Shell replay', async () => {
  const f = await setup({ run: async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'left plus right\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'retained auxiliary output');
    return 'controlled private repair';
  } });
  try {
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const helperId = f.store.deliveryRun(f.run.id).integration_worker_id;
    f.start(); await exited(f, helperId); f.stopScheduling();
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const helper = f.store.task(helperId), landed = await git(f.root, 'rev-parse', 'main');
    await f.project.acceptTask(f.sources[0].id);
    const realGit = f.project.workspaces.git.bind(f.project.workspaces);
    f.project.workspaces.git = (cwd, ...args) => args[0] === 'update-ref' && args[1] === '-d'
      && args[2] === `refs/heads/${helper.branch}` ? Promise.reject(new Error('controlled ref cleanup interruption')) : realGit(cwd, ...args);
    await expect(f.project.acceptTask(f.sources[1].id)).rejects.toThrow('整合资源未完全回收');
    expect(f.store.task(f.sources[1].id).status).toBe('completed');
    expect(f.store.task(helperId)).toMatchObject({ workspace: null, branch: helper.branch, status: 'awaiting_acceptance' });
    expect(await realGit(f.root, 'rev-parse', helper.branch)).toBe(helper.head_commit);
    f.project.workspaces.git = realGit;
    const realCommand = f.project.workspaces.runConvergenceValidation;
    f.project.workspaces.runConvergenceValidation = () => { throw new Error('must not replay Shell'); };
    await f.project.acceptTask(f.sources[1].id);
    f.project.workspaces.runConvergenceValidation = realCommand;
    expect(f.store.task(helperId)).toMatchObject({ workspace: null, branch: null, status: 'completed' });
    expect(await git(f.root, 'rev-parse', 'main')).toBe(landed);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='task.accepted'", f.sources[1].id).n).toBe(1);
  } finally { await f.close(); }
});

test('v3 fixed-source input stays buffered through repair, preserves publication, then resumes the independent source iteration', async () => {
  const f = await setup({ run: async ({ task, cwd }) => {
    expect(task.task_kind).toBe('integration');
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'left plus right\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'buffered-input isolation');
    return 'private output';
  } });
  try {
    const source = f.sources[0], fixedBooking = f.store.task(source.id).reservation;
    expect(f.project.message(source.id, 'another independent iteration').input_queue.buffered).toBe(1);
    f.project.wake(source.id);
    expect(f.store.task(source.id)).toMatchObject({ status: 'waiting', reservation: fixedBooking });
    expect(f.project.running.has(source.id)).toBe(false);
    await expect(f.project.acceptTask(source.id)).rejects.toThrow();
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    const helperId = f.store.deliveryRun(f.run.id).integration_worker_id;
    f.start(); await exited(f, helperId); f.stopScheduling();
    await f.project.prepareConvergenceRun(f.run.id, 1, new AbortController().signal);
    expect(f.store.deliveryRun(f.run.id).state).toBe('integrated');
    expect(f.store.task(source.id)).toMatchObject({ status: 'queued', reservation: null, iteration_base_commit: source.head_commit });
    expect(f.store.unread(source.id).find(message => message.body === 'another independent iteration').delivery_hold).toBe('released');
    expect(f.store.task(helperId).status).toBe('awaiting_acceptance');
    await unchanged(f);
  } finally { await f.close(); }
});
