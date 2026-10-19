import { test, expect } from 'bun:test';
import { runPackages } from '../../src/cli/commands/agent-packages.js';

test('agent packages maps verbs onto narrow user-only RPCs', async () => {
  const calls = [], view = { version: 1, packages: [], resources: { extensions: [], skills: [] }, truncated: false };
  const client = { request: async (method, params) => { calls.push({ method, params }); return view; } };
  const execute = args => runPackages(args, { client, json: true });
  expect(await execute(['list'])).toEqual(view);
  await execute(['install', 'npm:@scope/tools@1.0.0']);
  await execute(['update', 'pkg-0123456789abcdef']);
  await execute(['remove', 'pkg-0123456789abcdef']);
  expect(calls).toEqual([
    { method: 'agent.packages.list', params: {} },
    { method: 'agent.packages.install', params: { source: 'npm:@scope/tools@1.0.0' } },
    { method: 'agent.packages.update', params: { id: 'pkg-0123456789abcdef' } },
    { method: 'agent.packages.remove', params: { id: 'pkg-0123456789abcdef' } },
  ]);
});
