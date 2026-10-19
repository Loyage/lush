import { test, expect } from 'bun:test';
import { fetch, setup } from './harness.js';
import { gate, repo, until } from '../helpers.js';
import { attachRegisteredHook } from '../hook-registry.js';
import { UIClient } from '../../src/ui/client.js';
import { safeRestartFlow } from '../../src/ui/web/assets/safe-restart-flow.js';

const post = (f, method, params = {}, suffix = '', envelope = {}) => fetch(f.url + '/api/action' + suffix, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, ...envelope }),
});
const count = f => f.store.get("SELECT count(*) AS n FROM notices WHERE title='项目中断完成'").n;
const persisted = f => JSON.parse(f.store.get("SELECT value FROM meta WHERE key='project_maintenance'").value);
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
    const completionMount = JSON.parse(f.store.task(task.id).hooks).mounts.find(mount => mount.signal_binding?.batch_id === ack.batch_id);
    expect(completionMount).toMatchObject({ registry_id: 'system:interruption-notice', registry_version: 1 });
    expect(f.project.hooksList().registry.items.find(item => item.id === completionMount.registry_id)).toMatchObject({ readonly: true });
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
