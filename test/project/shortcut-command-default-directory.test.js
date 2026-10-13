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
async function runHook(f, item, worker) {
  f.project.attachTaskHook(worker.id, { name: 'mounted directory', trigger: 'worker.merge_received', mode: 'once', enabled: true,
    actions: [{ type: 'command', command_id: item.id, command_version: item.version }] }, f.project.taskHooks(worker.id).revision);
  f.project.emitTaskHook(worker.id, 'worker.merge_received'); await f.project.hookQueue;
  return f.project.shortcutCommandHistory().items[0];
}

test('default Worker saves project checkout identity, omission preserves it, null clears it and edits keep enabled references', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('directory', 'main', [], null, false);
    let item = save(f, { name: 'default', command: 'true', default_worker_id: task.id });
    expect(item).toMatchObject({ default_worker_id: task.id, version: 1 });
    const hook = f.project.attachTaskHook(f.main.id, { name: 'old version', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
      actions: [{ type: 'command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    item = save(f, { id: item.id, name: item.name, command: item.command });
    expect(item).toMatchObject({ default_worker_id: task.id, version: 2 });
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === hook.id).enabled).toBe(true);
    item = save(f, { id: item.id, name: item.name, command: item.command, default_worker_id: f.main.id });
    expect(item).toMatchObject({ default_worker_id: f.main.id, version: 3 });
    item = save(f, { id: item.id, name: item.name, command: item.command, default_worker_id: null });
    expect(item).toMatchObject({ default_worker_id: null, version: 4 });
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

test('omitted historical child default survives Shell-to-prompt conversion; explicitly supplying it still rejects', async () => {
  const f = await setup();
  try {
    const child = (await f.project.order('shell directory', 'main', [], null, false)).task;
    f.store.run("UPDATE tasks SET task_kind='child' WHERE id=?", child.id);
    let item = save(f, { name: 'shell child default', command: 'true', default_worker_id: child.id });
    const convert = { id: item.id, name: item.name, kind: 'prompt', prompt: 'prompt body' };
    const before = revision(f);
    expect(() => save(f, { ...convert, default_worker_id: child.id })).toThrow('parent');
    expect(() => save(f, { name: 'bad default', kind: 'prompt', prompt: 'body', default_worker_id: child.id })).toThrow('parent');
    expect(revision(f)).toBe(before);
    item = save(f, convert);
    expect(item).toMatchObject({ kind: 'prompt', version: 2, default_worker_id: child.id });
    expect(item.command).toBeUndefined();
    item = save(f, { id: item.id, name: 'renamed', prompt: item.prompt });
    expect(item).toMatchObject({ version: 3, default_worker_id: child.id });
    expect(JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value).items.at(-1).default_worker_id).toBe(child.id);
    expect(save(f, { id: item.id, name: item.name, prompt: item.prompt, default_worker_id: null })).toMatchObject({ version: 4, default_worker_id: null });
  } finally { await f.close(); }
});

for (const kind of ['shell', 'prompt']) test(`${kind} edits preserve omitted unavailable historical defaults without revalidating or reauthorizing them`, async () => {
  const f = await setup();
  try {
    const parent = (await f.project.order('old default', 'main', [], null, false)).task;
    const body = kind === 'shell' ? { command: 'true' } : { prompt: 'prompt body' };
    let item = save(f, { name: 'old default', kind, ...body, default_worker_id: parent.id });
    const original = f.store.task(parent.id);
    const patches = kind === 'shell' ? [{ status: 'cancelled' }, { workspace: path.join(f.root, 'missing-checkout') }, { branch: 'missing-branch' }]
      : [{ status: 'cancelled' }, { status: 'completed' }];
    for (const patch of patches) {
      for (const [key, value] of Object.entries(patch)) f.store.run(`UPDATE tasks SET ${key}=? WHERE id=?`, value, parent.id);
      const before = revision(f), version = item.version;
      expect(() => save(f, { id: item.id, name: item.name, kind, ...body, default_worker_id: parent.id })).toThrow();
      expect(revision(f)).toBe(before);
      item = save(f, { id: item.id, name: 'edited historical default', kind, ...body });
      expect(item).toMatchObject({ version: version + 1, default_worker_id: parent.id });
      expect(JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value).items.at(-1).default_worker_id).toBe(parent.id);
      f.store.run('UPDATE tasks SET status=?,workspace=?,branch=? WHERE id=?', original.status, original.workspace, original.branch, parent.id);
    }
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
    const result = await runHook(f, item, owner);
    expect(result.command_result.status).toBe('succeeded');
    await f.project.workspaces.git(workspace, 'checkout', '--detach');
    expect(() => save(f, { id: item.id, name: item.name, command: item.command, default_worker_id: owner.id })).toThrow('no real executable');
  } finally { await f.close(); }
});

test('Hook ignores historical defaults and always uses its mounted Worker', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('default target', 'main', [], null, false);
    const item = save(f, { name: 'cwd', command: 'pwd > directory-proof', default_worker_id: task.id });
    expect(f.project.startShortcutCommand).toBeUndefined(); expect(f.project.runShortcutCommand).toBeUndefined();
    expect(fs.existsSync(path.join(task.workspace, 'directory-proof'))).toBe(false);
    f.project.attachTaskHook(f.main.id, { name: 'mounted directory', trigger: 'worker.merge_received', mode: 'once', enabled: true,
      actions: [{ type: 'command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(f.main.id).revision);
    f.project.emitTaskHook(f.main.id, 'worker.merge_received'); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.root, 'directory-proof'), 'utf8').trim()).toBe(f.root);
    expect(f.project.shortcutCommandHistory().items[0]).toMatchObject({ source: 'hook', worker_id: f.main.id, status: 'succeeded' });
  } finally { await f.close(); }
});

test('expired historical default does not route execution; Hook remains bound to its mounted identity', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('expired', 'main', [], null, false);
    const item = save(f, { name: 'expired', command: 'printf x > directory-proof', default_worker_id: task.id });
    f.store.update(task.id, { status: 'completed' });
    expect(fs.existsSync(path.join(f.root, 'directory-proof'))).toBe(false);
    await runHook(f, item, f.main);
    expect(fs.readFileSync(path.join(f.root, 'directory-proof'), 'utf8')).toBe('x');
    expect(f.project.shortcutCommands().items.at(-1).default_worker_id).toBe(task.id);
  } finally { f.project.running.clear(); await f.close(); }
});

test('queued Hook follows a default-directory edit before claim but remains in its mounted directory', async () => {
  const f = await setup(), held = gate(); let release;
  try {
    const { task } = await f.project.order('new default', 'main', [], null, false);
    let item = save(f, { name: 'queued', command: 'printf latest > .lush/directory-current', default_worker_id: f.main.id });
    release = f.project.workspaces.exclusive(() => held.promise);
    const hook = f.project.attachTaskHook(f.main.id, { name: 'queued directory', trigger: 'worker.merge_received', mode: 'once', enabled: true,
      actions: [{ type: 'command', command_id: item.id, command_version: 1 }] }, f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    f.project.emitTaskHook(f.main.id, 'worker.merge_received');
    item = save(f, { id: item.id, name: item.name, command: item.command, default_worker_id: task.id });
    held.resolve(); await release; await f.project.hookQueue;
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === hook.id)).toBeUndefined();
    expect(f.project.shortcutCommandHistory().items[0]).toMatchObject({ status: 'succeeded', command_version: 2, worker_id: f.main.id });
    expect(fs.readFileSync(path.join(f.config.home, 'directory-current'), 'utf8')).toBe('latest');
    expect(fs.existsSync(path.join(task.workspace, '.lush/directory-current'))).toBe(false);
  } finally { held.resolve(); await release; await f.close(); }
});
