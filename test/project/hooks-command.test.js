import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { normalizeHook } from '../../src/core/hooks.js';
import { Project } from '../../src/core/project.js';
import { executeCommand, commandEnvironment } from '../../src/core/workspaces/command.js';

setDefaultTimeout(20000);
const rule = (command = 'true', extra = {}) => ({ name: 'command', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
  actions: [{ type: 'command', command }], ...extra });
const authorize = (f, command) => {
  const item = f.project.saveShortcutCommand({ name: 'test command', command }, f.project.shortcutCommands().revision).commands.items.at(-1);
  f.project.authorizeShortcutCommand(item.id, item.version, true, f.project.shortcutCommands().revision);
  return { type: 'command', command_id: item.id, command_version: item.version };
};
const registered = (f, hook) => hook.actions ? { ...hook, actions: hook.actions.map(action => action.type === 'command' && action.command !== undefined
  ? authorize(f, action.command) : action) } : hook;
const authorizeExample = f => {
  const action = f.project.hooksList().command_example.hooks.mounts.at(-1).actions[0];
  f.project.authorizeShortcutCommand(action.command_id, action.command_version, true, f.project.shortcutCommands().revision);
};
const attach = (f, task, hook) => f.project.attachTaskHook(task.id, registered(f, hook), f.project.taskHooks(task.id).revision).mounts.at(-1);
const view = (f, task, hook) => f.project.taskHooks(task.id).mounts.find(m => m.id === hook.id);
const emit = (f, task, source = null, trigger = 'worker.merge_received') => {
  const id = source ?? f.store.event(task.id, 'test.merge', {});
  f.project.emitTaskHook(task.id, trigger, id); return id;
};
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); const main = await f.project.bootstrapMain(); return { ...f, main };
}
async function deliver(f, name) {
  const { task } = await f.project.order(name, 'main', [], null, false);
  fs.writeFileSync(path.join(task.workspace, `${name}.txt`), name);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
  f.store.update(task.id, { status: 'waiting', result: 'done' });
  await f.project.workspaces.finish(f.store.task(task.id));
  await f.project.reserveTask(task.id, 'merge');
  await f.project.driveTaskMerge(f.main.id);
  expect(f.store.task(task.id).integration).toBe('merged');
  return task;
}

test('command actions validate exact references, modes and fields and reject inline Shell', () => {
  const action = { type: 'command', command_id: '12345678-1234-1234-1234-123456789abc', command_version: 1 };
  const hook = extra => rule('', { actions: [action], ...extra });
  expect(normalizeHook(hook()).actions).toEqual([action]);
  expect(normalizeHook(hook({ mode: 'once' })).mode).toBe('once');
  for (const command of ['', 'git push', 'a\0b', 'a'.repeat(16001)]) expect(() => normalizeHook(rule(command))).toThrow('fields');
  for (const command_version of [0, -1, '1', 1.5]) expect(() => normalizeHook(hook({ actions: [{ ...action, command_version }] }))).toThrow('reference');
  expect(() => normalizeHook(hook({ actions: [{ ...action, cwd: '/' }] }))).toThrow('fields');
  expect(() => normalizeHook(hook({ trigger: 'time.scheduled', schedule: { kind: 'daily', time: '00:00', timezone: 'UTC' } }))).toThrow('not allowed');
  for (const trigger of ['agent.failed','worker.accepted','worker.cancelled']) expect(() => normalizeHook(hook({ trigger }))).toThrow('not allowed');
});

test('startup installs exactly one disabled persistent template/main mount; reads and deletion never reinstall', async () => {
  const f = fixture(); f.project.kick = () => {};
  try {
    const before = f.store.get('SELECT count(*) AS n FROM meta').n;
    expect(f.project.hooksList().command_example).toBeNull();
    expect(f.store.get('SELECT count(*) AS n FROM meta').n).toBe(before);
    await repo(f.root); const main = await f.project.bootstrapMain();
    const initial = f.project.hooksList(), example = initial.command_example;
    expect(example.worker_id).toBe(main.id);
    expect(example.hooks.mounts.find(m => m.id === example.hook_id)).toMatchObject({ enabled: false, mode: 'persistent',
      actions: [{ type: 'command', command_id: initial.commands.items[0].id, command_version: 1 }], trigger: 'worker.merge_received' });
    expect(initial.commands.items[0]).toMatchObject({ name: 'git push', command: 'git push', authorized: true });
    expect(initial.templates.find(t => t.id === example.template_id)).toMatchObject({ enabled: false, mode: 'persistent' });
    await f.project.bootstrapMain(); expect(f.project.hooksList().revision).toBe(initial.revision);
    const history = f.store.history(main.id).length;
    f.project.hooksList(); f.project.taskHooks(main.id); f.project.inspect(main.id);
    expect(f.store.history(main.id)).toHaveLength(history);
    f.project.removeHookTemplate(example.template_id, initial.revision);
    f.project.removeTaskHook(main.id, example.hook_id, f.project.taskHooks(main.id).revision);
    await f.project.bootstrapMain();
    expect(f.project.hooksList().command_example).toMatchObject({ template_id: example.template_id, hook_id: example.hook_id, worker_id: main.id });
    expect(f.project.hooksList().command_example.hooks.mounts.some(m => m.id === example.hook_id)).toBe(false);
    expect(f.project.hooksList().templates).toHaveLength(0);
  } finally { await f.close(); }
});

test('a real successful queue landing triggers git push to a temporary bare remote, exactly once per parent event', async () => {
  const f = await setup();
  try {
    const remote = path.join(f.config.home, 'remote.git');
    await git(f.root, 'init', '--bare', remote); await git(f.root, 'remote', 'add', 'origin', remote);
    await git(f.root, 'push', '-u', 'origin', 'main');
    const example = f.project.hooksList().command_example;
    authorizeExample(f);
    await f.project.updateTaskHook(f.main.id, example.hook_id, true, example.hooks.revision);
    const first = await deliver(f, 'first');
    const firstTip = await git(f.root, 'rev-parse', 'main');
    expect(await git(remote, 'rev-parse', 'main')).toBe(firstTip);
    const second = await deliver(f, 'second');
    const secondTip = await git(f.root, 'rev-parse', 'main');
    expect(secondTip).not.toBe(firstTip); expect(await git(remote, 'rev-parse', 'main')).toBe(secondTip);
    const events = f.store.history(f.main.id).filter(e => e.type === 'worker.merge_received');
    expect(events).toHaveLength(2);
    expect(events.map(e => e.data.source_worker_id)).toEqual([first.id, second.id]);
    for (const event of [events[1], events[0], events[1]]) emit(f, f.main, event.id);
    await f.project.hookQueue;
    expect(f.store.history(f.main.id).filter(e => e.type === 'hook.command_submitted')).toHaveLength(2);
    expect(view(f, f.main, { id: example.hook_id }).state).toBe('succeeded');
    expect(f.store.task(f.main.id).calls).toBe(0);
  } finally { await f.close(); }
});

test('busy commands preserve every continuous merge event durably, including older-event deduplication', async () => {
  const f = await setup();
  try {
    const hook = attach(f, f.main, rule('while [ ! -f .lush/release ]; do sleep 0.01; done; printf x >> .lush/runs'));
    const one = emit(f, f.main);
    await until(() => view(f, f.main, hook).state === 'running');
    const two = emit(f, f.main), three = emit(f, f.main);
    emit(f, f.main, one); emit(f, f.main, two); emit(f, f.main, three);
    expect(view(f, f.main, hook).pending_count).toBe(3);
    fs.writeFileSync(path.join(f.config.home, 'release'), 'go');
    await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'runs'), 'utf8')).toBe('xxx');
    expect(view(f, f.main, hook)).toMatchObject({ state: 'succeeded', pending_count: 0 });
    expect(f.store.history(f.main.id).filter(e => e.type === 'hook.execution_succeeded' && e.data.hook_id === hook.id)).toHaveLength(3);
  } finally { await f.close(); }
});

test('failure hides raw stdout/stderr, stops future automatic execution and explicit recovery skips old queued triggers', async () => {
  const f = await setup();
  try {
    const hook = attach(f, f.main, rule('echo PRIVATE_STDOUT; echo PRIVATE_STDERR >&2; exit 7'));
    const first = emit(f, f.main); emit(f, f.main);
    await f.project.hookQueue;
    const failed = view(f, f.main, hook);
    expect(failed).toMatchObject({ state: 'failed', enabled: false });
    expect(failed.last_execution.command_result).toMatchObject({ exit_code: 7, status: 'failed' });
    const safe = JSON.stringify([failed.last_execution, f.store.history(f.main.id), f.store.all('SELECT * FROM notices')]);
    expect(safe).not.toContain('PRIVATE_STDOUT'); expect(safe).not.toContain('PRIVATE_STDERR');
    const submissions = f.store.history(f.main.id).filter(e => e.type === 'hook.command_submitted').length;
    emit(f, f.main); await f.project.hookQueue;
    expect(f.store.history(f.main.id).filter(e => e.type === 'hook.command_submitted')).toHaveLength(submissions);
    await f.project.updateTaskHook(f.main.id, hook.id, undefined, f.project.taskHooks(f.main.id).revision,
      registered(f, rule('printf recovered >> .lush/recovered')));
    emit(f, f.main, first); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'recovered'))).toBe(false);
    emit(f, f.main); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'recovered'), 'utf8')).toBe('recovered');
    expect(f.store.all("SELECT id FROM notices WHERE title='命令 Hook 已停用'")).toHaveLength(1);
  } finally { await f.close(); }
});

test('git push without a remote fails visibly and never installs or changes remotes', async () => {
  const f = await setup();
  try {
    const hook = f.project.hooksList().command_example;
    authorizeExample(f);
    await f.project.updateTaskHook(f.main.id, hook.hook_id, true, hook.hooks.revision);
    await deliver(f, 'no-remote');
    expect(view(f, f.main, { id: hook.hook_id })).toMatchObject({ state: 'failed', enabled: false });
    expect(await git(f.root, 'remote')).toBe('');
  } finally { await f.close(); }
});

test('commands wait for freezes/sync/cleanup/invocation and recheck after async workspace inspection inside Git queue', async () => {
  const f = await setup();
  try {
    const hook = attach(f, f.main, rule('printf x >> .lush/gated'));
    const blocker = await f.project.order('freeze', 'main', [], null, false);
    f.store.update(blocker.task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested' }) });
    emit(f, f.main); await f.project.hookQueue;
    expect(view(f, f.main, hook).state).toBe('waiting');
    f.store.update(blocker.task.id, { reservation: null });
    f.project.taskSyncBusy = new Set([f.main.id]); f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'gated'))).toBe(false);
    f.project.taskSyncBusy.clear(); f.project.workspaces.busy.add(f.main.id);
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'gated'))).toBe(false);
    f.project.workspaces.busy.clear(); f.project.running.set(f.main.id, {});
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'gated'))).toBe(false);
    f.project.running.delete(f.main.id);
    const original = f.project.workspaces.workspaceForBranch.bind(f.project.workspaces);
    f.project.workspaces.workspaceForBranch = async branch => {
      const result = await original(branch); f.project.running.set(f.main.id, {}); return result;
    };
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'gated'))).toBe(false);
    f.project.workspaces.workspaceForBranch = original; f.project.running.delete(f.main.id);
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'gated'), 'utf8')).toBe('x');
    expect(f.project.workspaces.pending).toBe(0);
  } finally { f.project.running.clear(); await f.close(); }
});

test('a following real merge can retain the parent slot without failing or losing an earlier unstarted command', async () => {
  const f = await setup(), hold = gate(); let blocker;
  try {
    const { task } = await f.project.order('slot-holder', 'main', [], null, false);
    fs.writeFileSync(path.join(task.workspace, 'child-slot.txt'), 'child');
    await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'source change');
    fs.writeFileSync(path.join(f.root, 'parent-slot.txt'), 'parent');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'parent diverges');
    f.store.update(task.id, { status: 'waiting', result: 'ready' });
    await f.project.workspaces.finish(f.store.task(task.id)); await f.project.reserveTask(task.id, 'merge');
    const hook = attach(f, f.main, rule('printf x >> .lush/slot-runs'));
    // Hold the global Git queue while the following merge queues ahead of the command's lock entry.
    blocker = f.project.workspaces.exclusive(() => hold.promise);
    const drive = f.project.driveTaskMerge(f.main.id);
    const earlier = emit(f, f.main);
    await Promise.resolve(); hold.resolve(); await blocker; await drive; await f.project.hookQueue;
    const booking = JSON.parse(f.store.task(task.id).reservation);
    expect(booking.status).toBe('resolving'); expect(f.project.activeTaskMerge(f.main.id).id).toBe(task.id);
    expect(view(f, f.main, hook)).toMatchObject({ state: 'waiting', enabled: true, pending_count: 1 });
    expect(fs.existsSync(path.join(f.config.home, 'slot-runs'))).toBe(false);
    expect(f.store.history(f.main.id).filter(e => e.type === 'hook.execution_failed' && e.data.hook_id === hook.id)).toHaveLength(0);
    // Preserve both sides in the source and resume this exact attempt; its successful parent event adds a second item.
    await git(task.workspace, 'merge', '--no-edit', booking.baseline);
    f.store.run('UPDATE messages SET consumed=1 WHERE task_id=?', task.id);
    f.store.update(task.id, { status: 'waiting', reservation: JSON.stringify({ ...booking, repair_ready: true }) });
    await f.project.workspaces.finish(f.store.task(task.id)); await f.project.driveTaskMerge(f.main.id);
    expect(f.store.task(task.id).integration).toBe('merged');
    expect(fs.readFileSync(path.join(f.config.home, 'slot-runs'), 'utf8')).toBe('xx');
    const received = f.store.history(f.main.id).filter(e => e.type === 'worker.merge_received').at(-1);
    emit(f, f.main, earlier); emit(f, f.main, received.id); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'slot-runs'), 'utf8')).toBe('xx');
    expect(view(f, f.main, hook)).toMatchObject({ state: 'succeeded', pending_count: 0 });
  } finally { hold.resolve(); await blocker; await f.close(); }
});

test('mounted worktree is actual cwd, environment strips invocation/provider capability and execution locks editing', async () => {
  const f = await setup(); let workspace;
  try {
    const { task } = await f.project.order('cwd', 'main', [], null, false);
    workspace = task.workspace;
    Object.assign(f.config.env, { LUSH_AGENT_TOKEN: 'TOKEN_SECRET', LUSH_TASK_ID: '987', PI_CODING_AGENT_DIR: '/private', CODEX_HOME: '/private',
      GIT_WORK_TREE: f.root });
    const hook = attach(f, task, rule('pwd > .lush-cwd; env > .lush-env; while [ ! -f release ]; do sleep 0.01; done', { trigger: 'agent.returned' }));
    emit(f, task, null, 'agent.returned');
    await until(() => view(f, task, hook).state === 'running');
    await until(() => fs.existsSync(path.join(task.workspace, '.lush-env')) && fs.statSync(path.join(task.workspace, '.lush-env')).size > 0);
    expect(fs.readFileSync(path.join(task.workspace, '.lush-cwd'), 'utf8').trim()).toBe(task.workspace);
    expect(fs.existsSync(path.join(f.root, '.lush-cwd'))).toBe(false);
    const env = fs.readFileSync(path.join(task.workspace, '.lush-env'), 'utf8');
    expect(env).not.toContain('TOKEN_SECRET'); expect(env).not.toContain('LUSH_TASK_ID=');
    expect(env).not.toContain('PI_CODING_AGENT_DIR='); expect(env).not.toContain('CODEX_HOME='); expect(env).not.toContain('GIT_WORK_TREE=');
    expect(env).toContain('GIT_TERMINAL_PROMPT=0');
    await expect(f.project.updateTaskHook(task.id, hook.id, false, f.project.taskHooks(task.id).revision)).rejects.toThrow('executing');
    expect(() => f.project.removeTaskHook(task.id, hook.id, f.project.taskHooks(task.id).revision)).toThrow('executing');
    fs.writeFileSync(path.join(task.workspace, 'release'), 'go'); await f.project.hookQueue;
  } finally { if (workspace) fs.writeFileSync(path.join(workspace, 'release'), 'go'); await f.close(); }
});

test('successful command receipts explain only the mounted ref; unrelated and failed writes remain unattributed', async () => {
  const f = await setup();
  const watches = [];
  try {
    await git(f.root, 'branch', 'other');
    const main = await f.project.workspaces.watchBranch('main'), other = await f.project.workspaces.watchBranch('other');
    watches.push(main, other);
    const result = await f.project.workspaces.runHookCommand(f.main,
      'git commit --allow-empty -m authorized-command && git update-ref refs/heads/other "$(git rev-parse HEAD)"', () => true);
    expect(result.status).toBe('succeeded');
    const movement = await f.project.workspaces.checkWatchedBranch(main);
    expect(movement.explained).toBe(true); expect(movement.transitions).toHaveLength(1);
    expect(movement.transitions[0].source.kind).toBe('daemon');
    expect((await f.project.workspaces.checkWatchedBranch(other)).explained).toBe(false);
    expect(other.transitions).toHaveLength(0);
    const failed = await f.project.workspaces.runHookCommand(f.main,
      'git commit --allow-empty -m failed-command; exit 7', () => true);
    expect(failed).toMatchObject({ status: 'failed', exit_code: 7 });
    expect((await f.project.workspaces.checkWatchedBranch(main)).explained).toBe(false);
    expect(main.transitions).toHaveLength(1); // The earlier success does not excuse this later failed write.
    expect(f.project.workspaces.refWrites.size).toBe(0);
  } finally { for (const watch of watches) f.project.workspaces.unwatchBranch(watch); await f.close(); }
});

test('command admission is rechecked after the new asynchronous ref baseline read, before spawn or start receipt', async () => {
  const f = await setup();
  try {
    const workspaces = f.project.workspaces, read = workspaces.readGuardRef.bind(workspaces);
    let ready = true, started = false;
    workspaces.readGuardRef = async ref => { const head = await read(ref); ready = false; return head; };
    const result = await workspaces.runHookCommand(f.main, 'printf x > .lush/should-not-run', () => ready,
      { started() { started = true; } });
    expect(result).toEqual({ status: 'waiting' }); expect(started).toBe(false);
    expect(fs.existsSync(path.join(f.config.home, 'should-not-run'))).toBe(false);
    expect(workspaces.refWrites.size).toBe(0);
  } finally { await f.close(); }
});

test('bounded commands discard output and kill timeout processes without returning raw diagnostics', async () => {
  const f = await setup();
  try {
    const env = commandEnvironment(f.config.env);
    const result = await executeCommand('while :; do printf PRIVATE_OUTPUT; done', f.root, env, { output_bytes: 128 });
    expect(result).toMatchObject({ status: 'failed', reason: 'output_limit', output_truncated: true });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_OUTPUT');
    const timed = await executeCommand('sleep 20', f.root, env, { timeout_ms: 20 });
    expect(timed).toMatchObject({ status: 'failed', reason: 'timeout' });
    const input = await executeCommand('read value || exit 9', f.root, env);
    expect(input).toMatchObject({ status: 'failed', exit_code: 9 });
  } finally { await f.close(); }
});

test('new runtime resumes durable unstarted submissions, but unknown started effects never replay after restart', async () => {
  const f = await setup(); let next;
  try {
    const hook = attach(f, f.main, rule('printf x >> .lush/restart'));
    f.project.taskSyncBusy = new Set([f.main.id]); emit(f, f.main); emit(f, f.main);
    expect(view(f, f.main, hook).pending_count).toBe(2);
    next = new Project(f.config, f.store); next.kick = () => {}; next.recoverTaskHooks();
    await Promise.resolve(); await next.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'restart'), 'utf8')).toBe('xx');
    next.taskSyncBusy = new Set([f.main.id]);
    const source = f.store.event(f.main.id, 'test.started', {}); next.emitTaskHook(f.main.id, 'worker.merge_received', source);
    const data = JSON.parse(f.store.task(f.main.id).hooks), active = data.mounts.find(m => m.id === hook.id);
    const submission = f.store.history(f.main.id).filter(e => e.type === 'hook.command_submitted').at(-1);
    active.state = 'running'; active.command_started_index = 0; active.receipts = [];
    active.last_execution = { id: submission.id, trigger: active.trigger, status: 'running', created_at: new Date().toISOString() };
    f.store.update(f.main.id, { hooks: JSON.stringify(data) });
    await next.shutdown(); next = new Project(f.config, f.store); next.kick = () => {}; next.recoverTaskHooks();
    await Promise.resolve(); await next.hookQueue;
    const unknown = next.taskHooks(f.main.id).mounts.find(m => m.id === hook.id);
    expect(unknown).toMatchObject({ state: 'unknown', enabled: false });
    expect(fs.readFileSync(path.join(f.config.home, 'restart'), 'utf8')).toBe('xx');
    await next.updateTaskHook(f.main.id, hook.id, true, next.taskHooks(f.main.id).revision);
    await Promise.resolve(); await next.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'restart'), 'utf8')).toBe('xx');
    next.emitTaskHook(f.main.id, 'worker.merge_received', f.store.event(f.main.id, 'test.future', {})); await next.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'restart'), 'utf8')).toBe('xxx');
    // A crash after an exact receipt, but before marking the rule finished, reconciles without execution.
    const snapshot = JSON.parse(f.store.task(f.main.id).hooks), exact = snapshot.mounts.find(m => m.id === hook.id);
    exact.state = 'running'; exact.last_execution.status = 'running';
    f.store.update(f.main.id, { hooks: JSON.stringify(snapshot) }); next.recoverTaskHooks();
    await Promise.resolve(); await next.hookQueue;
    expect(next.taskHooks(f.main.id).mounts.find(m => m.id === hook.id).state).toBe('succeeded');
    expect(fs.readFileSync(path.join(f.config.home, 'restart'), 'utf8')).toBe('xxx');
  } finally { await next?.shutdown(); await f.close(); }
});

test('a successful landing during shutdown atomically retains its unstarted command for the next runtime', async () => {
  const f = await setup(); let next;
  try {
    const hook = attach(f, f.main, rule('printf x >> .lush/shutdown-landing'));
    const finalize = f.project.finalizeTaskMerge.bind(f.project);
    f.project.finalizeTaskMerge = (...args) => { f.project.stopping = true; return finalize(...args); };
    await deliver(f, 'shutdown-landing');
    expect(view(f, f.main, hook)).toMatchObject({ state: 'waiting', pending_count: 1 });
    expect(fs.existsSync(path.join(f.config.home, 'shutdown-landing'))).toBe(false);
    next = new Project(f.config, f.store); next.kick = () => {}; next.recoverTaskHooks();
    await Promise.resolve(); await next.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'shutdown-landing'), 'utf8')).toBe('x');
    expect(next.taskHooks(f.main.id).mounts.find(m => m.id === hook.id)).toMatchObject({ state: 'succeeded', pending_count: 0 });
  } finally { await next?.shutdown(); await f.close(); }
});

test('full editing preserves mount identity/private profile; template edits and copied mounts stay isolated', async () => {
  const f = await setup();
  try {
    const saved = f.project.saveHookTemplate(registered(f, rule('echo original')), f.project.hooksList().revision);
    const template = saved.templates.at(-1), one = attach(f, f.main, { template_id: template.id }), two = attach(f, f.main, { template_id: template.id });
    f.project.saveHookTemplate({ id: template.id, ...registered(f, rule('echo template-edited')) }, saved.revision);
    await f.project.updateTaskHook(f.main.id, one.id, undefined, f.project.taskHooks(f.main.id).revision, registered(f, rule('echo instance-edited', { enabled: false })));
    expect(f.project.resolveShortcutCommand(view(f, f.main, one).actions[0]).command).toBe('echo instance-edited');
    expect(f.project.resolveShortcutCommand(view(f, f.main, two).actions[0]).command).toBe('echo original');
    expect(view(f, f.main, one).id).toBe(one.id);
    await expect(f.project.updateTaskHook(f.main.id, one.id, true, f.project.taskHooks(f.main.id).revision, rule())).rejects.toThrow('not both');
    await expect(f.project.updateTaskHook(f.main.id, one.id, undefined, 'stale', rule())).rejects.toThrow('revision changed');
    const creation = attach(f, f.main, { name: 'private', trigger: 'worker.parent_ready', mode: 'once', enabled: false,
      actions: [{ type: 'create_worker', content: 'private', start: false, profile: { agent: 'pi', config_mode: 'lush', model: 'test/model',
        append_prompt: 'PRIVATE_PROMPT', env: { KEY: 'PRIVATE_ENV' } } }] });
    const publicRule = { name: 'renamed', trigger: creation.trigger, mode: creation.mode, enabled: false,
      actions: creation.actions.map(({ model_selection, ...action }) => action) };
    await f.project.updateTaskHook(f.main.id, creation.id, undefined, f.project.taskHooks(f.main.id).revision, publicRule);
    const raw = JSON.parse(f.store.task(f.main.id).hooks).mounts.find(m => m.id === creation.id);
    expect(raw.actions[0].profile.append_prompt).toBe('PRIVATE_PROMPT'); expect(raw.actions[0].profile.env.KEY).toBe('PRIVATE_ENV');
    expect(JSON.stringify(f.project.taskHooks(f.main.id))).not.toContain('PRIVATE_ENV');
  } finally { await f.close(); }
});

test('once commands execute once, absent checkout/closed owner fail safely, and a later failing action never repeats earlier effects', async () => {
  const f = await setup();
  try {
    const once = attach(f, f.main, rule('printf x >> .lush/once', { mode: 'once' }));
    emit(f, f.main); emit(f, f.main); await f.project.hookQueue; emit(f, f.main); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'once'), 'utf8')).toBe('x');
    const compound = attach(f, f.main, rule('true', { actions: [{ type: 'command', command: 'printf x >> .lush/partial' },
      { type: 'command', command: 'exit 1' }] }));
    emit(f, f.main); await f.project.hookQueue; f.project.recoverTaskHooks(); await Promise.resolve(); await f.project.hookQueue;
    expect(view(f, f.main, compound)).toMatchObject({ state: 'failed', enabled: false });
    expect(fs.readFileSync(path.join(f.config.home, 'partial'), 'utf8')).toBe('x');
    const missing = attach(f, f.main, rule());
    await git(f.root, 'switch', '-c', 'other'); emit(f, f.main); await f.project.hookQueue;
    expect(view(f, f.main, missing)).toMatchObject({ state: 'failed', enabled: false });
    await git(f.root, 'switch', 'main');
    const closed = attach(f, f.main, rule()); f.store.update(f.main.id, { status: 'completed' }); emit(f, f.main); await f.project.hookQueue;
    expect(view(f, f.main, closed)).toMatchObject({ state: 'failed', enabled: false });
  } finally { await f.close(); }
});
