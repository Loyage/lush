import { test, expect } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { fixture, gate } from '../helpers.js';
import { ConnectionFile } from '../../src/agent/connections-file.js';
import { AgentConnectionsService } from '../../src/core/agent-connections.js';

const connection = { label: 'Shared account', provider: 'deepseek', auth_type: 'api_key', models: [] };
const balance = value => Response.json({ balance_infos: [{ currency: 'USD', total_balance: value }] });
const writable = ({ credential, storage_scope, ...value }) => value;
function setup(options = {}) {
  const f = fixture(); f.config.deviceHome = path.join(f.root, 'device', 'shared');
  f.project.agentConnections = new AgentConnectionsService(f.project, options);
  return { ...f, service: f.project.agentConnections };
}

test('scoped service shares configuration and latest observations across projects while consumers and history remain project-local', async () => {
  const a = setup({ managerOptions: { fetch: async () => balance(12) } }), b = setup({ managerOptions: { fetch: async () => balance(99) } });
  b.config.deviceHome = a.config.deviceHome;
  try {
    const device = a.service.forScope('device');
    const row = await device.save(connection, { api_key: 'shared-key-secret' });
    expect(a.service.forScope('device')).toBe(device);
    expect(() => device.forScope('project')).toThrow('no longer');
    expect(b.service.list().connections[0]).toMatchObject({ id: row.id, storage_scope: 'device', observation: { status: 'unknown' } });
    await a.service.query(row.id);
    expect(a.service.list().connections[0].observation.resources[0].remaining).toBe(12);
    expect(b.service.list().connections[0].observation.resources[0].remaining).toBe(12);
    expect(b.service.history(row.id).series).toEqual([]);
    expect(a.service.history(row.id).series).toHaveLength(1);
    const runtime = await a.service.prepareRuntime(row.id);
    a.project.running.set(456, { agent: { model: 'deepseek/deepseek-chat' }, connectionBinding: { id: row.id,
      account_key: runtime.account_key, source_key: runtime.source_key } });
    expect(device.list().connections[0].consumers).toEqual([{ task_id: 456, task_worker_number: null, model: 'deepseek/deepseek-chat' }]);
    expect(b.service.list().connections[0].consumers).toEqual([]);
    a.project.running.delete(456);
    expect(JSON.stringify(device.list())).not.toContain('shared-key-secret');
    expect(a.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(0);
  } finally { a.project.running.clear(); await b.close(); await a.close(); }
});

test('device edits apply to the sole runtime source, ignoring same-UUID legacy credentials', async () => {
  const f = setup({ managerOptions: { fetch: async () => balance(12) } });
  try {
    const device = f.service.forScope('device'), shared = await device.save(connection, { api_key: 'shared-key-secret' });
    const file = new ConnectionFile(f.config.home);
    file.transaction(data => { data.connections.push({ ...device.getManager().file.read().connections[0], credential: { type: 'api_key', key: 'local-key-secret' } }); });
    const before = fs.readFileSync(file.file), prepared = await f.service.prepareRuntime(shared.id);
    expect(prepared.credential.key).toBe('shared-key-secret');
    f.project.running.set(123, { agent: { model: 'deepseek/deepseek-chat' }, connectionBinding: { id: shared.id,
      account_key: prepared.account_key, source_key: prepared.source_key } });
    await device.query(shared.id);
    expect(device.list().connections[0].consumers).toEqual([{ task_id: 123, task_worker_number: null, model: 'deepseek/deepseek-chat' }]);
    await device.save({ ...writable(shared), label: 'Shared renamed' }); expect(f.service.list().connections[0].label).toBe('Shared renamed');
    await device.remove(shared.id); expect(f.service.list().connections).toEqual([]);
    expect(fs.readFileSync(file.file)).toEqual(before);
  } finally { f.project.running.clear(); await f.close(); }
});

test('inheriting projects refresh shared sampling on subsequent source reads without duplicating scoped timers', async () => {
  let next = 0; const pending = new Set();
  const timerOptions = { setTimeout: () => { const timer = { id: ++next, unref() {} }; pending.add(timer); return timer; },
    clearTimeout: timer => pending.delete(timer) };
  const a = setup(timerOptions), b = setup(timerOptions); b.config.deviceHome = a.config.deviceHome;
  try {
    a.service.start(); b.service.start();
    expect(b.service.timer).toBeNull();
    const device = a.service.forScope('device');
    await device.configureSampling({ enabled: true, interval_minutes: 10, retention_days: 90 });
    expect(a.service.timer).not.toBeNull(); expect(device).toBe(a.service);
    expect(b.service.timer).toBeNull();
    b.service.list(); const first = b.service.timer;
    expect(first).not.toBeNull();
    b.service.list(); expect(b.service.timer).toBe(first);
    await device.configureSampling({ enabled: false, interval_minutes: 10, retention_days: 90 });
    b.service.list(); expect(b.service.timer).toBeNull(); expect(pending.has(first)).toBe(false);
  } finally { await b.close(); await a.close(); }
  expect(pending.size).toBe(0);
});

test('device retention applies to project-local historical observations', async () => {
  const f = setup(), seen = []; const now = Date.UTC(2026, 9, 7);
  try {
    f.service.getManager().file.transaction(data => { data.sampling.retention_days = 90; });
    const device = f.service.forScope('device'); device.now = () => now;
    f.store.pruneAgentConnections = cutoff => seen.push(cutoff);
    await device.configureSampling({ enabled: false, interval_minutes: 10, retention_days: 1 });
    expect(seen).toEqual([new Date(now - 1 * 86400000).toISOString()]);
    expect(f.service.config().sampling.retention_days).toBe(1);
    expect(device.config().sampling.retention_days).toBe(1);
  } finally { await f.close(); }
});

test('device sampling save is not failed by a malformed local source override after publishing shared defaults', async () => {
  const f = setup();
  try {
    const device = f.service.forScope('device');
    const credentials = path.join(f.config.home, 'credentials'); fs.mkdirSync(credentials, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(credentials, 'agent-connections.json'), '{PRIVATE-INVALID', { mode: 0o600 });
    const policy = { enabled: false, interval_minutes: 10, retention_days: 90 };
    expect(await device.configureSampling(policy)).toEqual(policy);
    expect(device.config().sampling).toEqual(policy);
    expect(f.service.warning).toBeNull();
  } finally { await f.close(); }
});

test('scoped editors do not add duplicate sampling timers, and stopping closes all pending services', async () => {
  const entered = gate(), release = gate(), timers = new Set();
  const f = setup({ setTimeout: () => { const timer = { unref() {} }; timers.add(timer); return timer; }, clearTimeout: timer => timers.delete(timer), managerOptions: {
    fetch: async () => { entered.resolve(); await release.promise; return balance(12); }
  } });
  try {
    const device = f.service.forScope('device');
    const row = await device.save(connection, { api_key: 'shared-key-secret' });
    await device.configureSampling({ enabled: true, interval_minutes: 10, retention_days: 90 });
    device.start(); const initial = timers.size;
    device.start(); expect(timers.size).toBe(initial);
    expect(device.started).toBe(true); expect(device.timer).not.toBeNull();
    const query = device.query(row.id); await entered.promise;
    expect(f.service.isBusy()).toBeTruthy();
    const stopping = f.service.stop(); release.resolve();
    await stopping; await expect(query).rejects.toThrow();
    expect(device.closed).toBe(true); expect(device.getManager().closed).toBe(true); expect(timers.size).toBe(0);
    expect(() => f.service.forScope('device')).toThrow('project is stopping');
    expect(fs.existsSync(path.join(f.config.home, 'credentials', 'agent-connections.json'))).toBe(false);
  } finally { release.resolve(); await f.close(); }
});
