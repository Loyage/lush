import { retiredHook } from '../hook-assertions.js';
import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git, until } from '../helpers.js';
setDefaultTimeout(15000);

test('a newly queued invocation cannot overlap Shell execution in the same worktree and resumes after release', async () => {
  let calls = 0, workspace;
  const f = fixture({ resolve() { return { agent: 'mock' }; }, async run() { calls++; return 'done'; } });
  f.project.kick = () => {}; await repo(f.root);
  try {
    const { task } = await f.project.order('no overlap', 'main', [], null, false); workspace = task.workspace;
    const command = f.project.saveShortcutCommand({ name: 'shell', command: 'id -u > daemon-user; while [ ! -f release ]; do sleep 0.01; done' }, f.project.shortcutCommands().revision).commands.items.at(-1);
    f.project.authorizeShortcutCommand(command.id, command.version, true, f.project.shortcutCommands().revision);
    const hooks = f.project.attachTaskHook(task.id, { name: 'shell', trigger: 'agent.returned', mode: 'once', enabled: true,
      actions: [{ type: 'command', command_id: command.id, command_version: command.version }] }, f.project.taskHooks(task.id).revision);
    const hook = hooks.mounts.at(-1);
    f.project.emitTaskHook(task.id, 'agent.returned');
    await until(() => f.project.commandHookRunning?.has(task.id));
    await until(() => fs.existsSync(path.join(workspace, 'daemon-user')) && fs.statSync(path.join(workspace, 'daemon-user')).size > 0);
    expect(Number(fs.readFileSync(path.join(workspace, 'daemon-user'), 'utf8').trim())).toBe(process.getuid());
    f.project.resumeTask(task.id); f.project.pump(); await Promise.resolve();
    expect(f.store.task(task.id).status).toBe('queued'); expect(calls).toBe(0); expect(f.project.running.has(task.id)).toBe(false);
    fs.writeFileSync(path.join(workspace, 'release'), 'go'); await f.project.hookQueue;
    expect(f.project.commandHookRunning.has(task.id)).toBe(false);
    // Only the untracked test markers remain; commit before the mock delivery inspects the worktree.
    await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'test command artifacts');
    f.project.pump(); await until(() => f.store.task(task.id).calls === 1 && f.store.task(task.id).status === 'waiting');
    expect(calls).toBe(1);
    retiredHook(f.project, task.id, hook.id);
  } finally { if (workspace) fs.writeFileSync(path.join(workspace, 'release'), 'go'); await f.close(); }
});
