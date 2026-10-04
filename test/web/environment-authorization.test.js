import { test, expect } from 'bun:test';
import { createEnvironmentManager } from '../../src/host/environments.js';
import { gate } from '../helpers.js';
const ID = 'abcdef0123456789abcdef0123456789';
function fixture(options = {}) {
  let connected = false, now = 1000;
  const disconnects = [], calls = [];
  const profile = { id: ID, alias: 'dev' };
  const manager = { list: () => [{ ...profile, url: 'http://127.0.0.1:42424/', connected }],
    async inspect() { return { profile, ready: false, requiresInstall: true, plan: { alias: 'dev' }, warnings: [] }; },
    async connect(input) { calls.push(input); await options.connect?.(); connected = true; return { profile }; },
    disconnect(id) { disconnects.push(id); connected = false; }, dispose() { connected = false; } };
  const env = createEnvironmentManager({ scope: { home: '/not-used-in-fixture' }, env: {}, sshManager: manager,
    readConfig: () => ({ hosts: [], warnings: [] }), now: () => now, planTtlMs: 100 });
  return { env, disconnects, calls, expire: () => { now += 101; } };
}

test('cancel in-flight connect retains ownership, rejects late result and prevents tunnel exposure', async () => {
  const g = gate(), f = fixture({ connect: () => g.promise });
  try {
    const preview = await f.env.inspect('session', { alias: 'dev' });
    const pending = f.env.connect('session', { confirmation: preview.confirmation, install: true });
    f.env.cancel('session');
    expect(f.disconnects).toEqual([ID]);
    await expect(f.env.inspect('other-session', { alias: 'dev' })).rejects.toThrow('正在操作');
    g.resolve();
    await expect(pending).rejects.toThrow('已取消');
    expect(() => f.env.endpoint(ID)).toThrow('未连接');
    await expect(f.env.connect('session', { confirmation: preview.confirmation, install: true })).rejects.toThrow('一次性');
  } finally { g.resolve(); f.env.dispose(); }
});

test('ready confirmation expires; abandoning a plan does not disconnect a live environment', async () => {
  const f = fixture();
  try {
    let preview = await f.env.inspect('session', { alias: 'dev' });
    f.expire();
    await expect(f.env.connect('session', { confirmation: preview.confirmation, install: true })).rejects.toThrow('一次性');
    expect(f.calls).toEqual([]);
    preview = await f.env.inspect('session', { alias: 'dev' });
    await f.env.connect('session', { confirmation: preview.confirmation, install: true });
    await f.env.inspect('session', { alias: 'dev' });
    f.env.cancel('session');
    expect(f.disconnects).toEqual([]);
    expect(f.env.endpoint(ID)).toBe('http://127.0.0.1:42424');
  } finally { f.env.dispose(); }
});

test('plans cannot cross sessions and simultaneous profile operations cannot share cancellation ownership', async () => {
  const g = gate(), f = fixture({ connect: () => g.promise });
  try {
    const a = await f.env.inspect('a', { alias: 'dev' });
    const b = await f.env.inspect('b', { alias: 'dev' });
    await expect(f.env.connect('b', { confirmation: a.confirmation, install: true })).rejects.toThrow('一次性');
    const pending = f.env.connect('a', { confirmation: a.confirmation, install: true });
    await expect(f.env.connect('b', { confirmation: b.confirmation, install: true })).rejects.toThrow('正在操作');
    f.env.cancel('b');
    expect(f.disconnects).toEqual([]);
    g.resolve(); await pending;
    expect(f.calls).toHaveLength(1);
  } finally { g.resolve(); f.env.dispose(); }
});
