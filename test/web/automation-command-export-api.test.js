import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
const id = 'ee2f98f1-fc9a-46b1-a37c-67d8595c0649';
const route = '/api/hooks/commands/export';

test('automation Markdown export requires login and same origin and rejects extra or duplicate parameters', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'fixture-password' } }), calls = [];
  f.project.exportShortcutCommand = (...args) => { calls.push(args); return { filename: 'SKILL.md', markdown: '---\nname: review\n---\n' }; };
  try {
    const query = `?id=${id}&version=2`;
    expect((await fetch(f.url + route + query)).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=fixture-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await fetch(f.url + route + query, { headers: { Cookie, Origin: 'https://evil.invalid' } })).status).toBe(403);
    for (const invalid of ['', `?id=${id}`, '?id=bad&version=2', `?id=${id}&version=0`, `?id=${id}&version=02`,
      `?id=${id}&version=2&version=3`, `?id=${id}&id=${id}&version=2`, `?id=${id}&version=2&_token=agent`,
      `?id=${id}&version=9007199254740992`, `?id=${id}&version=2&authorize=true`])
      expect((await fetch(f.url + route + invalid, { headers: { Cookie } })).status).toBe(400);
    expect(calls).toEqual([]);
    const response = await fetch(f.url + route + query, { headers: { Cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ filename: 'SKILL.md', markdown: '---\nname: review\n---\n' });
    expect(calls).toEqual([[id, 2]]);
    expect((await fetch(f.url + '/api/action', { method: 'POST', headers: { Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'hooks.command_export', params: { id, version: 2 } }) })).status).toBe(400);
    expect((await fetch(f.url + route + query, { method: 'POST', headers: { Cookie } })).status).toBe(404);
    expect(calls).toHaveLength(1);
  } finally { await f.close(); }
});

test('HTTP saves prompt definitions with metadata and keeps creation an explicit user action', async () => {
  const f = await setup(), calls = [];
  f.project.saveShortcutCommand = (...args) => { calls.push(args); return { ok: true }; };
  try {
    const command = { name: 'review', kind: 'prompt', prompt: 'Review current changes', description: 'Review', when_to_use: '', tags: ['review'], examples: '', warnings: '' };
    const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'hooks.command_save', params: { command, expected_revision: 'rev' } }) });
    expect(response.status).toBe(200); expect(calls).toEqual([[command, 'rev']]);
    for (const invalid of [{ ...command, command: 'echo wrong' }, { ...command, profile: { agent: 'pi' } }, { ...command, tags: ['tag', 7] }])
      expect((await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'hooks.command_save', params: { command: invalid, expected_revision: 'rev' } }) })).status).toBe(400);
    expect(calls).toHaveLength(1);
  } finally { await f.close(); }
});
