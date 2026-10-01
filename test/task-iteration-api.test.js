import { test, expect } from 'bun:test';
import { PARAMS, USER_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { HANDLERS } from '../src/rpc/dispatcher.js';
import { run } from '../src/cli/commands/task.js';
import { HELP } from '../src/cli/help.js';

const cases = [
  ['accept', 'acceptTask'], ['reopen', 'reopenTask'],
  ['sync_parent', 'syncTaskParent'], ['resolve_sync', 'resolveTaskSync'],
];
for (const [verb, method] of cases) {
  test(`task.${verb} is id-only and forwards its result with the correct authority`, async () => {
    const rpc = `task.${verb}`, task = { id: 7, status: 'awaiting_acceptance' };
    const result = verb === 'sync_parent' ? { task, synced: false, conflict: true,
      source_commit: 'source', parent_commit: 'parent', reason: 'conflict' } : task;
    expect(PARAMS[rpc]).toEqual(['id']); expect(USER_ONLY.has(rpc)).toBe(verb !== 'accept');
    expect(assertAllowed(rpc, { id: 7 }, null)).toBeNull();
    if (verb === 'accept') expect(assertAllowed(rpc, { id: 7 }, 42)).toBe(42);
    else expect(() => assertAllowed(rpc, { id: 7 }, 42)).toThrow('requires user approval');
    expect(() => assertAllowed(rpc, { id: 7, force: true }, null)).toThrow('unknown parameter');
    const calls = [];
    const project = { [method](...args) { calls.push(args); return result; } };
    expect(await HANDLERS[rpc](project, { id: 7 }, null)).toBe(result);
    expect(calls).toEqual([verb === 'accept' ? [7, null] : [7]]);
    if (verb === 'accept') {
      expect(await HANDLERS[rpc](project, { id: 7 }, 42)).toBe(result);
      expect(calls.at(-1)).toEqual([7, 42]);
    }
    const cliCalls = [], client = { async request(method, params) { cliCalls.push({ method, params }); return result; } };
    const cli = verb.replaceAll('_', '-');
    expect(await run('task', [cli, '7'], { client, json: true })).toBe(result);
    expect(cliCalls).toEqual([{ method: rpc, params: { id: 7 } }]);
    expect(HELP).toContain(`task ${cli} ID`);
    await expect(run('task', [cli, '7', 'force'], { client, json: true })).rejects.toThrow();
  });
}
