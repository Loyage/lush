import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { check } from '../../src/core/types.js';

const id = 'ee2f98f1-fc9a-46b1-a37c-67d8595c0649', expected_revision = 'commands:revision';
const requests = [
  ['hooks.command_save', { command: { name: 'fixture', command: 'printf fixture' }, expected_revision }, 'saveShortcutCommand'],
  ['hooks.command_authorize', { id, version: 1, authorized: true, expected_revision }, 'authorizeShortcutCommand'],
  ['hooks.command_remove', { id, expected_revision }, 'removeShortcutCommand'],
  ['hooks.command_run', { id, version: 1, worker_id: 7, expected_revision }, 'runShortcutCommand'],
  ['hooks.command_import', { source: { worker_id: 7, hook_id: 'legacy' }, expected_revision }, 'importLegacyHookCommands'],
];
function mocks(f) {
  const calls = [];
  for (const [, , method] of requests) f.project[method] = (...args) => { calls.push({ method, args }); return { ok: true }; };
  return calls;
}
function post(url, method, params, headers = {}) {
  return fetch(url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method, params }) });
}

test('all shortcut mutations require login and same-origin authorization; no GET execution exists', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'fixture-password' } }), calls = mocks(f);
  try {
    for (const [method, params] of requests) expect((await post(f.url, method, params)).status).toBe(401);
    expect(calls).toEqual([]);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=fixture-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    for (const [method, params] of requests) {
      expect((await post(f.url, method, params, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
      expect((await post(f.url, method, { ...params, _token: 'agent' }, { Cookie })).status).toBe(400);
      expect((await post(f.url, method, params, { Cookie, Origin: f.url })).status).toBe(200);
      expect((await fetch(f.url + '/api/hooks/' + method.split('.')[1], { headers: { Cookie } })).status).toBe(404);
    }
    expect(calls).toHaveLength(requests.length);
    expect((await fetch(f.url + '/api/hooks?command_run=' + id, { headers: { Cookie } })).status).toBe(400);
    expect(calls).toHaveLength(requests.length);
  } finally { await f.close(); }
});

test('shortcut HTTP rejects nested privilege additions and invalid identities before Runtime', async () => {
  const f = await setup(), calls = mocks(f);
  try {
    for (const command of [null, [], {}, { name: 'fixture', command: 'echo', authorized: true },
      { name: 'fixture', command: 'echo', version: 3 }, { name: 'fixture', command: 'echo', cwd: '/tmp' },
      { name: 'fixture', command: 'echo\0secret' }])
      expect((await post(f.url, 'hooks.command_save', { command, expected_revision })).status).toBe(400);
    for (const source of [null, {}, { template_id: 't', worker_id: 7, hook_id: 'h' },
      { worker_id: 7, hook_id: 'h', force: true }, { worker_id: 'W151-1', hook_id: 'h' }])
      expect((await post(f.url, 'hooks.command_import', { source, expected_revision })).status).toBe(400);
    for (const version of [null, 0, -1, '1', 1.5]) {
      expect((await post(f.url, 'hooks.command_run', { id, version, worker_id: 7, expected_revision })).status).toBe(400);
      expect((await post(f.url, 'hooks.command_authorize', { id, version, authorized: true, expected_revision })).status).toBe(400);
    }
    expect((await post(f.url, 'hooks.command_run', { id, version: 1, worker_id: 'W151-1', expected_revision })).status).toBe(400);
    expect((await post(f.url, 'hooks.command_authorize', { id, version: 1, authorized: 'true', expected_revision })).status).toBe(400);
    expect(calls).toEqual([]);
    let attempts = 0;
    f.project.runShortcutCommand = () => { attempts++; check(false, 'Command revision changed'); };
    const stale = await post(f.url, 'hooks.command_run', { id, version: 1, worker_id: 7, expected_revision: 'stale' });
    expect(stale.status).toBe(400); expect((await stale.json()).error).toContain('revision changed');
    expect(attempts).toBe(1);
  } finally { await f.close(); }
});
