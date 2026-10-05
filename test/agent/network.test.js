import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { requestJson } from '../../src/agent/connections-utils.js';
import { spawn } from 'node:child_process';
import { readNetworkConfiguration, saveNetworkConfiguration, networkSnapshot, agentNetworkEnvironment, mergeNetworkEnvironment, redactNetworkText } from '../../src/agent/network.js';

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const configuration = (mode = 'proxy', extra = {}) => ({ version: 1, mode, proxy_url: mode === 'proxy' ? 'http://127.0.0.1:7897' : null, no_proxy: [], ...extra });
function fixture(env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-network-test-')), home = path.join(root, '.lush');
  fs.mkdirSync(home, { mode: 0o700 }); cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, env, file: path.join(home, 'network.json') };
}
async function server(handle, connect = null) {
  const service = http.createServer(handle); if (connect) service.on('connect', connect);
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise(resolve => { service.closeAllConnections(); service.close(resolve); }));
  return { service, url: `http://127.0.0.1:${service.address().port}` };
}
function child(source, variables = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(name)) delete env[name];
    const proc = spawn(process.execPath, ['-e', source], { env: { ...env, ...variables }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => stdout += data); proc.stderr.on('data', data => stderr += data);
    proc.on('error', reject); proc.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`fixture ${code}: ${stderr}`)));
  });
}

test('private network config defaults, modes, canonical origin and write-only auth retention', () => {
  const f = fixture(); expect(readNetworkConfiguration(f)).toEqual({ ...configuration('inherit'), has_proxy_auth: false });
  const saved = saveNetworkConfiguration(f, configuration('proxy', { proxy_auth: { username: 'PRIVATE-USER', password: 'PRIVATE-PASSWORD' } }));
  expect(saved.proxy_url).toBe('http://127.0.0.1:7897'); expect(saved.has_proxy_auth).toBe(true);
  for (const value of [saved, readNetworkConfiguration(f)]) expect(JSON.stringify(value)).not.toContain('PRIVATE');
  expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
  expect(saveNetworkConfiguration(f, configuration()).has_proxy_auth).toBe(true);
  expect(saveNetworkConfiguration(f, configuration('proxy', { proxy_url: 'http://another.example:1234' })).has_proxy_auth).toBe(false);
  saveNetworkConfiguration(f, configuration('proxy', { proxy_auth: { username: 'u', password: 'p' } }));
  expect(saveNetworkConfiguration(f, configuration('direct')).has_proxy_auth).toBe(false);
  expect(networkSnapshot(f).route('https://openai.example')).toBe('');
  expect(saveNetworkConfiguration(f, configuration('inherit')).mode).toBe('inherit');
});

test('invalid input and unsafe alias/permission states never disclose credentials or remove busy locks', () => {
  const f = fixture();
  for (const bad of [configuration('unknown'), configuration('proxy', { proxy_url: 'socks5://PRIVATE:1234' }),
    configuration('proxy', { proxy_url: 'http://PRIVATE:SECRET@proxy.example' }), configuration('proxy', { no_proxy: ['https://PRIVATE.example'] }),
    configuration('proxy', { no_proxy: ['example.com:65536'] }), configuration('proxy', { proxy_auth: { username: 'PRIVATE\n', password: 'SECRET' } }),
    { ...configuration(), extra: 'SECRET' }]) {
    expect(() => saveNetworkConfiguration(f, bad)).toThrow('Invalid outbound network');
    expect(fs.existsSync(path.join(f.home, 'network.lock'))).toBe(false);
  }
  const outside = path.join(f.root, 'external'); fs.writeFileSync(outside, 'PRIVATE', { mode: 0o600 });
  fs.symlinkSync(outside, f.file); expect(() => readNetworkConfiguration(f)).toThrow('Invalid outbound network');
  expect(() => saveNetworkConfiguration(f, configuration())).toThrow('Invalid outbound network'); fs.unlinkSync(f.file);
  fs.linkSync(outside, f.file); expect(() => readNetworkConfiguration(f)).toThrow(); fs.unlinkSync(f.file);
  saveNetworkConfiguration(f, configuration()); fs.chmodSync(f.file, 0o644); expect(() => readNetworkConfiguration(f)).toThrow(); fs.chmodSync(f.file, 0o600);
  fs.mkdirSync(path.join(f.home, 'network.lock')); expect(() => saveNetworkConfiguration(f, configuration())).toThrow();
  expect(fs.existsSync(path.join(f.home, 'network.lock'))).toBe(true); fs.rmdirSync(path.join(f.home, 'network.lock'));
  fs.chmodSync(f.home, 0o755); expect(() => readNetworkConfiguration(f)).toThrow(); fs.chmodSync(f.home, 0o700);
});

test('NO_PROXY uses domain/port boundaries and always bypasses local addresses', () => {
  const f = fixture(); saveNetworkConfiguration(f, configuration('proxy', { no_proxy: ['.example.com:443', '[2001:db8::1]:8443', 'other.test'] }));
  const network = networkSnapshot(f);
  for (const url of ['https://example.com', 'https://sub.example.com', 'https://[2001:db8::1]:8443', 'http://sub.other.test',
    'https://localhost', 'http://a.localhost', 'http://127.55.0.1:9999', 'https://[::1]']) expect(network.route(url)).toBe('');
  for (const url of ['http://example.com', 'https://notexample.com', 'https://example.com:444', 'https://[2001:db8::1]', 'https://other.test.evil']) expect(network.route(url)).toBeTruthy();
  saveNetworkConfiguration(f, configuration('proxy', { no_proxy: ['*'] })); expect(networkSnapshot(f).route('https://anything.example')).toBe('');
});

test('daemon inheritance rejects SOCKS-only; explicit modes and role/Worker case overrides are independent', () => {
  const f = fixture({ HTTPS_PROXY: 'http://daemon.example:80', HTTP_PROXY: 'http://http.example', ALL_PROXY: 'socks5://unused.example', NO_PROXY: 'daemon-bypass.example' });
  expect(networkSnapshot(f).route('https://openai.example')).toBe('http://daemon.example:80');
  expect(() => networkSnapshot(fixture({ ALL_PROXY: 'socks5://unsupported.example' })).route('https://official.example')).toThrow();
  expect(networkSnapshot(f).route('https://daemon-bypass.example')).toBe('');
  saveNetworkConfiguration(f, configuration());
  const env = agentNetworkEnvironment(f, { https_proxy: 'http://role.example', no_proxy: 'role-bypass.example' }, { HTTPS_PROXY: 'http://worker.example' });
  expect(env.https_proxy).toBe('http://worker.example'); expect(env.HTTPS_PROXY).toBe(env.https_proxy);
  expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7897/'); expect(env.ALL_PROXY).toBe('');
  expect(env.no_proxy).toContain('role-bypass.example'); expect(env.NO_PROXY).toContain('127.0.0.1');
  expect(mergeNetworkEnvironment({ http_proxy: 'old' }, { HTTP_PROXY: 'new' }).http_proxy).toBe('new');
  saveNetworkConfiguration(f, configuration('direct'));
  expect(agentNetworkEnvironment(f).HTTPS_PROXY).toBe(''); expect(agentNetworkEnvironment(f).ALL_PROXY).toBe('');
  expect(agentNetworkEnvironment(f, { https_proxy: 'http://explicit.example' }).HTTPS_PROXY).toBe('http://explicit.example');
});

test('snapshots freeze routing/auth while subsequent requests hot-read new project state', async () => {
  const f = fixture(); saveNetworkConfiguration(f, configuration('proxy', { proxy_auth: { username: 'private', password: 'p@ss' } }));
  const before = networkSnapshot(f); saveNetworkConfiguration(f, configuration('proxy', { proxy_url: 'https://new.example:9443' }));
  const after = networkSnapshot(f); expect(before.key).not.toBe(after.key);
  expect(before.route('https://official.example')).toContain('private:p%40ss@');
  expect(after.route('https://official.example')).toBe('https://new.example:9443/');
  const observed = []; await before.fetch('https://official.example', { method: 'POST' }, async (url, init) => { observed.push(init.proxy); return Response.json({}); });
  expect(observed[0]).toContain('private');
  const other = fixture(); expect(readNetworkConfiguration(other).mode).toBe('inherit');
});

test('real transport overrides Bun process proxy/NO_PROXY, authenticates proxy only and never falls back', async () => {
  const requests = [];
  const proxy = await server((request, response) => { requests.push({ url: request.url, headers: request.headers }); response.end('proxy-ok'); });
  const direct = await server((request, response) => response.end('direct-ok'));
  const f = fixture(); saveNetworkConfiguration(f, configuration('proxy', { proxy_url: proxy.url, proxy_auth: { username: 'private-user', password: 'private-password' } }));
  const module = new URL('../../src/agent/network.js', import.meta.url).href;
  const result = await child(`import {networkSnapshot} from ${JSON.stringify(module)};const n=networkSnapshot({home:${JSON.stringify(f.home)},env:process.env});console.log(JSON.stringify({body:await(await n.fetch('http://destination.invalid/path',{headers:{Authorization:'origin-token'},signal:AbortSignal.timeout(2000)})).text()}));`, { HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '*' });
  expect(result.body).toBe('proxy-ok'); expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('http://destination.invalid/path'); expect(requests[0].headers.authorization).toBe('origin-token');
  expect(requests[0].headers['proxy-authorization']).toBe(`Basic ${Buffer.from('private-user:private-password').toString('base64')}`);
  saveNetworkConfiguration(f, configuration('direct'));
  const local = await child(`import {networkSnapshot} from ${JSON.stringify(module)};const n=networkSnapshot({home:${JSON.stringify(f.home)},env:process.env});console.log(JSON.stringify({body:await(await n.fetch(${JSON.stringify(direct.url)},{signal:AbortSignal.timeout(2000)})).text()}));`, { HTTP_PROXY: proxy.url, NO_PROXY: '' });
  expect(local.body).toBe('direct-ok'); expect(requests).toHaveLength(1);
  saveNetworkConfiguration(f, configuration('proxy', { proxy_url: 'http://127.0.0.1:1' }));
  await expect(networkSnapshot(f).fetch('http://destination.invalid', { signal: AbortSignal.timeout(1000) })).rejects.toThrow('Outbound network request failed');
  expect(requests).toHaveLength(1);
});

test('CONNECT sends proxy authentication separately and rejects denied tunnels without TLS fallback', async () => {
  const requests = [];
  const proxy = await server((request, response) => { response.writeHead(500); response.end(); }, (request, socket) => {
    requests.push({ url: request.url, headers: request.headers }); socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  const f = fixture(); saveNetworkConfiguration(f, configuration('proxy', { proxy_url: proxy.url, proxy_auth: { username: 'u', password: 'p' } }));
  await expect(networkSnapshot(f).fetch('https://official.invalid', { headers: { Authorization: 'private-origin' }, signal: AbortSignal.timeout(2000) })).rejects.toThrow('Outbound network request failed');
  expect(requests).toHaveLength(1); expect(requests[0].url).toBe('official.invalid:443');
  expect(requests[0].headers.authorization).toBeUndefined(); expect(requests[0].headers['proxy-authorization']).toBe('Basic dTpw');
});

test('real HTTP/HTTPS CONNECT preserves origin TLS verification and separates proxy/origin credentials', async () => {
  // Public, disposable test certificate/key; trusted only by these isolated test children.
  const certificate = fileURLToPath(new URL('./network-test-cert.pem', import.meta.url));
  const tlsOptions = { cert: fs.readFileSync(certificate), key: fs.readFileSync(new URL('./network-test-key.pem', import.meta.url)) };
  const originRequests = [], originSNI = [], tunnels = [], sockets = new Set();
  const origin = https.createServer(tlsOptions, (request, response) => {
    originRequests.push(request.headers); originSNI.push(request.socket.servername); response.end('tls-origin-ok');
  });
  const listen = async service => {
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); service.closeAllConnections(); service.close(resolve); }));
  };
  await listen(origin);
  const connect = (request, downstream, head) => {
    tunnels.push(request.headers); sockets.add(downstream); downstream.on('close', () => sockets.delete(downstream));
    const upstream = net.connect(origin.address().port, '127.0.0.1'); sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.once('connect', () => { downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); downstream.pipe(upstream); upstream.pipe(downstream); });
    upstream.on('error', () => downstream.destroy()); downstream.on('error', () => upstream.destroy());
    downstream.once('close', () => upstream.destroy()); upstream.once('close', () => downstream.destroy());
  };
  const plain = http.createServer(), encrypted = https.createServer(tlsOptions); plain.on('connect', connect); encrypted.on('connect', connect);
  await listen(plain); await listen(encrypted);
  const f = fixture(), module = new URL('../../src/agent/network.js', import.meta.url).href;
  const code = `import {networkSnapshot} from ${JSON.stringify(module)};const n=networkSnapshot({home:${JSON.stringify(f.home)},env:process.env});console.log(JSON.stringify({body:await(await n.fetch('https://outbound-network.fixture.invalid/data',{headers:{Authorization:'origin-secret'},signal:AbortSignal.timeout(2000)})).text()}));`;
  for (const [protocol, service] of [['http', plain], ['https', encrypted]]) {
    saveNetworkConfiguration(f, configuration('proxy', { proxy_url: `${protocol}://127.0.0.1:${service.address().port}`, proxy_auth: { username: 'proxy-user', password: 'proxy-password' } }));
    expect((await child(code, { NODE_EXTRA_CA_CERTS: certificate, NO_PROXY: '*' })).body).toBe('tls-origin-ok');
  }
  expect(originRequests).toHaveLength(2); expect(tunnels).toHaveLength(2);
  expect(originSNI).toEqual(['outbound-network.fixture.invalid', 'outbound-network.fixture.invalid']);
  for (const headers of originRequests) { expect(headers.authorization).toBe('origin-secret'); expect(headers['proxy-authorization']).toBeUndefined(); }
  for (const headers of tunnels) { expect(headers.authorization).toBeUndefined(); expect(headers['proxy-authorization']).toBe(`Basic ${Buffer.from('proxy-user:proxy-password').toString('base64')}`); }
  saveNetworkConfiguration(f, configuration('proxy', { proxy_url: `http://127.0.0.1:${plain.address().port}` }));
  await expect(child(code.replaceAll('outbound-network.fixture.invalid', 'wrong-network.fixture.invalid'), { NODE_EXTRA_CA_CERTS: certificate })).rejects.toThrow('Outbound network request failed');
  expect(originRequests).toHaveLength(2); // A trusted chain with the wrong destination hostname must also fail.
  await expect(networkSnapshot(f).fetch('https://outbound-network.fixture.invalid/data', { signal: AbortSignal.timeout(2000) })).rejects.toThrow('Outbound network request failed');
  expect(originRequests).toHaveLength(2); // Untrusted TLS must not send the origin request or retry direct.
});

test('cancellation and total request deadline destroy stalled CONNECT and TLS handshakes', async () => {
  const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const bounded = promise => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handshake fixture did not close')), 2000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  for (const stage of ['CONNECT', 'TLS']) for (const termination of ['cancel', 'deadline']) {
    const entered = gate(), closed = gate(); let socket;
    const proxy = await server((request, response) => response.end(), (request, connected) => {
      socket = connected; socket.once('close', closed.resolve); socket.once('end', () => socket.end()); socket.on('error', () => {}); socket.resume();
      if (stage === 'TLS') socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      entered.resolve(); // No CONNECT response or no TLS ServerHello: the request cannot complete normally.
    });
    cleanups.push(() => socket?.destroy());
    const f = fixture(); saveNetworkConfiguration(f, configuration('proxy', { proxy_url: proxy.url }));
    const snapshot = networkSnapshot(f), controller = new AbortController();
    const pending = termination === 'cancel'
      ? snapshot.fetch('https://stalled-handshake.invalid', { signal: controller.signal }).then(() => null, error => error)
      : requestJson('https://stalled-handshake.invalid', {}, { fetch: (url, init) => snapshot.fetch(url, init), timeout: 1000 }).then(() => null, error => error);
    await bounded(entered.promise);
    if (termination === 'cancel') controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    if (termination === 'deadline') expect(error.connectionCode).toBe('timeout');
    else expect(error.message).toBe('Outbound network request failed');
    await bounded(closed.promise); expect(socket.destroyed).toBe(true);
  }
});

test('CLI diagnostics scrub authenticated proxy addresses, raw/encoded userinfo and Basic auth', () => {
  const env = { HTTPS_PROXY: 'http://private-user:p%40ssword@proxy.example/' };
  const text = `${env.HTTPS_PROXY} private-user p%40ssword p@ssword ${Buffer.from('private-user:p@ssword').toString('base64')}`;
  const safe = redactNetworkText(env, text);
  expect(safe).not.toContain('private-user'); expect(safe).not.toContain('p@ssword'); expect(safe).not.toContain('p%40ssword');
  expect(safe).toContain('[redacted]');
});

test('production gzip responses retain decompressed size bounds and never follow redirects', async () => {
  let mode = 'ok';
  const proxy = await server((request, response) => {
    if (mode === 'redirect') { response.writeHead(302, { Location: 'https://never-follow.invalid' }); response.end(); return; }
    const body = gzipSync(JSON.stringify(mode === 'ok' ? { ok: true } : { value: 'x'.repeat(70000) }));
    response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': String(body.length), 'Content-Type': 'application/json' }); response.end(body);
  });
  const f = fixture(); saveNetworkConfiguration(f, configuration('proxy', { proxy_url: proxy.url }));
  const snapshot = networkSnapshot(f), options = { fetch: (url, init) => snapshot.fetch(url, init), timeout: 1000 };
  expect(await requestJson('http://gzip.invalid', {}, options)).toEqual({ ok: true });
  mode = 'large';
  try { await requestJson('http://gzip.invalid', {}, options); throw new Error('expected bound'); } catch (error) { expect(error.connectionCode).toBe('invalid_response'); }
  mode = 'redirect';
  try { await requestJson('http://gzip.invalid', {}, options); throw new Error('expected redirect refusal'); } catch (error) { expect(error.connectionCode).toBe('network'); }
});

test('transport body deadlines and cancellation terminate slow proxy streams', async () => {
  const proxy = await server((request, response) => { response.writeHead(200); response.write('{'); });
  const f = fixture(); saveNetworkConfiguration(f, configuration('proxy', { proxy_url: proxy.url }));
  const response = await networkSnapshot(f).fetch('http://slow.invalid', { signal: AbortSignal.timeout(30) });
  await expect(response.text()).rejects.toThrow();
});
