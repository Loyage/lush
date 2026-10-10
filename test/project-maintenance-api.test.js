import { test, expect } from 'bun:test';
import { PARAMS, USER_ONLY, AGENT_ONLY, MANAGER_METHODS, assertAllowed } from '../src/rpc/registry.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { createSignal } from '../src/signal.js';

const maintenance = paused => ({ version: 1, paused, phase: paused ? 'pausing' : 'running',
  ready_to_restart: false, active_calls: 2, pending_operations: 1, affected_count: paused ? 2 : 0,
  blockers: ['等待当前调用安全退出', '等待后台操作安全收尾'] });
const cases = [['system.interrupt_all', 'interruptAll', true], ['system.resume_all', 'resumeAll', false]];

for (const [method, target, paused] of cases) {
  test(`${method} is a no-parameter, user-only method forwarding once to the project`, async () => {
    expect(PARAMS[method]).toEqual([]);
    expect(USER_ONLY.has(method)).toBe(true);
    expect(AGENT_ONLY.has(method)).toBe(false);
    expect(MANAGER_METHODS.has(method)).toBe(false);
    expect(assertAllowed(method, {}, null)).toBeNull();
    const calls = [], signal = createSignal(), result = maintenance(paused);
    const p = { actor: token => token ? 7 : null,
      [target](...args) { calls.push(args); return result; } };
    const d = new Dispatcher(p, signal, {});
    expect(await d.dispatch(method, {})).toEqual(result);
    expect(calls).toEqual([[]]);
    // Repetition is forwarded to the runtime's idempotent operation, not implemented by the adapter.
    expect(await d.dispatch(method)).toEqual(result);
    expect(calls).toEqual([[], []]);
    expect(signal.isRequested()).toBe(false);
    expect(p.stopping).toBeUndefined();
  });

  test(`${method} rejects ordinary and management Agent credentials before any maintenance effect`, async () => {
    const calls = [];
    for (const kind of ['order', 'child', 'management']) {
      const p = { actor: token => token ? 7 : null,
        store: { task: () => ({ role: kind === 'management' ? 'manager' : 'agent', task_kind: kind }) },
        [target]() { calls.push(kind); return maintenance(paused); } };
      await expect(new Dispatcher(p).dispatch(method, { _token: 'live-invocation-token' }))
        .rejects.toThrow('requires user approval');
    }
    const expired = new Dispatcher({ actor() { throw new Error('invalid or expired agent token'); },
      [target]() { calls.push('expired'); } });
    await expect(expired.dispatch(method, { _token: 'expired' })).rejects.toThrow('invalid or expired');
    expect(calls).toEqual([]);
  });

  test(`${method} rejects illegal params and unknown fields before resolving credentials`, async () => {
    let identities = 0, effects = 0;
    const p = { actor() { identities++; return null; }, [target]() { effects++; } };
    const d = new Dispatcher(p);
    for (const params of [null, [], 1, true, 'all', { id: 7 }, { project: '/other' }, { scope: 'device' },
      { force: true }, { profile: {} }, { confirm: true }, { _token: 'live', branch: 'main' }]) {
      await expect(d.dispatch(method, params)).rejects.toThrow();
    }
    expect(identities).toBe(0);
    expect(effects).toBe(0);
  });

  test(`${method} preserves runtime errors and stopping admission without retrying or restarting`, async () => {
    let effects = 0;
    const signal = createSignal(), p = { actor: () => null,
      [target]() { effects++; throw new Error('maintenance guard rejected'); } };
    const d = new Dispatcher(p, signal, {});
    await expect(d.dispatch(method)).rejects.toThrow('maintenance guard rejected');
    expect(effects).toBe(1);
    expect(signal.isRequested()).toBe(false);
    signal.request();
    await expect(d.dispatch(method)).rejects.toThrow('正在停止');
    expect(effects).toBe(1);
  });

  test(`${method} uses the public-result safety filter without dropping the maintenance projection`, async () => {
    const result = { ...maintenance(paused), retry_profile: 'private profile', hooks: 'private hooks', auto_merge: 'private settings' };
    const d = new Dispatcher({ actor: () => null, [target]: () => result });
    expect(await d.dispatch(method)).toEqual(maintenance(paused));
    expect(result.retry_profile).toBe('private profile');
  });
}
