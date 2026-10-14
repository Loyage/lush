import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';
import { cliHelp } from '../../src/cli/catalog.js';
import { UIClient } from '../../src/ui/client.js';
import { createHostRoutes } from '../../src/ui/web/server-host-routes.js';

test('real project HTTP -> user-only RPC catalogue has no writes or secrets and rejects parameters/actions', async () => {
  const f = await setup();
  try {
    const before = f.store.get('SELECT count(*) AS n FROM events').n;
    for (const route of ['/api/cli/catalog','/api/host/cli/catalog']) expect((await fetch(f.url + route, { anonymous: true })).status).toBe(401);
    const response = await fetch(f.url + '/api/cli/catalog'); expect(response.status).toBe(200);
    const value = await response.json(); expect(value).toEqual(cliCatalog());
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
    for (const command of value.commands.filter(item => !item.directory)) expect(cliHelp(command.executable)).toContain(command.usage.slice(command.executable.length + 1));
    const global = await fetch(f.url + '/api/host/cli/catalog'); expect(global.status).toBe(200); expect(await global.json()).toEqual(value);
    for (const route of ['/api/cli/catalog', '/api/host/cli/catalog']) {
      for (const query of ['?q=worker','?scope=device','?_token=secret','?id=1&id=2']) expect((await fetch(f.url + route + query)).status).toBe(400);
    }
    expect((await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'cli.catalog', params: {} }) })).status).toBe(400);
    expect((await fetch(f.url + '/api/host/cli/catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
    const client = new UIClient(f.config);
    expect((await client.request('cli.catalog'))).toEqual(value);
    await expect(client.request('cli.catalog', { arbitrary: 'x' })).rejects.toThrow('unknown parameter');
    expect(JSON.stringify(value)).not.toContain(f.root);
    for (const secret of ['agent_token_hash','retry_profile','credentials','permissions_snapshot','socket','creation_fingerprint']) expect(JSON.stringify(value)).not.toContain(secret);
  } finally { await f.close(); }
});

test('global Host catalogue read never resolves a project, settings or project daemon', async () => {
  const calls = [];
  const projectHost = new Proxy({}, { get: (_target, key) => () => { calls.push(key); throw Error('must not open a project'); } });
  const routes = createHostRoutes(projectHost, { username: 'fixture' }, {}, {});
  const json = value => Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const request = new Request('http://fixture/api/host/cli/catalog');
    const response = await routes.handle({ request, url: new URL(request.url), json, headers: {} });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(cliCatalog()); expect(calls).toEqual([]);
  } finally { await routes.close(); }
});
