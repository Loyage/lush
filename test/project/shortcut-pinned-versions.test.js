import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, repo, gate, git } from '../helpers.js';
import { normalizeHook } from '../../src/core/hooks.js';
import { attachRegisteredHook } from '../hook-registry.js';

const reference = (item, type = item.kind === 'prompt' ? 'prompt_command' : 'command') =>
  ({ type, command_id: item.id, command_version: item.version });
const rule = action => ({ name: 'pinned shortcut', trigger: action.type === 'command' ? 'agent.returned' : 'worker.parent_ready',
  mode: 'once', enabled: true, actions: [action] });
const save = (f, value) => {
  const commands = f.project.saveShortcutCommand(value, f.project.shortcutCommands().revision).commands;
  return value.id ? commands.items.find(item => item.id === value.id) : commands.items.at(-1);
};
const history = (f, executionId) => f.project.shortcutCommandHistory({ execution_id: executionId }).items[0];
const mount = (f, action) => attachRegisteredHook(f.project, f.main.id, rule(action)).mounts.at(-1);
const drain = async f => { await Promise.resolve(); await f.project.hookQueue; };
const event = (f, type, executionId) => JSON.parse(f.store.get('SELECT data FROM events WHERE type=? AND json_extract(data,\'$.execution_id\')=?', type, executionId).data);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); f.main = await f.project.bootstrapMain(); return f;
}
function holdWorkspaceMethod(f, method) {
  const entered = gate(), release = gate(), original = f.project.workspaces[method];
  f.project.workspaces[method] = async function (...args) {
    entered.resolve(); await release.promise; return original.apply(this, args);
  };
  return { entered, release };
}

test('normalization preserves explicit Shell/Prompt versions and rejects invalid pins', () => {
  for (const type of ['command', 'prompt_command']) {
    const action = { type, command_id: randomUUID(), command_version: 7 };
    expect(normalizeHook(rule(action)).actions).toEqual([action]);
    const { command_version, ...legacy } = action;
    expect(normalizeHook(rule(legacy)).actions).toEqual([legacy]);
    for (const invalid of [0, -1, 1.5, '7', null, Number.MAX_SAFE_INTEGER + 1])
      expect(() => normalizeHook(rule({ ...action, command_version: invalid }))).toThrow('invalid shortcut command reference');
  }
});

test('edits retain immutable definition versions for resolve/export without expanding the public directory', async () => {
  const f = await setup();
  try {
    const first = save(f, { name: 'original', command: 'printf PRIVATE_OLD', description: 'original description', tags: ['old'] });
    const firstRef = reference(first), second = save(f, { id: first.id, name: 'renamed', command: 'printf PRIVATE_NEW', description: 'new description', tags: ['new'] });
    const third = save(f, { id: first.id, name: 'metadata edit', command: second.command, warnings: 'changed metadata' });
    expect(third.version).toBe(3);
    expect(f.project.resolveShortcutCommand(firstRef)).toMatchObject({ id: first.id, name: first.name, version: 1, command: first.command, description: first.description, tags: ['old'] });
    expect(f.project.resolveShortcutCommand(reference(second))).toMatchObject({ name: second.name, version: 2, tags: ['new'], warnings: '' });
    expect(f.project.resolveShortcutCommand({ type: 'command', command_id: first.id }).version).toBe(3);
    const exported = f.project.exportShortcutCommand(first.id, 1);
    expect(exported.filename).toEndWith('-v1.md'); expect(exported.markdown).toContain(first.command);
    expect(exported.markdown).toContain('original description'); expect(exported.markdown).not.toContain(second.command);
    expect(() => f.project.resolveShortcutCommand({ ...firstRef, command_version: 99 })).toThrow('definition changed');
    expect(() => f.project.resolveShortcutCommand({ ...firstRef, command_version: 0 })).toThrow('invalid shortcut command reference');
    expect(third).not.toHaveProperty('versions');
    const stored = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value).items.find(item => item.id === first.id);
    expect(stored.versions.map(item => item.version)).toEqual([1, 2]);
    expect(stored.versions.every(item => !('versions' in item) && !('last_execution' in item) && !('authorized' in item))).toBe(true);
    const before = f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value;
    f.project.resolveShortcutCommand(firstRef); f.project.exportShortcutCommand(first.id, 1); f.project.shortcutCommands();
    expect(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value).toBe(before);
  } finally { await f.close(); }
});

test('claim/start of an old definition keep its evidence but update the current item execution slot', async () => {
  const f = await setup();
  try {
    const first = save(f, { name: 'old shell', command: 'true' });
    const latest = save(f, { id: first.id, name: 'new shell', command: 'false' });
    const executionId = randomUUID();
    const claim = f.project.claimShortcutExecution(first.id, first.version, f.main.id, executionId, 'hook');
    expect(claim.execution).toMatchObject({ command_name: first.name, command_version: 1, status: 'pending' });
    f.project.startShortcutExecution(first.id, first.version, f.main.id, executionId);
    expect(event(f, 'shortcut.command_started', executionId)).toMatchObject({ command_name: first.name, command_version: 1, version: 1, status: 'running', created_at: claim.execution.created_at });
    f.project.finishShortcutExecution(first.id, executionId, f.main.id, 'succeeded');
    expect(history(f, executionId)).toMatchObject({ command_name: first.name, command_version: 1, status: 'succeeded' });
    expect(f.project.shortcutCommands().items.find(item => item.id === first.id)).toMatchObject({ version: latest.version, command: latest.command, last_execution: { id: executionId, command_version: 1, status: 'succeeded' } });
    const stored = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value).items.find(item => item.id === first.id);
    expect(stored.versions[0]).not.toHaveProperty('last_execution');
  } finally { await f.close(); }
});

test('a real Shell Hook executes pinned old body after a same-kind edit and records the executed version', async () => {
  const f = await setup(), held = holdWorkspaceMethod(f, 'runHookCommand');
  try {
    const output = path.join(f.config.home, 'pinned-shell-result');
    const first = save(f, { name: 'old shell body', command: `printf old > '${output}'` });
    const attached = mount(f, reference(first));
    save(f, { id: first.id, name: 'new shell body', command: `printf new > '${output}'` });
    const mounted = f.project.taskHooks(f.main.id).mounts.find(item => item.id === attached.id);
    expect(mounted).toMatchObject({ registry_id: attached.registry_id, registry_version: 1, legacy: false });
    expect(typeof mounted.registry_id).toBe('string');
    expect(mounted.actions[0]).toEqual(reference(first));
    f.project.emitTaskHook(f.main.id, 'agent.returned');
    await held.entered.promise;
    save(f, { id: first.id, name: 'later shell body', command: `printf later > '${output}'` });
    held.release.resolve(); await drain(f);
    expect(fs.readFileSync(output, 'utf8')).toBe('old');
    const execution = f.project.shortcutCommandHistory().items[0];
    expect(execution).toMatchObject({ command_id: first.id, command_name: first.name, command_version: 1, status: 'succeeded' });
    const receipt = JSON.parse(f.store.get("SELECT data FROM events WHERE type='hook.action_completed' AND json_extract(data,'$.shortcut_execution_id')=?", execution.id).data);
    expect(receipt).toMatchObject({ hook_id: attached.id, command_id: first.id, command_version: 1, shortcut_execution_id: execution.id });
    expect(event(f, 'hook.execution_succeeded', receipt.execution_id)).toMatchObject({ hook_id: attached.id });
    expect(f.project.taskHooks(f.main.id).mounts.some(item => item.id === attached.id)).toBe(false);
    expect(JSON.stringify(f.store.all("SELECT data FROM events WHERE type LIKE 'shortcut.%' OR type LIKE 'hook.%'"))).not.toContain(first.command);
  } finally { held.release.resolve(); await drain(f); await f.close(); }
});

test('a pinned Prompt creates the old Input/Worker and exact receipt despite edits before claim and during anchor admission', async () => {
  const f = await setup(), held = holdWorkspaceMethod(f, 'anchor');
  try {
    const first = save(f, { name: 'old prompt', kind: 'prompt', prompt: 'PRIVATE_PINNED_PROMPT' });
    const attached = mount(f, reference(first));
    save(f, { id: first.id, name: 'new prompt', kind: 'prompt', prompt: 'PRIVATE_NEW_PROMPT' });
    f.project.emitTaskHook(f.main.id, 'worker.parent_ready');
    const execution = f.project.shortcutCommandHistory().items[0];
    await held.entered.promise;
    save(f, { id: first.id, name: 'later prompt', kind: 'prompt', prompt: 'PRIVATE_LATER_PROMPT' });
    held.release.resolve(); await drain(f);
    const result = history(f, execution.id);
    expect(result).toMatchObject({ command_name: first.name, command_version: 1, kind: 'prompt', status: 'succeeded' });
    const created = f.store.task(result.created_worker_id);
    expect(created.goal).toBe(first.prompt);
    expect(f.store.get('SELECT content FROM inputs WHERE id=?', created.input_id).content).toBe(first.prompt);
    const receipt = JSON.parse(f.store.get("SELECT data FROM events WHERE task_id=? AND type='hook.worker_created' AND json_extract(data,'$.shortcut_execution_id')=?", f.main.id, execution.id).data);
    expect(receipt).toMatchObject({ hook_id: attached.id, command_id: first.id, command_version: 1, shortcut_execution_id: execution.id, worker_id: created.id, input_id: created.input_id });
    expect(attached).toMatchObject({ registry_version: 1, legacy: false });
    expect(typeof attached.registry_id).toBe('string');
    expect(f.project.shortcutCommands().items.find(item => item.id === first.id)).toMatchObject({ version: 3, last_execution: { id: execution.id, command_version: 1, status: 'succeeded', created_worker_id: created.id } });
    expect(JSON.stringify(f.store.all("SELECT data FROM events WHERE type LIKE 'shortcut.%' OR type LIKE 'hook.%'"))).not.toContain(first.prompt);
  } finally { held.release.resolve(); await drain(f); await f.close(); }
});

for (const change of ['remove', 'kind']) test(`historical definitions cannot bypass current ${change} rejection for resolve/claim/start/export`, async () => {
  const f = await setup();
  try {
    const first = save(f, { name: 'old shell', command: 'true' });
    save(f, { id: first.id, name: 'new shell', command: 'false' });
    if (change === 'remove') f.project.removeShortcutCommand(first.id, f.project.shortcutCommands().revision);
    else save(f, { id: first.id, name: 'now prompt', kind: 'prompt', prompt: 'not shell' });
    expect(() => f.project.resolveShortcutCommand(reference(first))).toThrow();
    expect(() => f.project.claimShortcutExecution(first.id, first.version, f.main.id, randomUUID(), 'hook')).toThrow();
    expect(() => f.project.startShortcutExecution(first.id, first.version, f.main.id, randomUUID())).toThrow();
    expect(() => f.project.exportShortcutCommand(first.id, first.version)).toThrow();
    expect(f.project.shortcutCommandHistory().items).toEqual([]);
  } finally { await f.close(); }
});

for (const change of ['remove', 'kind']) test(`a claimed pinned Prompt is rejected if ${change} changes during asynchronous creation`, async () => {
  const f = await setup(), held = holdWorkspaceMethod(f, 'anchor');
  try {
    const first = save(f, { name: 'old prompt', kind: 'prompt', prompt: 'NEVER_CREATED_PROMPT' });
    mount(f, reference(first));
    save(f, { id: first.id, name: 'new prompt', kind: 'prompt', prompt: 'NEW_PROMPT' });
    f.project.emitTaskHook(f.main.id, 'worker.parent_ready');
    const execution = f.project.shortcutCommandHistory().items[0];
    await held.entered.promise;
    if (change === 'remove') f.project.removeShortcutCommand(first.id, f.project.shortcutCommands().revision);
    else save(f, { id: first.id, name: 'now shell', kind: 'shell', command: 'true' });
    held.release.resolve(); await drain(f);
    expect(history(f, execution.id)).toMatchObject({ command_name: first.name, command_version: 1, kind: 'prompt', status: 'failed' });
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='hook.worker_created'").n).toBe(0);
  } finally { held.release.resolve(); await drain(f); await f.close(); }
});

test('convergence validation uses the pinned definition and exact execution guard on a real isolated checkout', async () => {
  const f = await setup(); let checkout;
  try {
    const first = save(f, { name: 'old validator', command: 'test -f file.txt' });
    const latest = save(f, { id: first.id, name: 'new validator', command: 'false' });
    const validation = { command_id: first.id, command_version: first.version };
    const run = { validation: JSON.stringify(validation), data: JSON.stringify({ verification_mode: 'command', validation_execution: validation }) };
    const command = f.project.assertConvergenceCommand(run);
    expect(command).toMatchObject({ command: first.command, version: 1, name: first.name });
    expect(f.project.assertConvergenceCommand({ validation: JSON.stringify({ command_id: first.id }), data: '{}' }).version).toBe(latest.version);
    expect(() => f.project.assertConvergenceCommand({ ...run, data: JSON.stringify({ validation_execution: { command_id: first.id, command_version: latest.version } }) })).toThrow('definition changed');
    const commit = await git(f.root, 'rev-parse', 'HEAD');
    checkout = await f.project.workspaces.exclusive(() => f.project.workspaces.createConvergenceValidationUnsafe({ id: 1, generation: 1, commit }));
    const guard = () => { f.project.assertConvergenceCommand(run); return true; };
    const result = await f.project.workspaces.runConvergenceValidation(checkout, command.command, guard,
      { started: () => { save(f, { id: first.id, name: 'later validator', command: 'exit 2' }); return true; } });
    expect(result).toMatchObject({ status: 'succeeded', exit_code: 0, commit });
    await expect(f.project.workspaces.runConvergenceValidation(checkout, command.command, guard)).rejects.toThrow('already started or finished');
    save(f, { id: first.id, name: 'now prompt', kind: 'prompt', prompt: 'not a validator' });
    expect(() => f.project.assertConvergenceCommand(run)).toThrow('kind does not match');
    f.project.removeShortcutCommand(first.id, f.project.shortcutCommands().revision);
    expect(() => f.project.assertConvergenceCommand(run)).toThrow('不存在');
  } finally {
    if (checkout) await f.project.workspaces.exclusive(() => f.project.workspaces.removeConvergenceValidationUnsafe(checkout));
    await f.close();
  }
});

test('recovery settles a pinned pending Prompt as unknown and does not replay the queued creation', async () => {
  const f = await setup(), held = gate();
  try {
    f.project.hookQueue = held.promise;
    const first = save(f, { name: 'old prompt', kind: 'prompt', prompt: 'UNKNOWN_PROMPT' });
    mount(f, reference(first));
    save(f, { id: first.id, name: 'new prompt', kind: 'prompt', prompt: 'LATEST_PROMPT' });
    f.project.emitTaskHook(f.main.id, 'worker.parent_ready');
    const execution = f.project.shortcutCommandHistory().items[0];
    f.project.recoverShortcutCommands();
    held.resolve(); await drain(f);
    expect(history(f, execution.id)).toMatchObject({ command_name: first.name, command_version: 1, status: 'unknown' });
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    f.project.recoverShortcutCommands();
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE type='shortcut.command_unknown' AND json_extract(data,'$.execution_id')=?", execution.id).n).toBe(1);
  } finally { held.resolve(); await drain(f); await f.close(); }
});
