import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, until } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { hookRevision } from '../../src/core/hooks.js';

setDefaultTimeout(20000);
const sourceRule = (actions, enabled = true) => ({ name: 'shortcut', trigger: 'worker.merge_received', mode: 'persistent', enabled, conditions: {}, actions });
const action = item => ({ type: 'command', command_id: item.id });
function register(f, command) {
  return f.project.saveShortcutCommand({ name: 'test shortcut', command }, f.project.shortcutCommands().revision).commands.items.at(-1);
}
const attach = (f, task, actions, enabled = true) => f.project.attachTaskHook(task.id, sourceRule(actions, enabled), f.project.taskHooks(task.id).revision).mounts.at(-1);
const mount = (f, task, hook) => f.project.taskHooks(task.id).mounts.find(m => m.id === hook.id);
const emit = (f, task) => f.project.emitTaskHook(task.id, 'worker.merge_received', f.store.event(task.id, 'test.merge', {}));
const itemView = (f, item) => f.project.shortcutCommands().items.find(c => c.id === item.id);
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); const main = await f.project.bootstrapMain(); return { ...f, main };
}

test('shortcut registry reads are pure and project-local, revisioned edits retain versions without authorization fields', async () => {
  const f = fixture(), other = fixture();
  try {
    const rows = f.store.get('SELECT count(*) AS n FROM meta').n;
    const initial = f.project.shortcutCommands(); f.project.hooksList();
    expect(f.store.get('SELECT count(*) AS n FROM meta').n).toBe(rows);
    expect(initial).toMatchObject({ version: 1, items: [] });
    const item = register(f, 'echo PRIVATE_CONFIG', false);
    expect(item).toMatchObject({ version: 1, last_execution: null });
    expect(item).not.toHaveProperty('authorized');
    expect(JSON.parse(f.store.get("SELECT value FROM meta WHERE key='shortcut_commands'").value).items[0]).not.toHaveProperty('authorized');
    expect(f.project.authorizeShortcutCommand).toBeUndefined();
    expect(() => f.project.exportShortcutCommand(item.id)).toThrow('reference');
    expect(() => f.project.startShortcutExecution(item.id, undefined, 1, 'missing-version')).toThrow('reference');
    expect(other.project.shortcutCommands().items).toEqual([]);
    expect(() => f.project.saveShortcutCommand({ id: item.id, name: 'stale', command: 'true' }, initial.revision)).toThrow('revision changed');
    const before = f.project.hooksList();
    f.project.saveShortcutCommand({ id: item.id, name: 'renamed', command: item.command }, before.commands.revision);
    expect(itemView(f, item)).toMatchObject({ version: 2 });
    expect(f.project.hooksList().revision).toBe(before.revision);
    expect(() => f.project.exportShortcutCommand(item.id, 1)).toThrow('definition changed');
    for (const value of [{ name: '', command: 'true' }, { name: 'x', command: '' }, { name: 'x', command: 'a\0b' },
      { name: 'x', command: 'x'.repeat(16001) }, { name: 'x', command: 'true', authorized: true }, { name: 'x', command: 'true', cwd: '/' }])
      expect(() => f.project.saveShortcutCommand(value, f.project.shortcutCommands().revision)).toThrow();
    const id = item.id; f.project.removeShortcutCommand(id, f.project.shortcutCommands().revision);
    expect(itemView(f, item)).toBeUndefined(); expect(register(f, 'true').id).not.toBe(id);
    expect(JSON.stringify(f.store.all('SELECT * FROM events'))).not.toContain('PRIVATE_CONFIG');
  } finally { await f.close(); await other.close(); }
});

test('Hook shortcut execution uses the real Worker cwd and safe receipts, never raw output or invocation credentials', async () => {
  const f = await setup();
  try {
    const { task } = await f.project.order('manual cwd', 'main', [], null, false);
    Object.assign(f.config.env, { LUSH_AGENT_TOKEN: 'PRIVATE_TOKEN', PI_CODING_AGENT_DIR: '/private', CODEX_HOME: '/private' });
    const item = register(f, 'pwd > actual-cwd; env > actual-env; echo PRIVATE_MANUAL_OUTPUT; echo PRIVATE_STDERR >&2; exit 7');
    const before = f.project.shortcutCommands().revision;
    attach(f, task, [action(item)]); emit(f, task); await f.project.hookQueue;
    const execution = itemView(f, item).last_execution;
    const result = { execution_id: execution.id, command_result: execution.command_result, commands: f.project.shortcutCommands() };
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
