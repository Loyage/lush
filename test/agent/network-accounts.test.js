import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionManager } from '../../src/agent/connections.js';
import { saveNetworkConfiguration } from '../../src/agent/network.js';
import { discoverAgentUsage } from '../../src/agent/status.js';

const proxy = address => ({ version: 1, mode: 'proxy', proxy_url: `http://${address}`, no_proxy: [] });
const codex = () => ({ label: 'network account', provider: 'openai-codex', auth_type: 'oauth', models: [] });
const access = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'private-account' } })).toString('base64url')}.signature`;
const tokens = () => ({ access_token: access, refresh_token: 'private-refresh', expires_in: 3600 });
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-network-account-')), home = path.join(root, '.lush'); fs.mkdirSync(home, { mode: 0o700 });
  return { root, home, env: {}, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('device, callback, token refresh and quota paths all use fixed login or newly captured project routing', async () => {
  const f = world(), requests = []; let now = Date.now();
  const manager = new ConnectionManager(f, { now: () => now, fetch: async (url, init) => {
    requests.push({ url, proxy: init.proxy });
    if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'private-device', user_code: 'ABCD-EFGH', interval: 1 });
    if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'private-code', code_verifier: 'private-verifier' });
    if (url.endsWith('/oauth/token')) return Response.json(tokens());
    return Response.json({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } });
  } });
  try {
    saveNetworkConfiguration(f, proxy('first.example:8080'));
    const row = manager.save(codex()), device = await manager.deviceStart(row.id);
    saveNetworkConfiguration(f, proxy('second.example:8080')); now += 1000;
    expect((await manager.devicePoll(row.id, device.login_id)).status).toBe('complete');
    expect(requests.map(row => row.proxy)).toEqual(Array(3).fill('http://first.example:8080/'));
    await manager.query(row.id); expect(requests.at(-1).proxy).toBe('http://second.example:8080/');
    now += 3600000; await manager.prepareRuntime(row.id);
    expect(requests.at(-1)).toMatchObject({ proxy: 'http://second.example:8080/', url: 'https://auth.openai.com/oauth/token' });
    const browser = manager.loginStart(row.id), state = new URL(browser.url).searchParams.get('state');
    saveNetworkConfiguration(f, proxy('third.example:8080'));
    await manager.loginFinish(row.id, browser.login_id, `${browser.redirect_uri}?code=private-code&state=${state}`);
    expect(requests.at(-1).proxy).toBe('http://second.example:8080/');
    await manager.query(row.id); expect(requests.at(-1).proxy).toBe('http://third.example:8080/');
  } finally { await manager.stop(); f.close(); }
});

test('legacy quota and OAuth refresh use project network, and changed network invalidates query single-flight', async () => {
  const f = world(), configDir = path.join(f.root, 'pi'); fs.mkdirSync(configDir, { mode: 0o700 });
  const config = { ...f, project: f.root, env: { PI_CODING_AGENT_DIR: configDir } }, profile = { agent: 'pi', model: 'openai-codex/test' };
  const file = path.join(configDir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify({ 'openai-codex': { type: 'oauth', access, refresh: 'private-refresh', expires: Date.now() - 1000, accountId: 'private-account' } }), { mode: 0o600 });
  const requests = []; let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const options = { usageConfig: { providers: ['openai-codex'], custom: [] }, fetch: async (url, init) => {
    requests.push({ url, proxy: init.proxy });
    if (url.endsWith('/oauth/token')) return Response.json(tokens());
    if (requests.filter(row => row.url.endsWith('/wham/usage')).length === 1) { entered(); await gate; }
    return Response.json({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } } });
  } };
  try {
    saveNetworkConfiguration(f, proxy('first.example:8080'));
    const first = discoverAgentUsage(config, profile, options); await waiting;
    const same = discoverAgentUsage(config, profile, options);
    // The credential refresh changed the query identity; establish stable concurrent identity after it.
    saveNetworkConfiguration(f, proxy('second.example:8080'));
    const next = discoverAgentUsage(config, profile, options);
    release(); const [a, b] = await Promise.all([first, next]); await same;
    expect(a.query_id).not.toBe(b.query_id);
    expect(requests[0]).toMatchObject({ url: 'https://auth.openai.com/oauth/token', proxy: 'http://first.example:8080/' });
    expect(requests.some(row => row.url.endsWith('/wham/usage') && row.proxy === 'http://second.example:8080/')).toBe(true);
    expect(JSON.stringify(a)).not.toContain('first.example'); expect(JSON.stringify(b)).not.toContain('private-refresh');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  } finally { release?.(); f.close(); }
});
