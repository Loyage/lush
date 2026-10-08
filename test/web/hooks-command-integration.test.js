import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git } from '../helpers.js';
import { setup, fetch } from './harness.js';

setDefaultTimeout(20000);
const get = async (f, suffix) => (await fetch(f.url + suffix)).json();
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }) });
  const value = await response.json();
  if (response.status !== status) throw new Error(`${method}: expected HTTP ${status}, received ${response.status}: ${value.error}`);
  expect(response.status).toBe(status); return value;
}
function definition(mount, enabled = mount.enabled) {
  return { name: mount.name, trigger: mount.trigger, mode: mount.mode, enabled, conditions: mount.conditions,
    actions: mount.actions };
}
async function prepare() {
  const f = await setup(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  await repo(f.root); await f.project.bootstrapMain(); return f;
}
async function deliver(f, mainId, name) {
  const { task } = await post(f, 'order.submit', { content: name, branch: 'main', start: false });
  fs.writeFileSync(path.join(task.workspace, `${name}.txt`), name);
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', name);
  f.store.update(task.id, { status: 'waiting', result: 'done' });
  await f.project.workspaces.finish(f.store.task(task.id));
  await post(f, 'worker.reserve', { id: task.id, kind: 'merge' });
  await f.project.driveTaskMerge(mainId); await f.project.hookQueue;
  expect(f.store.task(task.id).integration).toBe('merged'); return task;
}

test('HTTP main push example and Worker Hooks are the same revisioned mount: enabled merges push to a local bare remote', async () => {
  const f = await prepare();
  try {
    const remote = path.join(f.config.home, 'http-remote.git');
    await git(f.root, 'init', '--bare', remote); await git(f.root, 'remote', 'add', 'origin', remote);
    await git(f.root, 'push', '-u', 'origin', 'main');
    let catalogue = await get(f, '/api/hooks'), example = catalogue.command_example;
    const mainId = example.worker_id, hookId = example.hook_id;
    const initial = example.hooks.mounts.find(m => m.id === hookId);
    expect(initial).toMatchObject({ enabled: false, trigger: 'worker.merge_received', actions: [{ type: 'command', command: 'git push' }] });
    expect(await get(f, `/api/worker/${mainId}/hooks`)).toEqual(example.hooks);
    const beforeEvents = f.store.history(mainId).length;
    await get(f, '/api/hooks'); await get(f, `/api/worker/${mainId}/hooks`);
    expect(f.store.history(mainId)).toHaveLength(beforeEvents);
    await deliver(f, mainId, 'disabled');
    expect(await git(remote, 'rev-parse', 'main')).not.toBe(await git(f.root, 'rev-parse', 'main'));

    example = (await get(f, '/api/hooks')).command_example;
    const enabled = await post(f, 'worker.hook_update', { id: mainId, hook_id: hookId, enabled: true, expected_revision: example.hooks.revision });
    expect(enabled.mounts.find(m => m.id === hookId).enabled).toBe(true);
    const nextExample = (await get(f, '/api/hooks')).command_example;
    expect(nextExample.hooks).toEqual(await get(f, `/api/worker/${mainId}/hooks`));
    await post(f, 'worker.hook_update', { id: mainId, hook_id: hookId, enabled: false, expected_revision: example.hooks.revision }, 400);
    for (const name of ['first-enabled', 'second-enabled']) {
      await deliver(f, mainId, name);
      expect(await git(remote, 'rev-parse', 'main')).toBe(await git(f.root, 'rev-parse', 'main'));
      const current = (await get(f, '/api/hooks')).command_example.hooks.mounts.find(m => m.id === hookId);
      expect(current).toMatchObject({ state: 'succeeded', enabled: true, last_execution: { command_result: { status: 'succeeded', exit_code: 0 } } });
    }
    const submissions = f.store.history(mainId).filter(e => e.type === 'hook.command_submitted');
    expect(submissions).toHaveLength(2); expect(f.store.task(mainId).calls).toBe(0);
  } finally { await f.close(); }
});

test('HTTP edits and disabled copies remain independent, preserve template separation and expose safe failure without retries', async () => {
  const f = await prepare();
  try {
    let catalogue = await get(f, '/api/hooks');
    const { worker_id: mainId, hook_id: hookId, template_id: templateId } = catalogue.command_example;
    let hooks = await get(f, `/api/worker/${mainId}/hooks`);
    const initial = hooks.mounts.find(m => m.id === hookId);
    const edited = { ...definition(initial, false), name: 'custom command', actions: [{ type: 'command', command: 'printf x >> .lush/http-command-runs' }] };
    hooks = await post(f, 'worker.hook_update', { id: mainId, hook_id: hookId, hook: edited, expected_revision: hooks.revision });
    expect(hooks.mounts.find(m => m.id === hookId)).toMatchObject(edited);
    await post(f, 'worker.hook_update', { id: mainId, hook_id: hookId, hook: edited, enabled: false, expected_revision: hooks.revision }, 400);
    // Runtime observations may advance revisions independently of a completed mutation.
    hooks = await get(f, `/api/worker/${mainId}/hooks`);
    hooks = await post(f, 'worker.hook_attach', { id: mainId, hook: { ...edited, name: 'disabled copy' }, expected_revision: hooks.revision });
    expect(hooks.mounts).toHaveLength(2); expect(hooks.mounts.at(-1).last_execution).toBeNull();
    expect(fs.existsSync(path.join(f.config.home, 'http-command-runs'))).toBe(false);
    catalogue = await get(f, '/api/hooks');
    expect(catalogue.templates.find(t => t.id === templateId).actions[0].command).toBe('git push');
    await post(f, 'hooks.save', { expected_revision: catalogue.revision, template: {
      ...definition(catalogue.templates.find(t => t.id === templateId)), id: templateId, name: 'template only',
      actions: [{ type: 'command', command: 'true' }],
    } });
    expect((await get(f, `/api/worker/${mainId}/hooks`)).mounts.find(m => m.id === hookId).actions).toEqual(edited.actions);
    const failedRule = { ...edited, enabled: true, actions: [{ type: 'command', command: 'echo PRIVATE_COMMAND_OUTPUT; exit 9' }] };
    hooks = await get(f, `/api/worker/${mainId}/hooks`);
    hooks = await post(f, 'worker.hook_update', { id: mainId, hook_id: hookId, hook: failedRule, expected_revision: hooks.revision });
    await deliver(f, mainId, 'command-fails');
    const failed = (await get(f, `/api/worker/${mainId}/hooks`)).mounts.find(m => m.id === hookId);
    expect(failed).toMatchObject({ enabled: false, state: 'failed', last_execution: { command_result: { exit_code: 9 } } });
    expect(failed.last_execution.error).toContain('停用');
    expect(JSON.stringify(failed.last_execution)).not.toContain('PRIVATE_COMMAND_OUTPUT');
    const count = f.store.history(mainId).filter(e => e.type === 'hook.command_submitted').length;
    await deliver(f, mainId, 'after-failure');
    expect(f.store.history(mainId).filter(e => e.type === 'hook.command_submitted')).toHaveLength(count);
    hooks = await get(f, `/api/worker/${mainId}/hooks`);
    await post(f, 'worker.hook_remove', { id: mainId, hook_id: hookId, expected_revision: hooks.revision });
    await f.project.bootstrapMain();
    catalogue = await get(f, '/api/hooks');
    expect(catalogue.command_example.hook_id).toBe(hookId);
    expect(catalogue.command_example.hooks.mounts.some(m => m.id === hookId)).toBe(false);
  } finally { await f.close(); }
});
