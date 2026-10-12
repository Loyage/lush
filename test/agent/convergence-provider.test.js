import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../../src/config.js';
import { PiProvider, CodexProvider } from '../../src/agent/provider.js';
import { agentPrompt, builtInPrompt } from '../../src/agent/prompts.js';
import { AGENT_CAPABILITIES } from '../../src/agent/capabilities.js';
import { env, temp } from '../helpers.js';

function setup() {
  const root = temp(), fake = path.join(root, 'fake-pi');
  fs.writeFileSync(fake, '#!/usr/bin/env bun\nconsole.log(JSON.stringify({args:process.argv.slice(2)}));\n', { mode: 0o755 });
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device'),
    LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake }) }); config.prepare();
  const cwd = path.join(config.home, 'worktrees', '50-integration'); fs.mkdirSync(cwd, { recursive: true });
  const task = { id: 50, role: 'agent', task_kind: 'integration', workspace: cwd, branch: 'private-integration', base_commit: 'a'.repeat(40) };
  const options = { task, context: { invocation: { run_id: 3 }, integration: { version: 1, worker_id: 50,
    run_id: 1, node_id: 2, generation: 1, seed_commit: task.base_commit } },
    messages: [], cwd, token: 'one-invocation-token', signal: new AbortController().signal, onSpawn() {},
    agent: { agent: 'pi', config_mode: 'pi' } };
  return { root, config, options, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test('integration has mandatory purpose-specific Prompt without delegation, automatic titles or replacement overlays', () => {
  const f = setup();
  try {
    fs.mkdirSync(path.join(f.root, '.lush-agent'), { recursive: true });
    fs.writeFileSync(path.join(f.root, '.lush-agent', 'agent.md'), 'OVERLAY THAT DELEGATES');
    const prompt = agentPrompt(f.config, 'agent', { default_prompt: 'REPLACE AND DELEGATE', append_prompt: 'DEVELOPER APPEND' }, 'integration');
    expect(prompt.parts.every(part => part.source === 'builtin')).toBe(true);
    for (const text of ['角色：隔离整合 Worker', '不改变任何来源', 'git diff --find-renames', 'Agent 自己负责专项', '不执行最终验证快捷指令', '不能宣称 runtime 自动运行全量', '历史 command 模式', '不得 spawn', '不要调用 auto-title', '不是OS沙箱'])
      expect(prompt.text).toContain(text);
    for (const text of ['REPLACE AND DELEGATE', 'DEVELOPER APPEND', 'OVERLAY THAT DELEGATES', '角色：agent', 'lush worker spawn', 'lush worker auto-title'])
      expect(prompt.text).not.toContain(text);
    expect(prompt.customization.project).toEqual([]);
    expect(() => agentPrompt(f.config, 'worker', {}, 'integration')).toThrow('agent role');
    expect(agentPrompt(f.config, 'agent', {}, 'order').text).toContain('OVERLAY THAT DELEGATES');
  } finally { f.close(); }
});

test('integration previews and invocations share restricted optional Skills and respect disabled progress/context', () => {
  const f = setup();
  try {
    for (const settings of [{}, { progress_reporting: false, context_retrieval: false }]) {
      let reads = 0;
      const config = { ...f.config, runtimeSettings: { get() { reads++; return settings; } } };
      const prompt = agentPrompt(config, 'agent', {}, 'integration');
      expect(reads).toBe(1);
      expect(prompt.text).toBe(builtInPrompt('agent', { taskKind: 'integration', capabilities: settings }));
      expect(prompt.parts.map(part => part.name)).toEqual(['runtime', 'integration', 'decisions', 'capabilities']);
      expect(prompt.builtin_skills).toEqual(settings.progress_reporting === false ? []
        : AGENT_CAPABILITIES.filter(entry => ['progress', 'context'].includes(entry.id)).map(entry => entry.skill));
      for (const id of ['delegation', 'auto-title']) {
        expect(prompt.capabilities.find(entry => entry.id === id)).toMatchObject({ applicable: false, enabled: false });
        expect(prompt.text).not.toContain(`lush skills get ${id}`);
      }
      expect(prompt.text).not.toContain('lush progress plan');
      expect(prompt.text).not.toContain('角色：agent');
      expect(prompt.text).toContain('不得 spawn');
    }
  } finally { f.close(); }
});

test('Pi helper has its own session and ignores a fixed source commit checkpoint rather than inheriting a source session', async () => {
  const f = setup();
  try {
    const result = JSON.parse(await new PiProvider(f.config).run({ ...f.options,
      forkPointer: { session: '/missing-source-session', entry: 'private-source-entry' } }));
    expect(result.args.filter((value, index) => result.args[index - 1] === '--skill')).toEqual(
      AGENT_CAPABILITIES.filter(entry => ['progress', 'context'].includes(entry.id)).map(entry => entry.skill));
    expect(result.args).not.toContain('--fork'); expect(result.args).not.toContain('/missing-source-session');
    expect(result.args[result.args.indexOf('--session-id') + 1]).toBe('lush-task-50-pi');
    expect(fs.readFileSync(path.join(f.config.home, 'sessions', 'task-50-system.md'), 'utf8')).toContain('角色：隔离整合 Worker');
    await expect(new PiProvider(f.config).run({ ...f.options, choiceFork: { file: '/source', digest: 'a' } })).rejects.toThrow('inherit');
    await expect(new PiProvider(f.config).run({ ...f.options, token: '' })).rejects.toThrow('current invocation token');
  } finally { f.close(); }
});

for (const backend of [PiProvider, CodexProvider]) test(`${backend.name} rejects canonical cwd or wrong fixed identity before launching`, async () => {
  const f = setup();
  try {
    const provider = new backend(f.config);
    await expect(provider.run({ ...f.options, cwd: f.root, task: { ...f.options.task, workspace: f.root } })).rejects.toThrow('private worktree');
    await expect(provider.run({ ...f.options, context: { integration: { ...f.options.context.integration, generation: 0 } } })).rejects.toThrow('private worktree');
    await expect(provider.run({ ...f.options, task: { ...f.options.task, role: 'worker' } })).rejects.toThrow('private worktree');
    expect(fs.existsSync(path.join(f.config.home, 'sessions', 'task-50-input.md'))).toBe(false);
  } finally { f.close(); }
});
