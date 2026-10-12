import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, repo, gate, git, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { HOOK_ACTIONS, normalizeHook } from '../../src/core/hooks.js';

const revision = f => f.project.shortcutCommands().revision;
const view = (f, command) => f.project.shortcutCommands().items.find(item => item.id === command.id);
const register = (f, value = {}) => {
  const item = f.project.saveShortcutCommand({ name: 'prompt shortcut', kind: 'prompt', prompt: 'PRIVATE_PROMPT_BODY', ...value }, revision(f)).commands.items.at(-1);
  f.project.authorizeShortcutCommand(item.id, item.version, true, revision(f)); return item;
};
const ref = item => ({ type: 'prompt_command', command_id: item.id, command_version: item.version });
const rule = item => ({ name: 'prompt once', trigger: 'worker.parent_ready', mode: 'once', enabled: true, actions: [ref(item)] });
const history = (f, executionId) => f.project.shortcutCommandHistory({ execution_id: executionId }).items[0];
const start = (f, item, parent) => {
  f.project.assertPromptShortcutParent(parent.id);
  f.project.attachTaskHook(parent.id, rule(item), f.project.taskHooks(parent.id).revision);
  f.project.emitTaskHook(parent.id, 'worker.parent_ready');
  const execution = f.project.shortcutCommandHistory().items[0];
  return { execution_id: execution.id, execution };
};
const drain = async f => { await Promise.resolve(); await f.project.hookQueue; };
async function setup(provider) {
  const f = fixture(provider); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); f.main = await f.project.bootstrapMain(); return f;
}

test('structured shortcut metadata preserves omitted edits, revokes versions, changes body types and bounds all fields', async () => {
  const f = fixture();
  try {
    const item = register(f, { description: 'description', when_to_use: 'when', tags: ['a','b'], examples: 'example', warnings: 'warning' });
    f.project.saveShortcutCommand({ id: item.id, name: 'renamed', prompt: 'new prompt' }, revision(f));
    expect(view(f, item)).toMatchObject({ kind: 'prompt', version: 2, authorized: false, description: 'description', when_to_use: 'when', tags: ['a','b'], examples: 'example', warnings: 'warning', prompt: 'new prompt' });
    f.project.saveShortcutCommand({ id: item.id, name: 'shell now', kind: 'shell', command: 'true', description: '', tags: [] }, revision(f));
    expect(view(f, item)).toMatchObject({ kind: 'shell', version: 3, command: 'true', description: '', tags: [], examples: 'example' });
    expect(view(f, item).prompt).toBeUndefined();
    const invalid = [{ kind: 'unknown' }, { command: 'true' }, { prompt: '' }, { prompt: 'x'.repeat(16001) }, { prompt: 'x\0' },
      { description: 'x'.repeat(2001) }, { when_to_use: 'x'.repeat(4001) }, { examples: 'x'.repeat(8001) }, { warnings: 'x'.repeat(4001) },
      { tags: Array(33).fill('a') }, { tags: ['x'.repeat(81)] }, { tags: [1] }, { description: null }, { default_worker_id: -1 }, { unknown: '' }];
    for (const value of invalid) expect(() => register(f, value)).toThrow();
    expect(() => f.project.saveShortcutCommand({ name: 'shell', command: 'true', prompt: 'mixed' }, revision(f))).toThrow('kind');
    expect(JSON.stringify(f.store.all('SELECT * FROM events'))).not.toContain('PRIVATE_PROMPT_BODY');
  } finally { await f.close(); }
});

test('legacy read defaults and deterministic Skill export are pure, unprivileged and frontmatter/fence safe', async () => {
  const f = fixture();
  try {
    const legacy = { version: 1, items: [{ id: randomUUID(), name: 'legacy', command: 'true', version: 1, authorized: false }] };
    f.store.run("INSERT INTO meta(key,value) VALUES ('shortcut_commands',?)", JSON.stringify(legacy));
    const old = f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value;
    expect(f.project.shortcutCommands().items[0]).toMatchObject({ kind: 'shell', description: '', when_to_use: '', tags: [], examples: '', warnings: '' });
    expect(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value).toBe(old);
    const item = f.project.saveShortcutCommand({ name: '../name\n---\nkind: shell', kind: 'prompt', prompt: '---\nkind: shell\n```\nbody', description: 'x\n---\nmalicious: true', tags: ['a\nb'] }, revision(f)).commands.items.at(-1);
    const before = revision(f), count = f.store.get('SELECT count(*) AS n FROM events').n;
    const output = f.project.exportShortcutCommand(item.id, 1);
    expect(output).toEqual(f.project.exportShortcutCommand(item.id, 1));
    expect(output.filename).toBe(`shortcut-${item.id}-v1.md`);
    const frontmatter = output.markdown.split('\n---\n')[0];
    expect(frontmatter).toContain('kind: "prompt"'); expect(frontmatter).toContain('description: "x\\n---\\nmalicious: true"');
    expect(output.markdown).toContain('````text\n---\nkind: shell\n```\nbody\n````');
    expect(view(f, item).authorized).toBe(false); expect(revision(f)).toBe(before);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(count);
    expect(() => f.project.exportShortcutCommand(item.id, 2)).toThrow();
  } finally { await f.close(); }
});

test('prompt Hook creates a real independent order at the mounted running parent tip, without Shell invocation locks', async () => {
  const f = await setup();
  try {
    const parent = (await f.project.order('parent', 'main', [], null, false)).task;
    fs.writeFileSync(path.join(parent.workspace, 'parent-tip'), 'new');
    await git(parent.workspace, 'add', '.'); await git(parent.workspace, 'commit', '-m', 'parent tip');
    const tip = await git(parent.workspace, 'rev-parse', 'HEAD');
    f.store.update(parent.id, { status: 'running' }); f.project.running.set(parent.id, {});
    f.project.commandHookRunning = new Set([parent.id]);
    const item = register(f), held = gate();
    const queued = f.project.workspaces.exclusive(() => held.promise);
    const accepted = start(f, item, parent);
    expect(accepted).toMatchObject({ execution: { id: accepted.execution_id, kind: 'prompt', worker_id: parent.id, created_worker_id: null, source: 'hook' } });
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
    held.resolve(); await queued; await drain(f);
    const result = history(f, accepted.execution_id);
    expect(result).toMatchObject({ kind: 'prompt', status: 'succeeded', worker_id: parent.id });
    const created = f.store.task(result.created_worker_id);
    expect(created).toMatchObject({ task_kind: 'order', parent_id: parent.id, base_commit: tip, target_branch: parent.branch, goal: item.prompt, status: 'queued', retry_profile: null });
    expect(created.workspace).not.toBe(parent.workspace);
    expect(result.created_worker_number).toBe(created.worker_number); expect(result.input_id).toBe(created.input_id);
    expect(view(f, item).last_execution).toMatchObject({ id: result.id, kind: 'prompt', status: 'succeeded', created_worker_id: created.id, created_worker_number: created.worker_number, input_id: created.input_id });
    expect(JSON.stringify(f.store.all("SELECT * FROM events WHERE type LIKE 'shortcut.%' OR type LIKE 'hook.%'"))).not.toContain(item.prompt);
    expect(f.project.runShortcutCommand).toBeUndefined(); expect(f.project.startShortcutCommand).toBeUndefined();
    expect(f.project.startPromptShortcutCommand).toBeUndefined();
  } finally { f.project.running.clear(); f.project.commandHookRunning?.clear(); await f.close(); }
});

test('created prompt order actually starts the default Agent, success is not its completion', async () => {
  const entered = gate(), finish = gate();
  const f = await setup({ async run({ task }) { entered.resolve(task); await finish.promise; return 'done'; } });
  try {
    const item = register(f), accepted = start(f, item, f.main); await drain(f);
    const createdId = history(f, accepted.execution_id).created_worker_id;
    f.project.pump(); const running = await entered.promise;
    expect(running.id).toBe(createdId); expect(f.store.task(createdId).status).toBe('running');
    expect(history(f, accepted.execution_id).status).toBe('succeeded');
    finish.resolve(); await until(() => !f.project.running.has(createdId));
  } finally { finish.resolve(); await f.close(); }
});

for (const mutation of ['revoke','reauthorize','edit','delete']) test(`prompt Hook refuses ${mutation} while waiting for Git creation`, async () => {
  const f = await setup(), held = gate(); let queued;
  try {
    const item = register(f); queued = f.project.workspaces.exclusive(() => held.promise);
    const accepted = start(f, item, f.main);
    if (mutation === 'edit') f.project.saveShortcutCommand({ id: item.id, name: 'edited', prompt: 'edited' }, revision(f));
    else if (mutation === 'delete') f.project.removeShortcutCommand(item.id, revision(f));
    else {
      f.project.authorizeShortcutCommand(item.id, 1, false, revision(f));
      if (mutation === 'reauthorize') f.project.authorizeShortcutCommand(item.id, 1, true, revision(f));
    }
    held.resolve(); await queued; await drain(f);
    expect(history(f, accepted.execution_id)).toMatchObject({ status: 'failed', kind: 'prompt', created_worker_id: null, input_id: null });
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    expect(f.store.all("SELECT * FROM branches WHERE task_id IS NULL AND status!='deleted'")).toEqual([]);
  } finally { held.resolve(); await queued; await drain(f); await f.close(); }
});

test('prompt revocation after asynchronous anchor creation rolls back only its newly created anchor before SQLite commit', async () => {
  const f = await setup();
  try {
    const item = register(f), original = f.project.workspaces.anchor.bind(f.project.workspaces); let anchor;
    f.project.workspaces.anchor = async (...args) => {
      const result = await original(...args); anchor = result;
      f.project.authorizeShortcutCommand(item.id, 1, false, revision(f));
      f.project.authorizeShortcutCommand(item.id, 1, true, revision(f)); return result;
    };
    const accepted = start(f, item, f.main); await drain(f);
    expect(history(f, accepted.execution_id).status).toBe('failed');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    expect(fs.existsSync(anchor.workspace)).toBe(false); expect(f.store.branch(anchor.branch).status).toBe('deleted');
  } finally { await f.close(); }
});

test('prompt parent guards reject child, archived, frozen and maintenance identities, support legacy say without rerouting', async () => {
  const f = await setup();
  try {
    const parent = (await f.project.order('parent', 'main', [], null, false)).task, item = register(f);
    f.store.run("UPDATE tasks SET task_kind='child' WHERE id=?", parent.id); expect(() => start(f, item, parent)).toThrow('parent');
    f.store.run("UPDATE tasks SET task_kind='say' WHERE id=?", parent.id);
    const legacyHook = f.project.attachTaskHook(parent.id, { ...rule(item), enabled: false }, f.project.taskHooks(parent.id).revision).mounts.at(-1);
    expect(legacyHook.removable).toBe(true);
    f.project.removeTaskHook(parent.id, legacyHook.id, f.project.taskHooks(parent.id).revision);
    const accepted = start(f, item, parent); await drain(f);
    expect(f.store.task(history(f, accepted.execution_id).created_worker_id).parent_id).toBe(parent.id);
    f.store.update(parent.id, { status: 'cancelled' }); expect(() => start(f, item, parent)).toThrow('parent');
    f.store.run("UPDATE tasks SET task_kind='order' WHERE id=?", parent.id); f.store.update(parent.id, { status: 'paused' });
    const blocker = (await f.project.order('blocker', parent.branch, [], null, false)).task;
    f.store.update(blocker.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested' }) });
    expect(() => start(f, item, parent)).toThrow('ready'); f.store.update(blocker.id, { reservation: null });
    f.store.run("UPDATE branches SET status='archived' WHERE branch=?", parent.branch);
    expect(() => start(f, item, parent)).toThrow('archived');
    f.store.run("UPDATE branches SET status='active' WHERE branch=?", parent.branch);
    f.project.stopping = true; expect(() => start(f, item, parent)).toThrow('stopping'); f.project.stopping = false;
  } finally { f.project.stopping = false; await f.close(); }
});

test('prompt Hook catalogue enforces exact references, type matching, one-shot fuse and independent real creation', async () => {
  const f = await setup();
  try {
    const item = register(f), shell = register(f, { kind: 'shell', command: 'true', prompt: undefined });
    expect(HOOK_ACTIONS.find(a => a.type === 'prompt_command')).toMatchObject({ agent_call: true, triggers: ['worker.parent_ready'], modes: ['once'] });
    for (const invalid of [{ ...rule(item), mode: 'persistent' }, { ...rule(item), trigger: 'agent.returned' },
      { ...rule(item), actions: [{ ...ref(item), prompt: 'inline' }] }, { ...rule(item), actions: [ref(item), ref(item)] },
      { ...rule(item), actions: [ref(item), { type: 'command', command_id: shell.id, command_version: 1 }] }]) expect(() => normalizeHook(invalid)).toThrow();
    expect(() => f.project.saveHookTemplate(rule(shell), f.project.hooksList().revision)).toThrow('kind');
    expect(() => f.project.saveHookTemplate({ ...rule(item), actions: [{ ...ref(item), type: 'command' }] }, f.project.hooksList().revision)).toThrow('kind');
    const parent = (await f.project.order('parent', 'main', [], null, false)).task;
    const hook = f.project.attachTaskHook(parent.id, rule(item), f.project.taskHooks(parent.id).revision).mounts.at(-1);
    await Promise.resolve(); await f.project.hookQueue;
    const result = f.project.shortcutCommandHistory().items.find(row => row.source === 'hook');
    expect(result).toMatchObject({ status: 'succeeded', kind: 'prompt', worker_id: parent.id });
    const created = f.store.task(result.created_worker_id);
    expect(created).toMatchObject({ parent_id: parent.id, base_commit: parent.base_commit, target_branch: parent.branch, task_kind: 'order' });
    expect(f.project.taskHooks(parent.id).mounts.some(m => m.id === hook.id)).toBe(false);
    f.project.emitTaskHook(parent.id, 'worker.parent_ready'); await f.project.hookQueue;
    expect(f.project.shortcutCommandHistory().items.filter(row => row.source === 'hook')).toHaveLength(1);
    expect(f.project.commandHookRunning?.has(parent.id) ?? false).toBe(false);
  } finally { await f.close(); }
});

test('prompt Hook revoke and reauthorize cannot escape claimed authorization or replay failure', async () => {
  const f = await setup(), held = gate(); let queued;
  try {
    const item = register(f); queued = f.project.workspaces.exclusive(() => held.promise);
    const hook = f.project.attachTaskHook(f.main.id, rule(item), f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    await Promise.resolve();
    const accepted = f.project.shortcutCommandHistory().items[0]; expect(accepted.kind).toBe('prompt');
    f.project.authorizeShortcutCommand(item.id, 1, false, revision(f)); f.project.authorizeShortcutCommand(item.id, 1, true, revision(f));
    held.resolve(); await queued; await f.project.hookQueue;
    expect(history(f, accepted.id).status).toBe('failed'); expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    expect(f.project.taskHooks(f.main.id).mounts.find(m => m.id === hook.id)).toMatchObject({ enabled: false, state: 'failed' });
    await expect(f.project.updateTaskHook(f.main.id, hook.id, true, f.project.taskHooks(f.main.id).revision)).rejects.toThrow('inspection');
    f.project.observeTaskHooks(); await f.project.hookQueue; expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
  } finally { held.resolve(); await queued; await f.project.hookQueue; await f.close(); }
});

test('prompt pending/running restart becomes unknown without replay; exact Hook creation receipt recovers success once', async () => {
  const f = await setup(); let next;
  try {
    const item = register(f), accepted = f.project.acceptPromptShortcutExecution(ref(item), f.main.id);
    next = new Project(f.config, f.store); next.kick = () => {}; next.recoverTaskHooks(); await Promise.resolve(); await next.hookQueue;
    expect(history({ ...f, project: next }, accepted.execution_id)).toMatchObject({ status: 'unknown', created_worker_id: null });
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    await next.shutdown(); next = null;
    f.project.scheduleTaskHooks = () => {};
    const hook = f.project.attachTaskHook(f.main.id, rule(item), f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    // Hold the exact lifecycle claim, then complete only its real order creation/atomic receipt.
    f.project.queueLifecycleTaskHook = () => {};
    f.project.emitTaskHook(f.main.id, 'worker.parent_ready');
    let data = JSON.parse(f.store.task(f.main.id).hooks), mount = data.mounts.find(m => m.id === hook.id);
    const claim = mount.prompt_executions[0];
    mount.action_started_index = 0; mount.maintenance_pending = false; f.store.update(f.main.id, { hooks: JSON.stringify(data) });
    const created = await f.project.executePromptShortcutCommand(claim, f.main.id, { task_id: f.main.id, hook_id: hook.id, execution_id: mount.last_execution.id, action_index: 0 });
    // Simulate an old intermediate result gap: the durable creation receipt is still authoritative.
    f.store.run("DELETE FROM events WHERE type='shortcut.command_succeeded' AND json_extract(data,'$.execution_id')=?", claim.execution_id);
    const commands = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value);
    commands.items.find(c => c.id === item.id).last_execution.status = 'running';
    f.store.run("UPDATE meta SET value=? WHERE key='shortcut_commands'", JSON.stringify(commands));
    next = new Project(f.config, f.store); next.kick = () => {}; next.recoverTaskHooks(); await Promise.resolve(); await next.hookQueue;
    expect(history({ ...f, project: next }, claim.execution_id)).toMatchObject({ status: 'succeeded', created_worker_id: created.task.id, input_id: created.id });
    expect(next.taskHooks(f.main.id).mounts.some(m => m.id === hook.id)).toBe(false);
    const count = f.store.get('SELECT count(*) AS n FROM inputs').n; next.recoverTaskHooks(); await Promise.resolve(); await next.hookQueue;
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(count);
  } finally { await next?.shutdown(); await f.close(); }
});

for (const state of ['running','unstarted','waiting']) test(`interrupted prompt Hook (${state}) without a creation receipt cannot replay after restart`, async () => {
  const f = await setup(); let next;
  try {
    const item = register(f); f.project.scheduleTaskHooks = () => {}; f.project.queueLifecycleTaskHook = () => {};
    const hook = f.project.attachTaskHook(f.main.id, rule(item), f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    f.project.emitTaskHook(f.main.id, 'worker.parent_ready');
    const data = JSON.parse(f.store.task(f.main.id).hooks), mount = data.mounts.find(m => m.id === hook.id);
    mount.maintenance_pending = state !== 'running';
    if (state === 'running') mount.action_started_index = 0;
    if (state === 'waiting') { mount.state = 'waiting'; mount.last_execution.status = 'waiting'; }
    f.store.update(f.main.id, { hooks: JSON.stringify(data) });
    next = new Project(f.config, f.store); next.kick = () => {}; next.recoverTaskHooks(); await Promise.resolve(); await next.hookQueue;
    expect(next.taskHooks(f.main.id).mounts.find(m => m.id === hook.id).state).toBe('unknown');
    expect(history({ ...f, project: next }, mount.prompt_executions[0].execution_id).status).toBe('unknown');
    next.observeTaskHooks(); await next.hookQueue;
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
  } finally { await next?.shutdown(); await f.close(); }
});

test('shutdown rejects new prompt Hook claims and drains Git-waiting work to safe history', async () => {
  const f = await setup(), held = gate(); let queued;
  try {
    const item = register(f); queued = f.project.workspaces.exclusive(() => held.promise);
    const accepted = start(f, item, f.main); await Promise.resolve(); expect(f.project.writing).toBeGreaterThan(0);
    const stopped = f.project.shutdown(); let settled = false; stopped.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    expect(() => start(f, item, f.main)).toThrow('stopping');
    held.resolve(); await queued; await stopped;
    expect(f.project.writing).toBe(0); expect(history(f, accepted.execution_id).status).toBe('failed');
    expect(f.project.lifecycleHookRunning.size).toBe(0);
  } finally { held.resolve(); await queued; await f.close(); }
});

test('changing the selected parent during asynchronous creation fails safely without falling back to main', async () => {
  const f = await setup(), held = gate(); let queued;
  try {
    const parent = (await f.project.order('parent', 'main', [], null, false)).task, item = register(f);
    queued = f.project.workspaces.exclusive(() => held.promise); const accepted = start(f, item, parent);
    f.store.update(parent.id, { status: 'cancelled' }); held.resolve(); await queued; await drain(f);
    expect(history(f, accepted.execution_id)).toMatchObject({ status: 'failed', worker_id: parent.id, created_worker_id: null });
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(1);
  } finally { held.resolve(); await queued; await f.close(); }
});

test('concurrent prompt Hook claims keep the newest last_execution while each independent creation has durable history', async () => {
  const f = await setup(), entered = gate(), held = gate();
  try {
    const item = register(f); f.project.scheduleTaskHooks = () => {};
    f.project.attachTaskHook(f.main.id, rule(item), f.project.taskHooks(f.main.id).revision);
    f.project.attachTaskHook(f.main.id, rule(item), f.project.taskHooks(f.main.id).revision);
    const original = f.project.workspaces.anchor.bind(f.project.workspaces); let first = true;
    f.project.workspaces.anchor = async (...args) => {
      if (first) { first = false; entered.resolve(); await held.promise; }
      return original(...args);
    };
    f.project.emitTaskHook(f.main.id, 'worker.parent_ready');
    const latest = f.project.shortcutCommandHistory().items[0];
    await entered.promise;
    expect(view(f, item).last_execution).toMatchObject({ id: latest.id, status: 'pending' });
    held.resolve(); await f.project.hookQueue;
    const histories = f.project.shortcutCommandHistory().items;
    expect(histories).toHaveLength(2); expect(histories.every(row => row.status === 'succeeded')).toBe(true);
    expect(new Set(histories.map(row => row.created_worker_id)).size).toBe(2);
    expect(view(f, item).last_execution).toMatchObject({ id: latest.id, status: 'succeeded' });
    expect(f.project.removeShortcutCommandHistory({ execution_id: latest.id })).toEqual({ removed_count: 1 });
    expect(view(f, item).last_execution).toBeNull();
  } finally { held.resolve(); await f.project.hookQueue; await f.close(); }
});

test('internal prompt executor rejects a different claim even with a real mounted Hook receipt', async () => {
  const f = await setup();
  try {
    const item = register(f); f.project.scheduleTaskHooks = () => {}; f.project.queueLifecycleTaskHook = () => {};
    const hook = f.project.attachTaskHook(f.main.id, rule(item), f.project.taskHooks(f.main.id).revision).mounts.at(-1);
    f.project.emitTaskHook(f.main.id, 'worker.parent_ready');
    const mount = JSON.parse(f.store.task(f.main.id).hooks).mounts.find(m => m.id === hook.id);
    const unrelated = f.project.acceptPromptShortcutExecution(ref(item), f.main.id);
    const receipt = { task_id: f.main.id, hook_id: hook.id, execution_id: mount.last_execution.id, action_index: 0 };
    await expect(f.project.executePromptShortcutCommand(unrelated, f.main.id, receipt)).rejects.toThrow('创建未完成');
    expect(history(f, unrelated.execution_id).status).toBe('failed');
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    const created = await f.project.executePromptShortcutCommand(mount.prompt_executions[0], f.main.id, receipt);
    expect(created.task.parent_id).toBe(f.main.id);
    expect(history(f, mount.prompt_executions[0].execution_id).status).toBe('succeeded');
  } finally { await f.close(); }
});

test('historical prompt output sanitizes created identities and never exposes arbitrary secret result fields', async () => {
  const f = await setup();
  try {
    const item = register(f), executionId = randomUUID();
    f.project.claimShortcutExecution(item.id, 1, f.main.id, executionId, 'manual');
    f.store.event(f.main.id, 'shortcut.command_succeeded', { command_id: item.id, execution_id: executionId,
      created_worker_id: -1, created_worker_number: 'PRIVATE_NUMBER', input_id: 'PRIVATE_INPUT', prompt: 'PRIVATE_BODY', error: 'PRIVATE_ERROR',
      command_result: { status: 'succeeded', stdout: 'PRIVATE_OUTPUT' } });
    expect(history(f, executionId)).toMatchObject({ kind: 'prompt', status: 'succeeded', created_worker_id: null, created_worker_number: null, input_id: null });
    expect(JSON.stringify(history(f, executionId))).not.toContain('PRIVATE');
  } finally { await f.close(); }
});
