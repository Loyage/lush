import { test, expect } from 'bun:test';
import { fetch, setup } from './harness.js';
import { gate, repo, until } from '../helpers.js';
import { attachRegisteredHook } from '../hook-registry.js';
import { UIClient } from '../../src/ui/client.js';
import { Project } from '../../src/core/project.js';
import { Store } from '../../src/persistence/store.js';
import { safeRestartFlow } from '../../src/ui/web/assets/safe-restart-flow.js';
import path from 'node:path';

const post = (f, method, params = {}, suffix = '', envelope = {}) => fetch(f.url + '/api/action' + suffix, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, ...envelope }),
});
const count = f => f.store.get("SELECT count(*) AS n FROM notices WHERE title='项目中断完成'").n;
const persisted = f => JSON.parse(f.store.get("SELECT value FROM meta WHERE key='project_maintenance'").value);
const save = (f, data) => f.store.run("UPDATE meta SET value=? WHERE key='project_maintenance'", JSON.stringify(data));
async function hostMaintenance(f) {
  const data = await (await fetch(f.url + '/api/host/projects')).json();
  return data.projects[0].summary.maintenance;
}
async function root(f) {
  await repo(f.root);
  return (await f.project.order('held', 'main', [], null, false)).task;
}

test('authenticated HTTP -> RPC user gate -> real maintenance -> Host: manual default and silent policy are durable batch choices', async () => {
  const f = await setup(); const hold = gate(); let providerCalls = 0;
  f.project.provider = { async run() { providerCalls++; await hold.promise; return 'safe natural boundary'; } };
  try {
    const task = await root(f), client = new UIClient(f.config);
    const owner = f.store.task(task.parent_id);
    attachRegisteredHook(f.project, owner.id, { name: 'user-owned', trigger: 'project.interrupted', mode: 'persistent', enabled: true,
      conditions: {}, actions: [{ type: 'notify', title: 'user-owned completion', body: '' }] });
    f.project.resumeTask(task.id);
    await until(() => providerCalls === 1);
    const run = f.project.running.get(task.id);
    await expect(client.request('system.interrupt_all', { notify_completion: false, _token: run.token })).rejects.toThrow('requires user approval');
    expect(f.project.maintenancePaused()).toBe(false);
    const response = await post(f, 'system.interrupt_all', { notify_completion: false });
    expect(response.status).toBe(200); const ack = await response.json();
    expect(ack).toMatchObject({ paused: true, completion_state: 'pending', completion_notice_id: null, notify_completion: false, ready_to_restart: false });
    const repeated = await (await post(f, 'system.interrupt_all')).json();
    expect(repeated.batch_id).toBe(ack.batch_id); expect(repeated.notify_completion).toBe(false);
    expect(persisted(f).notify_completion).toBe(false);
    expect(count(f)).toBe(0);
    hold.resolve();
    await until(() => { f.project.observeMaintenanceCompletion(); return f.project.maintenanceView().completion_state === 'completed'; });
    await f.project.hookQueue;
    expect(await hostMaintenance(f)).toMatchObject({ completion_state: 'completed', completion_notice_id: null, notify_completion: false });
    expect(count(f)).toBe(0);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title='user-owned completion'").n).toBe(1);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE title LIKE '% 中断完成'").n).toBe(1);
    expect(f.store.get("SELECT data FROM events WHERE type='project.interrupted' ORDER BY id DESC LIMIT 1").data).toContain('"notify_completion":false');
    f.project.kick = () => {}; // Verify resume bookkeeping without launching another invocation.
    expect(await (await post(f, 'system.resume_all')).json()).toMatchObject({ paused: false, completion_state: 'cancelled', notify_completion: false });
    const manual = await (await post(f, 'system.interrupt_all')).json();
    expect(manual).toMatchObject({ completion_state: 'completed', notify_completion: true });
    expect(manual.completion_notice_id).toBeGreaterThan(0); expect(count(f)).toBe(1);
    expect((await (await post(f, 'system.interrupt_all', { notify_completion: false })).json()).notify_completion).toBe(true);
    await post(f, 'system.resume_all');
    const quiet = await (await post(f, 'system.interrupt_all', { notify_completion: false })).json();
    expect(quiet.batch_id).not.toBe(manual.batch_id); expect(quiet.completion_notice_id).toBeNull();
    expect(count(f)).toBe(1); // Never delete historical manual notifications.
  } finally { hold.resolve(); await f.close(); }
});

test('HTTP and RPC reject malformed options, tokens, unknown envelope/query/parameters without closing admission', async () => {
  const f = await setup();
  try {
    await root(f); const client = new UIClient(f.config);
    for (const params of [{ notify_completion: 'false' }, { notify_completion: null }, { notify_completion: 0 }, { unknown: false }, { _token: '' }]) {
      expect((await post(f, 'system.interrupt_all', params)).status).not.toBe(200);
    }
    expect((await post(f, 'system.resume_all', { notify_completion: false })).status).not.toBe(200);
    expect((await post(f, 'system.interrupt_all', {}, '?notify_completion=false')).status).not.toBe(200);
    expect((await post(f, 'system.interrupt_all', {}, '', { notify_completion: false })).status).not.toBe(200);
    for (const params of [{ notify_completion: 'false' }, { notify_completion: null }, { extra: false }])
      await expect(client.request('system.interrupt_all', params)).rejects.toThrow();
    expect(f.project.maintenancePaused()).toBe(false);
  } finally { await f.close(); }
});

test('silent completion survives a fresh Store/Project; missing evidence fails closed; pending recovery stays unknown', async () => {
  const f = await setup(); let reopened, store;
  try {
    await root(f); f.project.interruptAll({ notify_completion: false });
    f.project.stopMaintenanceMonitor();
    store = new Store(path.join(f.config.home, 'project.db'), f.root);
    reopened = new Project(f.config, store, { run() { throw new Error('must not invoke'); } });
    reopened.kick = () => {}; reopened.recoverMaintenanceBatch();
    expect(reopened.maintenanceView()).toMatchObject({ paused: true, completion_state: 'completed', notify_completion: false, completion_notice_id: null });
    expect(count(f)).toBe(0);
    const complete = persisted(f); delete complete.notify_completion; save(f, complete);
    expect(() => reopened.maintenanceView()).toThrow('invalid project maintenance batch');
    save(f, { ...complete, notify_completion: false, completion_state: 'pending' });
    reopened.recoverMaintenanceBatch();
    expect(reopened.maintenanceView()).toMatchObject({ completion_state: 'unknown', notify_completion: false, completion_notice_id: null });
    reopened.observeMaintenanceCompletion(); expect(count(f)).toBe(0);
    // Legacy notified batches remain compatible, never inferred as silent.
    save(f, { ...complete, completion_state: 'completed', completion_notice_id: 123 });
    expect(reopened.maintenanceView().notify_completion).toBe(true);
    expect(await hostMaintenance(f)).toMatchObject({ completion_state: 'completed', notify_completion: true, completion_notice_id: 123 });
  } finally {
    if (reopened) await reopened.shutdown(); store?.close(); await f.close();
  }
});

test('real provider failure, dynamic writers and withdrawn batches cannot produce silent success', async () => {
  const f = await setup(); const hold = gate(); let entered = false;
  f.project.provider = { async run() { entered = true; await hold.promise; throw new Error('controlled failure'); } };
  try {
    const task = await root(f); f.project.resumeTask(task.id); await until(() => entered);
    const ack = f.project.interruptAll({ notify_completion: false }); hold.resolve();
    await until(() => !f.project.running.has(task.id));
    expect(f.project.maintenanceView()).toMatchObject({ batch_id: ack.batch_id, completion_state: 'unknown', completion_notice_id: null });
    expect(count(f)).toBe(0);
    f.project.resumeAll(); f.project.writing++;
    const pending = f.project.interruptAll({ notify_completion: false });
    expect(pending).toMatchObject({ completion_state: 'pending', ready_to_restart: false });
    f.project.resumeAll(); f.project.writing--; f.project.observeMaintenanceCompletion();
    expect(f.project.maintenanceView()).toMatchObject({ batch_id: pending.batch_id, completion_state: 'cancelled' });
    expect(count(f)).toBe(0);
    f.project.writing++;
    expect(f.project.interruptAll({ notify_completion: false }).completion_state).toBe('pending');
    f.project.observeMaintenanceCompletion(); expect(f.project.maintenanceView().ready_to_restart).toBe(false);
    f.project.writing--; f.project.observeMaintenanceCompletion();
    expect(f.project.maintenanceView()).toMatchObject({ completion_state: 'completed', completion_notice_id: null,
      notify_completion: false, ready_to_restart: true });
    expect(count(f)).toBe(0);
  } finally { hold.resolve(); await f.close(); }
});

test('real stop_if_idle RPC atomically rechecks current barriers, not silent completion evidence', async () => {
  const f = await setup();
  try {
    await root(f); const client = new UIClient(f.config);
    const value = await client.request('system.interrupt_all', { notify_completion: false });
    expect(value).toMatchObject({ completion_state: 'completed', completion_notice_id: null });
    f.project.writing++;
    await expect(client.request('system.stop_if_idle')).rejects.toThrow('后台操作');
    expect(f.project.stopping).toBe(false); f.project.writing--;
    (f.project.completionBusy ??= new Set()).add(999);
    await expect(client.request('system.stop_if_idle')).rejects.toThrow('自动化');
    expect(f.project.stopping).toBe(false); f.project.completionBusy.delete(999);
    expect(await client.request('system.stop_if_idle')).toEqual({ stopping: true });
    expect(f.project.stopping).toBe(true); expect(count(f)).toBe(0);
  } finally { await f.close(); }
});

test('Host whitelist preserves only explicit silent evidence and fails closed for malformed completed/null', async () => {
  const f = await setup(); const original = f.project.maintenanceView;
  try {
    await root(f); const valid = f.project.interruptAll({ notify_completion: false });
    for (const evidence of [undefined, null, true, 'false', 0]) {
      f.project.maintenanceView = () => ({ ...valid, notify_completion: evidence });
      expect(await hostMaintenance(f)).toBeUndefined();
    }
    f.project.maintenanceView = () => ({ ...valid, secret: 'not display data' });
    const projected = await hostMaintenance(f);
    expect(projected.notify_completion).toBe(false); expect(projected.secret).toBeUndefined();
    f.project.maintenanceView = () => ({ ...valid, notify_completion: undefined, completion_notice_id: 9 });
    expect(await hostMaintenance(f)).toMatchObject({ completion_notice_id: 9, completion_state: 'completed' });
    expect(Object.hasOwn(await hostMaintenance(f), 'notify_completion')).toBe(false);
  } finally { f.project.maintenanceView = original; await f.close(); }
});

test('safe restart flow uses real authenticated HTTP/RPC/Project/Host; only service replacements are controlled', async () => {
  const f = await setup(); const writes = [];
  try {
    const task = await root(f); const controller = new AbortController();
    const result = await safeRestartFlow({ signal: controller.signal, checkPage() {}, confirm: async () => true, recover: async () => true, reload() {},
      request: async (route, options = {}) => {
        if (options.method === 'POST') writes.push([route, JSON.parse(options.body)]);
        if (route === '/api/host') return { restart_supported: true, pid: 777 };
        if (route.endsWith('/api/service/restart')) {
          expect(f.project.maintenanceView()).toMatchObject({ completion_state: 'completed', notify_completion: false, ready_to_restart: true });
          return { restarted: true, project: f.root, pid: 888 };
        }
        if (route === '/api/host/restart') return { restarting: true };
        const response = await fetch(f.url + route, options);
        if (response.status !== 200) throw new Error(await response.text());
        return response.json();
      },
    });
    expect(result.error).toBeUndefined();
    expect(writes.map(([, body]) => body.method).filter(Boolean)).toEqual(['system.interrupt_all', 'system.resume_all']);
    expect(writes[0][1].params).toEqual({ notify_completion: false });
    expect(count(f)).toBe(0); expect(f.store.task(task.id).status).toBe('paused'); // Original personal pause was not started.
    expect(f.project.maintenancePaused()).toBe(false);
  } finally { await f.close(); }
});
