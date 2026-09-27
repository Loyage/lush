import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { AgentSettings } from '../src/agent/settings.js';
import { CodexProvider, PiProvider } from '../src/agent/provider.js';
import { readUsageStatistics } from '../src/core/usage-statistics.js';
import { discoverAgentModels } from '../src/agent/models.js';
import { discoverAgentResources } from '../src/agent/resources.js';
import { GUIDE } from '../src/agent/guide.js';
import { run as runAgentCommand } from '../src/cli/commands/agent.js';
import { env, temp } from './helpers.js';

test('project Agent config is atomic, role-aware, and re-read dynamically', () => {
  const root = temp();
  const config = new Config({ project: root, env: env({ LUSH_PROVIDER: 'pi', LUSH_PI_MODEL: 'openai-codex/gpt-5.4', LUSH_PI_THINKING: 'medium' }) });
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
    expect(fs.statSync(path.join(root, '.lush', 'agent.json')).mode & 0o077).toBe(0);

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

test('agent CLI exposes the selected backend model catalog', async () => {
  const calls = [];
  const client = { token: null, async request(method, params) { calls.push({ method, params }); return { agent: params.agent, models: [] }; } };
  expect(await runAgentCommand('agent', ['models', 'codex'], { client })).toEqual({ agent: 'codex', models: [] });
  expect(calls).toEqual([{ method: 'agent.models', params: { agent: 'codex' } }]);
});

test('model discovery returns only the current CLI catalog shape', async () => {
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
  const config = new Config({ project: root, env: env({ LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: pi, LUSH_CODEX_COMMAND: codex }) });
  config.prepare();
  try {
    const piResult = await discoverAgentModels(config, 'pi');
    expect(piResult.source).toBe('cli');
    expect(piResult.models.map(model => model.id)).toEqual(['openai-codex/gpt-current', 'deepseek/flash-now']);
    const codexResult = await discoverAgentModels(config, 'codex');
    expect(codexResult.models).toEqual([{ id: 'gpt-current', label: 'GPT Current', description: 'Current model',
      default_thinking: 'medium', thinking: ['low', 'high'] }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pi resource discovery lists installed extensions and skills without loading them', async () => {
  const root = temp(), piHome = path.join(root, 'pi-home'), pkg = path.join(root, 'installed-package');
  fs.mkdirSync(path.join(piHome, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(piHome, 'skills', 'local-skill'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'skills', 'package-skill'), { recursive: true });
  fs.writeFileSync(path.join(piHome, 'extensions', 'local.ts'), 'export default () => {}');
  fs.writeFileSync(path.join(piHome, 'skills', 'local-skill', 'SKILL.md'), '---\nname: local-skill\ndescription: Local skill.\n---\n');
  fs.writeFileSync(path.join(pkg, 'tools', 'plugin.js'), 'export default () => {}');
  fs.writeFileSync(path.join(pkg, 'skills', 'package-skill', 'SKILL.md'), '---\nname: package-skill\ndescription: Package skill.\n---\n');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'demo-plugin', pi: { extensions: ['./tools/*.js'], skills: ['./skills'] } }));
  const fakePi = path.join(root, 'fake-pi');
  fs.writeFileSync(fakePi, `#!/usr/bin/env bun\nconsole.log('User packages:');\nconsole.log('  npm:demo-plugin');\nconsole.log('    ${pkg}');\n`, { mode: 0o755 });
  const config = new Config({ project: root, env: env({ PI_CODING_AGENT_DIR: piHome, LUSH_PI_COMMAND: fakePi }) });
  config.prepare();
  try {
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
  const config = new Config({ project: root, env: env({ LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake }) });
  config.prepare();
  try {
    const provider = new PiProvider(config);
    expect(await provider.run({ task: { id: 8, parent_id: 3, role: 'worker', goal: 'test' }, context: {}, messages: [], cwd: root, token: 'secret',
      signal: new AbortController().signal, onSpawn() {}, agent: { agent: 'pi', model: '', thinking: '', default_prompt: '', append_prompt: '',
        extensions: ['/tmp/selected-extension.ts'], skills: ['/tmp/selected-skill/SKILL.md'] } })).toBe('pi finished');
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
  const config = new Config({ project: root, env: env({ LUSH_PROVIDER: 'codex', LUSH_CODEX_COMMAND: fake }) });
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
