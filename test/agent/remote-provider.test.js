import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../../src/config.js';
import { PiProvider, CodexProvider, AgentPreempted } from '../../src/agent/provider.js';
import { assertRemoteConfiguration } from '../../src/agent/remote-provider.js';
import { normalizeAgentProfile } from '../../src/agent/settings.js';
import { piConfigDirectory, ensurePiConfiguration } from '../../src/agent/pi-config.js';
import { assertRemoteDescriptor, REMOTE_PI_VERSION, REMOTE_TOOL_NAMES } from '../../src/agent/remote-contract.js';
import { remoteHarness, write } from './fixtures/remote-harness.js';

const realPi = process.env.LUSH_REMOTE_PI_TEST === '1' ? test : test.skip;
const profile = { agent: 'pi', config_mode: 'lush', model: 'openai-compatible/controlled', thinking: 'off',
  connection_id: '84293f3c-2a70-4d83-bcd1-620183380bd0', extensions: [], skills: [], soft_budget: { responses: 1 } };
test('explicit remote descriptor/configuration rejects unsupported modes/resources, secrets and identity before spawn', async () => {
  expect(() => assertRemoteConfiguration(profile)).not.toThrow();
  const inherited = normalizeAgentProfile(profile);
  expect(inherited.config_mode).toBeUndefined();
  expect(() => assertRemoteConfiguration(inherited)).not.toThrow();
  for (const bad of [{ agent: 'codex' }, { config_mode: 'pi' }, ...['extensions', 'skills', 'mcp', 'packages', 'themes', 'prompts', 'tools'].map(key => ({ [key]: ['custom'] }))]) {
    expect(() => assertRemoteConfiguration({ ...profile, ...bad })).toThrow();
  }
  for (const raw of [{ defaultTools: ['read', 'grep'] }, { shellPath: '/custom' }, { shellCommandPrefix: 'unsafe' }, { extensions: ['plugin'] }]) {
    expect(() => assertRemoteConfiguration(profile, raw)).toThrow('Unsupported');
  }
  const descriptor = { version: 1, runner_protocol: 1, pi_version: REMOTE_PI_VERSION, socket: '/fixture.sock', path: '/remote',
    identity: { project_id: 'project', node_id: 'node', runner_id: 'runner', worker_id: 1, workspace_id: 'workspace', generation: 1, run_id: 1 } };
  expect(() => assertRemoteDescriptor(descriptor, 1, 1)).not.toThrow();
  for (const bad of [{ pi_version: 'unverified' }, { token: 'secret' }, { path: '../relative' }, { identity: { ...descriptor.identity, generation: 2, secret: 'x' } }]) {
    expect(() => assertRemoteDescriptor({ ...descriptor, ...bad }, 1, 1)).toThrow();
  }
  await expect(new CodexProvider({}).run({ remote_workspace: descriptor })).rejects.toThrow('no local fallback');
});

test('Provider refuses an actually incompatible installed SDK and configured custom resources before guard/model startup', async () => {
  const f = await remoteHarness(); let spawned = false;
  try {
    const fake = path.join(f.root, 'fake-pi');
    write(path.join(fake, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '0.0.0', exports: { '.': './dist/index.js' } }));
    write(path.join(fake, 'dist/index.js'), 'throw new Error("UNVERIFIED SDK MUST NOT LOAD")');
    write(path.join(fake, 'bin/pi'), '#!/bin/sh\nexit 99\n'); fs.chmodSync(path.join(fake, 'bin/pi'), 0o700);
    const config = new Config({ project: f.root, env: { PATH: '/usr/bin:/bin', LUSH_GLOBAL_CONFIG: path.join(f.root, 'isolated-device'), LUSH_PI_COMMAND: path.join(fake, 'bin/pi') } }); config.prepare();
    const options = { task: f.worker, context: { invocation: { run_id: f.run.id } }, messages: [], cwd: f.control,
      token: f.token, signal: new AbortController().signal, onSpawn: () => { spawned = true; }, agent: profile, remote_workspace: f.descriptor };
    await expect(new PiProvider(config).run(options)).rejects.toThrow('verified SDK');
    ensurePiConfiguration(config);
    write(path.join(piConfigDirectory(config), 'settings.json'), JSON.stringify({ packages: ['unreviewed'] }));
    await expect(new PiProvider(config).run(options)).rejects.toThrow('Unsupported remote Pi resource: packages');
    expect(spawned).toBe(false); expect(fs.existsSync(path.join(config.home, 'agent-runtime'))).toBe(false);
  } finally { await f.close(); }
});

for (const mode of ['complete', 'preempt', 'abort']) realPi(`production PiProvider guarded SDK subprocess: ${mode}, private snapshot and real stop barrier`, async () => {
  const f = await remoteHarness(); let step = 0, deliveries = 0, pid;
  const requests = [], signals = [];
  const certificate = fileURLToPath(new URL('./network-test-cert.pem', import.meta.url));
  const config = new Config({ project: f.root, env: { PATH: process.env.PATH, HOME: f.root,
    LUSH_GLOBAL_CONFIG: path.join(f.root, 'device-config'), NODE_EXTRA_CA_CERTS: certificate, NO_PROXY: '*' } }); config.prepare();
  write(path.join(f.root, '.lush-agent/common.md'), 'CENTRAL_PROJECT_SUPPLEMENT_POISON');
  write(path.join(f.remote, '.lush-agent/common.md'), 'REMOTE_PROJECT_SUPPLEMENT');
  const controller = new AbortController();
  const model = Bun.serve({ hostname: '127.0.0.1', port: 0,
    tls: { cert: fs.readFileSync(certificate), key: fs.readFileSync(new URL('./network-test-key.pem', import.meta.url)) },
    async fetch(request) {
      const body = await request.json(); requests.push(body);
      const name = step === 0 ? 'bash' : step === 1 ? 'read' : null;
      if (mode === 'preempt' && step === 0) write(path.join(config.home, 'preempt', `task-${f.worker.id}.request.json`), JSON.stringify({ task_id: f.worker.id, run_id: f.run.id, reason: 'fixture preemption' }));
      const args = name === 'bash' ? { command: mode === 'abort' ? 'touch started; while :; do printf x >> activity; sleep 0.02; done' : 'printf GUARDED_REMOTE; printf guarded > guarded.txt' } : { path: 'same.txt' };
      step++;
      const delta = name ? { tool_calls: [{ index: 0, id: `call_${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: 'guarded remote complete' };
      const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `r_${step}`, object: 'chat.completion.chunk', created: 1, model: 'controlled',
        choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } } : {}) })}\n\n`;
      return new Response(chunk({ role: 'assistant' }) + chunk(delta) + chunk({}, name ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const connectionRuntime = { connection: { id: profile.connection_id, provider: 'openai-compatible',
    endpoint: `https://127.0.0.1:${model.port}/v1`, auth_type: 'api_key', enabled: true, models: ['controlled'] },
    credential: { type: 'api_key', key: 'MANAGED-PRIVATE-SNAPSHOT' }, account_key: 'fixture', source_key: 'fixture' };
  try {
    const pending = new PiProvider(config).run({ task: f.worker, context: { invocation: { run_id: f.run.id, task_id: f.worker.id } },
      messages: [], cwd: f.control, token: f.token, signal: controller.signal, onSpawn: value => { pid = value; },
      onInputDelivered: () => { deliveries++; }, onPreempt: value => signals.push(value), agent: profile,
      connectionRuntime, remote_workspace: f.descriptor });
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    if (mode === 'abort') {
      for (let i = 0; i < 500 && !fs.existsSync(path.join(f.remote, 'started')); i++) await Bun.sleep(10);
      expect(fs.existsSync(path.join(f.remote, 'started'))).toBe(true);
      controller.abort(new Error('fixture abort'));
    }
    const answer = await outcome;
    if (mode === 'complete') expect(answer).toEqual({ value: 'guarded remote complete' });
    else if (mode === 'preempt') { expect(answer.error).toBeInstanceOf(AgentPreempted); expect(signals[0].safe_point).toBe('turn_end'); expect(requests).toHaveLength(1); }
    else expect(answer.error.message).toBe('fixture abort');
    expect(pid).toBeGreaterThan(0); expect(deliveries).toBe(1);
    for (const request of requests) expect(request.tools.map(tool => tool.function.name).sort()).toEqual([...REMOTE_TOOL_NAMES].sort());
    const wire = JSON.stringify(requests);
    for (const secret of [...f.secrets, connectionRuntime.credential.key, 'LOCAL_POISON', 'LOCAL_CONTEXT_POISON', 'CENTRAL_PROJECT_SUPPLEMENT_POISON']) expect(wire).not.toContain(secret);
    expect(wire).toContain('REMOTE_PROJECT_SUPPLEMENT');
    const sessionFiles = fs.readdirSync(path.join(config.home, 'sessions')).filter(name => name.endsWith(`_lush-task-${f.worker.id}.jsonl`));
    expect(sessionFiles).toHaveLength(1);
    const sessionText = fs.readFileSync(path.join(config.home, 'sessions', sessionFiles[0]), 'utf8');
    expect(sessionText).toContain('lush.invocation');
    if (mode === 'complete') { expect(sessionText).toContain('lush.soft_budget'); expect(sessionText).toContain('"totalTokens":30'); }
    expect(fs.readdirSync(path.join(config.home, 'agent-runtime'))).toEqual([]);
    expect(await f.bridge.drain()).toMatchObject({ stopped: true });
    const marker = mode === 'abort' ? 'activity' : 'guarded.txt';
    const before = fs.readFileSync(path.join(f.remote, marker), 'utf8'); await Bun.sleep(70);
    expect(fs.readFileSync(path.join(f.remote, marker), 'utf8')).toBe(before);
  } finally { controller.abort(); model.stop(true); await f.close(); }
});
