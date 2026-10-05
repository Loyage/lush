import { test, expect } from 'bun:test';
import { runPackages } from '../../src/cli/commands/agent-packages.js';

const view = () => ({ version: 1, packages: [], resources: { extensions: [], skills: [] }, truncated: false });

function fixture() {
  const calls = [];
  const client = { request: async (method, params) => { calls.push({ method, params }); return view(); } };
  return { calls, client, execute: (args, json = true) => runPackages([...args], { client, json }) };
}

test('agent packages maps verbs onto narrow user-only RPCs', async () => {
  const f = fixture();
  expect(await f.execute(['list'])).toEqual(view());
  expect(await f.execute([])).toEqual(view());
  await f.execute(['install', 'npm:@scope/tools@1.0.0']);
  await f.execute(['remove', 'pkg-0123456789abcdef']);
  await f.execute(['update', 'pkg-0123456789abcdef']);
  expect(f.calls).toEqual([
    { method: 'agent.packages.list', params: {} },
    { method: 'agent.packages.list', params: {} },
    { method: 'agent.packages.install', params: { source: 'npm:@scope/tools@1.0.0' } },
    { method: 'agent.packages.remove', params: { id: 'pkg-0123456789abcdef' } },
    { method: 'agent.packages.update', params: { id: 'pkg-0123456789abcdef' } },
  ]);
});

test('agent packages accepts a bare client context and rejects invalid arguments locally', async () => {
  const f = fixture();
  expect(await runPackages(['list'], f.client)).toEqual(view());
  await expect(f.execute(['install'])).rejects.toThrow('invalid arguments');
  await expect(f.execute(['install', 'a', 'b'])).rejects.toThrow('invalid arguments');
  await expect(f.execute(['remove'])).rejects.toThrow('invalid arguments');
  await expect(f.execute(['delete'])).rejects.toThrow('agent packages expects');
  expect(f.calls).toEqual([{ method: 'agent.packages.list', params: {} }]);
});

test('agent tokens cannot list or change Lush-managed packages', async () => {
  const f = fixture();
  f.client.token = 'invocation-capability';
  for (const args of [['list'], ['install', 'npm:@scope/tools@1.0.0'], ['remove', 'pkg-0123456789abcdef'], ['update', 'pkg-0123456789abcdef']]) {
    await expect(f.execute(args)).rejects.toThrow('agents cannot change');
  }
  expect(f.calls).toHaveLength(0);
});
