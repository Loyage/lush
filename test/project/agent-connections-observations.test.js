import { ConnectionFile } from '../../src/agent/connections-file.js';
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, gate } from '../helpers.js';
import { AgentConnectionsService } from '../../src/core/agent-connections.js';
import { DeviceSettingsService } from '../../src/host/device-settings.js';

const connection = { label: 'shared', provider: 'deepseek', auth_type: 'api_key', models: [] };
const balance = value => Response.json({ balance_infos: [{ currency: 'USD', total_balance: value }] });
const writable = ({ credential, storage_scope, ...row }) => row;
function setup(fetch) {
  const f = fixture();
  f.project.agentConnections = new AgentConnectionsService(f.project, { managerOptions: { fetch } });
  return { ...f, service: f.project.agentConnections };
}

test('Host and projects read one persistent device observation without refreshing or copying project history', async () => {
  let calls = 0;
  const a = setup(async () => { calls++; return balance(12); }), b = setup(async () => { throw new Error('read must not query'); });
  b.config.deviceHome = a.config.deviceHome;
  const host = new DeviceSettingsService(a.config.env, { connections: { fetch: async () => { calls++; return balance(24); } } });
  let restarted;
  try {
    expect(host.config.home).toBe(a.config.deviceHome);
    const row = await host.request('agent.connections.save', { connection, credential: { api_key: 'PRIVATE-SHARED-KEY' } });
    await host.request('agent.connections.query', { id: row.id });
    expect(a.service.list().connections[0].observation.resources[0].remaining).toBe(24);
    expect(b.service.forScope('device').list().connections[0].observation.resources[0].remaining).toBe(24);
    expect(a.service.history(row.id).series).toEqual([]);
    await a.service.query(row.id);
    const cached = b.service.list().connections[0];
    expect(cached.observation.resources[0].remaining).toBe(12);
    expect(cached.consumers).toEqual([]);
    expect(b.service.history(row.id).series).toEqual([]);
    expect(a.service.history(row.id).series).toHaveLength(1);
    await host.stop();
    restarted = new DeviceSettingsService(a.config.env);
    const list = await restarted.request('agent.connections.list');
    expect(list.connections[0].observation).toEqual(cached.observation);
    expect(list.history_available).toBe(false);
    expect(calls).toBe(2);
    const file = path.join(a.config.deviceHome, 'credentials', 'agent-connection-observations.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('PRIVATE-SHARED-KEY');
    expect(JSON.stringify(list)).not.toContain('PRIVATE-SHARED-KEY');
    // A separate process sees the file directly, not a daemon/Host memory map.
    const child = Bun.spawn([process.execPath, '--eval', `import { DeviceSettingsService } from './src/host/device-settings.js';
      const s = new DeviceSettingsService(process.env); console.log(JSON.stringify(await s.request('agent.connections.list'))); await s.stop();`],
    { cwd: process.cwd(), env: a.config.env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(''); expect(exit).toBe(0);
    expect(JSON.parse(stdout).connections[0].observation).toEqual(cached.observation);
  } finally { await restarted?.stop(); await host.stop(); await b.close(); await a.close(); }
});

test('shared failures retain old success across projects; credential changes and local shadows never reuse device values', async () => {
  let fail = false;
  const a = setup(async () => fail ? new Response('', { status: 503 }) : balance(12)), b = setup(async () => balance(99));
  b.config.deviceHome = a.config.deviceHome;
  try {
    const device = a.service.forScope('device'), row = await device.save(connection, { api_key: 'PRIVATE-OLD-KEY' });
    await device.query(row.id); fail = true; await device.query(row.id);
    const failed = b.service.list().connections[0];
    expect(failed.observation.status).toBe('error');
    expect(failed.observation.resources).toEqual([]);
    expect(failed.last_success.observation.resources[0].remaining).toBe(12);
    // Default-model / display edits do not change the observation identity.
    await device.save({ ...writable(row), label: 'Renamed', default_model: 'deepseek-chat' });
    expect(b.service.list().connections[0].last_success).toEqual(failed.last_success);
    await device.save({ ...writable(row), label: 'New account' }, { api_key: 'PRIVATE-NEW-KEY' });
    expect(b.service.list().connections[0]).toMatchObject({ observation: { status: 'unknown' }, last_success: null });
    const source = device.getManager().file.read().connections[0];
    new ConnectionFile(b.config.home).transaction(data => { data.connections.push({ ...source, credential: { type: 'api_key', key: 'PRIVATE-LOCAL-KEY' } }); });
    await b.service.query(row.id);
    expect(b.service.list().connections[0].observation.resources[0].remaining).toBe(99);
    expect(b.service.forScope('device').list().connections[0].observation.resources[0].remaining).toBe(99);
    expect(a.service.list().connections[0].observation.resources[0].remaining).toBe(99);
  } finally { await b.close(); await a.close(); }
});

test('passive response observations are device-shared while history stays in the producing project', async () => {
  const a = setup(async () => balance(12)), b = setup(async () => { throw new Error('no network'); });
  b.config.deviceHome = a.config.deviceHome;
  try {
    const row = await a.service.forScope('device').save(connection, { api_key: 'PRIVATE-KEY' });
    const runtime = await a.service.prepareRuntime(row.id);
    await a.service.observe(row.id, runtime.account_key, runtime.source_key, { status: 'available', source: 'response_headers',
      checked_at: new Date().toISOString(), resources: [{ id: 'window', kind: 'quota', scope: 'account', used_percent: 15 }] });
    expect(b.service.list().connections[0].observation).toMatchObject({ status: 'available', source: 'response_headers', resources: [{ used_percent: 15 }] });
    expect(b.service.history(row.id).series).toEqual([]);
    expect(a.service.history(row.id).series).toHaveLength(1);
  } finally { await b.close(); await a.close(); }
});

test('a query completed after another project replaces the account cannot publish an old device observation', async () => {
  const entered = gate(), release = gate();
  const a = setup(async () => { entered.resolve(); await release.promise; return balance(12); }), b = setup(async () => balance(99));
  b.config.deviceHome = a.config.deviceHome;
  try {
    const row = await a.service.forScope('device').save(connection, { api_key: 'PRIVATE-OLD' });
    const pending = a.service.query(row.id); await entered.promise;
    await b.service.forScope('device').save(writable(row), { api_key: 'PRIVATE-NEW' });
    await b.service.query(row.id); release.resolve(); await pending;
    expect(a.service.list().connections[0].observation.resources[0].remaining).toBe(99);
    expect(a.service.history(row.id).series).toEqual([]);
  } finally { release.resolve(); await b.close(); await a.close(); }
});
