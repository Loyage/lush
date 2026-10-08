import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, temp, until } from '../helpers.js';
import { PiProvider } from '../../src/agent/provider.js';
import { AgentConnectionsService } from '../../src/core/agent-connections.js';

// No real Pi account or model call: exercise scheduler -> Manager -> private auth -> passive Store write.
const STUB = `#!/usr/bin/env bun
import fs from 'node:fs';
const args = process.argv.slice(2), dir = process.env.PI_CODING_AGENT_DIR;
const ctx = JSON.parse(process.env.LUSH_RUNTIME_CONTEXT);
const auth = JSON.parse(fs.readFileSync(dir + '/auth.json', 'utf8'))['openai-codex'];
if (!auth.access || auth.refresh !== '' || !args.includes('--no-approve')) process.exit(7);
if (args.join(' ').includes(auth.access)) process.exit(8);
const prompt = args.find(arg => arg.startsWith('@'));
if (fs.readFileSync(prompt.slice(1), 'utf8').includes(auth.access)) process.exit(9);
fs.writeFileSync(ctx.connection.observations_file, JSON.stringify([{
  status: 'available', checked_at: new Date().toISOString(), source: 'response_headers',
  resources: [{ id: 'primary', kind: 'quota', scope: 'account', label: '主要窗口', unit: '%',
    remaining: 75, total: 100, used: 25, used_percent: 25, window_seconds: 18000, models: [] }]
}]), {mode: 0o600});
console.log('managed invocation finished');
`;

async function login(service) {
  const connection = await service.save({ label: '测试 Codex', provider: 'openai-codex', auth_type: 'oauth', models: ['test-model'] });
  const started = await service.loginStart(connection.id);
  const state = new URL(started.url).searchParams.get('state');
  await service.loginFinish(connection.id, started.login_id, `${started.redirect_uri}?code=private-code&state=${state}`);
  return connection.id;
}
function service(f) {
  const instance = new AgentConnectionsService(f.project, { managerOptions: { fetch: async url => {
    expect(url).toBe('https://auth.openai.com/oauth/token');
    return Response.json({ access_token: `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': {
      chatgpt_account_id: 'test-account-private' } })).toString('base64url')}.signature`, refresh_token: 'private-refresh', expires_in: 3600 });
  } } });
  f.project.agentConnections = instance;
  return instance;
}

test('scheduler freezes managed identity, reports active consumers, ingests passive quota and removes auth on exit', async () => {
  const root = temp(), executable = path.join(root, 'fake-pi');
  fs.writeFileSync(executable, STUB, { mode: 0o755 });
  let profile, runtimeRun, launches = 0;
  const f = fixture({ resolve: () => profile, async run(options) {
    launches++;
    runtimeRun = f.project.running.get(options.task.id);
    expect(runtimeRun.connectionBinding.id).toBe(profile.connection_id);
    expect(f.project.agentConnections.list().connections[0].consumers).toEqual([{ task_id: options.task.id, task_worker_number: options.task.worker_number, model: profile.model }]);
    expect(JSON.stringify(options.context)).not.toContain(options.connectionRuntime.credential.access);
    return new PiProvider(f.config).run(options);
  } }, { LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: executable });
  try {
    await repo(f.root);
    const connections = service(f), id = await login(connections);
    profile = { agent: 'pi', model: 'openai-codex/test-model', connection_id: id, extensions: [], skills: [] };
    const order = await f.project.order('verify managed invocation');
    await until(() => launches === 1 && f.project.running.size === 0, 8000);
    expect(f.store.task(order.task.id).status).toBe('waiting');
    expect(f.store.task(order.task.id).result).toBe('managed invocation finished');
    expect(runtimeRun.connectionBinding).toBeUndefined();
    expect(fs.readdirSync(path.join(f.config.home, 'agent-runtime'))).toEqual([]);
    const local = connections.list().connections[0];
    expect(local.consumers).toEqual([]);
    expect(local.observation.source).toBe('response_headers');
    expect(local.observation.resources[0].remaining).toBe(75);
    expect(connections.history(id).series[0].points[0].source).toBe('response_headers');
    const events = f.store.all('SELECT type,data FROM events WHERE task_id=?', order.task.id);
    expect(events.filter(event => event.type === 'invocation.connection')).toHaveLength(1);
    for (const secret of ['private-refresh', 'private-code', 'test-account-private']) expect(JSON.stringify(events)).not.toContain(secret);
  } finally { await f.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('scheduler rejects a mismatched physical provider before starting a managed model process', async () => {
  let profile, launches = 0;
  const f = fixture({ resolve: () => profile, async run() { launches++; return 'must not launch'; } });
  try {
    await repo(f.root);
    const connections = service(f), id = await login(connections);
    profile = { agent: 'pi', model: 'deepseek/test-model', connection_id: id };
    const order = await f.project.order('invalid managed binding');
    await until(() => f.store.task(order.task.id).status === 'failed' && f.project.running.size === 0, 8000);
    expect(launches).toBe(0);
    expect(f.store.task(order.task.id).error).toContain('qualified physical model');
    expect(connections.list().connections[0].consumers).toEqual([]);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_connection_queries').n).toBe(0);
  } finally { await f.close(); }
});
