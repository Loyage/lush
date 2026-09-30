import { test, expect } from 'bun:test';
import { fixture, gate } from './helpers.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { createSignal } from '../src/signal.js';
import { assertAllowed } from '../src/rpc/registry.js';

const dispatcher = f => {
  const signal = createSignal();
  return { signal, rpc: new Dispatcher(f.project, signal, {}) };
};

test('idle stop atomically closes scheduling and RPC admission without changing tasks', async () => {
  const f = fixture();
  try {
    const { rpc, signal } = dispatcher(f);
    expect(await rpc.dispatch('system.stop_if_idle')).toEqual({ stopping: true });
    expect(signal.isRequested()).toBe(true);
    expect(f.project.stopping).toBe(true);
    f.project.kick();
    expect(f.project.scheduled).toBe(false);
    await expect(rpc.dispatch('say.submit', { content: 'must not start' })).rejects.toThrow('正在停止');
    await expect(rpc.dispatch('system.stop_if_idle')).rejects.toThrow('正在停止');
    expect(await rpc.dispatch('system.summary')).toBeObject();
  } finally { await f.close(); }
});

test('active calls, parked unwinding calls, model requests and merge drivers reject idle stop', async () => {
  const f = fixture();
  try {
    const { rpc, signal } = dispatcher(f);
    for (const run of [{}, { parked: true }]) {
      f.project.running.set(1, run);
      await expect(rpc.dispatch('system.stop_if_idle')).rejects.toThrow('活动 Agent');
      f.project.running.clear();
    }
    f.project.introRunning.set(1, {});
    await expect(rpc.dispatch('system.stop_if_idle')).rejects.toThrow('模型调用');
    f.project.introRunning.clear();
    for (const key of ['taskMergeBusy', 'mergeRunsDriving', 'integratingIntents']) {
      f.project[key] ??= new Set(); f.project[key].add(1);
      await expect(rpc.dispatch('system.stop_if_idle')).rejects.toThrow('后台操作');
      f.project[key].clear();
    }
    f.project.writing = 1;
    await expect(rpc.dispatch('system.stop_if_idle')).rejects.toThrow('后台操作');
    f.project.writing = 0;
    expect(signal.isRequested()).toBe(false);
    expect(f.project.stopping).toBe(false);
  } finally { f.project.running.clear(); f.project.introRunning.clear(); await f.close(); }
});

test('queued and executing Git work prevents idle stop; rejected Git releases admission', async () => {
  const f = fixture(), g = gate();
  try {
    const { rpc, signal } = dispatcher(f);
    const work = f.project.workspaces.exclusive(() => g.promise);
    expect(f.project.workspaces.pending).toBe(1);
    await expect(rpc.dispatch('system.stop_if_idle')).rejects.toThrow('Git');
    expect(signal.isRequested()).toBe(false);
    g.resolve(); await work;
    expect(f.project.workspaces.pending).toBe(0);
    await expect(f.project.workspaces.exclusive(() => { throw new Error('git failed'); })).rejects.toThrow('git failed');
    expect(f.project.workspaces.pending).toBe(0);
    expect(await rpc.dispatch('system.stop_if_idle')).toEqual({ stopping: true });
  } finally { g.resolve(); await f.close(); }
});

test('idle shutdown is user-only and has no parameters', () => {
  expect(() => assertAllowed('system.stop_if_idle', {}, { id: 1 })).toThrow('requires user approval');
  expect(() => assertAllowed('system.stop_if_idle', { force: true }, null)).toThrow('unknown parameter');
});
