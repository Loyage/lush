import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../src/config.js';
import { AgentSettings } from '../../src/agent/settings.js';
import { PiProvider } from '../../src/agent/provider.js';
import { ensurePiConfiguration } from '../../src/agent/pi-config.js';
import { createRuntimeConnection, validateRuntimeConnection, readRuntimeObservations, parseConnectionHeaders } from '../../src/agent/connection-runtime.js';
import lushRuntime from '../../src/agent/pi-runtime.js';
import { run as agentCommand } from '../../src/cli/commands/agent.js';
import { temp, env } from '../helpers.js';

const id = '84293f3c-2a70-4d83-bcd1-620183380bd0';
const profile = { agent: 'pi', model: 'deepseek/deepseek-chat', connection_id: id, thinking: '', extensions: [], skills: [] };
function snapshot(provider = 'deepseek') {
  return { connection: { id, provider, endpoint: provider === 'openai-codex' ? 'https://chatgpt.com/backend-api' : 'https://api.deepseek.com',
    auth_type: provider === 'openai-codex' ? 'oauth' : 'api_key', enabled: true, models: [] },
    credential: provider === 'openai-codex' ? { type: 'oauth', access: 'ACCESS-NOT-IN-CONTEXT', refresh: 'REFRESH-NEVER-COPIED', expires: Date.now() + 3600000, accountId: 'fixture' }
      : { type: 'api_key', key: 'MANAGED-KEY-NOT-IN-CONTEXT' }, account_key: 'anonymous-account', source_key: 'endpoint-source' };
}
function setup(extra = {}) {
  const root = temp(); const config = new Config({ project: root, env: env(extra) }); config.prepare();
  return { root, config, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test('managed profile is opt-in, Pi-only, qualified, and can be changed/reset by CLI', async () => {
  const f = setup(); const settings = new AgentSettings(f.config);
  try {
    const client = { token: null, request: async (method, params) => method === 'agent.config' ? settings.get() : settings.save(params.config) };
    await agentCommand('agent', ['set', 'default', '--agent', 'pi', '--model', profile.model, '--connection', id], { client });
    expect(settings.resolve('agent').connection_id).toBe(id);
    await agentCommand('agent', ['set', 'default', '--connection', 'off'], { client });
    expect(settings.resolve('agent').connection_id).toBeUndefined();
    for (const bad of [{ ...profile, agent: 'codex' }, { ...profile, connection_id: '../../secret' }, { ...profile, model: 'unqualified' }]) {
      expect(() => settings.save({ default: bad })).toThrow();
    }
    settings.save({ default: profile });
    await agentCommand('agent', ['set', 'default', '--agent', 'codex'], { client });
    expect(settings.get().default.connection_id).toBeUndefined();
  } finally { f.close(); }
});

test('connection validation rejects disabled, wrong provider/model scope, commands and expired auth', () => {
  expect(() => validateRuntimeConnection(profile, snapshot())).not.toThrow();
  const disabled = snapshot(); disabled.connection.enabled = false;
  expect(() => validateRuntimeConnection(profile, disabled)).toThrow('unavailable');
  expect(() => validateRuntimeConnection({ ...profile, model: 'openrouter/deepseek-chat' }, snapshot())).toThrow('qualified');
  const restricted = snapshot(); restricted.connection.models = ['other-model'];
  expect(() => validateRuntimeConnection(profile, restricted)).toThrow('scope');
  for (const key of ['!touch /tmp/bad', '$SECRET', 'key\nsecret']) {
    const runtime = snapshot(); runtime.credential.key = key;
    expect(() => validateRuntimeConnection(profile, runtime)).toThrow('literal');
  }
  const oauth = snapshot('openai-codex'); oauth.credential.expires = Date.now() - 1;
  expect(() => validateRuntimeConnection({ ...profile, model: 'openai-codex/fake' }, oauth)).toThrow('expired');
});

test('runtime copies selected auth and Lush-owned metadata/settings, never external configuration or global context', () => {
  const f = setup(); const globalDir = path.join(f.root, 'external-pi'); fs.mkdirSync(globalDir);
  const globalAuth = JSON.stringify({ deepseek: { type: 'api_key', key: 'EXTERNAL-KEY' }, openrouter: { type: 'api_key', key: 'OTHER-KEY' } });
  fs.writeFileSync(path.join(globalDir, 'auth.json'), globalAuth, { mode: 0o600 });
  fs.writeFileSync(path.join(globalDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'never', transport: 'sse',
    extensions: ['arbitrary-code'], packages: ['remote-package'], compaction: { enabled: false } }));
  fs.writeFileSync(path.join(globalDir, 'AGENTS.md'), 'Global user instructions.');
  fs.writeFileSync(path.join(globalDir, 'models.json'), JSON.stringify({ providers: { deepseek: { apiKey: 'EXTERNAL-MODEL-KEY',
    baseUrl: 'https://proxy.invalid', headers: { Authorization: 'EXTERNAL-HEADER' }, models: [{ id: 'deepseek-chat', api: 'openai-completions',
      contextWindow: 12345, baseUrl: 'https://another.invalid', headers: { Secret: 'MODEL-HEADER' } }] } } }));
  const baseline = ensurePiConfiguration(f.config);
  fs.writeFileSync(path.join(baseline.dir, 'settings.json'), JSON.stringify({ transport: 'sse', compaction: { enabled: false },
    defaultProjectTrust: 'always', extensions: ['must-not-load'], packages: ['must-not-load'] }), { mode: 0o600 });
  fs.writeFileSync(path.join(baseline.dir, 'models.json'), JSON.stringify({ providers: { deepseek: { api: 'openai-completions',
    apiKey: 'BASELINE-SECRET-NOT-COPIED', headers: { Authorization: 'BASELINE-SECRET-NOT-COPIED' },
    models: [{ id: 'deepseek-chat', contextWindow: 6789, headers: { Secret: 'BASELINE-SECRET-NOT-COPIED' } }] } } }), { mode: 0o600 });
  f.config.env.PI_CODING_AGENT_DIR = globalDir;
  try {
    const managed = createRuntimeConnection(f.config, profile, snapshot(), { PI_CODING_AGENT_DIR: globalDir });
    const auth = JSON.parse(fs.readFileSync(path.join(managed.dir, 'auth.json')));
    expect(auth).toEqual({ deepseek: { type: 'api_key', key: snapshot().credential.key } });
    const models = JSON.parse(fs.readFileSync(path.join(managed.dir, 'models.json')));
    expect(models.providers.deepseek).toEqual({ api: 'openai-completions', baseUrl: 'https://api.deepseek.com', models: [{ id: 'deepseek-chat', contextWindow: 6789 }] });
    expect(JSON.stringify(models)).not.toContain('SECRET');
    const settings = JSON.parse(fs.readFileSync(path.join(managed.dir, 'settings.json')));
    expect(settings).toMatchObject({ transport: 'sse', compaction: { enabled: false }, defaultProjectTrust: 'never' });
    expect(settings.extensions).toBeUndefined(); expect(settings.packages).toBeUndefined();
    expect(fs.existsSync(path.join(managed.dir, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(managed.dir, 'SYSTEM.md'))).toBe(false);
    expect(fs.readFileSync(path.join(globalDir, 'auth.json'), 'utf8')).toBe(globalAuth);
    expect(fs.statSync(managed.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(managed.dir, 'auth.json')).mode & 0o777).toBe(0o600);
    fs.rmSync(managed.dir, { recursive: true });
    const oauth = createRuntimeConnection(f.config, { ...profile, model: 'openai-codex/fake' }, snapshot('openai-codex'));
    const copied = fs.readFileSync(path.join(oauth.dir, 'auth.json'), 'utf8');
    expect(copied).toContain('ACCESS-NOT-IN-CONTEXT'); expect(copied).not.toContain('REFRESH-NEVER-COPIED');
  } finally { f.close(); }
});

test('passive parser does not invent quotas from generic rate limits or absent/invalid percentages', () => {
  const at = '2026-10-03T10:00:00.000Z';
  expect(parseConnectionHeaders('deepseek', { 'x-ratelimit-remaining-tokens': '10' }, 200, at)).toBeNull();
  expect(parseConnectionHeaders('openai-codex', { 'x-ratelimit-remaining-tokens': '10' }, 200, at)).toBeNull();
  expect(parseConnectionHeaders('openai-codex', { 'x-codex-primary-used-percent': 'NaN' }, 200, at)).toBeNull();
  const observation = parseConnectionHeaders('openai-codex', { 'X-Codex-Primary-Used-Percent': '25', 'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-after-seconds': '60', Authorization: 'DO-NOT-CAPTURE' }, 200, at);
  expect(observation.resources).toHaveLength(1);
  expect(observation.resources[0]).toMatchObject({ id: 'primary', remaining: 75, used_percent: 25, window_seconds: 18000, reset_at: '2026-10-03T10:01:00.000Z' });
  expect(JSON.stringify(observation)).not.toContain('DO-NOT-CAPTURE');
  expect(parseConnectionHeaders('openai-codex', {}, 429, at)).toMatchObject({ status: 'error', error_code: 'rate_limited', resources: [] });
});

test('Pi passive extension records bounded safe output only for the fixed provider/model/endpoint', () => {
  const f = setup(); const oauth = { ...profile, model: 'openai-codex/fake' };
  const managed = createRuntimeConnection(f.config, oauth, snapshot('openai-codex'));
  const previous = process.env.LUSH_RUNTIME_CONTEXT; const hooks = {};
  try {
    process.env.LUSH_RUNTIME_CONTEXT = JSON.stringify({ connection: { ...managed.binding, observations_file: managed.observations } });
    lushRuntime({ on(name, fn) { hooks[name] = fn; }, appendEntry() {} });
    const ctx = { model: { provider: 'openai-codex', id: 'fake', baseUrl: 'https://chatgpt.com/backend-api' } };
    hooks.after_provider_response({ status: 200, headers: { 'x-codex-primary-used-percent': '0', authorization: 'SECRET' } }, ctx);
    expect(readRuntimeObservations(managed)).toHaveLength(1);
    hooks.after_provider_response({ status: 200, headers: { 'x-codex-primary-used-percent': '99' } }, { model: { ...ctx.model, id: 'other' } });
    expect(readRuntimeObservations(managed)).toHaveLength(1);
    hooks.after_provider_response({ status: 200, headers: { 'x-codex-primary-used-percent': '99' } }, { model: { ...ctx.model, baseUrl: 'https://other.invalid' } });
    expect(readRuntimeObservations(managed)).toHaveLength(1);
    for (let n = 0; n < 70; n++) hooks.after_provider_response({ status: 200, headers: { 'x-codex-primary-used-percent': String(n) } }, ctx);
    expect(readRuntimeObservations(managed)).toHaveLength(64);
    expect(fs.readFileSync(managed.observations, 'utf8')).not.toContain('SECRET');
    fs.chmodSync(managed.observations, 0o644); expect(readRuntimeObservations(managed)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.LUSH_RUNTIME_CONTEXT; else process.env.LUSH_RUNTIME_CONTEXT = previous;
    f.close();
  }
});

for (const fail of [false, true]) test(`Pi invocation isolates credentials, absorbs passive output, cleans up, and masks diagnostics (failure=${fail})`, async () => {
  const f = setup(); const fake = path.join(f.root, 'fake-managed-pi');
  const passive = parseConnectionHeaders('openai-codex', { 'x-codex-primary-used-percent': '20' }, 200);
  fs.writeFileSync(fake, `#!/usr/bin/env bun\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst args=process.argv.slice(2);\nconst dir=process.env.PI_CODING_AGENT_DIR;\nconst context=JSON.parse(process.env.LUSH_RUNTIME_CONTEXT);\nconst auth=JSON.parse(fs.readFileSync(path.join(dir,'auth.json'),'utf8'));\nif(args.includes('--api-key')||args.includes('--provider')||!args.includes('--no-approve')||!auth.deepseek)process.exit(7);\nfs.writeFileSync(context.connection.observations_file,${JSON.stringify(JSON.stringify([passive]))},{mode:0o600});\nfs.writeFileSync(path.join(process.env.LUSH_HOME,'private-dir-path'),dir);\n${fail ? "console.error(auth.deepseek.key);process.exit(1);" : "console.log('managed finished');"}\n`, { mode: 0o755 });
  f.config.env.LUSH_PI_COMMAND = fake; f.config.env.LUSH_PI_PROVIDER = 'obsolete';
  const seen = [];
  try {
    const call = new PiProvider(f.config).run({ task: { id: 6, role: 'agent', goal: 'test' }, context: { invocation: { run_id: 9 } },
      messages: [], cwd: f.root, token: 'invocation-token', signal: new AbortController().signal, onSpawn() {},
      agent: profile, connectionRuntime: snapshot(), onConnectionObservation: value => seen.push(value) });
    if (fail) await expect(call).rejects.toThrow('managed Pi invocation failed');
    else expect(await call).toBe('managed finished');
    expect(seen).toEqual([passive]);
    const dir = fs.readFileSync(path.join(f.config.home, 'private-dir-path'), 'utf8'); expect(fs.existsSync(dir)).toBe(false);
    const prompt = fs.readFileSync(path.join(f.config.home, 'sessions/task-6-input.md'), 'utf8');
    expect(prompt).toContain(id); expect(prompt).not.toContain(snapshot().credential.key);
  } finally { f.close(); }
});
