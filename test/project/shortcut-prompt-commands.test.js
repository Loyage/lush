import { test, expect } from 'bun:test';
import { fixture, repo, gate, until } from '../helpers.js';
import { attachRegisteredHook } from '../hook-registry.js';

test('prompt Hook creates an independent order and starts the default Agent', async () => {
  const entered = gate(), finish = gate();
  const f = fixture({ async run({ task }) { entered.resolve(task); await finish.promise; return 'done'; } });
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; await repo(f.root);
  try {
    const main = await f.project.bootstrapMain();
    const item = f.project.saveShortcutCommand({ name: 'prompt shortcut', kind: 'prompt', prompt: 'PRIVATE_PROMPT_BODY' }, f.project.shortcutCommands().revision).commands.items.at(-1);
    attachRegisteredHook(f.project, main.id, { name: 'prompt once', trigger: 'worker.parent_ready', mode: 'once', enabled: true,
      actions: [{ type: 'prompt_command', command_id: item.id }] });
    f.project.emitTaskHook(main.id, 'worker.parent_ready');
    await f.project.hookQueue;
    const execution = f.project.shortcutCommandHistory().items[0];
    const created = f.store.task(execution.created_worker_id);
    expect(created).toMatchObject({ task_kind: 'order', parent_id: main.id, goal: item.prompt, status: 'queued' });
    expect(created.workspace).not.toBe(main.workspace);
    expect(execution).toMatchObject({ status: 'succeeded', input_id: created.input_id, created_worker_number: created.worker_number });
    f.project.pump(); const running = await entered.promise;
    expect(running.id).toBe(created.id); expect(f.store.task(created.id).status).toBe('running');
    finish.resolve(); await until(() => !f.project.running.has(created.id));
    expect(f.store.task(created.id).result).toBe('done');
  } finally { finish.resolve(); await f.close(); }
});
