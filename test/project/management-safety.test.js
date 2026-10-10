import fs from 'node:fs';
import path from 'node:path';
import { retiredHook } from '../hook-assertions.js';
import { test, expect, setDefaultTimeout } from 'bun:test';
import { fixture, repo, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { Store } from '../../src/persistence/store.js';
setDefaultTimeout(20000);

async function prepared(run = () => 'done') {
  const f = fixture({ run }); f.project.kick = () => {}; await repo(f.root);
  f.target = (await f.project.order('ordinary target', 'main', [], null, false)).task;
  let clock = Date.parse('2030-01-01T00:00:00Z');
  f.project.scheduledHookOptions = { now: () => clock, setTimeout: () => 1, clearTimeout: () => {} };
  f.advance = ms => { clock += ms; };
  f.signal = (daily = false) => f.project.saveHookSignal({ name: 'reset time is not quota proof', schedule: daily
    ? { kind: 'daily', time: '00:01', timezone: 'UTC' }
    : { kind: 'once', at: '2030-01-01T00:01:00Z', timezone: 'UTC' } }, f.project.hookSignals().revision).signals.items.at(-1);
  f.manager = (signal, mode = 'once') => f.project.createManagementWorker({ name: 'management', instruction: 'start paused target', signal_id: signal.id, mode });
  f.flush = () => f.project.observeScheduledTaskHooks();
  f.run = async () => { f.project.pump(); await Promise.all([...f.project.running.values()].map(run => run.promise)); };
  return f;
}

test('can_enable safely reflects consumed, failed, unavailable signal, cleanup and physical-exit gates without changing revision', async () => {
  const f = await prepared();
  try {
    const signal = f.signal(true), manager = f.manager(signal, 'persistent');
    const view = () => f.project.managementView(manager.id);
    expect(view().can_enable).toBe(true);
    f.project.updateManagementBinding(manager.id, false, view().revision);
    const revision = view().revision;
    expect(view().can_enable).toBe(true);
    f.project.workspaces.busy.add(manager.id);
    expect(view()).toMatchObject({ can_enable: false, revision });
    expect(view().reason).toContain('安全点');
    expect(() => f.project.updateManagementBinding(manager.id, true, revision)).toThrow('安全点');
    f.project.workspaces.busy.delete(manager.id);
    f.project.running.set(manager.id, { role: 'manager', controller: new AbortController(), promise: Promise.resolve() });
    expect(view()).toMatchObject({ can_enable: false, revision });
    expect(view().reason).toContain('实际退出');
    f.project.running.delete(manager.id);
    f.project.saveHookSignal({ id: signal.id, name: signal.name, schedule: signal.schedule, enabled: false }, f.project.hookSignals().revision);
    expect(view()).toMatchObject({ can_enable: false, revision });
    expect(view().reason).toContain('未来');
    f.project.saveHookSignal({ id: signal.id, name: signal.name, schedule: signal.schedule, enabled: true }, f.project.hookSignals().revision);
    expect(view().can_enable).toBe(true);
    f.project.updateManagementBinding(manager.id, true, revision);
    f.project.failManagementOccurrence(manager.id, 'unknown');
    expect(view()).toMatchObject({ can_enable: false });
    expect(view().reason).toContain('另建');
    const once = f.manager(f.signal());
    f.advance(60000); f.flush(); await f.run();
    expect(f.project.managementView(once.id)).toMatchObject({ can_enable: false, enabled: false, state: 'succeeded' });
    expect(f.project.hooksList().management_workers.find(item => item.id === once.id).management.can_enable).toBe(false);
  } finally { f.project.running.clear(); await f.close(); }
});

test('same creation key recovers the original receipt before changed defaults, consumed or removed signal checks and never calls a provider', async () => {
  let calls = 0;
  const f = await prepared(() => { calls += 1; return 'done'; });
  try {
    const signal = f.signal();
    const options = { client_request_id: 'cc63d08b-8b42-41b0-8f70-d5a30e899605', name: 'saved creation', instruction: 'start Wxx', signal_id: signal.id };
    const first = f.project.createManagementWorker(options);
    expect(f.project.createManagementWorker({ ...options, mode: 'once' }).id).toBe(first.id);
    const raw = JSON.parse(f.store.task(first.id).management);
    expect(raw.client_request_id).toBe(options.client_request_id);
    expect(raw.creation_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(f.project.inspect(first.id))).not.toContain(options.client_request_id);
    expect(JSON.stringify(f.project.hooksList())).not.toContain(raw.creation_fingerprint);
    f.advance(60000); f.flush(); await f.run();
    expect(calls).toBe(1);
    f.project.removeHookSignal(signal.id, f.project.hookSignals().revision);
    f.config.provider = 'pi';
    f.project.agentSettings.resolve = () => { throw new Error('later broken defaults'); };
    const replay = f.project.createManagementWorker(options);
    expect(replay.id).toBe(first.id); expect(replay.status).toBe('completed');
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management'").n).toBe(1);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='management.created'").n).toBe(1);
    expect(calls).toBe(1);
  } finally { await f.close(); }
});

test('creation keys compare stable original definitions, reject incompatible reuse and invalid keys before creating another Worker', async () => {
  const f = await prepared();
  try {
    const signal = f.signal(true), options = { name: 'keyed', instruction: 'start W1', signal_id: signal.id, client_request_id: 'opaque-request-1' };
    const first = f.project.createManagementWorker(options);
    const unicode = f.project.createManagementWorker({ ...options, client_request_id: '管理请求 内部空格' });
    expect(f.project.createManagementWorker({ ...options, client_request_id: '管理请求 内部空格' }).id).toBe(unicode.id);
    for (const changed of [{ instruction: 'start W2' }, { mode: 'persistent' }, { name: 'renamed' }, { signal_id: 'unknown' }, { profile: null }])
      expect(() => f.project.createManagementWorker({ ...options, ...changed })).toThrow('different management definition');
    for (const key of ['', null, ' padded key ', 'x'.repeat(129), 'bad\nkey', 123])
      expect(() => f.project.createManagementWorker({ ...options, client_request_id: key })).toThrow('client_request_id');
    const explicit = { ...options, client_request_id: 'explicit-profile-key', profile: { agent: 'pi', config_mode: 'pi',
      env: { PRIVATE: 'PRIVATE_VALUE', SECOND: 'SECOND_VALUE' } } };
    const saved = f.project.createManagementWorker(explicit);
    const reordered = { ...explicit, profile: { env: { SECOND: 'SECOND_VALUE', PRIVATE: 'PRIVATE_VALUE' }, config_mode: 'pi', agent: 'pi' } };
    expect(f.project.createManagementWorker(reordered).id).toBe(saved.id);
    expect(() => f.project.createManagementWorker({ ...explicit, profile: { ...explicit.profile, env: { PRIVATE: 'new-private-value' } } })).toThrow('different management definition');
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management'").n).toBe(3);
    expect(f.project.inspect(first.id).management.can_enable).toBe(true);
    expect(JSON.stringify(f.project.hooksList())).not.toContain('PRIVATE_VALUE');
  } finally { await f.close(); }
});

test('concurrent duplicate submissions and a fresh SQLite/Project instance reuse the same persisted key; no-key legacy submissions remain distinct', async () => {
  const f = await prepared(); let otherStore, other;
  try {
    const signal = f.signal(true), options = { name: 'deduplicated', instruction: 'start Wxx', signal_id: signal.id, client_request_id: 'concurrent-request' };
    const replies = await Promise.all(Array.from({ length: 12 }, () => Promise.resolve().then(() => f.project.createManagementWorker(options))));
    expect(new Set(replies.map(reply => reply.id)).size).toBe(1);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management'").n).toBe(1);
    f.advance(60000); f.flush();
    const occurrence = f.project.managementView(replies[0].id).pending_signal.id;
    await f.project.shutdown();
    otherStore = new Store(path.join(f.config.home, 'project.db'), f.root);
    other = new Project(f.config, otherStore, { run: () => 'mock only' });
    other.scheduledHookOptions = { now: () => Date.parse('2030-01-01T00:02:00Z'), setTimeout: () => 1, clearTimeout: () => {} };
    other.kick = () => {}; other.recover();
    expect(other.createManagementWorker(options).id).toBe(replies[0].id);
    expect(other.managementView(replies[0].id).pending_signal.id).toBe(occurrence);
    expect(() => other.createManagementWorker({ ...options, instruction: 'different' })).toThrow('different management definition');
    const { client_request_id: _key, ...withoutKey } = options;
    const legacy = [other.createManagementWorker(withoutKey), other.createManagementWorker(withoutKey)];
    expect(legacy[0].id).not.toBe(legacy[1].id);
    expect(otherStore.get("SELECT count(*) AS n FROM tasks WHERE task_kind='management'").n).toBe(3);
    const retained = JSON.parse(otherStore.task(replies[0].id).management);
    const extra = otherStore.create({ role: 'manager', task_kind: 'management', input_id: null, goal: 'invalid duplicate bypass' });
    expect(() => otherStore.update(extra.id, { management: JSON.stringify(retained) })).toThrow(); // DB uniqueness is an additional race backstop.
  } finally { await other?.shutdown(); otherStore?.close(); await f.close(); }
});

test('ordinary timed Hook and project time signal share one bounded timer without disturbing lifecycle Hooks or daemon settings', async () => {
  const f = await prepared();
  try {
    const manager = f.manager(f.signal()), main = f.target.parent_id;
    const daemonRevision = f.project.daemonHooks().revision;
    const mount = f.project.attachTaskHook(main, { name: 'ordinary notice', trigger: 'time.scheduled', mode: 'once', enabled: true,
      schedule: { kind: 'once', at: '2030-01-01T00:01:00Z', timezone: 'UTC' },
      actions: [{ type: 'notify', title: 'ordinary quota clock', body: 'not proof of quota' }] }, f.project.taskHooks(main).revision).mounts.at(-1);
    f.advance(60000); f.flush(); await f.project.hookQueue;
    expect(f.project.managementView(manager.id).state).toBe('queued');
    retiredHook(f.project, main, mount.id);
    expect(f.project.daemonHooks().revision).toBe(daemonRevision);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='ordinary quota clock'").n).toBe(1);
    await f.run(); expect(f.project.managementView(manager.id).state).toBe('succeeded');
    expect(f.project.scheduledHookTimer).toBeNull();
  } finally { await f.close(); }
});

test('management admission respects the existing execution lane capacity rather than starting a separate unbounded control pool', async () => {
  let calls = 0;
  const f = await prepared(({ task }) => { if (task.role === 'manager') calls += 1; return 'done'; });
  try {
    f.config.configureRuntime({ concurrency: 1 });
    const manager = f.manager(f.signal());
    f.project.running.set(f.target.id, { role: 'agent', controller: new AbortController(), promise: Promise.resolve() });
    f.advance(60000); f.flush(); f.project.pump();
    expect(calls).toBe(0); expect(f.project.managementView(manager.id).state).toBe('queued');
    f.project.running.delete(f.target.id); await f.run();
    expect(calls).toBe(1); expect(f.store.task(manager.id).status).toBe('completed');
  } finally { f.project.running.delete(f.target.id); await f.close(); }
});

test('fresh timers submit and start a management provider without a browser, explicit clock observation or real model call', async () => {
  let calls = 0;
  const f = await prepared(({ task }) => { if (task.role === 'manager') calls += 1; return 'mock operation analysis'; });
  try {
    f.project.kick = Project.prototype.kick.bind(f.project);
    f.project.scheduledHookOptions = { now: Date.now, setTimeout, clearTimeout };
    const signal = f.project.saveHookSignal({ name: 'real timer', schedule: { kind: 'once', at: new Date(Date.now() + 250).toISOString(), timezone: 'UTC' } },
      f.project.hookSignals().revision).signals.items.at(-1);
    const manager = f.manager(signal);
    await until(() => f.store.task(manager.id).status === 'completed' && !f.project.running.has(manager.id));
    expect(calls).toBe(1); expect(f.project.managementView(manager.id).last_execution.status).toBe('succeeded');
    expect(f.project.scheduledHookTimer).toBeNull();
  } finally { await f.close(); }
});

test('stale management occurrence identities, aborted/ended invocations and cross-kind actors cannot submit operations', async () => {
  const f = await prepared(({ task, api, token }) => {
    if (task.role !== 'manager') return 'done';
    const state = JSON.parse(api.store.task(task.id).management), run = api.running.get(task.id);
    expect(api.actor(token)).toBe(task.id);
    state.pending_signal.run_id = 999999; api.store.update(task.id, { management: JSON.stringify(state) });
    expect(() => api.requestManagementAction(task.id, 'start', f.target.id)).toThrow('authorization is not active');
    state.pending_signal.run_id = run.recordId; api.store.update(task.id, { management: JSON.stringify(state) });
    run.invocationEnded = true;
    expect(() => api.managementQuery(task.id)).toThrow('not active');
    run.invocationEnded = false;
    expect(() => api.managementQuery(f.target.id)).toThrow('only a management');
    expect(api.managementQuery(task.id, f.target.id).status).toBe('paused');
    return 'no unauthorized action';
  });
  try {
    const manager = f.manager(f.signal()); f.advance(60000); f.flush(); await f.run();
    expect(f.store.task(f.target.id).status).toBe('paused');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='management.action_submitted'").n).toBe(0);
    expect(f.store.task(manager.id).status).toBe('completed');
  } finally { await f.close(); }
});

test('explicit Worker deletion recognizes exact management-directory ownership, while manager histories do not appear as missing Git branches', async () => {
  const f = await prepared();
  try {
    const manager = f.manager(f.signal(true));
    const dir = await f.project.workspaces.ensure(f.store.task(manager.id));
    expect((await f.project.taskGraph()).nodes.some(node => node.id === manager.id)).toBe(false);
    expect((await f.project.graph()).nodes.some(node => node.kind === 'task' && node.id === manager.id)).toBe(false);
    fs.writeFileSync(path.join(dir, 'retained.txt'), 'explicit deletion only');
    f.project.cancel(manager.id);
    const preview = await f.project.deleteTaskPreview(manager.id);
    expect(preview.blockers).toEqual([]); expect(preview.can_delete).toBe(true);
    await f.project.deleteTask(manager.id, { revision: preview.revision, confirm: true });
    expect(f.store.get('SELECT id FROM tasks WHERE id=?', manager.id)).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
    expect(f.store.task(f.target.id).status).toBe('paused');
  } finally { await f.close(); }
});
