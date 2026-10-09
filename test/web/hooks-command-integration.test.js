import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git } from '../helpers.js';
import { setup, fetch } from './harness.js';

setDefaultTimeout(30000);
const get = async (f, suffix) => (await fetch(f.url + suffix)).json();
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }) });
  const value = await response.json();
  if (response.status !== status) throw new Error(`${method}: expected HTTP ${status}, received ${response.status}: ${value.error}`);
  expect(response.status).toBe(status); return value;
}
function definition(mount, enabled = mount.enabled) {
  return { name: mount.name, trigger: mount.trigger, mode: mount.mode, enabled, conditions: mount.conditions, actions: mount.actions };
}
const reference = item => ({ type: 'command', command_id: item.id, command_version: item.version });
async function authorize(f, item, authorized = true) {
  const catalogue = await get(f, '/api/hooks');
  return post(f, 'hooks.command_authorize', { id: item.id, version: item.version, authorized, expected_revision: catalogue.commands.revision });
}
async function register(f, command, authorized = true) {
  const catalogue = await get(f, '/api/hooks');
  const result = await post(f, 'hooks.command_save', { command: { name: 'HTTP command', command }, expected_revision: catalogue.commands.revision });
  const item = result.commands.items.at(-1);
  expect(item.authorized).toBe(false);
  if (authorized) await authorize(f, item);
  return item;
}
async function updateMount(f, mainId, hookId, changes) {
  const hooks = await get(f, `/api/worker/${mainId}/hooks`);
  return post(f, 'worker.hook_update', { id: mainId, hook_id: hookId, ...changes, expected_revision: hooks.revision });
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

test('HTTP built-in git push is pre-authorized but its Hook stays off until explicitly enabled, then pushes each successful merge', async () => {
  const f = await prepare();
  try {
    const remote = path.join(f.config.home, 'http-remote.git');
    await git(f.root, 'init', '--bare', remote); await git(f.root, 'remote', 'add', 'origin', remote);
    await git(f.root, 'push', '-u', 'origin', 'main');
    let catalogue = await get(f, '/api/hooks'), example = catalogue.command_example;
    const mainId = example.worker_id, hookId = example.hook_id;
    const command = catalogue.commands.items.find(item => item.command === 'git push');
    const initial = example.hooks.mounts.find(m => m.id === hookId);
    expect(command).toMatchObject({ authorized: true, version: 1 });
    expect(initial).toMatchObject({ enabled: false, trigger: 'worker.merge_received', actions: [reference(command)] });
    expect(Object.hasOwn(initial.actions[0], 'command')).toBe(false);
    expect(await get(f, `/api/worker/${mainId}/hooks`)).toEqual(example.hooks);
    const beforeEvents = f.store.history(mainId).length;
    await get(f, '/api/hooks'); await get(f, `/api/worker/${mainId}/hooks`);
    expect(f.store.history(mainId)).toHaveLength(beforeEvents);
    await deliver(f, mainId, 'disabled');
    expect(await git(remote, 'rev-parse', 'main')).not.toBe(await git(f.root, 'rev-parse', 'main'));

    example = (await get(f, '/api/hooks')).command_example;
    const enabled = await updateMount(f, mainId, hookId, { enabled: true });
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
    expect(f.store.history(mainId).filter(e => e.type === 'hook.command_submitted')).toHaveLength(2);
    expect(f.store.task(mainId).calls).toBe(0);
  } finally { await f.close(); }
});

test('HTTP exact-version edits and disabled copies preserve template separation; failed execution stops future Hook triggers', async () => {
  const f = await prepare();
  try {
    let catalogue = await get(f, '/api/hooks');
    const { worker_id: mainId, hook_id: hookId, template_id: templateId } = catalogue.command_example;
    const originalActions = catalogue.templates.find(t => t.id === templateId).actions;
    const command = await register(f, 'printf x >> .lush/http-command-runs');
    let hooks = await get(f, `/api/worker/${mainId}/hooks`);
    const initial = hooks.mounts.find(m => m.id === hookId);
    const edited = { ...definition(initial, false), name: 'custom command', actions: [reference(command)] };
    hooks = await updateMount(f, mainId, hookId, { hook: edited });
    expect(hooks.mounts.find(m => m.id === hookId)).toMatchObject(edited);
    await post(f, 'worker.hook_update', { id: mainId, hook_id: hookId, hook: edited, enabled: false, expected_revision: hooks.revision }, 400);
    hooks = await get(f, `/api/worker/${mainId}/hooks`);
    hooks = await post(f, 'worker.hook_attach', { id: mainId, hook: { ...edited, name: 'disabled copy' }, expected_revision: hooks.revision });
    expect(hooks.mounts).toHaveLength(2); expect(hooks.mounts.at(-1).last_execution).toBeNull();
    expect(fs.existsSync(path.join(f.config.home, 'http-command-runs'))).toBe(false);
    catalogue = await get(f, '/api/hooks');
    expect(catalogue.templates.find(t => t.id === templateId).actions).toEqual(originalActions);
    const templateCommand = await register(f, 'true');
    catalogue = await get(f, '/api/hooks');
    await post(f, 'hooks.save', { expected_revision: catalogue.revision, template: {
      ...definition(catalogue.templates.find(t => t.id === templateId)), id: templateId, name: 'template only', actions: [reference(templateCommand)],
    } });
    expect((await get(f, `/api/worker/${mainId}/hooks`)).mounts.find(m => m.id === hookId).actions).toEqual(edited.actions);
    const failing = await register(f, 'echo PRIVATE_COMMAND_OUTPUT; exit 9');
    await updateMount(f, mainId, hookId, { hook: { ...edited, enabled: true, actions: [reference(failing)] } });
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

test('HTTP manual execution uses selected Worker cwd, version edits revoke old Hook references and unsafe attempts have no side effects', async () => {
  const f = await prepare();
  try {
    const { task } = await post(f, 'order.submit', { content: 'manual HTTP', branch: 'main', start: false });
    const command = await register(f, 'printf old > manual-result; echo PRIVATE_HTTP_OUTPUT');
    const catalogue = await get(f, '/api/hooks');
    const mainId = catalogue.command_example.worker_id, hookId = catalogue.command_example.hook_id;
    const initial = catalogue.command_example.hooks.mounts.find(m => m.id === hookId);
    await updateMount(f, mainId, hookId, { hook: { ...definition(initial, true), actions: [reference(command)] } });
    const revision = (await get(f, '/api/hooks')).commands.revision;
    const params = { id: command.id, version: 1, worker_id: task.id, expected_revision: revision };
    const result = await post(f, 'hooks.command_run', params);
    expect(result.command_result).toMatchObject({ status: 'succeeded', exit_code: 0 });
    expect(result.commands.items.find(c => c.id === command.id).last_execution).toMatchObject({ worker_id: task.id, worker_number: task.worker_number, status: 'succeeded' });
    expect(fs.readFileSync(path.join(task.workspace, 'manual-result'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(f.root, 'manual-result'))).toBe(false);
    expect(JSON.stringify(result.commands.items.find(c => c.id === command.id).last_execution)).not.toContain('PRIVATE_HTTP_OUTPUT');
    await post(f, 'hooks.command_run', params, 400); // A receipt changed the read revision: no accidental double submit.
    const edited = await post(f, 'hooks.command_save', { command: { id: command.id, name: command.name, command: 'printf new > manual-result' }, expected_revision: result.commands.revision });
    const next = edited.commands.items.find(c => c.id === command.id);
    expect(next).toMatchObject({ version: 2, authorized: false });
    expect(edited.command_example.hooks.mounts.find(m => m.id === hookId).enabled).toBe(false);
    await post(f, 'hooks.command_run', { ...params, version: 2, expected_revision: edited.commands.revision }, 400);
    await authorize(f, next);
    let hooks = await get(f, `/api/worker/${mainId}/hooks`);
    await post(f, 'worker.hook_update', { id: mainId, hook_id: hookId, enabled: true, expected_revision: hooks.revision }, 400);
    expect(fs.readFileSync(path.join(task.workspace, 'manual-result'), 'utf8')).toBe('old');
    const runNext = async (status = 200) => post(f, 'hooks.command_run', { id: command.id, version: 2, worker_id: task.id, expected_revision: (await get(f, '/api/hooks')).commands.revision }, status);
    f.project.running.set(task.id, {}); await runNext(400); f.project.running.clear();
    await runNext(); expect(fs.readFileSync(path.join(task.workspace, 'manual-result'), 'utf8')).toBe('new');
    await authorize(f, next, false); await runNext(400);
    const revoked = await get(f, '/api/hooks');
    await post(f, 'hooks.command_remove', { id: command.id, expected_revision: revoked.commands.revision });
    await runNext(400);
    expect(JSON.stringify(f.store.all('SELECT * FROM events'))).not.toContain('PRIVATE_HTTP_OUTPUT');
  } finally { f.project.running.clear(); await f.close(); }
});

test('HTTP explicit legacy import stops old inline execution, preserves source identity/history and requires fresh authorization', async () => {
  const f = await prepare();
  try {
    const example = (await get(f, '/api/hooks')).command_example;
    const mainId = example.worker_id, hookId = example.hook_id;
    const state = JSON.parse(f.store.task(mainId).hooks), mount = state.mounts.find(m => m.id === hookId);
    const history = { id: 77, status: 'failed', error: 'safe legacy failure' };
    Object.assign(mount, { enabled: true, actions: [{ type: 'command', command: 'printf imported >> .lush/http-import' }], last_execution: history });
    f.store.update(mainId, { hooks: JSON.stringify(state) });
    const before = f.store.task(mainId).hooks;
    let catalogue = await get(f, '/api/hooks');
    expect(catalogue.command_example.hooks.mounts.find(m => m.id === hookId)).toMatchObject({ enabled: false, reason: expect.stringContaining('导入') });
    expect(f.store.task(mainId).hooks).toBe(before); // Read APIs never migrate or register.
    await deliver(f, mainId, 'legacy-disabled');
    expect(fs.existsSync(path.join(f.config.home, 'http-import'))).toBe(false);
    catalogue = await get(f, '/api/hooks');
    const source = { worker_id: mainId, hook_id: hookId };
    await post(f, 'hooks.command_import', { source, expected_revision: 'stale' }, 400);
    const imported = await post(f, 'hooks.command_import', { source, expected_revision: catalogue.command_example.hooks.revision });
    const item = imported.commands.items.find(c => c.id === imported.imported_command_ids[0]);
    expect(item).toMatchObject({ authorized: false, version: 1 });
    expect(imported.worker_hooks.mounts.find(m => m.id === hookId)).toMatchObject({ id: hookId, enabled: false, actions: [reference(item)], last_execution: history });
    await authorize(f, item);
    await updateMount(f, mainId, hookId, { enabled: true });
    await f.project.hookQueue;
    expect(fs.existsSync(path.join(f.config.home, 'http-import'))).toBe(false);
    await deliver(f, mainId, 'legacy-imported');
    expect(fs.readFileSync(path.join(f.config.home, 'http-import'), 'utf8')).toBe('imported');
  } finally { await f.close(); }
});
