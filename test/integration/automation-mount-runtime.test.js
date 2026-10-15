import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, fetch } from '../web/harness.js';
import { repo, git, until } from '../helpers.js';
import { RPCClient } from '../../src/rpc/client.js';

async function get(f, route = '/api/hooks') {
  const response = await fetch(f.url + route); expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store'); return response.json();
}
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url },
    body: JSON.stringify({ method, params }) });
  const value = await response.json(); expect(response.status).toBe(status); return value;
}
const hooks = (f, id) => get(f, `/api/worker/${id}/hooks`);
const patch = async (f, value) => post(f, 'hooks.automation_settings', { patch: value, expected_revision: (await get(f)).automation_settings.revision });
const create = async (f, content) => (await post(f, 'order.submit', { content, start: false })).task;

test('HTTP creation to RPC/SQLite/Git preserves frozen mounts and serial handler while retired convergence defaults reject writes', async () => {
  const f = await setup(); f.project.kick = () => {};
  try {
    await repo(f.root); await f.project.bootstrapMain();
    const old = await create(f, 'existing authorization');
    await post(f, 'worker.completion', { id: old.id, level: 'accept', expected_revision: (await hooks(f, old.id)).revision });
    const oldRow = f.store.task(old.id), oldHooks = await hooks(f, old.id);
    const initial = (await get(f)).automation_settings;
    expect(initial.mount_scopes).toEqual({ completion: 'all', acceptance_notice: 'all' });
    const policy = await patch(f, { mount_scopes: { completion: 'none', acceptance_notice: 'none' },
      completion_defaults: { enabled: true, level: 'accept' }, display_principles: { completion: 'all', convergence: 'all', push: 'all' } });
    expect(policy.automation_settings.version).toBe(1);
    expect(f.store.task(old.id)).toEqual(oldRow);
    expect((await hooks(f, old.id)).mounted_features).toEqual(oldHooks.mounted_features);
    expect((await hooks(f, old.id)).revision).toBe(oldHooks.revision);
    const d = await get(f, '/api/branch-convergence/defaults');
    expect(d).toMatchObject({ mounted: false, scope: 'none', enabled: false, retired: true, editable: false });
    const beforeRetiredWrite = ['meta', 'events'].map(table => f.store.all(`SELECT * FROM ${table}`));
    expect((await post(f, 'branch.convergence_defaults_set', {
      mounted: true, enabled: false, scope: 'main', expected_revision: d.revision,
    }, 400)).error).toContain('retired');
    expect(['meta', 'events'].map(table => f.store.all(`SELECT * FROM ${table}`))).toEqual(beforeRetiredWrite);
    const fresh = await create(f, 'new unmounted');
    const freshHooks = await hooks(f, fresh.id);
    expect(freshHooks.mounted_features).toEqual({ completion: false, acceptance_notice: false, convergence: false, push: false });
    expect(freshHooks.completion.level).toBe('off'); expect(freshHooks.acceptance_notice.enabled).toBe(false);
    expect(freshHooks.mounts.find(m => m.id === 'delivery-handler').actions[0].strategy).toBe('serial');
    expect(JSON.parse(f.store.task(fresh.id).auto_merge).mounted_features).toEqual({ completion: false, acceptance_notice: false });
    expect(await git(fresh.workspace, 'rev-parse', 'HEAD')).toBe(fresh.base_commit);
    const rpc = new RPCClient(f.config.socket);
    expect(await rpc.request('worker.hooks', { id: fresh.id })).toEqual(freshHooks);
    const on = await post(f, 'worker.completion', { id: fresh.id, level: 'merge', expected_revision: freshHooks.revision });
    expect(on.mounted_features.completion).toBe(true); expect(on.mounts.find(m => m.id === 'auto-merge').enabled).toBe(true);
    const notified = await post(f, 'worker.acceptance_notice', { id: fresh.id, enabled: true, expected_revision: on.revision });
    expect(notified.mounted_features.acceptance_notice).toBe(true); expect(notified.acceptance_notice.enabled).toBe(true);
    const currentD = await get(f, '/api/branch-convergence/defaults');
    expect(currentD).toEqual(d);
    for (const scope of [null, true, 'device', ''])
      expect((await post(f, 'branch.convergence_defaults_set', { mounted: true, enabled: false, scope, expected_revision: currentD.revision }, 400)).error).toContain('scope');
    expect((await post(f, 'branch.convergence_defaults_set', { mounted: false, enabled: false, scope: 'user', expected_revision: currentD.revision }, 400)).error).toContain('match scope');
    for (const expected_revision of [d.revision, 'stale-revision'])
      expect((await post(f, 'branch.convergence_defaults_set', { mounted: true, enabled: false, scope: 'all', expected_revision }, 400)).error).toContain('retired');
    for (const mount_scopes of [{ push: 'main' }, { completion: null }, { acceptance_notice: 'device' }, {}])
      expect((await post(f, 'hooks.automation_settings', { patch: { mount_scopes }, expected_revision: policy.automation_settings.revision }, 400)).error).toBeString();
    const snapshot = ['tasks','events','meta','notices'].map(table => f.store.all(`SELECT * FROM ${table}`));
    await hooks(f, fresh.id); await get(f); await get(f, '/api/branch-convergence/defaults');
    expect(['tasks','events','meta','notices'].map(table => f.store.all(`SELECT * FROM ${table}`))).toEqual(snapshot);
    const main = f.store.task(fresh.parent_id), mainHooks = await hooks(f, main.id);
    expect(mainHooks.mounted_features.push).toBe(true);
    await post(f, 'worker.hook_remove', { id: main.id, hook_id: mainHooks.push.hook_id, expected_revision: mainHooks.revision });
    await f.project.bootstrapMain();
    expect((await hooks(f, main.id)).mounted_features.push).toBe(false);
    expect((await hooks(f, fresh.id)).mounted_features.push).toBe(false);
  } finally { await f.close(); }
});

test('controlled Provider really executes unmounted-default order without auto completion or success notice; permissions stay user-only', async () => {
  const f = await setup(); let checked = 0;
  try {
    await repo(f.root);
    f.project.provider = { resolve() { return { agent: 'mock' }; }, async run({ task, token }) {
      const rpc = new RPCClient(f.config.socket);
      for (const [method, params] of [
        ['hooks.automation_settings', { patch: { mount_scopes: { completion: 'all' } }, expected_revision: 'x' }],
        ['branch.convergence_defaults_set', { mounted: true, enabled: false, scope: 'all', expected_revision: 'x' }],
        ['worker.completion', { id: task.id, level: 'accept', expected_revision: 'x' }],
        ['worker.acceptance_notice', { id: task.id, enabled: true, expected_revision: 'x' }],
      ]) { await expect(rpc.request(method, { ...params, _token: token })).rejects.toThrow('requires user approval'); checked++; }
      fs.writeFileSync(path.join(task.workspace, 'controlled.txt'), 'real work');
      await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'controlled work'); return 'done';
    } };
    await patch(f, { completion_defaults: { enabled: true, level: 'accept' }, mount_scopes: { completion: 'none', acceptance_notice: 'none' } });
    const task = await create(f, 'unmounted execution'), mainHead = await git(f.root, 'rev-parse', 'main');
    await post(f, 'worker.resume', { id: task.id });
    await until(() => f.store.task(task.id).status === 'waiting' && !f.project.running.has(task.id), 10000);
    expect(checked).toBe(4); expect(await git(f.root, 'rev-parse', 'main')).toBe(mainHead);
    expect(f.store.task(task.id).reservation).toBeNull();
    await post(f, 'worker.reserve', { id: task.id, kind: 'merge' });
    await until(() => f.store.task(task.id).status === 'awaiting_acceptance' && !f.project.taskMergeBusy?.size, 10000);
    expect(f.store.task(task.id).integration).toBe('merged'); expect(await git(f.root, 'rev-parse', 'main')).not.toBe(mainHead);
    expect(f.store.history(task.id).some(e => e.type === 'task.accepted')).toBe(false);
    expect(f.store.all("SELECT * FROM events WHERE task_id=? AND type='task.acceptance_notice_observed'", task.id).map(e => JSON.parse(e.data).enabled)).toEqual([false]);
    expect((await hooks(f, task.id)).mounted_features.completion).toBe(false);
  } finally { await f.close(); }
});
