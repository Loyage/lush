import { retiredHook } from '../hook-assertions.js';
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
    expect(enabled.completion_defaults).toMatchObject({ enabled: true, level: 'accept' });
    const disabled = configure(f, false, 'archive');
    expect(disabled.completion_defaults).toMatchObject({ enabled: false, level: 'accept' });
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
      level: 'accept', completion: { authorization: expect.any(String), round: 0, executions: {}, notices: {} } });
    expect(settings(f, one).completion.authorization).not.toBe(settings(f, two).completion.authorization);
    const newChild = await f.project.spawn(one.id, 'new child');
    expect(settings(f, child)).toEqual({ version: 1, enabled: true, locked: true, mounted_features: { completion: true, acceptance_notice: true }, acceptance_notice: { enabled: false } });
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
      .toEqual({ version: 1, enabled: false, locked: false, mounted_features: { completion: true, acceptance_notice: true }, acceptance_notice: { enabled: true } });
    expect(enabled.completion_defaults.level).toBe('accept');
    expect(JSON.stringify(f.project.hooksList())).not.toContain('authorization');
  } finally { await f.close(); }
});
