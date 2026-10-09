import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { hookRevision } from '../../src/core/hooks.js';

setDefaultTimeout(20000);
const sourceRule = (actions, enabled = true) => ({ name: 'shortcut', trigger: 'worker.merge_received', mode: 'persistent', enabled, conditions: {}, actions });
const action = item => ({ type: 'command', command_id: item.id, command_version: item.version });
function register(f, command, authorized = true) {
  let item = f.project.saveShortcutCommand({ name: 'test shortcut', command }, f.project.shortcutCommands().revision).commands.items.at(-1);
  if (authorized) item = f.project.authorizeShortcutCommand(item.id, item.version, true, f.project.shortcutCommands().revision).commands.items.find(c => c.id === item.id);
  return item;
}
const attach = (f, task, actions, enabled = true) => f.project.attachTaskHook(task.id, sourceRule(actions, enabled), f.project.taskHooks(task.id).revision).mounts.at(-1);
const mount = (f, task, hook) => f.project.taskHooks(task.id).mounts.find(m => m.id === hook.id);
const emit = (f, task) => f.project.emitTaskHook(task.id, 'worker.merge_received', f.store.event(task.id, 'test.merge', {}));
const itemView = (f, item) => f.project.shortcutCommands().items.find(c => c.id === item.id);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); const main = await f.project.bootstrapMain(); return { ...f, main };
}

test('shortcut registry reads are pure and project-local, revisioned mutations revoke exact versions and reject unsafe config', async () => {
  const f = fixture(), other = fixture();
  try {
    const rows = f.store.get('SELECT count(*) AS n FROM meta').n;
    const initial = f.project.shortcutCommands(); f.project.hooksList();
    expect(f.store.get('SELECT count(*) AS n FROM meta').n).toBe(rows);
    expect(initial).toMatchObject({ version: 1, items: [] });
    const item = register(f, 'echo PRIVATE_CONFIG', false);
    expect(item).toMatchObject({ version: 1, authorized: false, last_execution: null });
    expect(other.project.shortcutCommands().items).toEqual([]);
    expect(() => f.project.authorizeShortcutCommand(item.id, 1, true, initial.revision)).toThrow('revision changed');
    f.project.authorizeShortcutCommand(item.id, 1, true, f.project.shortcutCommands().revision);
    const before = f.project.hooksList();
    f.project.saveShortcutCommand({ id: item.id, name: 'renamed', command: item.command }, before.commands.revision);
    expect(itemView(f, item)).toMatchObject({ version: 2, authorized: false });
    expect(f.project.hooksList().revision).toBe(before.revision);
    expect(() => f.project.authorizeShortcutCommand(item.id, 1, true, f.project.shortcutCommands().revision)).toThrow('版本');
    for (const value of [{ name: '', command: 'true' }, { name: 'x', command: '' }, { name: 'x', command: 'a\0b' },
      { name: 'x', command: 'x'.repeat(16001) }, { name: 'x', command: 'true', authorized: true }, { name: 'x', command: 'true', cwd: '/' }])
      expect(() => f.project.saveShortcutCommand(value, f.project.shortcutCommands().revision)).toThrow();
    const id = item.id; f.project.removeShortcutCommand(id, f.project.shortcutCommands().revision);
    expect(itemView(f, item)).toBeUndefined(); expect(register(f, 'true').id).not.toBe(id);
    expect(JSON.stringify(f.store.all('SELECT * FROM events'))).not.toContain('PRIVATE_CONFIG');
  } finally { await f.close(); await other.close(); }
});

test('Hooks only accept existing exact-version references and require authorization to enable or submit', async () => {
  const f = await setup();
  try {
    const item = register(f, 'printf x >> .lush/auth', false);
    const saved = f.project.saveHookTemplate(sourceRule([action(item)], false), f.project.hooksList().revision);
    expect(saved.templates.at(-1).actions).toEqual([action(item)]);
    const hook = attach(f, f.main, [action(item)], false);
    await expect(f.project.updateTaskHook(f.main.id, hook.id, true, f.project.taskHooks(f.main.id).revision)).rejects.toThrow('授权');
    expect(() => attach(f, f.main, [action(item)])).toThrow('授权');
    expect(() => attach(f, f.main, [{ ...action(item), command_version: 9 }], false)).toThrow('版本');
    expect(() => attach(f, f.main, [{ ...action(item), command_id: '12345678-1234-1234-1234-123456789abc' }], false)).toThrow('不存在');
    expect(() => attach(f, f.main, [{ type: 'command', command: 'true' }], false)).toThrow('fields');
    expect(() => f.project.attachTaskHook(f.main.id, { template_id: saved.templates.at(-1).id }, f.project.taskHooks(f.main.id).revision)).not.toThrow();
    emit(f, f.main); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'auth'))).toBe(false);
    f.project.authorizeShortcutCommand(item.id, 1, true, f.project.shortcutCommands().revision);
    await f.project.updateTaskHook(f.main.id, hook.id, true, f.project.taskHooks(f.main.id).revision);
    emit(f, f.main); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'auth'), 'utf8')).toBe('x');
    expect(itemView(f, item).last_execution).toMatchObject({ worker_id: f.main.id, command_version: 1, status: 'succeeded', command_result: { status: 'succeeded' } });
  } finally { await f.close(); }
});

test('revoke in the asynchronous workspace check prevents spawn and reauthorization never replays discarded events', async () => {
  const f = await setup();
  try {
    const item = register(f, 'printf x >> .lush/revoked'), hook = attach(f, f.main, [action(item)]);
    const original = f.project.workspaces.workspaceForBranch.bind(f.project.workspaces);
    f.project.workspaces.workspaceForBranch = async branch => {
      const directory = await original(branch);
      f.project.authorizeShortcutCommand(item.id, 1, false, f.project.shortcutCommands().revision); return directory;
    };
    emit(f, f.main); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'revoked'))).toBe(false);
    expect(mount(f, f.main, hook)).toMatchObject({ enabled: false, pending_count: 0 });
    expect(itemView(f, item).last_execution).toBeNull();
    f.project.workspaces.workspaceForBranch = original;
    f.project.authorizeShortcutCommand(item.id, 1, true, f.project.shortcutCommands().revision);
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'revoked'))).toBe(false);
    await f.project.updateTaskHook(f.main.id, hook.id, true, f.project.taskHooks(f.main.id).revision);
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'revoked'))).toBe(false);
    emit(f, f.main); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'revoked'), 'utf8')).toBe('x');
  } finally { await f.close(); }
});

test('edit before the final asynchronous ref read invalidates pending execution and requires an explicit new version binding', async () => {
  const f = await setup();
  try {
    const item = register(f, 'printf old >> .lush/versioned'), hook = attach(f, f.main, [action(item)]);
    const original = f.project.workspaces.readGuardRef.bind(f.project.workspaces);
    let edited = false;
    f.project.workspaces.readGuardRef = async ref => {
      const head = await original(ref);
      if (!edited) { edited = true; f.project.saveShortcutCommand({ id: item.id, name: item.name, command: 'printf new >> .lush/versioned' }, f.project.shortcutCommands().revision); }
      return head;
    };
    emit(f, f.main); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'versioned'))).toBe(false);
    expect(itemView(f, item)).toMatchObject({ version: 2, authorized: false });
    f.project.workspaces.readGuardRef = original;
    f.project.authorizeShortcutCommand(item.id, 2, true, f.project.shortcutCommands().revision);
    await expect(f.project.updateTaskHook(f.main.id, hook.id, true, f.project.taskHooks(f.main.id).revision)).rejects.toThrow('版本');
    await f.project.updateTaskHook(f.main.id, hook.id, undefined, f.project.taskHooks(f.main.id).revision, sourceRule([action(itemView(f, item))]));
    emit(f, f.main); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'versioned'), 'utf8')).toBe('new');
  } finally { await f.close(); }
});

test('revocation while a command is started does not pretend to undo it, but cancels remaining actions and future queued triggers', async () => {
  const f = await setup();
  try {
    const first = register(f, 'printf started > .lush/start; while [ ! -f .lush/release ]; do sleep 0.01; done; printf done > .lush/done');
    const second = register(f, 'printf BAD >> .lush/second');
    const hook = attach(f, f.main, [action(first), action(second)]);
    emit(f, f.main); await until(() => fs.existsSync(path.join(f.config.home, 'start')));
    emit(f, f.main); emit(f, f.main);
    f.project.authorizeShortcutCommand(first.id, 1, false, f.project.shortcutCommands().revision);
    fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await f.project.hookQueue;
    expect(fs.readFileSync(path.join(f.config.home, 'done'), 'utf8')).toBe('done');
    expect(fs.existsSync(path.join(f.config.home, 'second'))).toBe(false);
    expect(mount(f, f.main, hook)).toMatchObject({ enabled: false, pending_count: 0, state: 'failed' });
    expect(itemView(f, first).last_execution.status).toBe('succeeded');
    f.project.authorizeShortcutCommand(first.id, 1, true, f.project.shortcutCommands().revision);
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'second'))).toBe(false);
  } finally { fs.writeFileSync(path.join(f.config.home, 'release'), 'go'); await f.close(); }
});

test('manual shortcut execution uses the real Worker cwd and safe receipts, never raw output or invocation credentials', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('manual cwd', 'main', [], null, false);
    Object.assign(f.config.env, { LUSH_AGENT_TOKEN: 'PRIVATE_TOKEN', PI_CODING_AGENT_DIR: '/private', CODEX_HOME: '/private' });
    const item = register(f, 'pwd > actual-cwd; env > actual-env; echo PRIVATE_MANUAL_OUTPUT; echo PRIVATE_STDERR >&2; exit 7');
    const before = f.project.shortcutCommands().revision;
    const result = await f.project.runShortcutCommand(item.id, 1, task.id, before);
    expect(result).toMatchObject({ command_result: { status: 'failed', exit_code: 7 }, commands: { items: expect.any(Array) } });
    expect(result.execution_id).toBeTruthy(); expect(result.commands.revision).not.toBe(before);
    expect(fs.readFileSync(path.join(task.workspace, 'actual-cwd'), 'utf8').trim()).toBe(task.workspace);
    expect(fs.existsSync(path.join(f.root, 'actual-cwd'))).toBe(false);
    const env = fs.readFileSync(path.join(task.workspace, 'actual-env'), 'utf8');
    expect(env).not.toContain('PRIVATE_TOKEN'); expect(env).not.toContain('LUSH_AGENT_TOKEN=');
    expect(env).not.toContain('PI_CODING_AGENT_DIR='); expect(env).not.toContain('CODEX_HOME=');
    const safe = JSON.stringify([itemView(f, item).last_execution, f.store.all('SELECT * FROM events'), f.store.all('SELECT * FROM notices')]);
    expect(safe).not.toContain('PRIVATE_MANUAL_OUTPUT'); expect(safe).not.toContain('PRIVATE_STDERR'); expect(safe).not.toContain('PRIVATE_TOKEN');
    expect(itemView(f, item).last_execution).toMatchObject({ id: result.execution_id, worker_id: task.id, worker_number: task.worker_number, status: 'failed' });
    expect(f.project.commandHookRunning.has(task.id)).toBe(false);
  } finally { await f.close(); }
});

test('manual command gates reject rather than queue, and deletion or reauthorization during Git inspection cannot sneak a stale run through', async () => {
  const f = await setup();
  try {
    const item = register(f, 'printf BAD > .lush/manual-gate');
    const run = () => f.project.runShortcutCommand(item.id, 1, f.main.id, f.project.shortcutCommands().revision);
    f.project.running.set(f.main.id, {}); await expect(run()).rejects.toThrow('Agent'); f.project.running.clear();
    f.project.taskSyncBusy = new Set([f.main.id]); await expect(run()).rejects.toThrow('同步'); f.project.taskSyncBusy.clear();
    f.project.commandHookRunning = new Set([f.main.id]); await expect(run()).rejects.toThrow('already executing'); f.project.commandHookRunning.clear();
    f.project.clearing = true; await expect(run()).rejects.toThrow('清理'); f.project.clearing = false;
    const blocker = await f.project.order('blocker', 'main', [], null, false);
    f.store.update(blocker.task.id, { reservation: JSON.stringify({ version: 1, kind: 'merge', status: 'requested' }) });
    await expect(run()).rejects.toThrow('冻结'); f.store.update(blocker.task.id, { reservation: null });
    expect(itemView(f, item).last_execution).toBeNull();
    const original = f.project.workspaces.readGuardRef.bind(f.project.workspaces);
    f.project.workspaces.readGuardRef = async ref => {
      const head = await original(ref);
      f.project.authorizeShortcutCommand(item.id, 1, false, f.project.shortcutCommands().revision);
      f.project.authorizeShortcutCommand(item.id, 1, true, f.project.shortcutCommands().revision);
      return head;
    };
    await expect(run()).rejects.toThrow('未开始');
    expect(fs.existsSync(path.join(f.config.home, 'manual-gate'))).toBe(false);
    expect(itemView(f, item).last_execution).toBeNull();
    f.project.workspaces.readGuardRef = original;
    f.project.workspaces.workspaceForBranch = async branch => {
      const directory = await f.project.workspaces.constructor.prototype.workspaceForBranch.call(f.project.workspaces, branch);
      f.project.removeShortcutCommand(item.id, f.project.shortcutCommands().revision); return directory;
    };
    await expect(run()).rejects.toThrow('未开始');
    expect(fs.existsSync(path.join(f.config.home, 'manual-gate'))).toBe(false);
  } finally { f.project.running.clear(); f.project.clearing = false; await f.close(); }
});

test('manual calls cannot share stale read revisions or overlap an invocation; shutdown drains their bounded work', async () => {
  const f = await setup(); let workspace;
  try {
    const { task } = await f.project.order('manual lock', 'main', [], null, false); workspace = task.workspace;
    const item = register(f, 'printf started > start; while [ ! -f release ]; do sleep 0.01; done');
    const rev = f.project.shortcutCommands().revision;
    const run = f.project.runShortcutCommand(item.id, 1, task.id, rev);
    const stale = f.project.runShortcutCommand(item.id, 1, task.id, rev).catch(error => error);
    await until(() => fs.existsSync(path.join(task.workspace, 'start')));
    f.project.resumeTask(task.id); f.project.pump(); await Promise.resolve();
    expect(f.project.running.has(task.id)).toBe(false); expect(f.store.task(task.id).status).toBe('queued');
    const stop = f.project.shutdown(); let stopped = false; stop.then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    fs.writeFileSync(path.join(task.workspace, 'release'), 'go');
    expect((await run).command_result.status).toBe('succeeded'); expect((await stale).message).toContain('未开始'); await stop;
    expect(stopped).toBe(true); expect(f.project.commandHookRunning.has(task.id)).toBe(false);
  } finally { if (workspace) fs.writeFileSync(path.join(workspace, 'release'), 'go'); await f.close(); }
});

test('manual started-without-result is recovered as unknown without executing or auto-retrying', async () => {
  const f = await setup(); let next;
  try {
    const item = register(f, 'printf BAD > .lush/manual-restart');
    f.project.startShortcutExecution(item.id, 1, f.main.id, 'interrupted-execution');
    next = new Project(f.config, f.store); next.kick = () => {}; next.recoverTaskHooks(); await Promise.resolve(); await next.hookQueue;
    expect(next.shortcutCommands().items.find(c => c.id === item.id).last_execution).toMatchObject({ id: 'interrupted-execution', status: 'unknown' });
    expect(fs.existsSync(path.join(f.config.home, 'manual-restart'))).toBe(false);
    const revision = next.shortcutCommands().revision; next.recoverTaskHooks();
    expect(next.shortcutCommands().revision).toBe(revision);
    expect(f.store.all("SELECT id FROM events WHERE type='shortcut.command_unknown'")).toHaveLength(1);
  } finally { await next?.shutdown(); await f.close(); }
});

test('legacy commands are read-only stopped projections, startup disables future execution and explicit import preserves identity/history', async () => {
  const f = await setup();
  try {
    const legacy = { ...sourceRule([{ type: 'command', command: 'printf x >> .lush/legacy' }]), id: 'legacy-mount', state: 'waiting',
      command_pending: 1, created_at: new Date().toISOString(), last_execution: { id: 77, status: 'failed', error: 'old safe diagnosis' }, receipts: [{ index: 0 }] };
    const state = JSON.parse(f.store.task(f.main.id).hooks); state.mounts.push(legacy); f.store.update(f.main.id, { hooks: JSON.stringify(state) });
    const original = f.store.task(f.main.id).hooks;
    expect(mount(f, f.main, legacy)).toMatchObject({ enabled: false, reason: expect.stringContaining('导入') });
    expect(f.store.task(f.main.id).hooks).toBe(original);
    await expect(f.project.updateTaskHook(f.main.id, legacy.id, true, f.project.taskHooks(f.main.id).revision)).rejects.toThrow('导入');
    emit(f, f.main); await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'legacy'))).toBe(false);
    f.project.recoverTaskHooks(); await Promise.resolve(); await f.project.hookQueue;
    const stopped = JSON.parse(f.store.task(f.main.id).hooks).mounts.find(m => m.id === legacy.id);
    expect(stopped).toMatchObject({ enabled: false, command_pending: 0, last_execution: legacy.last_execution, receipts: legacy.receipts });
    const revision = f.project.taskHooks(f.main.id).revision;
    expect(() => f.project.importLegacyHookCommands({ worker_id: f.main.id, hook_id: legacy.id }, 'stale')).toThrow('revision');
    const imported = f.project.importLegacyHookCommands({ worker_id: f.main.id, hook_id: legacy.id }, revision);
    const item = imported.commands.items.find(c => c.id === imported.imported_command_ids[0]);
    expect(item).toMatchObject({ command: 'printf x >> .lush/legacy', version: 1, authorized: false });
    expect(imported.worker_hooks.mounts.find(m => m.id === legacy.id)).toMatchObject({ id: legacy.id, enabled: false, actions: [action(item)], last_execution: legacy.last_execution });
    expect(() => f.project.importLegacyHookCommands({ worker_id: f.main.id, hook_id: legacy.id }, imported.worker_hooks.revision)).toThrow('no legacy');
    f.project.authorizeShortcutCommand(item.id, 1, true, f.project.shortcutCommands().revision);
    await f.project.updateTaskHook(f.main.id, legacy.id, true, f.project.taskHooks(f.main.id).revision);
    f.project.observeTaskHooks(); await f.project.hookQueue; expect(fs.existsSync(path.join(f.config.home, 'legacy'))).toBe(false);
    emit(f, f.main); await f.project.hookQueue; expect(fs.readFileSync(path.join(f.config.home, 'legacy'), 'utf8')).toBe('x');
  } finally { await f.close(); }
});

test('legacy template import preserves private profiles, rejects ambiguous sources and never imports or authorizes implicitly', async () => {
  const f = await setup();
  try {
    const state = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='hook_templates'").value);
    const legacy = { ...sourceRule([{ type: 'command', command: 'echo PRIVATE_INLINE' }, { type: 'create_worker', content: 'deferred', references: [], start: false,
      profile: { agent: 'pi', config_mode: 'lush', model: 'test/model', append_prompt: 'PRIVATE_PROFILE', env: { KEY: 'PRIVATE_ENV' } } }]),
      trigger: 'worker.parent_ready', mode: 'once' };
    state.templates.push({ id: 'legacy-template', definition: legacy });
    f.store.run("UPDATE meta SET value=? WHERE key='hook_templates'", JSON.stringify(state));
    const initial = f.project.hooksList(); const count = initial.commands.items.length;
    expect(initial.templates.at(-1).enabled).toBe(false); expect(f.project.shortcutCommands().items).toHaveLength(count);
    expect(() => f.project.importLegacyHookCommands({ worker_id: f.main.id, hook_id: 'x', template_id: 'legacy-template' }, initial.revision)).toThrow('source');
    expect(() => f.project.importLegacyHookCommands({ template_id: 'legacy-template', extra: true }, initial.revision)).toThrow('fields');
    const result = f.project.importLegacyHookCommands({ template_id: 'legacy-template' }, initial.revision);
    expect(result.commands.items).toHaveLength(count + 1);
    expect(result.templates.find(t => t.id === 'legacy-template')).toMatchObject({ enabled: false, actions: [
      { type: 'command', command_id: result.imported_command_ids[0], command_version: 1 }, { type: 'create_worker', content: 'deferred', start: false }] });
    const stored = JSON.parse(f.store.get("SELECT value FROM meta WHERE key='hook_templates'").value).templates.find(t => t.id === 'legacy-template');
    expect(stored.definition.actions[1].profile).toMatchObject({ append_prompt: 'PRIVATE_PROFILE', env: { KEY: 'PRIVATE_ENV' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROFILE'); expect(JSON.stringify(result)).not.toContain('PRIVATE_ENV');
    expect(result.commands.items.at(-1).authorized).toBe(false);
    expect(JSON.stringify(f.store.all('SELECT * FROM events'))).not.toContain('PRIVATE_INLINE');
    expect(result.revision).not.toBe(hookRevision(state));
  } finally { await f.close(); }
});
