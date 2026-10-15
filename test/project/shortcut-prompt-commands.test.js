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
  return item;
};
const ref = item => ({ type: 'prompt_command', command_id: item.id });
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
