import { retiredHook } from '../hook-assertions.js';
import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { normalizeHook } from '../../src/core/hooks.js';
import { Project } from '../../src/core/project.js';
import { executeCommand, commandEnvironment } from '../../src/core/workspaces/command.js';

setDefaultTimeout(20000);
const rule = (command = 'true', extra = {}) => ({ name: 'command', trigger: 'worker.merge_received', mode: 'persistent', enabled: true,
  actions: [{ type: 'command', command }], ...extra });
const register = (f, command) => {
  const item = f.project.saveShortcutCommand({ name: 'test command', command }, f.project.shortcutCommands().revision).commands.items.at(-1);
  return { type: 'command', command_id: item.id };
};
const registered = (f, hook) => hook.actions ? { ...hook, actions: hook.actions.map(action => action.type === 'command' && action.command !== undefined
  ? register(f, action.command) : action) } : hook;
const attach = (f, task, hook) => f.project.attachTaskHook(task.id, registered(f, hook), f.project.taskHooks(task.id).revision).mounts.at(-1);
const view = (f, task, hook) => f.project.taskHooks(task.id).mounts.find(m => m.id === hook.id);
const emit = (f, task, source = null, trigger = 'worker.merge_received') => {
  const id = source ?? f.store.event(task.id, 'test.merge', {});
  f.project.emitTaskHook(task.id, trigger, id); return id;
};
async function setup() {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); const main = await f.project.bootstrapMain(); return { ...f, main };
}
async function deliver(f, name) {
  const { task } = await f.project.order(name, 'main', [], null, false);
  fs.writeFileSync(path.join(task.workspace, `${name}.txt`), name);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
  f.store.update(task.id, { status: 'waiting', result: 'done' });
  await f.project.workspaces.finish(f.store.task(task.id));
  await f.project.reserveTask(task.id, 'merge');
  await f.project.driveTaskMerge(f.main.id);
  expect(f.store.task(task.id).integration).toBe('merged');
  return task;
}

test('a real successful queue landing triggers git push to a temporary bare remote, exactly once per parent event', async () => {
  const f = await setup();
  try {
    const remote = path.join(f.config.home, 'remote.git');
    await git(f.root, 'init', '--bare', remote); await git(f.root, 'remote', 'add', 'origin', remote);
    await git(f.root, 'push', '-u', 'origin', 'main');
    const example = f.project.hooksList().command_example;
    await f.project.updateTaskHook(f.main.id, example.hook_id, true, example.hooks.revision);
    const first = await deliver(f, 'first');
    const firstTip = await git(f.root, 'rev-parse', 'main');
    expect(await git(remote, 'rev-parse', 'main')).toBe(firstTip);
    const second = await deliver(f, 'second');
    const secondTip = await git(f.root, 'rev-parse', 'main');
    expect(secondTip).not.toBe(firstTip); expect(await git(remote, 'rev-parse', 'main')).toBe(secondTip);
    const events = f.store.history(f.main.id).filter(e => e.type === 'worker.merge_received');
    expect(events).toHaveLength(2);
    expect(events.map(e => e.data.source_worker_id)).toEqual([first.id, second.id]);
    for (const event of [events[1], events[0], events[1]]) emit(f, f.main, event.id);
    await f.project.hookQueue;
    expect(f.store.history(f.main.id).filter(e => e.type === 'hook.command_submitted')).toHaveLength(2);
    expect(view(f, f.main, { id: example.hook_id }).state).toBe('succeeded');
    expect(f.store.task(f.main.id).calls).toBe(0);
  } finally { await f.close(); }
});

test('mounted worktree is actual cwd, environment strips invocation/provider capability and execution locks editing', async () => {
  const f = await setup(); let workspace;
  try {
    const { task } = await f.project.order('cwd', 'main', [], null, false);
    workspace = task.workspace;
    Object.assign(f.config.env, { LUSH_AGENT_TOKEN: 'TOKEN_SECRET', LUSH_TASK_ID: '987', PI_CODING_AGENT_DIR: '/private', CODEX_HOME: '/private',
      GIT_WORK_TREE: f.root });
    const hook = attach(f, task, rule('pwd > .lush-cwd; env > .lush-env; while [ ! -f release ]; do sleep 0.01; done', { trigger: 'agent.returned' }));
    emit(f, task, null, 'agent.returned');
    await until(() => view(f, task, hook).state === 'running');
    await until(() => fs.existsSync(path.join(task.workspace, '.lush-env')) && fs.statSync(path.join(task.workspace, '.lush-env')).size > 0);
    expect(fs.readFileSync(path.join(task.workspace, '.lush-cwd'), 'utf8').trim()).toBe(task.workspace);
    expect(fs.existsSync(path.join(f.root, '.lush-cwd'))).toBe(false);
    const env = fs.readFileSync(path.join(task.workspace, '.lush-env'), 'utf8');
    expect(env).not.toContain('TOKEN_SECRET'); expect(env).not.toContain('LUSH_TASK_ID=');
    expect(env).not.toContain('PI_CODING_AGENT_DIR='); expect(env).not.toContain('CODEX_HOME='); expect(env).not.toContain('GIT_WORK_TREE=');
    expect(env).toContain('GIT_TERMINAL_PROMPT=0');
    await expect(f.project.updateTaskHook(task.id, hook.id, false, f.project.taskHooks(task.id).revision)).rejects.toThrow('executing');
    expect(() => f.project.removeTaskHook(task.id, hook.id, f.project.taskHooks(task.id).revision)).toThrow('executing');
    fs.writeFileSync(path.join(task.workspace, 'release'), 'go'); await f.project.hookQueue;
  } finally { if (workspace) fs.writeFileSync(path.join(workspace, 'release'), 'go'); await f.close(); }
});
