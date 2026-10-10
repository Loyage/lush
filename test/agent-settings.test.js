import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Config } from '../src/config.js';
import { AgentSettings, AGENT_ROLES } from '../src/agent/settings.js';
import { builtInPrompt, agentPrompt, PROMPT_PARTS, ROLE_PROMPT_PARTS } from '../src/agent/prompts.js';
import { CodexProvider, PiProvider } from '../src/agent/provider.js';
import { readUsageStatistics } from '../src/core/usage-statistics.js';
import { discoverAgentModels } from '../src/agent/models.js';
import { discoverAgentResources } from '../src/agent/resources.js';
import { ensurePiConfiguration } from '../src/agent/pi-config.js';
import { GUIDE } from '../src/agent/guide.js';
import { run as runAgentCommand } from '../src/cli/commands/agent.js';
import { env } from './helpers.js';
import { managedPiRun } from './agent/managed-runtime-fixture.js';
// Profile/provider tests reuse the isolated environment without constructing a Project fixture.
function temp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-agent-settings-'))); }

test('retired showcase profiles are ignored on read, preserved on disk and rejected on write', async () => {
  const root = temp();
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) }); config.prepare();
  try {
    const settings = new AgentSettings(config);
    const stored = { version: 1, default: { agent: 'pi', model: 'active-model' },
      roles: { showcase: { agent: 'obsolete-backend', prompt: 'legacy override' }, worker: { agent: 'codex', model: 'worker-model' } } };
    const body = JSON.stringify(stored);
    fs.mkdirSync(config.deviceHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(settings.file, body, { mode: 0o600 });
    const read = settings.get();
    expect(read.resolved.worker.model).toBe('worker-model');
    expect(read.roles.showcase).toBeUndefined();
    expect(read.resolved.showcase).toBeUndefined();
    expect(read.options.roles.some(role => role.id === 'showcase')).toBe(false);
    expect(read.options.default_prompts.showcase).toBeUndefined();
    expect(fs.readFileSync(settings.file, 'utf8')).toBe(body);
    expect(() => settings.save(stored)).toThrow('unknown role');
    expect(() => settings.retryProfile('showcase', { agent: 'pi' })).toThrow('unknown agent role');
    expect(() => settings.resolve('showcase')).toThrow('no longer supported');
    expect(AGENT_ROLES).not.toContain('showcase');
    expect(PROMPT_PARTS.showcase).toBeUndefined();
    expect(ROLE_PROMPT_PARTS.showcase).toBeUndefined();
    expect(() => builtInPrompt('showcase')).toThrow('role must be');
    expect(() => agentPrompt(config, 'showcase')).toThrow('role must be');
    const client = { token: null, async request() { return read; } };
    await expect(runAgentCommand('agent', ['set', 'showcase', '--model', 'x'], { client })).rejects.toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('device Agent config is atomic, role-aware, and re-read dynamically', () => {
  const root = temp();
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device'), LUSH_PROVIDER: 'pi', LUSH_PI_MODEL: 'openai-codex/gpt-5.4', LUSH_PI_THINKING: 'medium' }) });
  config.prepare();
  try {
    const settings = new AgentSettings(config);
    expect(settings.get().default).toEqual({ agent: 'pi', model: 'openai-codex/gpt-5.4', thinking: 'medium', default_prompt: '', append_prompt: '', extensions: [], skills: [] });
    expect(settings.get().options.default_prompt).toBe(GUIDE);
    const saved = settings.save({ version: 1,
      default: { agent: 'codex', model: 'gpt-5.4-mini', thinking: 'high', default_prompt: 'Replacement rules.', append_prompt: 'Keep changes small.' },
      // Old `prompt` remains an append-only compatibility alias.
      roles: { planner: { agent: 'pi', model: 'deepseek/deepseek-flash', thinking: 'xhigh', prompt: '先列风险。' } },
    });
    expect(saved.resolved.worker.agent).toBe('codex');
    expect(saved.resolved.planner).toMatchObject({ agent: 'pi', model: 'deepseek/deepseek-flash', thinking: 'xhigh' });
    expect(fs.statSync(path.join(config.deviceHome, 'agent.json')).mode & 0o077).toBe(0);

    // Another reader sees the file immediately; no daemon restart or in-memory mutation is required.
    const next = new AgentSettings(config);
    expect(next.resolve('worker').model).toBe('gpt-5.4-mini');
    expect(next.resolve('worker')).toMatchObject({ default_prompt: 'Replacement rules.', append_prompt: 'Keep changes small.' });
    expect(next.resolve('planner').append_prompt).toBe('先列风险。');
    expect(() => next.save({ version: 1, default: { agent: 'codex', model: '', thinking: 'max', default_prompt: '', append_prompt: '' }, roles: {} }))
      .toThrow('not supported by codex');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent CLI edits and resets one role without replacing the other profiles', async () => {
  let value = {
    version: 1, default: { agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '' }, roles: {},
    resolved: { merger: { agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '' } },
  };
  const client = { token: null, async request(method, params) {
    if (method === 'agent.config') return value;
    expect(method).toBe('agent.configure');
    value = { ...value, ...params.config,
      resolved: { merger: { ...(params.config.roles.merger || params.config.default) } } };
    return value;
  } };
  await runAgentCommand('agent', ['set', 'merger', '--agent', 'codex', '--model', 'gpt-5.4', '--thinking', 'high', '--default-prompt', '完整规则。', '--append-prompt', '只解决分歧。'], { client });
  expect(value.roles.merger).toEqual({ agent: 'codex', model: 'gpt-5.4', thinking: 'high', default_prompt: '完整规则。', append_prompt: '只解决分歧。' });
  await runAgentCommand('agent', ['reset', 'merger'], { client });
  expect(value.roles.merger).toBeUndefined();
});

test('agent CLI binds a managed connection, preserves it on model edits and clears it explicitly or on backend change', async () => {
  const id = '9e32c7e1-9b59-4ec2-a4b0-8fbbf224ef87';
  let profile = { agent: 'pi', model: 'deepseek/deepseek-chat', thinking: '' };
  const client = { token: null, async request(method, params) {
    if (method === 'agent.config') return { version: 1, default: profile, roles: {}, resolved: { agent: profile } };
    expect(method).toBe('agent.configure');
    profile = params.config.default;
    return params.config;
  } };
  await runAgentCommand('agent', ['set', 'default', '--connection', id], { client });
  expect(profile.connection_id).toBe(id);
  await runAgentCommand('agent', ['set', 'default', '--model', 'deepseek/deepseek-reasoner'], { client });
  expect(profile.connection_id).toBe(id);
  await runAgentCommand('agent', ['set', 'default', '--connection', 'off'], { client });
  expect(profile.connection_id).toBeUndefined();
  await runAgentCommand('agent', ['set', 'default', '--connection', id], { client });
  await runAgentCommand('agent', ['set', 'default', '--agent', 'codex'], { client });
  expect(profile.connection_id).toBeUndefined();
  expect(profile.model).toBe('');
  await expect(runAgentCommand('agent', ['set', 'default', '--connection', id], { client: { ...client, token: 'agent' } })).rejects.toThrow();
});

test('agent CLI exposes the selected backend model catalog', async () => {
  const calls = [];
  const client = { token: null, async request(method, params) { calls.push({ method, params }); return { agent: params.agent, models: [] }; } };
  expect(await runAgentCommand('agent', ['models', 'codex'], { client })).toEqual({ agent: 'codex', models: [] });
  expect(calls).toEqual([{ method: 'agent.models', params: { agent: 'codex' } }]);
});

test('Pi model discovery rejects unsafe CLI listing without SDK, Codex keeps its CLI catalog' , async () => {
  const root = temp();
  const pi = path.join(root, 'fake-pi');
  const codex = path.join(root, 'fake-codex-models');
  fs.writeFileSync(pi, `#!/usr/bin/env bun
console.log('provider        model          context  max-out  thinking  images');
console.log('openai-codex    gpt-current    272K     128K     yes       yes');
console.log('deepseek        flash-now      1M       384K     yes       no');
`, { mode: 0o755 });
  fs.writeFileSync(codex, `#!/usr/bin/env bun
console.log(JSON.stringify({ models: [
  { slug: 'gpt-current', display_name: 'GPT Current', description: 'Current model', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
  { slug: 'hidden-one', display_name: 'Hidden', visibility: 'hide' }
] }));
`, { mode: 0o755 });
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device'), LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: pi, LUSH_CODEX_COMMAND: codex }) });
  config.prepare();
  try {
    const piResult = await discoverAgentModels(config, 'pi');
    expect(piResult.source).toBe('presets');
    expect(piResult.warning).toContain('无法读取');
    expect(piResult.models.map(model => model.id)).not.toContain('deepseek/flash-now');
    fs.mkdirSync(config.deviceHome, { recursive: true, mode: 0o700 });
    const codexResult = await discoverAgentModels(config, 'codex');
    expect(codexResult.models).toEqual([{ id: 'gpt-current', label: 'GPT Current', description: 'Current model',
      default_thinking: 'medium', thinking: ['low', 'high'] }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pi resource discovery lists installed extensions and skills without loading them', async () => {
  const root = temp(), pkg = path.join(root, 'installed-package'), fakePi = path.join(root, 'fake-pi');
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device'), LUSH_PI_COMMAND: fakePi }) });
  config.prepare();
  try {
    // Initialize the private Pi directory explicitly; CI's umask must not determine its permissions.
    const { dir: piHome } = ensurePiConfiguration(config);
    expect(fs.statSync(piHome).mode & 0o777).toBe(0o700);
    fs.mkdirSync(path.join(piHome, 'extensions'), { recursive: true });
    fs.mkdirSync(path.join(piHome, 'skills', 'local-skill'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'skills', 'package-skill'), { recursive: true });
    fs.writeFileSync(path.join(piHome, 'extensions', 'local.ts'), 'export default () => {}');
    fs.writeFileSync(path.join(piHome, 'skills', 'local-skill', 'SKILL.md'), '---\nname: local-skill\ndescription: Local skill.\n---\n');
    fs.writeFileSync(path.join(pkg, 'tools', 'plugin.js'), 'export default () => {}');
    fs.writeFileSync(path.join(pkg, 'skills', 'package-skill', 'SKILL.md'), '---\nname: package-skill\ndescription: Package skill.\n---\n');
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'demo-plugin', pi: { extensions: ['./tools/*.js'], skills: ['./skills'] } }));
    fs.writeFileSync(fakePi, `#!/usr/bin/env bun\nconsole.log('User packages:');\nconsole.log('  npm:demo-plugin');\nconsole.log('    ${pkg}');\n`, { mode: 0o755 });
    const catalog = await discoverAgentResources(config);
    expect(catalog.warning).toBeNull();
    expect(catalog.extensions.map(item => item.label)).toContain('local.ts');
    expect(catalog.extensions.some(item => item.label.endsWith('plugin.js'))).toBe(true);
    expect(catalog.skills.map(item => item.label)).toContain('local-skill');
    expect(catalog.skills.map(item => item.label)).toContain('package-skill');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pi provider disables discovery and explicitly loads only the selected extensions and skills', async () => {
  const root = temp(), fake = path.join(root, 'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env bun\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.LUSH_HOME + '/pi-args.json', JSON.stringify(process.argv.slice(2)));\nfs.writeFileSync(process.env.LUSH_HOME + '/pi-env.json', JSON.stringify({ task: process.env.LUSH_TASK_ID }));\nconsole.log('pi finished');\n`, { mode: 0o755 });
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device'), LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake }) });
  config.prepare();
  try {
    const provider = new PiProvider(config);
    expect(await provider.run(managedPiRun({ task: { id: 8, parent_id: 3, role: 'worker', goal: 'test' }, context: {}, messages: [], cwd: root, token: 'secret',
      signal: new AbortController().signal, onSpawn() {}, agent: { agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '',
        extensions: ['/tmp/selected-extension.ts'], skills: ['/tmp/selected-skill/SKILL.md'] } }))).toBe('pi finished');
    const args = JSON.parse(fs.readFileSync(path.join(root, '.lush', 'pi-args.json'), 'utf8'));
    expect(args).toContain('--no-extensions'); expect(args).toContain('--no-skills');
    expect(args.slice(args.indexOf('--extension'), args.indexOf('--extension') + 2)).toEqual(['--extension', '/tmp/selected-extension.ts']);
    expect(args.slice(args.indexOf('--skill'), args.indexOf('--skill') + 2)).toEqual(['--skill', '/tmp/selected-skill/SKILL.md']);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.lush', 'pi-env.json'), 'utf8'))).toEqual({ task: '8' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex provider persists a task thread and resumes it on the next invocation', async () => {
  const root = temp();
  const fake = path.join(root, 'fake-codex');
  fs.writeFileSync(fake, `#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const out = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(out, 'codex finished');
fs.appendFileSync(path.join(process.env.LUSH_HOME, 'codex-seen.jsonl'), JSON.stringify({ args, task: process.env.LUSH_TASK_ID, token: !!process.env.LUSH_AGENT_TOKEN }) + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test-1' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } }));
`, { mode: 0o755 });
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device'), LUSH_PROVIDER: 'codex', LUSH_CODEX_COMMAND: fake }) });
  config.prepare();
  try {
    const provider = new CodexProvider(config);
    const common = {
      task: { id: 7, role: 'worker', goal: 'test' }, context: {}, messages: [], cwd: root, token: 'secret',
      signal: new AbortController().signal, onSpawn() {},
      agent: { agent: 'codex', model: 'gpt-5.4-mini', thinking: 'high', default_prompt: '', append_prompt: 'Run checks.', extensions: [], skills: [] },
    };
    expect(await provider.run(common)).toBe('codex finished');
    common.agent.default_prompt = 'Replacement system rules.';
    common.agent.append_prompt = 'Additional project rules.';
    expect(await provider.run(common)).toBe('codex finished');
    const systemPrompt = fs.readFileSync(path.join(root, '.lush', 'sessions', 'task-7-system.md'), 'utf8');
    expect(systemPrompt).toStartWith('Replacement system rules.');
    expect(systemPrompt).toContain('Additional project rules.');
    const seen = fs.readFileSync(path.join(root, '.lush', 'codex-seen.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(seen).toHaveLength(2);
    expect(seen[0].args.slice(0, 2)).toEqual(['exec', '--dangerously-bypass-approvals-and-sandbox']);
    expect(seen[0].args).toContain('model_reasoning_effort="high"');
    expect(seen[0].args.at(-1)).toContain('current Worker and unread messages');
    expect(seen[0].args.at(-1)).toContain('Follow the Worker role');
    expect(seen[1].args.slice(0, 3)).toEqual(['exec', 'resume', '--dangerously-bypass-approvals-and-sandbox']);
    expect(seen[1].args).toContain('thread-test-1');
    expect(seen.every(row => row.task === '7' && row.token)).toBe(true);
    const usage = await readUsageStatistics(config);
    expect(usage.totals).toMatchObject({ requests: 2, tokens: 240, input: 120, cache_read: 80, output: 40, unknown_cost: 2, unknown_tokens: 0 });
    expect(usage.models[0]).toMatchObject({ provider: 'codex', model: 'gpt-5.4-mini' });
    const files = fs.readdirSync(path.join(config.home, 'sessions')).filter(name => name.endsWith('_lush-task-7.jsonl'));
    expect(files.length).toBe(2);
    expect(fs.statSync(path.join(config.home, 'sessions', files[0])).mode & 0o777).toBe(0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
