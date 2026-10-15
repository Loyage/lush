import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { installDom } from '../dom-stub.js';
import { temp } from '../helpers.js';
import { cliCatalog } from '../../src/rpc/cli-catalog.js';
import { createStaticAssets } from '../../src/ui/web/static-assets.js';
import { startWeb } from '../../src/ui/web/server.js';
import { loadCliCatalog } from '../../src/ui/web/assets/cli-catalog.js';

const assetPath = html => /<meta id="cli-catalog-asset" content="([^\"]+)"/.exec(html)?.[1];
const request = (headers = {}) => new Request('http://localhost/', { headers });
const tiny = root => {
  const assets = path.join(root, 'assets'); fs.mkdirSync(assets);
  for (const [name, source] of Object.entries({ 'index.html': '<head><script src="/app.js" type="module"></script><script src="/appearance.js" type="module"></script></head>', 'app.js': 'console.log("app")', 'appearance.js': 'console.log("appearance")' })) fs.writeFileSync(path.join(assets, name), source);
  return { assets, cache: path.join(root, 'cache') };
};

test('CLI data is a separate immutable authenticated JSON representation; changes to descriptions, registry or policy invalidate the version', async () => {
  const root = temp();
  try {
    const options = tiny(root), catalog = cliCatalog();
    const first = createStaticAssets({ ...options, catalog });
    const url = assetPath(await first.response('/', request(), {}).text());
    expect(url).toBe(`/web-${first.version}-cli-catalog.json`);
    const response = first.response(url, request({ 'Accept-Encoding': 'identity' }), {});
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual(catalog);
    const gzip = first.response(url, request({ 'Accept-Encoding': 'gzip' }), {});
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    expect(JSON.parse(gunzipSync(Buffer.from(await gzip.arrayBuffer())).toString())).toEqual(catalog);
    const again = first.response(url, request({ 'If-None-Match': response.headers.get('etag') }), {});
    expect(again.status).toBe(304); expect(await again.text()).toBe('');
    expect(createStaticAssets({ ...options, catalog }).version).toBe(first.version);
    // No JS source change is necessary for command or reviewed permission updates.
    let previousName = url, previousCatalog = catalog;
    for (const mutate of [
      value => value.commands.find(item => !item.directory).description += ' changed',
      value => value.commands.find(item => item.rpc.length).rpc[0].parameters.push('new_parameter'),
      value => value.commands.find(item => item.rpc.length).rpc[0].reason = 'changed reviewed ceiling reason',
    ]) {
      const changed = structuredClone(catalog); mutate(changed);
      const next = createStaticAssets({ ...options, catalog: changed });
      expect(next.version).not.toBe(first.version);
      const name = assetPath(await next.response('/', request(), {}).text()); expect(name).not.toBe(url);
      expect(await next.response(name, request(), {}).json()).toEqual(changed);
      expect(await next.response(previousName, request(), {}).json()).toEqual(previousCatalog);
      previousName = name; previousCatalog = changed;
    }
    expect(first.response('/cli-catalog.json', request(), {})).toBeNull();
    expect(first.response('/web-00000000000000000000000000000000-cli-catalog.json', request(), {})).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real login -> HTML version -> static directory never opens a stopped project daemon and retains Origin/authentication checks', async () => {
  const root = temp(), calls = [];
  const password = 'catalogue cache test password';
  fs.writeFileSync(path.join(root, 'web.json'), JSON.stringify({ version: 2, username: 'owner', password }), { mode: 0o600 });
  const projectHost = { launcher: true, hasRoute: () => true, openRoute: () => { calls.push('open'); throw Error('project daemon stopped'); }, require: () => { calls.push('require'); throw Error('project daemon stopped'); } };
  const web = startWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: root }, projectHost });
  const base = `http://127.0.0.1:${web.port}`, get = (suffix, headers = {}) => fetch(base + suffix, { headers, redirect: 'manual' });
  try {
    const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'owner', password, next: '/' }).toString() });
    expect(login.status).toBe(303); const Cookie = login.headers.get('set-cookie').split(';')[0];
    const page = await get('/p/1111111111111111/', { Cookie }); expect(page.status).toBe(200);
    const name = assetPath(await page.text()); expect(name).toMatch(/^\/web-[a-f0-9]{32}-cli-catalog\.json$/);
    expect((await get(name)).status).toBe(303);
    const initial = await get(name, { Cookie }); expect(initial.status).toBe(200);
    const published = await initial.json(); expect(published).toEqual(cliCatalog());
    expect(published.commands.find(item => item.path === 'lush branch integrate').operations).toEqual(['read', 'write']);
    for (const [verb, operation, method] of [['plan', 'read', 'branch.integrate_plan'], ['show', 'read', 'branch.integration'],
      ['start', 'write', 'branch.integrate_start'], ['cancel', 'write', 'branch.integrate_cancel'], ['retry', 'write', 'branch.integrate_retry']]) {
      const item = published.commands.find(item => item.path === `lush branch integrate ${verb}`);
      expect(item.operation).toBe(operation); expect(item.operations).toEqual([operation]);
      expect(item.rpc.map(rpc => [rpc.method, rpc.audience])).toEqual([[method, 'user']]);
      expect(published.commands.some(entry => entry.path === `lushc branch integrate ${verb}`)).toBe(false);
    }
    expect((await get(name, { Cookie, Origin: 'https://attacker.invalid' })).status).toBe(403);
    const etag = initial.headers.get('etag');
    expect((await get(name, { Cookie, 'If-None-Match': etag })).status).toBe(304);
    expect((await get(name, { 'If-None-Match': etag })).status).toBe(303);
    expect(calls).toEqual([]);
    const text = JSON.stringify(await (await get(name, { Cookie })).json());
    for (const secret of [root, password, Cookie, 'permissions_snapshot', 'credentials']) expect(text).not.toContain(secret);
    expect((await get('/p/1111111111111111/api/management/permissions', { Cookie })).status).toBe(400);
    expect(calls).toEqual(['open']);
  } finally { await web.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test('document-level catalogue flights dedupe across navigation without storage, while a new asset URL cannot reuse an old value', async () => {
  const reads = [], asset = `/web-${'a'.repeat(32)}-cli-catalog.json`;
  let release;
  const dom = installDom({ fetch: (url, options) => { reads.push({ url, options }); return new Promise(resolve => { release = resolve; }); } });
  const storage = ['localStorage', 'sessionStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  try {
    dom.node('cli-catalog-asset').setAttribute('content', asset);
    for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(globalThis, name, { configurable: true, get() { throw Error('storage unavailable'); } });
    const first = loadCliCatalog(), second = loadCliCatalog(); expect(first).toBe(second); expect(reads).toHaveLength(1);
    release(Response.json(cliCatalog())); const value = await first;
    expect(await loadCliCatalog()).toBe(value); expect(reads).toHaveLength(1); expect(reads[0].options.cache).toBe('default');
    dom.node('cli-catalog-asset').setAttribute('content', `/web-${'b'.repeat(32)}-cli-catalog.json`);
    const updated = structuredClone(cliCatalog()); updated.commands[0].description += ' new version';
    const next = loadCliCatalog(); expect(reads).toHaveLength(2); release(Response.json(updated));
    expect(await next).toEqual(updated);
  } finally { for (const [name, descriptor] of storage) Object.defineProperty(globalThis, name, descriptor); dom.restore(); }
});

test('invalid catalogue caches fail visibly, retry bypasses HTTP cache, and invalid static addresses cannot fetch arbitrary paths', async () => {
  const reads = []; let response;
  const dom = installDom({ fetch: (url, options) => { reads.push({ url, options }); return response; } });
  try {
    dom.node('cli-catalog-asset').setAttribute('content', `/web-${'a'.repeat(32)}-cli-catalog.json`);
    response = new Response('broken JSON'); await expect(loadCliCatalog()).rejects.toThrow();
    response = Response.json({ version: 1, source: 'builtin-cli', commands: [] }); await expect(loadCliCatalog()).rejects.toThrow('目录不完整');
    expect(reads[1].options.cache).toBe('reload');
    const invalid = structuredClone(cliCatalog()); invalid.commands.find(item => item.directory).operations = ['write'];
    response = Response.json(invalid); await expect(loadCliCatalog()).rejects.toThrow('分类不一致');
    response = Response.json(cliCatalog()); expect((await loadCliCatalog()).commands.length).toBeGreaterThan(0);
    expect(reads[3].options.cache).toBe('reload');
    response = Response.json(cliCatalog()); await loadCliCatalog({ retry: true }); expect(reads[4].options.cache).toBe('reload');
    dom.node('cli-catalog-asset').setAttribute('content', '/api/management/permissions');
    await expect(loadCliCatalog()).rejects.toThrow('地址无效'); expect(reads).toHaveLength(5);
  } finally { dom.restore(); }
});
