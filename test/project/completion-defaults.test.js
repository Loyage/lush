import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { Store } from '../../src/persistence/store.js';

const settings = (f, task) => JSON.parse(f.store.task(task.id).auto_merge);
const configure = (f, enabled, level) => f.project.setCompletionDefaults(enabled, level, f.project.completionDefaults().revision);
const info = (f, task) => f.store.all("SELECT * FROM notices WHERE task_id=? AND kind='info' ORDER BY id", task.id);
async function setup(provider) {
  const f = fixture(provider); f.project.kick = () => {}; await repo(f.root); return f;
}
function facts(f) {
  return ['meta', 'tasks', 'events', 'notices', 'inputs'].map(table => f.store.all(`SELECT * FROM ${table}`));
}

const rule = { name: 'template', trigger: 'agent.returned', mode: 'once', enabled: true,
  actions: [{ type: 'notify', title: 'template', body: 'done' }] };

test('completion defaults start disabled, read without writes, persist per project and keep their selected level when disabled', async () => {
  const f = await setup(), other = fixture();
  let reopened;
  try {
    const before = facts(f), initial = f.project.completionDefaults();
    expect(initial).toEqual({ version: 1, enabled: false, level: 'merge', revision: expect.any(String) });
    expect(f.project.hooksList().completion_defaults).toEqual(initial);
    f.project.completionDefaults(); f.project.hooksList();
    expect(facts(f)).toEqual(before); // No lazy meta initialization or Hook execution on reads.
    const enabled = configure(f, true, 'archive');
    expect(enabled.completion_defaults).toMatchObject({ enabled: true, level: 'archive' });
    const disabled = configure(f, false, 'archive');
    expect(disabled.completion_defaults).toMatchObject({ enabled: false, level: 'archive' });
    expect(other.project.completionDefaults()).toEqual(initial);
    const current = facts(f);
    reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    const restarted = new Project(f.config, reopened);
    expect(restarted.completionDefaults()).toEqual(disabled.completion_defaults);
    expect(restarted.hooksList().completion_defaults).toEqual(disabled.completion_defaults);
    expect(facts(f)).toEqual(current);
    await restarted.shutdown();
  } finally { reopened?.close(); await f.close(); await other.close(); }
});

test('defaults have strict values and an independent revision, including concurrent and ABA edits', async () => {
  const f = await setup(); let connection, tab;
  try {
    const initial = f.project.hooksList();
    for (const [enabled, level] of [[1, 'merge'], ['true', 'merge'], [true, 'off'], [true, 'all'], [true, null]])
      expect(() => f.project.setCompletionDefaults(enabled, level, initial.completion_defaults.revision)).toThrow();
    for (const revision of [undefined, null, 1, '', initial.revision])
      expect(() => f.project.setCompletionDefaults(true, 'merge', revision)).toThrow('revision');
    expect(f.project.completionDefaults()).toEqual(initial.completion_defaults);
    const saved = f.project.saveHookTemplate(rule, initial.revision);
    expect(saved.completion_defaults).toEqual(initial.completion_defaults);
    const changed = configure(f, true, 'accept');
    expect(changed.revision).toBe(saved.revision);
    expect(changed.daemon_hooks.revision).toBe(saved.daemon_hooks.revision);
    // A defaults save does not invalidate a template editor, nor the inverse.
    f.project.removeHookTemplate(saved.templates[0].id, saved.revision);
    connection = new Store(path.join(f.config.home, 'project.db'), f.root);
    tab = new Project(f.config, connection);
    const revision = tab.completionDefaults().revision;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => f.project.setCompletionDefaults(false, 'accept', revision)),
      Promise.resolve().then(() => tab.setCompletionDefaults(true, 'archive', revision)),
    ]);
    expect(results.map(row => row.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1].reason.message).toContain('revision');
    expect(tab.completionDefaults()).toEqual(f.project.completionDefaults());
    const returned = configure(f, true, 'accept');
    expect(returned.completion_defaults.revision).not.toBe(revision); // Same value does not reuse old authorization revision.
    expect(() => tab.setCompletionDefaults(true, 'merge', revision)).toThrow('revision');
    const after = facts(f); f.project.clearing = true;
    expect(() => configure(f, false, 'accept')).toThrow('clear');
    expect(facts(f)).toEqual(after); f.project.clearing = false;
  } finally { f.project.clearing = false; await tab?.shutdown(); connection?.close(); await f.close(); }
});

test('only newly created order Workers copy defaults; existing, child, owners, management and private receipts stay unchanged', async () => {
  const f = await setup();
  try {
    const old = (await f.project.order('existing', null, [], null, false)).task;
    const child = await f.project.spawn(old.id, 'child');
    const main = f.store.task(old.parent_id);
    const management = f.store.create({ role: 'manager', task_kind: 'management', goal: 'manage' });
    f.store.update(management.id, { status: 'paused' });
    await f.project.setTaskCompletion(old.id, 'accept', f.project.taskHooks(old.id).revision);
    const untouched = [old, child, main, management].map(task => f.store.task(task.id));
    const enabled = configure(f, true, 'archive');
    expect([old, child, main, management].map(task => f.store.task(task.id))).toEqual(untouched);
    const one = (await f.project.order('new', null, [], null, false)).task;
    const two = (await f.project.order('nested independent order', old.branch, [], null, false)).task;
    for (const task of [one, two]) expect(settings(f, task)).toMatchObject({ version: 1, enabled: true, locked: false,
      level: 'archive', completion: { authorization: expect.any(String), round: 0, executions: {}, notices: {} } });
    expect(settings(f, one).completion.authorization).not.toBe(settings(f, two).completion.authorization);
    const newChild = await f.project.spawn(one.id, 'new child');
    expect(settings(f, child)).toEqual({ version: 1, enabled: true, locked: true });
    expect(settings(f, newChild)).toEqual(settings(f, child));
    const childHooks = f.project.taskHooks(newChild.id);
    expect(childHooks.completion).toMatchObject({ level: 'merge', min_level: 'merge', locked: true, editable: false });
    expect(childHooks.mounts.slice(0, 3).every(mount => mount.locked && !mount.editable)).toBe(true);
    for (const level of ['off', 'merge', 'accept', 'archive'])
      await expect(f.project.setTaskCompletion(newChild.id, level, childHooks.revision)).rejects.toThrow('锁定');
    expect(settings(f, newChild)).toEqual(settings(f, child));
    const frozen = [old, child, main, management, one, two, newChild].map(task => f.store.task(task.id));
    const history = f.store.all('SELECT * FROM events WHERE task_id IS NOT NULL');
    configure(f, false, 'archive');
    expect([old, child, main, management, one, two, newChild].map(task => f.store.task(task.id))).toEqual(frozen);
    expect(f.store.all('SELECT * FROM events WHERE task_id IS NOT NULL')).toEqual(history);
    expect(settings(f, (await f.project.order('disabled', null, [], null, false)).task))
      .toEqual({ version: 1, enabled: false, locked: false });
    expect(enabled.completion_defaults.level).toBe('archive');
    expect(JSON.stringify(f.project.hooksList())).not.toContain('authorization');
  } finally { await f.close(); }
});

test('archive project default still leaves a normally delivered child awaiting its parent acceptance', async () => {
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task }) {
    fs.writeFileSync(path.join(task.workspace, 'child.txt'), 'child work');
    await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'child work');
    return 'child done';
  } });
  f.project.stopping = true;
  try {
    await repo(f.root); configure(f, true, 'archive');
    const parent = (await f.project.order('paused parent', null, [], null, false)).task;
    const child = await f.project.spawn(parent.id, 'child');
    f.project.stopping = false; f.project.kick();
    await until(() => f.store.task(child.id).status === 'awaiting_acceptance' && !f.project.running.has(child.id)
      && !f.project.taskMergeBusy?.size, 10000);
    await f.project.completionQueue;
    expect(f.project.taskHooks(child.id).completion).toMatchObject({ level: 'merge', locked: true, min_level: 'merge' });
    expect(settings(f, child).completion.authorization).toBeNull();
    expect(settings(f, child).completion.executions.accept).toBeUndefined();
    expect(f.store.history(child.id).some(row => row.type === 'task.accepted' || row.type === 'branch.archive')).toBe(false);
    expect(fs.existsSync(child.workspace)).toBe(true);
    expect(f.store.task(parent.id).status).toBe('paused');
  } finally { await f.close(); }
}, 15000);

test('direct order creation resolves defaults after asynchronous Git preparation, inside its creation transaction', async () => {
  const f = await setup(), entered = gate(), release = gate();
  try {
    const anchor = f.project.anchorInput.bind(f.project);
    f.project.anchorInput = async (...args) => { const result = await anchor(...args); entered.resolve(); await release.promise; return result; };
    const creating = f.project.order('creation race', null, [], null, false);
    await entered.promise;
    expect(f.store.all("SELECT * FROM tasks WHERE task_kind='order'")).toHaveLength(0);
    configure(f, true, 'archive'); release.resolve();
    const { task } = await creating;
    expect(settings(f, task)).toMatchObject({ enabled: true, level: 'archive' });
    configure(f, false, 'archive');
    expect(settings(f, task)).toMatchObject({ enabled: true, level: 'archive' });
  } finally { release.resolve(); await f.close(); }
});

for (const [mountedEnabled, createdEnabled] of [[false, true], [true, false]])
  test(`actual deferred order uses creation-time defaults (${mountedEnabled} -> ${createdEnabled}), not mount-time policy`, async () => {
    const f = await setup();
    try {
      const source = (await f.project.order('freezing source', 'main', [], null, false)).task;
      f.store.update(source.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested', commit: source.base_commit }) });
      configure(f, mountedEnabled, 'accept');
      const queued = await f.project.order('reserved order', 'main', [], null, false, undefined, null, true);
      expect(queued.deferred).toBe(true);
      expect(f.store.all('SELECT * FROM inputs')).toHaveLength(1);
      expect(f.store.all("SELECT * FROM tasks WHERE task_kind='order'")).toHaveLength(1);
      configure(f, createdEnabled, 'archive');
      fs.writeFileSync(path.join(f.root, 'later.txt'), 'new parent baseline');
      await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'later parent');
      const tip = await git(f.root, 'rev-parse', 'main');
      f.store.update(source.id, { reservation: null });
      await f.project.runParentReadyHooks(source.parent_id);
      const mount = f.project.taskHooks(source.parent_id).mounts.find(row => row.id === queued.hook_id);
      expect(mount.state).toBe('succeeded');
      const task = f.store.task(mount.last_execution.worker_id);
      expect(task).toMatchObject({ task_kind: 'order', status: 'paused', base_commit: tip });
      expect(settings(f, task)).toMatchObject({ enabled: createdEnabled, locked: false,
        ...(createdEnabled ? { level: 'archive', completion: { authorization: expect.any(String) } } : {}) });
      await f.project.runParentReadyHooks(source.parent_id);
      expect(f.store.all('SELECT * FROM inputs')).toHaveLength(2);
    } finally { await f.close(); }
  });

for (const level of ['off', 'merge', 'accept', 'archive'])
  test(`new order default ${level} actually runs its authorized completion chain after project defaults are disabled`, async () => {
    const f = fixture({ resolve() { return { agent: 'mock' }; }, async run({ task }) {
      fs.writeFileSync(path.join(task.workspace, 'result.txt'), level);
      await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'default completion');
      return 'done';
    } });
    f.project.stopping = true;
    try {
      await repo(f.root); configure(f, level !== 'off', level === 'off' ? 'merge' : level);
      const { task } = await f.project.order(`default ${level}`);
      const copied = settings(f, task);
      configure(f, false, level === 'off' ? 'merge' : level);
      expect(settings(f, task)).toEqual(copied);
      f.project.stopping = false; f.project.kick();
      await until(() => !f.project.running.has(task.id) && (level === 'off'
        ? f.store.task(task.id).status === 'waiting'
        : level === 'merge' ? info(f, task).some(row => row.title.includes('待验收'))
        : level === 'accept' ? info(f, task).some(row => row.title.includes('待归档'))
        : f.store.branch(task.branch).status === 'archived' && settings(f, task).completion.executions.archive?.status === 'succeeded'), 15000);
      expect(f.store.task(task.id)).toMatchObject({ status: level === 'off' ? 'waiting' : level === 'merge' ? 'awaiting_acceptance' : 'completed',
        integration: level === 'off' ? 'pending' : 'merged' });
      const events = f.store.history(task.id), merge = events.find(row => row.type === 'task.merge_integrated'),
        accept = events.find(row => row.type === 'task.accepted'), archive = events.find(row => row.type === 'branch.archive');
      if (level !== 'off') expect(merge).toBeDefined(); else expect(merge).toBeUndefined();
      if (['accept', 'archive'].includes(level)) {
        expect(accept.id).toBeGreaterThan(merge.id);
        expect(accept.data).toMatchObject({ via: 'completion_hook', accepted_by: 'user', authorization: copied.completion.authorization });
      } else expect(accept).toBeUndefined();
      if (level === 'archive') expect(archive.id).toBeGreaterThan(accept.id); else expect(archive).toBeUndefined();
      expect(info(f, task)).toHaveLength(level === 'archive' ? 0 : 1);
      expect(fs.existsSync(task.workspace)).toBe(level !== 'archive');
      const count = events.length;
      f.project.scheduleTaskCompletion(task.id); await f.project.completionQueue;
      f.project.hooksList(); f.project.taskHooks(task.id);
      expect(f.store.history(task.id)).toHaveLength(count);
    } finally { await f.close(); }
  }, 20000);
