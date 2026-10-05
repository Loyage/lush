import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { AgentConnectionsService } from '../../src/core/agent-connections.js';
import { setup, fetch } from './harness.js';

// Real HTTP -> RPC -> Project -> Service -> Manager -> private file; only issuer traffic is mocked.
test('Codex device login traverses production HTTP/RPC and persists credentials without exposing secrets', async () => {
  const f = await setup(); let now = Date.parse('2026-01-10T12:00:00Z'); const requests = [];
  const access = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'private-account' } })).toString('base64url')}.signature`;
  f.project.agentConnections = new AgentConnectionsService(f.project, { now: () => now, managerOptions: {
    now: () => now, fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'private-device-id', user_code: 'ABCD-EFGH', interval: '5' });
      if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'private-code', code_verifier: 'private-verifier' });
      if (url === 'https://auth.openai.com/oauth/token') return Response.json({ access_token: access, refresh_token: 'private-refresh', expires_in: 3600 });
      throw new Error('unexpected destination');
    },
  } });
  const action = async (method, params) => {
    const response = await fetch(`${f.url}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json();
    for (const secret of ['private-device-id', 'private-code', 'private-verifier', 'private-refresh', 'private-account', access]) expect(JSON.stringify(result)).not.toContain(secret);
    return result;
  };
  try {
    const row = await action('agent.connections.save', { connection: { label: 'Codex test', provider: 'openai-codex', auth_type: 'oauth', models: [] } });
    const login = await action('agent.connections.device.start', { id: row.id });
    expect(login.verification_uri).toBe('https://auth.openai.com/codex/device'); expect(login.user_code).toBe('ABCD-EFGH');
    const params = { id: row.id, login_id: login.login_id };
    expect((await action('agent.connections.device.poll', params)).status).toBe('pending'); expect(requests).toHaveLength(1);
    now += 5000;
    const completed = await action('agent.connections.device.poll', params); expect(completed.status).toBe('complete');
    expect(completed.connection.credential.status).toBe('configured');
    expect((await action('agent.connections.device.poll', params)).status).toBe('complete'); expect(requests).toHaveLength(3);
    expect(requests[2].init.body.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
    const list = await (await fetch(`${f.url}/api/agent/connections`)).json();
    expect(list.connections[0].credential.status).toBe('configured'); expect(JSON.stringify(list)).not.toContain('private-');
    const file = path.join(f.config.home, 'credentials', 'agent-connections.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).connections[0].credential.refresh).toBe('private-refresh');
    expect((await action('agent.connections.device.cancel', params)).status).toBe('cancelled');
    expect(f.store.get('SELECT COUNT(*) AS n FROM events').n).toBe(0);
  } finally { await f.close(); }
});
