import { test, expect } from 'bun:test';
import { PARAMS, USER_ONLY, assertAllowed } from '../src/rpc/registry.js';
import { HANDLERS } from '../src/rpc/dispatcher.js';
import { run } from '../src/cli/commands/task.js';
import { HELP } from '../src/cli/help.js';

test('auto merge RPC is user-only and forwards a strict hook setting, not a reservation', async () => {
  expect(PARAMS['task.auto_merge']).toEqual(['id','enabled']);
  expect(USER_ONLY.has('task.auto_merge')).toBe(true);
  expect(assertAllowed('task.auto_merge', { id: 7, enabled: true }, null)).toBeNull();
  expect(() => assertAllowed('task.auto_merge', { id: 7, enabled: true }, 42)).toThrow('requires user approval');
  expect(() => assertAllowed('task.auto_merge', { id: 7, enabled: true, force: true }, null)).toThrow('unknown parameter');
  const result = { task_id: 7, changed: true, auto_merge: { enabled: true, locked: false, editable: true, reason: null } };
  const calls = [], project = { setTaskAutoMerge(...args) { calls.push(args); return result; } };
  expect(await HANDLERS['task.auto_merge'](project, { id: 7, enabled: true }, null)).toBe(result);
  expect(calls).toEqual([[7, true]]);
});

test('task auto-merge ID on|off uses the user hook API and rejects malformed CLI input', async () => {
  const calls = [], client = { async request(method, params) { calls.push({ method, params }); return params; } };
  expect(await run('task', ['auto-merge','7','on'], { client, json: true })).toEqual({ id: 7, enabled: true });
  expect(await run('task', ['auto-merge','7','off'], { client, json: true })).toEqual({ id: 7, enabled: false });
  expect(calls).toEqual([
    { method: 'task.auto_merge', params: { id: 7, enabled: true } },
    { method: 'task.auto_merge', params: { id: 7, enabled: false } },
  ]);
  for (const args of [['7'],['7','true'],['7','on','force'],['invalid','on']])
    await expect(run('task', ['auto-merge', ...args], { client, json: true })).rejects.toThrow();
  expect(calls).toHaveLength(2);
  expect(HELP).toContain('task auto-merge ID on|off');
});
