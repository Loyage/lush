import { test, expect } from 'bun:test';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { PARAMS, USER_ONLY } from '../src/rpc/registry.js';
import { run } from '../src/cli/commands/task.js';
import { HELP } from '../src/cli/help.js';

const revision = 'preview-resource-revision';

test('deletion API is user-only, narrow, and requires explicit preview confirmation before effects', async () => {
  const calls = [];
  const preview = { id: 7, revision, can_delete: true, blockers: [], workers: [{ id: 7 }], resources: {} };
  const project = { actor: token => token ? 42 : null,
    deleteTaskPreview: id => { calls.push(['preview', id]); return preview; },
    deleteTask: (id, options) => { calls.push(['delete', id, options]); return { deleted: { ids: [id] } }; } };
  const rpc = new Dispatcher(project);
  expect(PARAMS['worker.delete_preview']).toEqual(['id']);
  expect(PARAMS['worker.delete']).toEqual(['id','revision','confirm']);
  for (const method of ['worker.delete_preview','worker.delete']) {
    expect(USER_ONLY.has(method)).toBe(true);
    await expect(rpc.dispatch(method, { id: 7, _token: 'live' })).rejects.toThrow('requires user approval');
    await expect(rpc.dispatch(method, { id: 7, force: true })).rejects.toThrow('unknown parameter');
  }
  for (const params of [{ id: 7 }, { id: 7, confirm: false, revision }, { id: 7, confirm: 'true', revision },
    { id: 7, confirm: true }, { id: 7, confirm: true, revision: '' }, { id: 7, confirm: true, revision: 1 },
    { id: 7, confirm: true, revision: 'x'.repeat(257) }, { id: 0, confirm: true, revision }])
    await expect(rpc.dispatch('worker.delete', params)).rejects.toThrow();
  expect(calls).toEqual([]);
  expect(await rpc.dispatch('worker.delete_preview', { id: 7 })).toBe(preview);
  expect(await rpc.dispatch('worker.delete', { id: 7, confirm: true, revision })).toEqual({ deleted: { ids: [7] } });
  expect(calls).toEqual([['preview', 7], ['delete', 7, { confirm: true, revision }]]);
  await expect(rpc.dispatch('task.delete', { id: 7 })).rejects.toThrow('unknown method');
});

test('CLI defaults to preflight and only deletes with a separately supplied preview revision', async () => {
  const calls = [], result = { id: 7, revision };
  const client = { request: async (method, params) => { calls.push({ method, params }); return result; } };
  expect(await run('worker', ['delete','7'], { client, json: true })).toBe(result);
  expect(calls).toEqual([{ method: 'worker.delete_preview', params: { id: 7 } }]);
  expect(await run('worker', ['delete','7','--confirm','--revision',revision], { client, json: true })).toBe(result);
  expect(calls.at(-1)).toEqual({ method: 'worker.delete', params: { id: 7, confirm: true, revision } });
  for (const args of [['delete','7','--confirm'], ['delete','7','--revision',revision], ['delete','7','--confirm','--revision'],
    ['delete','7','--yes'], ['delete','7','--confirm','--confirm','--revision',revision], ['delete','0']])
    await expect(run('worker', args, { client, json: true })).rejects.toThrow();
  await expect(run('worker', ['delete','7'], { client: { ...client, token: 'agent' }, json: true })).rejects.toThrow('user only');
  expect(calls).toHaveLength(2);
  expect(HELP).toContain('worker delete ID --confirm --revision REV');
});
