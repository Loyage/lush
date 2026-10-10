import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createStaticAssets, staticEncoding } from '../../src/ui/web/static-assets.js';
import { startWeb } from '../../src/ui/web/server.js';
import { projectRouteId } from '../../src/host/registry.js';
import { temp } from '../helpers.js';
import { fetch } from './harness.js';

const links = html => [...html.matchAll(/(?:src|<link rel="stylesheet" href)="(\/[^"\n]+\.(?:js|css))"/g)].map(row => row[1]);
const imports = source => [...source.matchAll(/\b(?:from\s*|import\s*)["'](\.[^"']+)["']/g)].map(row => row[1]);
const request = encoding => new Request('http://localhost/', { headers: encoding ? { 'Accept-Encoding': encoding } : {} });

async function graph(url, pending) {
  const seen = new Map();
  while (pending.length) {
    const name = pending.shift();
    if (seen.has(name)) continue;
    const response = await fetch(url + name);
    expect(response.status).toBe(200);
    const source = await response.text(); seen.set(name, source);
    if (name.endsWith('.js')) for (const imported of imports(source)) pending.push(new URL(imported, `http://localhost${name}`).pathname);
  }
  return seen;
}

function tinyAssets(root) {
  const assets = path.join(root, 'assets'), cache = path.join(root, 'cache');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, 'index.html'), '<head><script src="/appearance.js" type="module"></script><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/extra.css"><script type="module" src="/app.js"></script></head>');
  fs.writeFileSync(path.join(assets, 'app.js'), 'import {value} from "./shared.js"; console.log(value); globalThis.later=()=>import("./later.js");');
  fs.writeFileSync(path.join(assets, 'appearance.js'), 'import {value} from "./shared.js"; globalThis.appearance=value;');
  fs.writeFileSync(path.join(assets, 'shared.js'), 'export const value="first";');
  fs.writeFileSync(path.join(assets, 'later.js'), 'export const later="later page";');
  fs.writeFileSync(path.join(assets, 'styles.css'), '@import url("./base.css");\nbody{color:red}');
  fs.writeFileSync(path.join(assets, 'base.css'), ':root{color-scheme:dark}');
  fs.writeFileSync(path.join(assets, 'extra.css'), 'body{color:blue}');
  return { assets, cache };
}

test('encoding negotiation respects q=0, wildcard and identity; unsupported-only yields 406', () => {
  for (const [input, output] of [['', 'identity'], ['gzip', 'gzip'], ['GZip;q=1, identity;q=0', 'gzip'],
    ['gzip;q=0, *;q=1', 'identity'], ['gzip;q=0.5', 'identity'], ['br, identity;q=0', null],
    ['*;q=0', null], ['*;q=0.8, identity;q=0', 'gzip'], ['gzip;q=bad', 'identity']]) expect(staticEncoding(input)).toBe(output);
});

test('content versions survive Host replacement without substitution; cache bounded to three generations', async () => {
  const root = temp();
  try {
    const options = tinyAssets(root), first = createStaticAssets(options);
    const html = await first.response('/', request(), {}).text();
    const original = links(html).find(name => name.includes('-app-'));
    const originalText = await first.response(original, request(), {}).text();
    expect(originalText).toContain('later-');
    expect(links(html).filter(name => name.endsWith('.css'))).toHaveLength(1);
    const css = await first.response(links(html).find(name => name.endsWith('.css')), request(), {}).text();
    expect(css).not.toContain('@import');
    expect(css.indexOf('color-scheme')).toBeLessThan(css.indexOf('color:red'));
    expect(css.indexOf('color:red')).toBeLessThan(css.indexOf('color:blue'));
    expect(createStaticAssets(options).version).toBe(first.version);
    fs.writeFileSync(path.join(options.assets, 'shared.js'), 'export const value="second";');
    const second = createStaticAssets(options);
    expect(second.version).not.toBe(first.version);
    expect(await second.response(original, request(), {}).text()).toBe(originalText);
    const updated = links(await second.response('/', request(), {}).text()).find(name => name.includes('-app-'));
    expect(updated).not.toBe(original);
    // Query strings cannot forge a content identity, nor can an unknown old version map to current code.
    expect(second.response('/web-00000000000000000000000000000000-app.js', request(), {})).toBeNull();
    for (const value of ['third', 'fourth']) {
      fs.writeFileSync(path.join(options.assets, 'shared.js'), `export const value="${value}";`);
      createStaticAssets(options);
    }
    const latest = createStaticAssets(options);
    expect(latest.response(original, request(), {})).toBeNull();
    expect(fs.readdirSync(options.cache).filter(name => name.endsWith('.json'))).toHaveLength(3);
    expect(fs.readdirSync(options.cache).some(name => name.startsWith('.build-'))).toBe(false);
    expect(fs.statSync(options.cache).mode & 0o777).toBe(0o700);
    for (const name of fs.readdirSync(options.cache)) expect(fs.statSync(path.join(options.cache, name)).mode & 0o777).toBe(0o600);
    for (const unsafe of ['/index.html', '/.hidden.js', '/nested/app.js', '/../app.js', '/app.mjs']) expect(latest.response(unsafe, request(), {})).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('immutable resources revalidate with representation-specific ETags without caching HTML or source modules', async () => {
  const root = temp();
  try {
    const assets = createStaticAssets(tinyAssets(root));
    const html = await assets.response('/', request(), {}).text();
    const name = links(html).find(value => value.endsWith('.js'));
    const identity = assets.response(name, request('identity'), {});
    const gzip = assets.response(name, request('gzip'), {});
    const etag = identity.headers.get('etag'), compressedEtag = gzip.headers.get('etag');
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(compressedEtag).not.toBe(etag);
    const conditional = (url, encoding, validator) => assets.response(url, new Request('http://localhost' + url,
      { headers: { 'Accept-Encoding': encoding, 'If-None-Match': validator } }), {});
    for (const validator of [etag, `W/${etag}`, `"unknown", ${etag}`, '*']) {
      const response = conditional(name, 'identity', validator);
      expect(response.status).toBe(304); expect(await response.text()).toBe('');
      expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      expect(response.headers.get('vary')).toBe('Accept-Encoding');
    }
    expect(conditional(name, 'gzip', etag).status).toBe(200);
    expect(conditional(name, 'gzip', compressedEtag).status).toBe(304);
    expect(conditional(name, 'identity;q=0,gzip;q=0', etag).status).toBe(406);
    for (const source of ['/', '/app.js']) {
      const response = conditional(source, 'identity', '*');
      expect(response.status).toBe(200); expect(response.headers.get('etag')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('static cache rejects symlink escape and invalid archive contents; failed builds preserve diagnostic output and clean scratch space', async () => {
  const root = temp(), external = temp();
  try {
    const options = tinyAssets(root);
    const outside = path.join(external, 'outside.js'); fs.writeFileSync(outside, 'private external contents');
    const linkedCache = path.join(root, 'linked-cache'); fs.symlinkSync(external, linkedCache);
    expect(() => createStaticAssets({ ...options, cache: linkedCache })).toThrow('Unsafe Web asset cache directory');
    fs.symlinkSync(outside, path.join(options.assets, 'escape.js'));
    expect(() => createStaticAssets(options)).toThrow('Unsafe Web asset file');
    fs.unlinkSync(path.join(options.assets, 'escape.js'));
    const original = createStaticAssets(options), archive = path.join(options.cache, `${original.version}.json`);
    fs.chmodSync(options.cache, 0o755);
    expect(() => createStaticAssets(options)).toThrow('Unsafe Web asset cache directory');
    fs.chmodSync(options.cache, 0o700);
    fs.chmodSync(archive, 0o644); createStaticAssets(options);
    expect(fs.statSync(archive).mode & 0o777).toBe(0o600);
    const record = JSON.parse(fs.readFileSync(archive, 'utf8'));
    const app = Object.keys(record.files).find(name => name.includes('-app-'));
    record.files[app].bytes = Buffer.from('tampered executable content').toString('base64');
    fs.writeFileSync(archive, JSON.stringify(record));
    const rebuilt = createStaticAssets(options);
    expect(await rebuilt.response(`/${app}`, request(), {}).text()).not.toContain('tampered executable content');
    expect(fs.readFileSync(archive, 'utf8')).not.toContain(record.files[app].bytes);
    // An archive symlink is not read, and replacement must leave its external target untouched.
    fs.unlinkSync(archive); fs.symlinkSync(outside, archive);
    const replacement = createStaticAssets(options);
    expect(replacement.version).toBe(original.version);
    expect(fs.lstatSync(archive).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('private external contents');
    // Invalid historical digests and traversal names cannot become public immutable assets.
    const invalidVersion = '0'.repeat(32), invalidName = `web-${invalidVersion}-old.js`;
    fs.writeFileSync(path.join(options.cache, `${invalidVersion}.json`), JSON.stringify({ version: invalidVersion, files: {
      'index.html': record.files['index.html'], [invalidName]: { bytes: Buffer.from('external data').toString('base64'), digest: 'incorrect' },
    } }), { mode: 0o600 });
    expect(createStaticAssets(options).response(`/${invalidName}`, request(), {})).toBeNull();
    fs.writeFileSync(path.join(options.cache, `${invalidVersion}.json`), JSON.stringify({ version: invalidVersion, files: {
      'index.html': record.files['index.html'], '../outside.js': record.files['index.html'], [invalidName]: record.files['index.html'],
    } }), { mode: 0o600 });
    expect(createStaticAssets(options).response(`/${invalidName}`, request(), {})).toBeNull();
    fs.writeFileSync(path.join(options.assets, 'app.js'), 'export const invalid = ;');
    expect(() => createStaticAssets(options)).toThrow(/Web asset build failed \(exit=1, signal=-\):[\s\S]*Unexpected ;/);
    expect(fs.readdirSync(options.cache).some(name => name.startsWith('.build-'))).toBe(false);
  } finally { for (const dir of [root, external]) fs.rmSync(dir, { recursive: true, force: true }); }
});

test('temporary authenticated Host ships fewer cold modules, compressed immutable assets and unchanged global/project routes', async () => {
  const global = temp(), allowed = temp(), denied = temp(), calls = [];
  const password = 'loading assets regression password';
  fs.writeFileSync(path.join(global, 'web.json'), JSON.stringify({ version: 1, username: 'owner', password, projects: [allowed] }), { mode: 0o600 });
  const web = startWeb(null, 0, { env: { ...process.env, LUSH_GLOBAL_CONFIG: global }, async openProject(project) {
    calls.push(project);
    return { config: { project, home: path.join(project, '.lush') }, client: { overview: async () => ({ status: { project } }) } };
  } });
  // This assertion also protects the synchronous embedding contract.
  expect(web.port).toBeGreaterThan(0); expect(typeof web.then).toBe('undefined');
  const url = `http://127.0.0.1:${web.port}`;
  try {
    const login = await fetch(url + '/login'); expect(login.headers.get('cache-control')).toBe('no-store');
    const loggedIn = await fetch(url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'owner', password, next: '/' }).toString() });
    expect(loggedIn.status).toBe(303);
    const Cookie = loggedIn.headers.get('set-cookie').split(';')[0], headers = { Cookie };
    const page = await fetch(url + '/', { headers }); const html = await page.text();
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const entries = links(html); expect(entries).toHaveLength(3);
    expect(entries.every(name => /^\/web-[a-f0-9]{32}-/.test(name))).toBe(true);
    // Traverse authenticated static imports only, exactly as a cold ES module loader would.
    const cold = new Map(), pending = entries.filter(name => name.endsWith('.js'));
    while (pending.length) {
      const name = pending.shift(); if (cold.has(name)) continue;
      const response = await fetch(url + name, { headers }); expect(response.status).toBe(200);
      const source = await response.text(); cold.set(name, source);
      for (const imported of imports(source)) pending.push(new URL(imported, `http://localhost${name}`).pathname);
    }
    // Native source graph remains available for pre-bundle HTML, but is no longer the shipped startup graph.
    const legacyWeb = startWeb(null, 0, { authConfig: null, env: { ...process.env, LUSH_GLOBAL_CONFIG: global } });
    let legacy;
    try { legacy = await graph(`http://127.0.0.1:${legacyWeb.port}`, ['/app.js', '/appearance.js']); } finally { await legacyWeb.stop(true); }
    // User decision #410: retain the absolute 24-JS cap; the expanded workspace uses a 4x native-graph comparison.
    expect(legacy.size).toBeGreaterThan(50); expect(cold.size).toBeLessThan(25); expect(cold.size).toBeLessThan(legacy.size / 4);
    const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map(row => row[1]);
    expect(new Set(preloads)).toEqual(new Set([...cold.keys()].filter(name => !entries.includes(name))));
    const app = [...cold].find(([name]) => name.includes('-app-'))[1];
    for (const lazy of ['render-settings', 'render-agent-status', 'render-versions', 'render-inputs', 'render-model-sources']) {
      expect(app).toContain(`-${lazy}-`);
      expect([...cold.keys()].some(name => name.includes(`-${lazy}-`))).toBe(false);
    }
    for (const name of entries) {
      const identity = await fetch(url + name, { headers: { ...headers, 'Accept-Encoding': 'identity' } });
      const plain = Buffer.from(await identity.arrayBuffer());
      for (const secret of [allowed, denied, password, Cookie]) expect(plain.toString('utf8')).not.toContain(secret);
      const compressed = await fetch(url + name, { headers: { ...headers, 'Accept-Encoding': 'gzip' } });
      const zipped = Buffer.from(await compressed.arrayBuffer());
      expect(compressed.headers.get('content-encoding')).toBe('gzip');
      expect(compressed.headers.get('vary')).toBe('Accept-Encoding');
      expect(compressed.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      expect(compressed.headers.get('content-type')).toBe(name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
      expect(compressed.headers.get('content-security-policy')).toBe(page.headers.get('content-security-policy'));
      expect(gunzipSync(zipped)).toEqual(plain);
      const validator = compressed.headers.get('etag');
      const validated = await fetch(url + name, { headers: { ...headers, 'Accept-Encoding': 'gzip', 'If-None-Match': validator } });
      expect(validated.status).toBe(304); expect(await validated.text()).toBe('');
      expect((await fetch(url + name, { headers: { 'If-None-Match': validator } })).status).toBe(303);
      const again = await fetch(url + name, { headers: { ...headers, 'Accept-Encoding': 'gzip' } });
      expect(Buffer.from(await again.arrayBuffer())).toEqual(zipped);
      expect((await fetch(url + name)).status).toBe(303);
      const origin = await fetch(url + name, { headers: { ...headers, Origin: 'https://attacker.invalid' } }); expect(origin.status).toBe(403);
      const none = await fetch(url + name, { headers: { ...headers, 'Accept-Encoding': 'gzip;q=0, identity;q=0' } });
      expect(none.status).toBe(406); expect(none.headers.get('cache-control')).toBe('no-store');
    }
    expect((await fetch(url + '/app.js', { headers })).headers.get('cache-control')).toBe('no-store');
    const host = await fetch(url + '/api/host', { headers }); expect(host.headers.get('cache-control')).toBe('no-store');
    const post = project => fetch(url + '/api/host/select', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });
    expect((await post(denied)).status).toBe(400); expect((await post(allowed)).status).toBe(200);
    const prefix = `/p/${projectRouteId(allowed)}`;
    expect(await (await fetch(url + prefix + '/', { headers })).text()).toBe(html);
    expect((await fetch(url + prefix + '/api/overview', { headers })).headers.get('cache-control')).toBe('no-store');
    expect((await fetch(url + prefix + entries[0], { headers })).status).toBe(200);
    expect((await fetch(url + '/api/overview', { headers })).status).toBe(400);
    for (const name of ['/index.html', '/server.js', '/assets/app.js', '/app.mjs', '/web-00000000000000000000000000000000-app.js']) expect((await fetch(url + name, { headers })).status).toBe(404);
    expect(calls).toEqual([fs.realpathSync(allowed)]);
    console.log(`cold modules: native=${legacy.size}, bundled=${cold.size}; blocking CSS links=1`);
  } finally {
    await web.stop(true);
    for (const root of [global, allowed, denied]) fs.rmSync(root, { recursive: true, force: true });
  }
});
