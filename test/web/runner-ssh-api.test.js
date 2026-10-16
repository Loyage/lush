import { test, expect } from 'bun:test';
import { startTestWeb, fetch } from './auth-fixture.js';
import { DeviceSettingsService } from '../../src/host/device-settings.js';
import { managementFixture } from '../runner-management-fixture.js';
import { sshFixture } from '../runner-ssh-fixture.js';
const post = (url, method, params, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method, params }) });

test('authenticated unselected Host HTTP → shared registry → device service → controlled SSH; no project startup, save, secret response or implicit network', async () => {
  const f = await managementFixture(), ssh = sshFixture(f.root); let opened = 0;
  ssh.config('Host fixture\nHostName private-host.example\nMatch exec "private-command"\n');
  const device = new DeviceSettingsService(f.config.env, { runner: { ssh: ssh.options } });
  const web = startTestWeb(null, 0, { env: f.config.env, deviceSettingsService: device, openProject: async () => { opened++; throw new Error('unexpected open'); } });
  const base = `http://127.0.0.1:${web.port}`, read = `${base}/api/host/settings/runner/ssh/aliases`, action = `${base}/api/host/settings/action`;
  try {
    const response = await fetch(read); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ aliases: ['fixture'], status: 'ok', limited: true }); expect(ssh.calls()).toBe(0);
    const unsupported = await post(action, 'runner.ssh.test', { ssh_alias: 'fixture' }); expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toMatchObject({ ok: false, reason: 'config_unsupported' }); expect(ssh.calls()).toBe(0);
    ssh.config('Host fixture\nHostName private-host.example\n');
    const trial = await post(action, 'runner.ssh.test', { ssh_alias: 'fixture' }); expect(trial.status).toBe(200);
    const result = await trial.json(); expect(result).toMatchObject({ ok: true, reason: 'connected' }); expect(JSON.stringify(result)).not.toMatch(/private-|config/);
    const failed = await post(action, 'runner.ssh.test', { ssh_alias: 'fail' }); expect(failed.status).toBe(200); expect(await failed.json()).toMatchObject({ ok: false, reason: 'not_confirmed' });
    for (const params of [{ ssh_alias: 'fixture', path: '/' }, { ssh_alias: '-oProxyCommand=bad' }, { ssh_alias: 'fixture', _token: 'agent' }, { ssh_alias: 'fixture', scope: 'project' }]) expect((await post(action, 'runner.ssh.test', params)).status).toBe(400);
    expect((await fetch(read + '?path=/etc/ssh/config')).status).toBe(400);
    expect((await fetch(read, { anonymous: true })).status).toBe(401);
    expect((await post(action, 'runner.ssh.test', { ssh_alias: 'fixture' }, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect(ssh.calls()).toBe(2); expect(opened).toBe(0);
    expect((await device.request('runner.nodes.get')).nodes).toEqual([]); expect((await device.request('runner.credentials.get')).nodes).toEqual([]);
    expect(f.store.runnerProject().project_id).toBeNull();
  } finally { await web.stop(true); await f.close(); }
});

test('project HTTP SSH reads/actions forward through authenticated real RPC with strict envelopes and user-only permissions', async () => {
  const f = await managementFixture(), ssh = sshFixture(f.root); f.project.runnerOptions = { ssh: ssh.options };
  ssh.config('Host fixture\n');
  const web = startTestWeb(f.config), base = `http://127.0.0.1:${web.port}`;
  try {
    expect(await (await fetch(`${base}/api/runner/ssh/aliases`)).json()).toMatchObject({ aliases: ['fixture'] }); expect(ssh.calls()).toBe(0);
    expect(await (await post(`${base}/api/action`, 'runner.ssh.test', { ssh_alias: 'fixture' })).json()).toMatchObject({ ok: true });
    expect((await fetch(`${base}/api/runner/ssh/aliases?scope=device`)).status).toBe(400);
    expect((await post(`${base}/api/action`, 'runner.ssh.test', { ssh_alias: 'fixture', _token: 'agent' })).status).toBe(400);
    expect((await post(`${base}/api/action?q=x`, 'runner.ssh.test', { ssh_alias: 'fixture' })).status).toBe(400);
    expect(ssh.calls()).toBe(1);
  } finally { await web.stop(true); await f.close(); }
});
