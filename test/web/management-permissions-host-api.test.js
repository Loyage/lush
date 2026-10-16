import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { env, temp } from '../helpers.js';
import { startWeb } from '../../src/ui/web/server.js';
import { fetch, startTestWeb } from './auth-fixture.js';

const route = '/api/host/management/permissions';
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
function host({ bound = false, auth = false, managementPermissionsService } = {}) {
  const root = temp(), home = path.join(root, 'device'), calls = [], webs = [];
  const environment = env({ LUSH_GLOBAL_CONFIG: home });
  if (auth) {
    fs.mkdirSync(home, { mode: 0o700 });
    fs.writeFileSync(path.join(home, 'web.json'), JSON.stringify({ version: 2, username: 'owner', password: 'permissions-test-password' }), { mode: 0o600 });
  }
  const projectHost = { launcher: !bound,
    require() { calls.push('require'); throw new Error('offline: must not start or attach'); },
    openRoute() { calls.push('openRoute'); throw new Error('offline: must not start or attach'); } };
  const config = bound ? { project: path.join(root, 'offline-project'), home: path.join(root, 'offline-project', '.lush'), env: environment } : null;
  const open = () => {
    const web = (auth ? startWeb : startTestWeb)(config, 0, { env: environment, projectHost, userServiceOptions: { managementPermissionsService } });
    webs.push(web); return `http://127.0.0.1:${web.port}`;
  };
  return { root, home, calls, open, webs, url: open(), async close() {
    await Promise.all(webs.map(web => web.stop(true))); fs.rmSync(root, { recursive: true, force: true });
  } };
}

for (const bound of [false,true]) test(`global permissions are readable/writable with ${bound ? 'an offline bound project' : 'no registered project'} and survive Host restart`, async () => {
  const f = host({ bound });
  try {
    const response = await fetch(f.url + route); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const draft = await response.json(); expect(draft).toMatchObject({ version: 1, scope: 'device', configured: false });
    expect(fs.existsSync(path.join(f.home, 'shared'))).toBe(false);
    const second = f.open(), body = { permissions: { ...draft.permissions, 'draft.add': 'confirmation' }, expected_revision: draft.revision };
    const replies = await Promise.all([post(f.url + route, body),post(second + route, body)]);
    expect(replies.map(reply => reply.status).sort()).toEqual([200,400]);
    const saved = await replies.find(reply => reply.status === 200).json();
    expect(saved).toMatchObject({ scope: 'device', configured: true, permissions: { 'draft.add': 'confirmation' } });
    expect(saved.revision).not.toBe(draft.revision);
    await f.webs[0].stop(true); const restarted = f.open();
    expect(await (await fetch(restarted + route)).json()).toEqual(saved);
    expect(f.calls).toEqual([]);
    expect(fs.readdirSync(path.join(f.home, 'shared'))).toEqual(['management-permissions.json']);
  } finally { await f.close(); }
});

test('Host permissions enforce strict user bodies/queries and do not initialize dependencies for invalid writes', async () => {
  let reads = 0, writes = 0, closes = 0;
  const f = host({ managementPermissionsService: {
    get() { reads++; return {}; }, save() { writes++; return {}; }, close() { closes++; },
  } });
  try {
    for (const query of ['?_token=forged','?scope=device','?x=1','?x=1&x=2']) expect((await fetch(f.url + route + query)).status).toBe(400);
    for (const body of [null, [], {}, { permissions: {} }, { permissions: {}, expected_revision: 'x', _token: 'forged' },
      { permissions: {}, expected_revision: 'x', scope: 'device' }]) expect((await post(f.url + route, body)).status).toBe(400);
    expect(reads).toBe(0); expect(writes).toBe(0);
    expect((await fetch(f.url + route)).status).toBe(200); expect(reads).toBe(1);
    await f.webs[0].stop(true); expect(closes).toBe(1); expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test('Host-only permission settings require login, same Origin and valid Host before access', async () => {
  let reads = 0, writes = 0;
  const f = host({ auth: true, managementPermissionsService: { get() { reads++; return {}; }, save() { writes++; return {}; } } });
  try {
    expect((await fetch(f.url + route)).status).toBe(401);
    expect((await post(f.url + route, {})).status).toBe(401); expect(reads + writes).toBe(0);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=permissions-test-password' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    expect((await post(f.url + route, {}, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await fetch(f.url + route, { headers: { Cookie, Host: 'evil.invalid' } })).status).toBe(403);
    expect(reads + writes).toBe(0);
    expect((await fetch(f.url + route, { headers: { Cookie } })).status).toBe(200); expect(reads).toBe(1);
  } finally { await f.close(); }
});
