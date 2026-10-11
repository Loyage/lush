import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
const uuid = 'ee2f98f1-fc9a-46b1-a37c-67d8595c0649';
const route = '/api/hooks/commands/executions';

test('execution history requires login and same origin, forwards bounded identity reads and rejects invalid queries', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'fixture-password' } }), calls = [];
  f.project.shortcutCommandHistory = params => { calls.push(params); return { version: 1, items: [], has_more: false, next_before: null }; };
  try {
    expect((await fetch(f.url + route)).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=fixture-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url + route, { headers: { Cookie, Origin: 'https://evil.invalid' } })).status).toBe(403);
    for (const query of ['?limit=0','?limit=101','?before=0','?before=1e3','?before=01','?before=-3','?limit=1.5',
      '?limit=1&limit=2','?execution_id=' + uuid + '&execution_id=' + uuid, '?id=' + uuid, '?execution_id=bad',
      '?execution_id=' + uuid + '&before=20','?_token=agent','?worker_id=7','?command_run=' + uuid])
      expect((await fetch(f.url + route + query, { headers: { Cookie } })).status).toBe(400);
    expect(calls).toEqual([]);
    for (const query of ['', '?before=20&limit=5', '?execution_id=' + uuid]) {
      const response = await fetch(f.url + route + query, { headers: { Cookie } });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ version: 1, items: [] });
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect(calls).toEqual([{}, { before: 20, limit: 5 }, { execution_id: uuid }]);
    expect((await fetch(f.url + '/api/action', { method: 'POST', headers: { Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'hooks.command_history', params: {} }) })).status).toBe(400);
    expect((await fetch(f.url + route, { method: 'POST', headers: { Cookie } })).status).toBe(404);
  } finally { await f.close(); }
});
