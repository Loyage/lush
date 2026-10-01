import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';

test('Web allows the four iteration mutations through user-only RPC', async () => {
  const f = await setup();
  const calls = [];
  const task = { id: 7, status: 'awaiting_acceptance' };
  try {
    for (const [verb, method] of [['accept', 'acceptTask'], ['reopen', 'reopenTask'],
      ['sync_parent', 'syncTaskParent'], ['resolve_sync', 'resolveTaskSync']]) {
      const result = verb === 'sync_parent' ? { task, synced: true, conflict: false,
        source_commit: 'source', parent_commit: 'parent' } : task;
      f.project[method] = id => { calls.push({ method, id }); return result; };
      const post = params => fetch(f.url + '/api/action', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: `task.${verb}`, params }) });
      const response = await post({ id: 7 });
      expect(response.status).toBe(200); expect(await response.json()).toEqual(result);
      expect(calls.at(-1)).toEqual({ method, id: 7 });
      expect((await post({ id: 7, _token: 'agent' })).status).toBe(400);
      expect((await post({ id: 7, force: true })).status).toBe(400);
    }
    expect(calls.length).toBe(4);
    expect((await fetch(f.url + '/render-iteration.js')).status).toBe(200);
  } finally { await f.close(); }
});
