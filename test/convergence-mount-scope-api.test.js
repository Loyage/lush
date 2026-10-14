import { test, expect } from 'bun:test';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { run as branch } from '../src/cli/commands/branch.js';
import { validateManagementCall } from '../src/rpc/management-policy.js';

const revision = 'opaque-read-revision';
test('optional scope RPC is registered, validated and forwarded without changing omission compatibility or permissions', async () => {
  const calls = [], rpc = new Dispatcher({ actor: token => token ? 7 : null, setBranchConvergenceDefaults(...args) { calls.push(args); return { version: 1 }; } });
  for (const scope of ['main','all','user','none']) {
    const params = { mounted: scope !== 'none', enabled: false, scope, expected_revision: revision };
    await rpc.dispatch('branch.convergence_defaults_set', params);
    expect(validateManagementCall('branch.convergence_defaults_set', params, 'project defaults').access).toBe('confirmation');
    await expect(rpc.dispatch('branch.convergence_defaults_set', { ...params, _token: 'agent' })).rejects.toThrow('requires user approval');
  }
  expect(calls).toEqual(['main','all','user','none'].map(scope => [scope !== 'none', false, revision, scope]));
  for (const scope of [null, 1, {}, [], 'device', 'user '])
    await expect(rpc.dispatch('branch.convergence_defaults_set', { mounted: true, enabled: false, scope, expected_revision: revision })).rejects.toThrow('scope');
  await expect(rpc.dispatch('branch.convergence_defaults_set', { mounted: false, enabled: false, scope: 'user', expected_revision: revision })).rejects.toThrow('match scope');
  expect(calls).toHaveLength(4);
});

test('CLI accepts optional scoped future defaults but rejects inconsistent, duplicate or foreign values before RPC', async () => {
  const calls = [], client = { request(method, params) { calls.push({ method, params }); } };
  const args = scope => ['convergence','defaults','set','--mounted', String(scope !== 'none'), '--enabled','false','--scope',scope,'--revision',revision];
  for (const scope of ['main','all','user','none']) await branch('branch', args(scope), { client, json: true });
  expect(calls).toEqual(['main','all','user','none'].map(scope => ({ method: 'branch.convergence_defaults_set',
    params: { mounted: scope !== 'none', enabled: false, expected_revision: revision, scope } })));
  for (const input of [args('device'), [...args('user'), '--scope','all'], args('user').map(value => value === 'true' ? 'false' : value),
    ['convergence','defaults','set','--mounted','true','--enabled','false','--scope','--revision',revision]])
    await expect(branch('branch', input, { client, json: true })).rejects.toThrow();
  expect(calls).toHaveLength(4);
});
