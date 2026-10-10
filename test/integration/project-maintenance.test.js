import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { Config } from '../../src/config.js';
import { UIClient } from '../../src/ui/client.js';
import { projectRouteId } from '../../src/host/registry.js';
import { temp, repo, env } from '../helpers.js';
import { cli, freePort, idle } from './harness.js';
import { fetch } from '../web/harness.js';

const post = async (url, body = {}) => {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); expect(response.status).toBe(200); return result;
};
async function changedHost(url, oldPid) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const response = await fetch(url + '/api/host').catch(() => null);
    if (response?.ok) { const host = await response.json(); if (host.pid !== oldPid) return host; }
    await Bun.sleep(25);
  }
  throw new Error('temporary Host did not restart');
}

// Real temporary daemon + supervised Host processes, with the offline MockProvider only.
test('maintenance survives daemon and Host process replacement, queues new parent/child work and resumes only after explicit continue', async () => {
  const root = temp(), other = temp(), device = temp(), port = freePort();
  const isolated = { LUSH_GLOBAL_CONFIG: device };
  try {
    await Promise.all([repo(root), repo(other)]);
    const [before, untouched] = await Promise.all([cli(root, ['daemon', 'start'], isolated), cli(other, ['daemon', 'start'], isolated)]);
    const client = new UIClient(new Config({ project: root, env: env(isolated) }));
    const web = await cli(root, ['host', 'start', String(port)], isolated), url = `http://127.0.0.1:${port}`;
    const action = (method, params = {}) => post(`${url}/p/${projectRouteId(root)}/api/action`, { method, params });
    expect(await action('system.interrupt_all')).toMatchObject({ paused: true, phase: 'paused', ready_to_restart: true });
    const parent = (await action('order.submit', { content: 'queued during maintenance' })).task;
    const child = await action('worker.spawn', { parent: parent.id, goal: 'child held by project gate' });
    const staged = (await action('order.submit', { content: 'do not begin staged', start: false })).task;
    for (const row of [parent, child]) expect(await client.request('worker.inspect', { id: row.id })).toMatchObject({ status: 'queued', calls: 0 });
    const restarted = await post(url + '/api/service/restart');
    expect(restarted).toMatchObject({ restarted: true, project: root }); expect(restarted.pid).not.toBe(before.pid);
    expect((await client.request('system.summary')).maintenance).toMatchObject({ paused: true, phase: 'paused', ready_to_restart: true });
    expect((await fetch(url + '/api/host').then(r => r.json())).pid).toBe(web.pid);
    expect(await post(url + '/api/host/restart')).toEqual({ restarting: true });
    expect((await changedHost(url, web.pid)).restart_supported).toBe(true);
    expect((await client.request('system.summary')).maintenance.paused).toBe(true);
    for (const row of [parent, child]) expect(await client.request('worker.inspect', { id: row.id })).toMatchObject({ status: 'queued', calls: 0 });
    expect(await client.request('worker.inspect', { id: staged.id })).toMatchObject({ status: 'paused', calls: 0 });
    expect((await cli(other, ['daemon', 'status'], isolated)).pid).toBe(untouched.pid);
    expect(await action('system.resume_all')).toMatchObject({ paused: false });
    expect((await idle(client, parent.id)).calls).toBeGreaterThan(0);
    expect((await client.request('worker.inspect', { id: child.id })).calls).toBe(1);
    expect(await client.request('worker.inspect', { id: staged.id })).toMatchObject({ status: 'paused', calls: 0 });
    expect((await cli(other, ['daemon', 'status'], isolated)).pid).toBe(untouched.pid);
  } finally {
    await cli(root, ['host', 'stop', String(port)], isolated).catch(() => {});
    await Promise.all([cli(root, ['daemon', 'stop'], isolated).catch(() => {}), cli(other, ['daemon', 'stop'], isolated).catch(() => {})]);
    for (const dir of [root, other, device]) fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
