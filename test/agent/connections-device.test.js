import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionManager } from '../../src/agent/connections.js';

const USER = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const POLL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const TOKEN = 'https://auth.openai.com/oauth/token';
const START = Date.parse('2026-01-10T12:00:00Z');
const fixtures = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.manager.stop(); fs.rmSync(f.root, { recursive: true }); } });
const config = (extra = {}) => ({ label: 'device account', provider: 'openai-codex', auth_type: 'oauth', models: [], ...extra });
const edit = (row, extra = {}) => { const { credential, ...value } = row; return { ...value, ...extra }; };
const device = (extra = {}) => ({ device_auth_id: 'private-device-id', user_code: 'ABCD-EFGH', interval: '5', ...extra });
const authorization = () => ({ authorization_code: 'private-code', code_verifier: 'private-verifier' });
const tokens = () => ({ access_token: `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-private' } })).toString('base64url')}.signature`, refresh_token: 'private-refresh', expires_in: 3600 });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function noSecrets(value) { for (const s of ['private-device-id','private-code','private-verifier','private-refresh','account-private']) expect(JSON.stringify(value)).not.toContain(s); }
function fixture(handle = async url => Response.json(url === USER ? device() : url === POLL ? authorization() : tokens()), options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-device-test-')), home = path.join(root, '.lush'); fs.mkdirSync(home, { mode: 0o700 });
  let now = START; const requests = [];
  const manager = new ConnectionManager({ home }, { ...options, now: () => now, fetch: async (url, init) => { requests.push({ url, init }); return handle(url, init); } });
  const f = { root, home, manager, requests, advance(ms) { now += ms; }, now: () => now }; fixtures.push(f); return f;
}
const ready = async f => { const row = f.manager.save(config()), login = await f.manager.deviceStart(row.id); f.advance(5000); return { row, login }; };

test('device start exposes only short code, official URI and bounded timing; it never reads external auth', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, 'auth.json'), 'external-secret');
  const row = f.manager.save(config()), login = await f.manager.deviceStart(row.id);
  expect(Object.keys(login).sort()).toEqual(['expires_at','id','interval_seconds','login_id','user_code','verification_uri']);
  expect(login).toMatchObject({ id: row.id, user_code: 'ABCD-EFGH', verification_uri: 'https://auth.openai.com/codex/device', interval_seconds: 5, expires_at: new Date(START + 900000).toISOString() });
  expect(f.requests).toHaveLength(1); expect(f.requests[0].url).toBe(USER);
  expect(JSON.parse(f.requests[0].init.body)).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
  expect(f.requests[0].init.redirect).toBe('error'); expect(f.manager.config().connections[0].credential.status).toBe('unconfigured');
  noSecrets(login); expect(fs.readFileSync(path.join(f.root, 'auth.json'), 'utf8')).toBe('external-secret');
});

test('server interval limits early polls; pending statuses do not read 403/404 bodies or expose IDs', async () => {
  let status = 403; const f = fixture(async url => url === USER ? Response.json(device()) : new Response('private-device-id', { status }));
  const row = f.manager.save(config()), login = await f.manager.deviceStart(row.id);
  const early = await f.manager.devicePoll(row.id, login.login_id); expect(early.status).toBe('pending'); expect(f.requests).toHaveLength(1); noSecrets(early);
  f.advance(5000); expect((await f.manager.devicePoll(row.id, login.login_id)).status).toBe('pending'); expect(f.requests).toHaveLength(2);
  expect(JSON.parse(f.requests[1].init.body)).toEqual({ device_auth_id: 'private-device-id', user_code: 'ABCD-EFGH' });
  status = 404; expect((await f.manager.devicePoll(row.id, login.login_id)).status).toBe('pending'); expect(f.requests).toHaveLength(2);
  f.advance(5000); expect((await f.manager.devicePoll(row.id, login.login_id)).status).toBe('pending'); expect(f.requests).toHaveLength(3);
});

test('pending OAuth errors and slow_down use bounded server-side backoff without raw errors', async () => {
  let code = 'deviceauth_authorization_pending';
  const f = fixture(async url => url === USER ? Response.json(device()) : Response.json({ error: { code }, detail: 'private-code' }, { status: 400 }));
  const { row, login } = await ready(f);
  expect((await f.manager.devicePoll(row.id, login.login_id)).interval_seconds).toBe(5);
  code = 'slow_down'; f.advance(5000); const slow = await f.manager.devicePoll(row.id, login.login_id); expect(slow.interval_seconds).toBe(10); noSecrets(slow);
  f.advance(5000); await f.manager.devicePoll(row.id, login.login_id); expect(f.requests).toHaveLength(3);
  f.advance(5000); code = 'authorization_pending'; expect((await f.manager.devicePoll(row.id, login.login_id)).interval_seconds).toBe(10); expect(f.requests).toHaveLength(4);
});

test('successful authorization exchanges once using fixed device redirect and private storage; replay is safe', async () => {
  const f = fixture(), { row, login } = await ready(f);
  const result = await f.manager.devicePoll(row.id, login.login_id);
  expect(result.status).toBe('complete'); expect(result.connection.credential.status).toBe('configured'); noSecrets(result);
  expect(f.requests.map(r => r.url)).toEqual([USER, POLL, TOKEN]);
  expect(f.requests[2].init.body.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
  expect(f.requests[2].init.body.get('code')).toBe('private-code'); expect(f.requests[2].init.body.get('code_verifier')).toBe('private-verifier');
  expect(f.requests[2].init.body.get('grant_type')).toBe('authorization_code');
  expect(await f.manager.devicePoll(row.id, login.login_id)).toEqual(result); expect(f.requests).toHaveLength(3);
  const session = f.manager.devices.sessions.get(login.login_id); expect(session).not.toHaveProperty('deviceAuthId'); expect(session).not.toHaveProperty('userCode');
  expect(fs.statSync(f.manager.file.file).mode & 0o777).toBe(0o600);
  expect((await f.manager.prepareRuntime(row.id)).credential.refresh).toBe('private-refresh');
  f.advance(60001); expect(() => f.manager.devicePoll(row.id, login.login_id)).toThrow('Connection operation unavailable');
  expect(f.manager.devices.sessions.size).toBe(0);
});

test('concurrent polls single-flight both device check and token exchange', async () => {
  const entered = gate(), release = gate(); const f = fixture(async url => {
    if (url === USER) return Response.json(device());
    if (url === TOKEN) { entered.resolve(); await release.promise; return Response.json(tokens()); }
    return Response.json(authorization());
  });
  const { row, login } = await ready(f), first = f.manager.devicePoll(row.id, login.login_id); await entered.promise;
  const second = f.manager.devicePoll(row.id, login.login_id); expect(second).toBe(first); release.resolve();
  expect(await first).toEqual(await second); expect(f.requests.map(r => r.url)).toEqual([USER, POLL, TOKEN]);
});

test('429 slow_down and zero-string interval are supported without increasing request frequency', async () => {
  const f=fixture(async url=>url===USER ? Response.json(device({interval:'0'})) : Response.json({error:'slow_down'}, {status:429}));
  const row=f.manager.save(config()),login=await f.manager.deviceStart(row.id);expect(login.interval_seconds).toBe(1);
  f.advance(1000);const pending=await f.manager.devicePoll(row.id,login.login_id);expect(pending.interval_seconds).toBe(6);
  f.advance(1000);await f.manager.devicePoll(row.id,login.login_id);expect(f.requests).toHaveLength(2);
});

test('cancelling an in-flight device check prevents later authorization-code exchange', async () => {
  const entered=gate(),release=gate();const f=fixture(async url=>{
    if(url===USER)return Response.json(device());entered.resolve();await release.promise;return Response.json(authorization());
  });
  const {row,login}=await ready(f),result=f.manager.devicePoll(row.id,login.login_id).then(value=>({value}),error=>({error}));
  await entered.promise;f.manager.deviceCancel(row.id,login.login_id);release.resolve();expect((await result).error).toBeDefined();
  expect(f.requests.map(r=>r.url)).toEqual([USER,POLL]);expect(f.manager.config().connections[0].credential.status).toBe('unconfigured');
});

test('cancel is idempotent and cannot cancel a different connection; no later network check', async () => {
  const f = fixture(), { row, login } = await ready(f); const other = f.manager.save(config());
  expect(() => f.manager.deviceCancel(other.id, login.login_id)).toThrow(); expect(f.manager.devices.sessions.size).toBe(1);
  expect(f.manager.deviceCancel(row.id, login.login_id)).toEqual({ id: row.id, login_id: login.login_id, status: 'cancelled' });
  expect(f.manager.deviceCancel(row.id, login.login_id).status).toBe('cancelled');
  expect(() => f.manager.devicePoll(row.id, login.login_id)).toThrow(); expect(f.requests).toHaveLength(1);
});

test('cancelling an old login ID cannot cancel a new session on the same connection', async () => {
  const f = fixture(), { row, login } = await ready(f), newer = await f.manager.deviceStart(row.id);
  expect(f.manager.deviceCancel(row.id, login.login_id).status).toBe('cancelled');
  expect(f.manager.devices.sessions.size).toBe(1); expect(f.manager.devices.sessions.has(newer.login_id)).toBe(true);
  f.advance(5000); expect((await f.manager.devicePoll(row.id, newer.login_id)).status).toBe('complete');
});

for (const change of ['cancel','save','remove','new_device','new_browser','external_change','credential_change','stop','expire']) {
  test(`late successful token exchange cannot write after ${change}`, async () => {
    const entered = gate(), release = gate(); const f = fixture(async url => {
      if (url === USER) return Response.json(device());
      if (url === TOKEN) { entered.resolve(); await release.promise; return Response.json(tokens()); }
      return Response.json(authorization());
    });
    const { row, login } = await ready(f), result = f.manager.devicePoll(row.id, login.login_id).then(value => ({ value }), error => ({ error })); await entered.promise;
    let stopped;
    if (change === 'cancel') f.manager.deviceCancel(row.id, login.login_id);
    if (change === 'save') f.manager.save(edit(row, { label: 'changed' }));
    if (change === 'remove') f.manager.remove(row.id);
    if (change === 'new_device') await f.manager.deviceStart(row.id);
    if (change === 'new_browser') f.manager.loginStart(row.id);
    if (change === 'external_change') f.manager.file.transaction(data => { data.connections[0].label = 'external update'; });
    if (change === 'credential_change') f.manager.file.transaction(data => { data.connections[0].credential = {
      type: 'oauth', access: tokens().access_token, refresh: 'replacement-refresh', expires: f.now() + 3600000, accountId: 'account-private',
    }; });
    if (change === 'stop') stopped = f.manager.stop();
    if (change === 'expire') f.advance(900001);
    release.resolve(); const outcome = await result; expect(outcome.error).toBeDefined(); noSecrets({ message: outcome.error.message });
    if (stopped) await stopped;
    if (change === 'credential_change') expect(f.manager.file.read().connections[0].credential.refresh).toBe('replacement-refresh');
    else expect(f.manager.config().connections.every(c => c.credential.status === 'unconfigured')).toBe(true);
  });
}

test('a new device session invalidates an already consumed browser callback exchange', async () => {
  const entered = gate(), release = gate(); const f = fixture(async url => {
    if (url === USER) return Response.json(device()); entered.resolve(); await release.promise; return Response.json(tokens());
  });
  const row = f.manager.save(config()), login = f.manager.loginStart(row.id), state = new URL(login.url).searchParams.get('state');
  const result = f.manager.loginFinish(row.id, login.login_id, `${login.redirect_uri}?code=private-code&state=${state}`).then(value => ({ value }), error => ({ error }));
  await entered.promise; await f.manager.deviceStart(row.id); release.resolve();
  expect((await result).error).toBeDefined(); expect(f.manager.config().connections[0].credential.status).toBe('unconfigured');
});

for (const change of ['new_browser', 'new_device', 'remove']) {
  test(`device start still requesting a short code cannot publish after ${change}`, async () => {
    const entered = gate(), release = gate(); let requests = 0;
    const f = fixture(async () => { requests++; if (requests === 1) { entered.resolve(); await release.promise; } return Response.json(device()); });
    const row = f.manager.save(config()), first = f.manager.deviceStart(row.id).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    let newer;
    if (change === 'new_browser') newer = f.manager.loginStart(row.id);
    if (change === 'new_device') newer = await f.manager.deviceStart(row.id);
    if (change === 'remove') f.manager.remove(row.id);
    release.resolve(); const outcome = await first; expect(outcome.error).toBeDefined();
    expect(outcome.error.message).not.toContain('ABCD-EFGH'); noSecrets({ message: outcome.error.message });
    if (change === 'new_device') expect([...f.manager.devices.sessions.keys()]).toEqual([newer.login_id]);
    else expect(f.manager.devices.sessions.size).toBe(0);
    if (change === 'new_browser') expect([...f.manager.logins.keys()]).toEqual([newer.login_id]);
    expect(f.manager.config().connections.every(c => c.credential.status === 'unconfigured')).toBe(true);
  });
}

test('new browser or concurrent device starts reject stale in-flight device-code responses', async () => {
  const entered = gate(), release = gate(); let calls = 0;
  const f = fixture(async () => { calls++; if (calls === 1) { entered.resolve(); await release.promise; } return Response.json(device()); });
  const row = f.manager.save(config()), first = f.manager.deviceStart(row.id).then(value => ({ value }), error => ({ error })); await entered.promise;
  const second = await f.manager.deviceStart(row.id); release.resolve(); expect((await first).error).toBeDefined();
  expect(f.manager.devices.sessions.size).toBe(1); expect(f.manager.devices.sessions.has(second.login_id)).toBe(true);
  f.manager.loginStart(row.id); expect(f.manager.devices.sessions.size).toBe(0);
});

for (const invalid of [device({ device_auth_id: '' }), device({ user_code: '<script>' }), device({ interval: 'junk' }), device({ interval: null }), device({ interval: '' }), device({ interval: -1 }), device({ interval: 301 })]) {
  test(`invalid start response fails closed ${JSON.stringify(invalid)}`, async () => {
    const f = fixture(async () => Response.json(invalid)), row = f.manager.save(config());
    await expect(f.manager.deviceStart(row.id)).rejects.toThrow('Connection operation unavailable'); expect(f.manager.devices.sessions.size).toBe(0);
  });
}

for (const response of [
  () => Response.json({ error: 'expired_token', detail: 'private-code' }, { status: 400 }),
  () => Response.json({ error: 'access_denied', detail: 'private-code' }, { status: 400 }),
  () => Response.json({ error: 'unrecognized', detail: 'private-code' }, { status: 429 }),
  () => Response.json({ authorization_code: 'private-code' }),
  () => new Response('private-code', { status: 500 }),
  () => new Response('private-code', { status: 302, headers: { location: 'https://evil.invalid' } }),
]) {
  test('failed device authorization never exchanges or leaks upstream response and cannot be replayed', async () => {
    const f = fixture(async url => url === USER ? Response.json(device()) : response()), { row, login } = await ready(f);
    try { await f.manager.devicePoll(row.id, login.login_id); throw new Error('expected failure'); } catch (error) { expect(error.message).toBe('Connection operation unavailable'); noSecrets({ message: error.message }); }
    expect(f.requests).toHaveLength(2); expect(() => f.manager.devicePoll(row.id, login.login_id)).toThrow(); expect(f.manager.config().connections[0].credential.status).toBe('unconfigured');
  });
}

test('bounded device errors reject oversized response bodies; complete body deadline also applies', async () => {
  const f = fixture(async url => url === USER ? Response.json(device()) : new Response('x'.repeat(65537), { status: 400 }));
  const { row, login } = await ready(f); await expect(f.manager.devicePoll(row.id, login.login_id)).rejects.toThrow();
  const hang = fixture(async url => url === USER ? Response.json(device()) : new Response(new ReadableStream({ start() {} }), { status: 400 }), { timeout: 5 });
  const readyHang = await ready(hang); await expect(hang.manager.devicePoll(readyHang.row.id, readyHang.login.login_id)).rejects.toThrow('Connection operation unavailable');
  expect(hang.manager.devices.sessions.size).toBe(0);
});

test('expiry is enforced before checking upstream; only Codex supports device login', async () => {
  const f = fixture(), { row, login } = await ready(f); f.advance(900000);
  expect(() => f.manager.devicePoll(row.id, login.login_id)).toThrow(); expect(f.requests).toHaveLength(1);
  const apiRow = f.manager.save({ ...config(), provider: 'deepseek', auth_type: 'api_key' });
  await expect(f.manager.deviceStart(apiRow.id)).rejects.toThrow('does not support device login'); expect(f.requests).toHaveLength(1);
});
