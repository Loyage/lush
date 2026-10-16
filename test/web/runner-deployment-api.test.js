import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { startTestWeb, fetch } from './auth-fixture.js';
import { DeviceSettingsService } from '../../src/host/device-settings.js';
import { deploymentApiFixture, deploymentRequests } from '../runner-deployment-api-fixture.js';

const post = (url, method, params, options = {}) => fetch(url, { method: 'POST', ...options,
  headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify({ method, params }) });

test('authenticated Project and unselected Host HTTP -> real deployment service -> controlled SSH yields blocked, all later write entrypoints refuse without fabricating a Runner', async () => {
  const f = await deploymentApiFixture(); let opened = 0;
  const device = new DeviceSettingsService(f.config.env, { runner: f.runnerOptions });
  const project = startTestWeb(f.config), host = startTestWeb(null, 0, { env: f.config.env, deviceSettingsService: device,
    openProject: async () => { opened++; throw Error('Unexpected project startup'); } });
  const urls = [`http://127.0.0.1:${project.port}/api/action`, `http://127.0.0.1:${host.port}/api/host/settings/action`];
  try {
    for (const [index, url] of urls.entries()) {
      const response = await post(url, 'runner.deployments.plan', deploymentRequests['runner.deployments.plan']);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text(), planned = JSON.parse(text); expect(planned.status).toBe('blocked'); expect(planned.plan.supported).toBe(false);
      expect(planned.plan.blockers.some(b => b.code.startsWith('cgroup_'))).toBe(true); expect(planned.node_id).toBeUndefined();
      expect(f.remote.records).toHaveLength(index + 1); expect(f.cleanups).toBe(index + 1);
      for (const secret of ['private_data', 'fixture.invalid', f.plans.store.read(planned.id).private_data.remote.machine_id]) expect(text).not.toContain(secret);
      for (const method of Object.keys(deploymentRequests).filter(m => !['runner.deployments.plan', 'runner.deployments.reconcile'].includes(m))) {
        const params = { ...deploymentRequests[method], id: planned.id, expected_revision: planned.revision,
          ...(method === 'runner.deployments.apply' ? { approved_actions: planned.plan.actions.map(a => a.id) } : {}) };
        expect((await post(url, method, params)).status).toBe(400); expect(f.remote.records).toHaveLength(index + 1);
      }
      const observed = await post(url, 'runner.deployments.reconcile', { id: planned.id, expected_revision: planned.revision });
      expect(observed.status).toBe(200); expect(await observed.json()).toMatchObject({ status: 'blocked', observation: { status: 'complete' } });
      expect(f.remote.records).toHaveLength(index + 1);
    }
    expect(f.connections()).toBe(0); expect(opened).toBe(0); expect(f.builds).toBe(2); expect(fs.readdirSync(f.remote.home)).toEqual([]);
    expect(f.project.runners.readNodes().nodes).toEqual([]); expect(f.project.runners.readCredentials().nodes).toEqual([]);
    expect(f.store.runnerProject().project_id).toBeNull(); expect(f.project.writing).toBe(0);
  } finally { await project.stop(true); await host.stop(true); await device.stop(); await f.close(); }
});

test('every deployment HTTP mutation rejects anonymous, cross-origin, ambient parameters, envelope/query injection and GET before any artifact or SSH', async () => {
  const f = await deploymentApiFixture(); let opened = 0;
  const device = new DeviceSettingsService(f.config.env, { runner: f.runnerOptions });
  const project = startTestWeb(f.config), host = startTestWeb(null, 0, { env: f.config.env, deviceSettingsService: device,
    openProject: async () => { opened++; throw Error('Unexpected project startup'); } });
  const urls = [`http://127.0.0.1:${project.port}/api/action`, `http://127.0.0.1:${host.port}/api/host/settings/action`];
  try {
    for (const [method, params] of Object.entries(deploymentRequests)) for (const url of urls) {
      expect((await post(url, method, params, { anonymous: true })).status).toBe(401);
      expect((await post(url, method, params, { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403);
      for (const patch of [{ _token: null }, { command: 'PRIVATE' }, { force: true }, { runtime_generation: {} }]) expect((await post(url, method, { ...params, ...patch })).status).toBe(400);
      expect((await post(url + '?scope=device', method, params)).status).toBe(400);
      const envelope = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, private: 'PRIVATE' }) });
      expect(envelope.status).toBe(400);
      const get = url.includes('/host/') ? url.replace('/action', '/' + method.slice('runner.'.length).replaceAll('.', '/')) : url.replace('/action', '/runner/' + method.slice('runner.'.length).replaceAll('.', '/'));
      expect((await fetch(get)).status).toBe(404);
    }
    expect(f.builds).toBe(0); expect(f.remote.records).toEqual([]); expect(f.deployments.list().items).toEqual([]); expect(f.connections()).toBe(0); expect(opened).toBe(0);
  } finally { await project.stop(true); await host.stop(true); await device.stop(); await f.close(); }
});
