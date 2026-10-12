import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, gate } from '../helpers.js';

setDefaultTimeout(20000);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); const main = await f.project.bootstrapMain(); return { ...f, main };
}
const revision = f => f.project.shortcutCommands().revision;
const save = (f, value) => f.project.saveShortcutCommand(value, revision(f)).commands.items.at(-1);
const authorize = (f, item) => f.project.authorizeShortcutCommand(item.id, item.version, true, revision(f));
const drain = f => Promise.all([...f.project.shortcutCommandJobs ?? []]);

test('default Worker saves project checkout identity, omission preserves it, null clears it and every edit revokes versions', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('directory', 'main', [], null, false);
    let item = save(f, { name: 'default', command: 'true', default_worker_id: task.id });
    expect(item).toMatchObject({ default_worker_id: task.id, version: 1, authorized: false });
    authorize(f, item);
    const hook = f.project.attachTaskHook(f.main.id, { name: 'old version', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
      actions: [{ type: 'command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    item = save(f, { id: item.id, name: item.name, command: item.command });
    expect(item).toMatchObject({ default_worker_id: task.id, version: 2, authorized: false });
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === hook.id).enabled).toBe(false);
    authorize(f, item);
    item = save(f, { id: item.id, name: item.name, command: item.command, default_worker_id: f.main.id });
    expect(item).toMatchObject({ default_worker_id: f.main.id, version: 3, authorized: false });
    authorize(f, item);
    item = save(f, { id: item.id, name: item.name, command: item.command, default_worker_id: null });
    expect(item).toMatchObject({ default_worker_id: null, version: 4, authorized: false });
    const legacy = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value);
    delete legacy.items.at(-1).default_worker_id;
    f.store.run("UPDATE meta SET value=? WHERE key='shortcut_commands'", JSON.stringify(legacy));
    expect(f.project.shortcutCommands().items.at(-1).default_worker_id).toBeNull();
  } finally { await f.close(); }
});

test('default directory rejects invalid IDs, terminal/non-development Workers, missing, foreign and mismatched checkouts without mutations', async () => {
  const f = await setup(), other = fixture();
  try {
    await repo(other.root);
    for (const default_worker_id of [0, -1, 1.5, '1', false, 999999]) {
      const before = revision(f);
      expect(() => save(f, { name: 'bad', command: 'true', default_worker_id })).toThrow();
      expect(revision(f)).toBe(before);
    }
    const { task } = await f.project.order('target', 'main', [], null, false);
    const original = f.store.task(task.id), before = revision(f);
    for (const patch of [{ status: 'completed' }, { task_kind: 'analysis' }, { task_kind: 'management' },
      { workspace: path.join(f.root, 'does-not-exist') }, { workspace: other.root }, { branch: 'nonexistent-branch' }]) {
      for (const [key, value] of Object.entries(patch)) f.store.run(`UPDATE tasks SET ${key}=? WHERE id=?`, value, task.id);
      expect(() => save(f, { name: 'bad', command: 'true', default_worker_id: task.id })).toThrow();
      f.store.run('UPDATE tasks SET status=?,task_kind=?,workspace=?,branch=? WHERE id=?', original.status, original.task_kind, original.workspace, original.branch, task.id);
    }
    expect(revision(f)).toBe(before);
    const branchStatus = f.store.branch(task.branch).status;
    f.store.run("UPDATE branches SET status='archived' WHERE branch=?", task.branch);
    expect(() => save(f, { name: 'bad', command: 'true', default_worker_id: task.id })).toThrow('unavailable');
    f.store.run('UPDATE branches SET status=? WHERE branch=?', branchStatus, task.branch);
    f.store.update(f.main.id, { status: 'completed' });
    expect(() => save(f, { name: 'bad', command: 'true', default_worker_id: task.id })).toThrow();
    f.store.update(f.main.id, { status: 'waiting' });
  } finally { await other.close(); await f.close(); }
});

test('prompt defaults reject child identities even on kind conversion or omitted-default edits, without silently changing the parent', async () => {
  const f = await setup();
  try {
    const child = (await f.project.order('shell directory', 'main', [], null, false)).task;
    f.store.run("UPDATE tasks SET task_kind='child' WHERE id=?", child.id);
    const item = save(f, { name: 'shell child default', command: 'true', default_worker_id: child.id }); authorize(f, item);
    const convert = { id: item.id, name: item.name, kind: 'prompt', prompt: 'prompt body' };
    const before = revision(f);
    expect(() => save(f, convert)).toThrow('parent');
    expect(() => save(f, { name: 'bad default', kind: 'prompt', prompt: 'body', default_worker_id: child.id })).toThrow('parent');
    expect(revision(f)).toBe(before);
    expect(f.project.shortcutCommands().items.find(c => c.id === item.id)).toMatchObject({ kind: 'shell', version: 1, authorized: true, default_worker_id: child.id });
    let prompt = save(f, { ...convert, default_worker_id: null });
    expect(prompt).toMatchObject({ kind: 'prompt', version: 2, authorized: false, default_worker_id: null });
    const parent = (await f.project.order('valid prompt parent', 'main', [], null, false)).task;
    prompt = save(f, { id: item.id, name: item.name, prompt: prompt.prompt, default_worker_id: parent.id });
    prompt = save(f, { id: item.id, name: 'renamed', prompt: prompt.prompt });
    expect(prompt).toMatchObject({ kind: 'prompt', version: 4, default_worker_id: parent.id });
    f.store.update(parent.id, { status: 'cancelled' });
    const stale = revision(f);
    expect(() => save(f, { id: item.id, name: 'edit stale default', prompt: prompt.prompt })).toThrow('parent');
    expect(revision(f)).toBe(stale);
    expect(save(f, { id: item.id, name: 'clear stale default', prompt: prompt.prompt, default_worker_id: null })).toMatchObject({ version: 5, default_worker_id: null });
  } finally { await f.close(); }
});

test('branch owner defaults resolve an existing linked worktree without storing an arbitrary path', async () => {
  const f = await setup();
  try {
    const workspace = path.join(f.root, '.lush', 'owner-worktree');
    await f.project.workspaces.git(f.root, 'worktree', 'add', '-b', 'explicit-owner', workspace);
    const head = await f.project.workspaces.git(f.root, 'rev-parse', 'explicit-owner');
    const owner = await f.project.bindBranch('explicit-owner', head);
    const item = save(f, { name: 'owner default', command: 'true', default_worker_id: owner.id });
    expect(item.default_worker_id).toBe(owner.id);
    authorize(f, item);
    const result = await f.project.runShortcutCommand(item.id, 1, owner.id, revision(f));
    expect(result.command_result.status).toBe('succeeded');
    await f.project.workspaces.git(workspace, 'checkout', '--detach');
    expect(() => save(f, { id: item.id, name: item.name, command: item.command, default_worker_id: owner.id })).toThrow('no real executable');
  } finally { await f.close(); }
});

test('manual directory remains explicit and overrides the convenience default; Hook uses its mounted Worker', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('default target', 'main', [], null, false);
    const item = save(f, { name: 'cwd', command: 'pwd > directory-proof', default_worker_id: task.id }); authorize(f, item);
    expect(() => f.project.startShortcutCommand(item.id, 1, undefined, revision(f))).toThrow();
    await expect(f.project.runShortcutCommand(item.id, 1, undefined, revision(f))).rejects.toThrow();
    f.project.startShortcutCommand(item.id, 1, task.id, revision(f)); await drain(f);
    expect(fs.readFileSync(path.join(task.workspace, 'directory-proof'), 'utf8').trim()).toBe(task.workspace);
    await f.project.runShortcutCommand(item.id, 1, f.main.id, revision(f));
    expect(fs.readFileSync(path.join(f.root, 'directory-proof'), 'utf8').trim()).toBe(f.root);
    fs.unlinkSync(path.join(f.root, 'directory-proof'));
    f.project.attachTaskHook(f.main.id, { name: 'mounted directory', trigger: 'worker.merge_received', mode: 'once', enabled: true,
      actions: [{ type: 'command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(f.main.id).revision);
    f.project.emitTaskHook(f.main.id, 'worker.merge_received'); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.root, 'directory-proof'), 'utf8').trim()).toBe(f.root);
    expect(f.project.shortcutCommandHistory().items[0]).toMatchObject({ source: 'hook', worker_id: f.main.id, status: 'succeeded' });
  } finally { await f.close(); }
});

test('expired default never silently falls back to main; explicit override still uses normal safety gates', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('expired', 'main', [], null, false);
    const item = save(f, { name: 'expired', command: 'printf x > directory-proof', default_worker_id: task.id }); authorize(f, item);
    f.store.update(task.id, { status: 'completed' });
    expect(() => f.project.startShortcutCommand(item.id, 1, task.id, revision(f))).toThrow('cannot execute');
    expect(fs.existsSync(path.join(f.root, 'directory-proof'))).toBe(false);
    f.project.running.set(f.main.id, {});
    expect(() => f.project.startShortcutCommand(item.id, 1, f.main.id, revision(f))).toThrow('Agent');
    f.project.running.clear();
    f.project.startShortcutCommand(item.id, 1, f.main.id, revision(f)); await drain(f);
    expect(fs.readFileSync(path.join(f.root, 'directory-proof'), 'utf8')).toBe('x');
    expect(f.project.shortcutCommands().items.at(-1).default_worker_id).toBe(task.id);
  } finally { f.project.running.clear(); await f.close(); }
});

test('default directory edit revokes a previously accepted command before spawn even after reauthorization', async () => {
  const f = await setup(), held = gate(); let release;
  try {
    const { task } = await f.project.order('new default', 'main', [], null, false);
    let item = save(f, { name: 'queued', command: 'printf BAD > forbidden', default_worker_id: f.main.id }); authorize(f, item);
    release = f.project.workspaces.exclusive(() => held.promise);
    const accepted = f.project.startShortcutCommand(item.id, 1, f.main.id, revision(f));
    item = save(f, { id: item.id, name: item.name, command: item.command, default_worker_id: task.id }); authorize(f, item);
    held.resolve(); await release; await drain(f);
    expect(f.project.shortcutCommandHistory({ execution_id: accepted.execution_id }).items[0]).toMatchObject({ status: 'failed', command_result: { reason: 'admission' } });
    expect(fs.existsSync(path.join(f.root, 'forbidden'))).toBe(false);
    expect(fs.existsSync(path.join(task.workspace, 'forbidden'))).toBe(false);
  } finally { held.resolve(); await release; await f.close(); }
});
