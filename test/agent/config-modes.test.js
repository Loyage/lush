import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../../src/config.js';
import { AgentSettings } from '../../src/agent/settings.js';
import { agentPrompt } from '../../src/agent/prompts.js';
import { PiProvider } from '../../src/agent/provider.js';
import { defaultPiEnvironment } from '../../src/agent/pi-config.js';
import { saveNetworkConfiguration } from '../../src/agent/network.js';
import { env, temp } from '../helpers.js';
import { managedPiRun } from './managed-runtime-fixture.js';

const PI_RUNTIME = fileURLToPath(new URL('../../src/agent/pi-runtime.js', import.meta.url));
const CONNECTION = '11111111-1111-4111-8111-111111111111';

/** process.env may carry a nested Lush invocation; Pi-default mode tests need a clean machine baseline. */
function cleanEnv(extra = {}) {
  const values = env();
  for (const key of ['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SESSION_ID', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL']) delete values[key];
  return { ...values, ...extra };
}

function fakePi(root) {
  const file = path.join(root, 'fake-pi');
  const out = path.join(root, 'pi-run.json');
  fs.writeFileSync(file, `#!/usr/bin/env bun
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }, null, 2));
console.log('pi finished');
`, { mode: 0o755 });
  return { file, read: () => JSON.parse(fs.readFileSync(out, 'utf8')) };
}

test('Pi-default mode keeps only the backend and mode, dropping every Lush-managed override', () => {
  const root = temp();
  const config = new Config({ project: root, env: cleanEnv({ LUSH_PROVIDER: 'pi' }) }); config.prepare();
  try {
    const settings = new AgentSettings(config);
    const saved = settings.save({ version: 1, default: { agent: 'pi', config_mode: 'pi', model: 'deepseek/deepseek-chat',
      thinking: 'high', default_prompt: 'REPLACE', append_prompt: 'APPEND', extensions: ['/tmp/ext.ts'],
      skills: ['/tmp/SKILL.md'], soft_budget: { tokens: 10 }, env: { SECRET: 'v' }, connection_id: CONNECTION }, roles: {} });
    expect(saved.default).toEqual({ agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '',
      extensions: [], skills: [], config_mode: 'pi' });
    expect(saved.options.config_modes).toEqual(['lush', 'pi']);
    // The effective profile has no managed source left to bind or leak.
    expect(saved.default.connection_id).toBeUndefined();
    expect(saved.resolved.worker.config_mode).toBe('pi');
    // Lush stays the byte-stable default: no config_mode key is written for it.
    const lush = settings.save({ version: 1, default: { agent: 'pi', config_mode: 'lush', model: 'deepseek/deepseek-chat' }, roles: {} });
    expect(lush.default.config_mode).toBeUndefined();
    expect(lush.default.model).toBe('deepseek/deepseek-chat');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pi-default mode is unavailable to Codex and to isolated explainer/butler roles', () => {
  const root = temp();
  const config = new Config({ project: root, env: cleanEnv({ LUSH_PROVIDER: 'pi' }) }); config.prepare();
  try {
    const settings = new AgentSettings(config);
    expect(() => settings.retryProfile('agent', { agent: 'codex', config_mode: 'pi' })).toThrow('Pi backend');
    expect(() => settings.retryProfile('explainer', { agent: 'pi', config_mode: 'pi' })).toThrow('isolated');
    expect(() => settings.retryProfile('butler', { agent: 'pi', config_mode: 'pi' })).toThrow('isolated');
    expect(() => settings.retryProfile('agent', { agent: 'pi', config_mode: 'other' })).toThrow('lush or pi');
    // A Pi-default project default never leaks into the isolated explainer role.
    settings.save({ version: 1, default: { agent: 'pi', config_mode: 'pi' }, roles: {} });
    expect(settings.get().resolved.explainer.config_mode).toBeUndefined();
    expect(settings.get().resolved.butler.config_mode).toBeUndefined();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pi-default mode injects only the built-in Worker prompt, never Lush Prompt overlays', () => {
  const root = temp();
  const config = new Config({ project: root, env: cleanEnv({ LUSH_PROVIDER: 'pi' }) }); config.prepare();
  try {
    fs.mkdirSync(path.join(config.project, '.lush-agent'), { recursive: true });
    fs.writeFileSync(path.join(config.project, '.lush-agent', 'common.md'), 'PROJECT-OVERLAY');
    fs.writeFileSync(path.join(config.project, '.lush-agent', 'agent.md'), 'ROLE-OVERLAY');
    fs.mkdirSync(path.join(config.home, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(config.home, 'agent', 'common.md'), 'LOCAL-OVERLAY');
    const pi = agentPrompt(config, 'agent', { agent: 'pi', config_mode: 'pi', append_prompt: 'APPEND-SECRET', default_prompt: 'REPLACE-SECRET' });
    expect(pi.customization.mode).toBe('pi');
    expect(pi.customization.project).toEqual([]);
    expect(pi.customization.local).toEqual([]);
    expect(pi.text).not.toContain('PROJECT-OVERLAY');
    expect(pi.text).not.toContain('ROLE-OVERLAY');
    expect(pi.text).not.toContain('LOCAL-OVERLAY');
    expect(pi.text).not.toContain('APPEND-SECRET');
    expect(pi.text).not.toContain('REPLACE-SECRET');
    expect(pi.parts.every(part => part.source === 'builtin')).toBe(true);
    expect(pi.text).toContain('Lush'); // The required Lush Worker protocol is still present.
    const lush = agentPrompt(config, 'agent', { agent: 'pi', append_prompt: 'APPEND-SECRET' });
    expect(lush.customization.mode).toBe('lush');
    expect(lush.text).toContain('PROJECT-OVERLAY');
    expect(lush.text).toContain('APPEND-SECRET');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('defaultPiEnvironment keeps machine Pi configuration and ambient auth, dropping stale session metadata', () => {
  const values = defaultPiEnvironment({ env: {} }, { OPENAI_API_KEY: 'ambient-key', PI_CODING_AGENT_DIR: '/machine/pi',
    PI_SESSION_ID: 's', PI_SESSION_FILE: '/s.jsonl', PI_PROVIDER: 'p', PI_MODEL: 'm', PI_REASONING_LEVEL: 'high', KEEP: '1' });
  expect(values).toEqual({ OPENAI_API_KEY: 'ambient-key', PI_CODING_AGENT_DIR: '/machine/pi', KEEP: '1' });
});

test('PiDefault and Lush invocations differ in argv, environment, and session identity', async () => {
  const root = temp(), pi = fakePi(root);
  const config = new Config({ project: root, env: cleanEnv({ LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: pi.file,
    OPENAI_API_KEY: 'ambient-key' }) });
  config.prepare();
  try {
    const provider = new PiProvider(config);
    const common = { task: { id: 42, parent_id: 3, role: 'agent', goal: 'mode test' }, context: {}, messages: [], cwd: root,
      token: 'secret', signal: new AbortController().signal, onSpawn() {} };
    expect(await provider.run({ ...common, agent: { agent: 'pi', config_mode: 'pi', model: '', thinking: '',
      default_prompt: '', append_prompt: '', extensions: [], skills: [] },
      // A Lush-mode checkpoint must never be imported into Pi-default mode.
      forkPointer: { session: path.join(config.home, 'sessions', 'never.jsonl'), entry: 'e', commit: 'a'.repeat(40) } }))
      .toBe('pi finished');
    const piRun = pi.read();
    expect(piRun.args).toContain('--print');
    for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--model', '--thinking', '--fork', '--no-approve']) {
      expect(piRun.args).not.toContain(flag);
    }
    expect(piRun.args.slice(piRun.args.indexOf('--extension'), piRun.args.indexOf('--extension') + 2)).toEqual(['--extension', PI_RUNTIME]);
    expect(piRun.args.slice(piRun.args.indexOf('--session-id'), piRun.args.indexOf('--session-id') + 2)).toEqual(['--session-id', 'lush-task-42-pi']);
    expect(piRun.args).toContain('--append-system-prompt');
    expect(piRun.env.OPENAI_API_KEY).toBe('ambient-key');
    expect(piRun.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(piRun.env.PI_OFFLINE).toBeUndefined();
    expect(JSON.parse(piRun.env.LUSH_RUNTIME_CONTEXT).config_mode).toBe('pi');

    const managed = managedPiRun({ agent: { agent: 'pi', model: 'deepseek/deepseek-chat', thinking: 'low',
      default_prompt: '', append_prompt: '', extensions: ['/tmp/selected-extension.ts'], skills: [] } });
    expect(await provider.run({ ...common, agent: managed.agent, connectionRuntime: managed.connectionRuntime })).toBe('pi finished');
    const lushRun = pi.read();
    expect(lushRun.args).toContain('--no-extensions');
    expect(lushRun.args).toContain('--no-approve');
    expect(lushRun.args.slice(lushRun.args.indexOf('--session-id'), lushRun.args.indexOf('--session-id') + 2)).toEqual(['--session-id', 'lush-task-42']);
    expect(lushRun.args.slice(lushRun.args.indexOf('--model'), lushRun.args.indexOf('--model') + 2)).toEqual(['--model', 'deepseek/deepseek-chat']);
    expect(lushRun.args.slice(lushRun.args.indexOf('--extension'), lushRun.args.indexOf('--extension') + 2)).toEqual(['--extension', '/tmp/selected-extension.ts']);
    expect(lushRun.env.OPENAI_API_KEY).toBeUndefined();
    expect(lushRun.env.PI_CODING_AGENT_DIR).not.toBeUndefined();
    expect(JSON.parse(lushRun.env.LUSH_RUNTIME_CONTEXT).config_mode).toBe('lush');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pi-default mode still applies the project outbound network policy', async () => {
  const root = temp(), pi = fakePi(root);
  const config = new Config({ project: root, env: cleanEnv({ LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: pi.file }) });
  config.prepare();
  try {
    saveNetworkConfiguration(config, { version: 1, mode: 'proxy', proxy_url: 'https://proxy.invalid', no_proxy: ['internal.invalid'], proxy_auth: null });
    const provider = new PiProvider(config);
    await provider.run({ task: { id: 44, parent_id: 3, role: 'agent', goal: 'network' }, context: {}, messages: [], cwd: root,
      token: 'secret', signal: new AbortController().signal, onSpawn() {}, agent: { agent: 'pi', config_mode: 'pi', model: '',
        thinking: '', default_prompt: '', append_prompt: '', extensions: [], skills: [] } });
    const values = pi.read().env;
    expect(values.HTTPS_PROXY).toBe('https://proxy.invalid/');
    expect(values.NO_PROXY).toContain('internal.invalid');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit PI_CODING_AGENT_DIR is honored in Pi-default mode but overridden by the managed snapshot', async () => {
  const root = temp(), pi = fakePi(root), machine = path.join(root, 'machine-pi');
  fs.mkdirSync(machine, { recursive: true, mode: 0o700 });
  const config = new Config({ project: root, env: cleanEnv({ LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: pi.file,
    PI_CODING_AGENT_DIR: machine }) });
  config.prepare();
  try {
    const provider = new PiProvider(config);
    const common = { task: { id: 43, parent_id: 3, role: 'agent', goal: 'machine dir' }, context: {}, messages: [], cwd: root,
      token: 'secret', signal: new AbortController().signal, onSpawn() {} };
    await provider.run({ ...common, agent: { agent: 'pi', config_mode: 'pi', model: '', thinking: '', default_prompt: '',
      append_prompt: '', extensions: [], skills: [] } });
    expect(pi.read().env.PI_CODING_AGENT_DIR).toBe(machine);
    const managedAgent = managedPiRun({ agent: { agent: 'pi', model: 'deepseek/deepseek-chat', thinking: '', default_prompt: '',
      append_prompt: '', extensions: [], skills: [] } });
    await provider.run({ ...common, agent: managedAgent.agent, connectionRuntime: managedAgent.connectionRuntime });
    const managedDir = pi.read().env.PI_CODING_AGENT_DIR;
    expect(managedDir).not.toBe(machine);
    expect(managedDir.startsWith(path.join(config.home, 'agent-runtime'))).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
