import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';

test('a successful queue landing executes the configured git push Hook', async () => {
  const f = fixture(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root);
  try {
    const main = await f.project.bootstrapMain();
    const remote = path.join(f.config.home, 'remote.git');
    await git(f.root, 'init', '--bare', remote); await git(f.root, 'remote', 'add', 'origin', remote);
    await git(f.root, 'push', '-u', 'origin', 'main');
    const example = f.project.hooksList().command_example;
    await f.project.updateTaskHook(main.id, example.hook_id, true, example.hooks.revision);
    const { task } = await f.project.order('feature', 'main', [], null, false);
    fs.writeFileSync(path.join(task.workspace, 'feature.txt'), 'feature\n');
    await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'feature');
    f.store.update(task.id, { status: 'waiting', result: 'done' });
    await f.project.workspaces.finish(f.store.task(task.id));
    await f.project.reserveTask(task.id, 'merge'); await f.project.driveTaskMerge(main.id);
    expect(f.store.task(task.id).integration).toBe('merged');
    expect(await git(remote, 'rev-parse', 'main')).toBe(await git(f.root, 'rev-parse', 'main'));
    expect(await git(remote, 'show', 'main:feature.txt')).toBe('feature');
    expect(f.project.taskHooks(main.id).mounts.find(item => item.id === example.hook_id).state).toBe('succeeded');
    expect(f.store.task(main.id).calls).toBe(0);

    const directory = f.project.hooksList();
    const temporary = f.project.createTemporaryAutomation({ command: { name: '临时 Shell', command: 'printf temporary' },
      hook: { name: '仅运行一次', trigger: 'agent.returned', enabled: true },
      expected_revisions: { commands: directory.commands.revision, registry: directory.registry.revision }, client_request_id: 'temporary-shell' });
    const attached = f.project.attachTaskHook(main.id, { template_id: temporary.template_id, template_version: 1 }, f.project.taskHooks(main.id).revision);
    const hookId = attached.mounts.at(-1).id;
    f.project.emitTaskHook(main.id, 'agent.returned'); await f.project.hookQueue;
    expect(f.project.taskHooks(main.id).mounts.some(mount => mount.id === hookId)).toBe(false);
    expect(f.project.shortcutCommandHistory().items.find(item => item.command_id === temporary.command_id)).toMatchObject({ status: 'succeeded', command_version: 1 });
    expect(f.project.temporaryAutomationHistory({ id: temporary.template_id }).usage).toMatchObject({ succeeded_total: 1, reclaimable: true });
    f.project.reclaimTemporaryAutomation({ id: temporary.template_id, expected_revision: f.project.hooksList().registry.revision, client_request_id: 'reclaim-shell' });
    expect(() => f.project.removeShortcutCommand(temporary.command_id, f.project.shortcutCommands().revision)).toThrow('retained');
  } finally { await f.close(); }
});
