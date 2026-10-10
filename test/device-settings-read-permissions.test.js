import { test, expect } from 'bun:test';
import { assertAllowed, USER_ONLY } from '../src/rpc/registry.js';

const reads = [
  ['agent.config', {}],
  ['agent.models', { agent: 'pi' }],
  ['agent.resources', {}],
];

test('device-backed Agent configuration, models and resource reads are user-only even without scope', () => {
  for (const [method, params] of reads) {
    expect(USER_ONLY.has(method)).toBe(true);
    expect(assertAllowed(method, params, null)).toBeNull();
    expect(assertAllowed(method, { ...params, scope: 'device' }, null)).toBeNull();
    expect(() => assertAllowed(method, params, 42)).toThrow('requires user approval');
    expect(() => assertAllowed(method, { ...params, scope: 'device' }, 42)).toThrow('user approval');
    expect(() => assertAllowed(method, { ...params, _token: 'invocation-token' }, () => 42)).toThrow('requires user approval');
    // Explicit legacy scope cannot serve as a permission bypass. The new
    // configuration layer may additionally reject project scope altogether.
    expect(() => assertAllowed(method, { ...params, scope: 'project' }, 42)).toThrow();
  }
});

test('the device read restriction does not close ordinary Worker summaries or project Notice read surfaces', () => {
  for (const [method, params] of [
    ['worker.inspect', { id: 1 }],
    ['worker.list', { after: 0, limit: 10 }],
    ['worker.lookup', { number: 'W1' }],
    ['notice.list', {}],
    ['notice.page', { status: 'all', limit: 30 }],
  ]) {
    expect(assertAllowed(method, params, 42)).toBe(42);
    expect(assertAllowed(method, params, null)).toBeNull();
  }
  expect(() => assertAllowed('notice.sync', {}, 42)).toThrow('requires user approval');
  expect(() => assertAllowed('worker.run_settings', { id: 1 }, 42)).toThrow('requires user approval');
});
