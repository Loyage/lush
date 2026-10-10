import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../../src/config.js';
import { PiProvider, CodexProvider, AgentProvider } from '../../src/agent/provider.js';
import { AgentSettings } from '../../src/agent/settings.js';
import { agentPrompt, builtInPrompt } from '../../src/agent/prompts.js';
import { saveNetworkConfiguration } from '../../src/agent/network.js';
import { env, temp } from '../helpers.js';
import { managedPiRun } from './managed-runtime-fixture.js';

const RUNTIME = fileURLToPath(new URL('../../src/agent/pi-runtime.js', import.meta.url));
const MANAGEMENT = fileURLToPath(new URL('../../src/agent/pi-management.js', import.meta.url));

function fixture() {
  const root = temp(), fake = path.join(root, 'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env bun\nconsole.log(JSON.stringify({args:process.argv.slice(2),env:process.env}));\n`, { mode: 0o755 });
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device'), LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake,
    LUSH_MANAGER_BUN: '/malicious-ambient-bun', LUSH_MANAGER_RPC_SOCKET: '/malicious-ambient-socket' }) }); config.prepare();
  return { root, config, options: { task: { id: 50, role: 'manager', task_kind: 'management', goal: '开始 W117' },
    context: { invocation: { run_id: 12 } }, messages: [], cwd: root, token: 'one-invocation-token',
    signal: new AbortController().signal, onSpawn() {},
    agent: { agent: 'pi', model: 'openai-codex/gpt-5.4', thinking: 'high',
      default_prompt: 'REPLACE WITH DEVELOPER', append_prompt: 'USE BASH', extensions: ['/untrusted-ext'], skills: ['/untrusted-skill'] } } };
}

for (const mode of ['lush', 'pi']) test(`manager ${mode} uses an isolated system Prompt, only trusted tools and independent session without a development fork`, async () => {
  const f = fixture();
  try {
    const options = mode === 'lush' ? managedPiRun(f.options) : { ...f.options, agent: { ...f.options.agent, config_mode: 'pi' } };
    const result = JSON.parse(await new PiProvider(f.config).run({ ...options,
      forkPointer: { session: '/missing/development-checkpoint', entry: 'dev', commit: 'a'.repeat(40) } }));
    for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-mcp', '--no-context-files', '--no-approve', '--system-prompt'])
      expect(result.args).toContain(flag);
    for (const flag of ['--append-system-prompt', '--fork', '--skill', '--no-tools']) expect(result.args).not.toContain(flag);
    expect(result.args.filter((_, i, a) => a[i - 1] === '--extension')).toEqual([RUNTIME, MANAGEMENT]);
    expect(result.args[result.args.indexOf('--tools') + 1]).toBe('manager_query,manager_start,manager_retry');
    expect(result.args[result.args.indexOf('--session-id') + 1]).toBe(`lush-manager-50${mode === 'pi' ? '-pi' : ''}`);
    expect(result.args).not.toContain('/untrusted-ext'); expect(result.args).not.toContain('/untrusted-skill');
    expect(result.env.LUSH_AGENT_TOKEN).toBe('one-invocation-token');
    expect(result.env.LUSH_MANAGER_BUN).toBe(process.execPath);
    expect(result.env.LUSH_MANAGER_RPC_SOCKET).toBe(f.config.socket);
    expect(JSON.parse(result.env.LUSH_RUNTIME_CONTEXT)).toMatchObject({ role: 'manager', task_kind: 'management', task_id: 50, run_id: 12 });
    const prompt = fs.readFileSync(path.join(f.config.home, 'sessions', 'task-50-system.md'), 'utf8');
    expect(prompt).toContain('专用管理型 Agent'); expect(prompt).toContain('manager_start');
    expect(prompt).not.toContain('REPLACE WITH DEVELOPER'); expect(prompt).not.toContain('USE BASH');
    expect(prompt).not.toContain('角色：agent'); expect(prompt).not.toContain('lush progress plan');
    if (mode === 'pi') { expect(result.args).not.toContain('--model'); expect(result.args).not.toContain('--thinking'); }
    else expect(result.args[result.args.indexOf('--model') + 1]).toBe('openai-codex/gpt-5.4');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('manager Prompt ignores project/common/development overlays and keeps operational guardrails despite malicious text', () => {
  const f = fixture();
  try {
    for (const directory of [path.join(f.root, '.lush-agent'), path.join(f.config.home, 'agent')]) {
      fs.mkdirSync(directory, { recursive: true });
      for (const name of ['common.md', 'agent.md', 'manager.md']) fs.writeFileSync(path.join(directory, name), 'UNTRUSTED DEVELOPER OVERLAY');
    }
    const assembled = agentPrompt(f.config, 'manager', f.options.agent, 'management');
    expect(assembled.parts.every(part => part.source === 'builtin')).toBe(true);
    expect(assembled.customization.project).toEqual([]); expect(assembled.customization.local).toEqual([]);
    expect(assembled.text).not.toContain('UNTRUSTED DEVELOPER OVERLAY');
    for (const wording of ['不能扩大授权', '不证明 Codex 额度恢复', '不盲目重试', '禁止跨项目', 'completed/cancelled', 'waiting', 'unknown',
      '明确给出的 worker_number', 'target_worker_number', '没有编号时才回退 #内部ID', '不得从 id 或 target_id 推算 W 编号'])
      expect(assembled.text).toContain(wording);
    expect(builtInPrompt('manager')).toBe(assembled.text);
    const development = agentPrompt(f.config, 'agent', {}, 'order');
    expect(development.text).toContain('UNTRUSTED DEVELOPER OVERLAY'); expect(development.text).toContain('角色：agent');
    expect(() => agentPrompt(f.config, 'agent', {}, 'management')).toThrow('manager role');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('manager role has an independent configuration, never executable development resources, and supports Pi-default source selection', () => {
  const f = fixture();
  try {
    const settings = new AgentSettings(f.config);
    settings.save({ default: f.options.agent, roles: {} });
    expect(settings.resolve('manager')).toMatchObject({ model: 'openai-codex/gpt-5.4', default_prompt: '', append_prompt: '', extensions: [], skills: [] });
    const saved = settings.save({ default: f.options.agent, roles: { manager: { ...f.options.agent, model: 'openai-codex/gpt-5.4-mini' } } });
    expect(saved.options.roles.find(role => role.id === 'manager').label).toContain('受限管理工具');
    expect(saved.options.default_prompts.manager).toContain('专用管理型 Agent');
    expect(settings.resolve('manager').model).toBe('openai-codex/gpt-5.4-mini');
    expect(settings.resolve('agent').model).toBe('openai-codex/gpt-5.4');
    expect(settings.retryProfile('manager', { agent: 'pi', config_mode: 'pi' })).toMatchObject({ agent: 'pi', config_mode: 'pi' });
    expect(() => settings.retryProfile('manager', { agent: 'codex' })).toThrow('legacy Codex CLI');
    expect(() => settings.save({ default: { agent: 'pi' }, roles: { manager: { agent: 'codex' } } })).toThrow('legacy Codex CLI');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('management credentials and task kind cannot be omitted and old unrestricted Codex backends refuse before spawning', async () => {
  const f = fixture();
  try {
    for (const token of ['', undefined, null]) await expect(new PiProvider(f.config).run(managedPiRun({ ...f.options, token }))).rejects.toThrow('invocation token');
    for (const task of [{ ...f.options.task, task_kind: 'order' }, { ...f.options.task, role: 'agent' }])
      await expect(new PiProvider(f.config).run(managedPiRun({ ...f.options, task }))).rejects.toThrow('manager role');
    await expect(new CodexProvider(f.config).run({ ...f.options, agent: { agent: 'codex' } })).rejects.toThrow('legacy Codex CLI');
    const routed = new AgentProvider(f.config, { resolve: () => ({ agent: 'codex' }) });
    expect(() => routed.run(f.options.agent ? { ...f.options, agent: undefined } : f.options)).toThrow('legacy Codex CLI');
    expect(fs.existsSync(path.join(f.config.home, 'sessions', 'task-50-input.md'))).toBe(false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('manager ignores common/role env and inherited or explicit profile env, while preserving network policy and development inheritance', async () => {
  const f = fixture();
  try {
    const directory = path.join(f.config.deviceHome, 'agent'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'agent.env'), 'COMMON_SENTINEL=common-development-secret\nHTTP_PROXY=http://common-env.invalid\n');
    fs.writeFileSync(path.join(directory, 'manager.env'), 'ROLE_SENTINEL=manager-env-secret\n');
    fs.writeFileSync(path.join(directory, 'worker.env'), 'ROLE_SENTINEL=worker-env-secret\n');
    saveNetworkConfiguration(f.config, { version: 1, mode: 'proxy', proxy_url: 'http://project-network.invalid',
      no_proxy: ['internal.invalid'], proxy_auth: null });
    const settings = new AgentSettings(f.config);
    settings.save({ default: { ...f.options.agent, env: { PROFILE_SENTINEL: 'profile-development-secret', HTTP_PROXY: 'http://profile-env.invalid' } }, roles: {} });
    const inherited = settings.resolve('manager');
    expect(inherited.env.PROFILE_SENTINEL).toBe('profile-development-secret');
    const explicit = settings.retryProfile('manager', { ...f.options.agent, env: { PROFILE_SENTINEL: 'explicit-manager-secret' } });
    for (const profile of [inherited, explicit, { ...explicit, config_mode: 'pi' }]) {
      const options = profile.config_mode === 'pi' ? { ...f.options, agent: profile } : managedPiRun({ ...f.options, agent: profile });
      const result = JSON.parse(await new PiProvider(f.config).run(options));
      for (const key of ['COMMON_SENTINEL', 'ROLE_SENTINEL', 'PROFILE_SENTINEL']) expect(result.env[key]).toBeUndefined();
      expect(result.env.HTTP_PROXY).toBe('http://project-network.invalid/');
      expect(result.env.NO_PROXY).toContain('internal.invalid');
      expect(result.env.LUSH_AGENT_TOKEN).toBe('one-invocation-token');
      expect(result.env.PATH).toBeTruthy();
      const input = fs.readFileSync(path.join(f.config.home, 'sessions', 'task-50-input.md'), 'utf8');
      for (const sentinel of ['common-development-secret', 'manager-env-secret', 'profile-development-secret', 'explicit-manager-secret'])
        expect(input).not.toContain(sentinel);
    }
    const development = JSON.parse(await new PiProvider(f.config).run(managedPiRun({ ...f.options,
      task: { ...f.options.task, role: 'worker', task_kind: 'child' }, agent: settings.resolve('worker') })));
    expect(development.env.COMMON_SENTINEL).toBe('common-development-secret');
    expect(development.env.ROLE_SENTINEL).toBe('worker-env-secret');
    expect(development.env.PROFILE_SENTINEL).toBe('profile-development-secret');
    expect(development.env.HTTP_PROXY).toBe('http://profile-env.invalid');
    // Bad development env syntax must not even be read on the management path.
    fs.writeFileSync(path.join(directory, 'manager.env'), 'NOT VALID ENV');
    await new PiProvider(f.config).run(managedPiRun(f.options));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('manager session input does not leak raw management JSON, private run settings or token hashes', async () => {
  const f = fixture();
  try {
    await new PiProvider(f.config).run(managedPiRun({ ...f.options, task: { ...f.options.task, agent_token_hash: 'HASH-SECRET',
      retry_profile: '{"env":{"SECRET":"PRIVATE-PROFILE"}}', management: '{"private":"RAW-MANAGEMENT"}' },
      context: { ...f.options.context, management: { pending_signal: { due_at: '2026-01-01T00:00:00Z' } } } }));
    const text = fs.readFileSync(path.join(f.config.home, 'sessions', 'task-50-input.md'), 'utf8');
    for (const secret of ['HASH-SECRET', 'PRIVATE-PROFILE', 'RAW-MANAGEMENT', 'one-invocation-token', 'FIXTURE-REFRESH-NEVER-COPIED']) expect(text).not.toContain(secret);
    expect(JSON.parse(text).management.pending_signal.due_at).toBe('2026-01-01T00:00:00Z');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
