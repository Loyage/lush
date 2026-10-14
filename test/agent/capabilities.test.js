import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENT_CAPABILITIES, listCapabilityGuides, capabilityGuide, resolveAgentCapabilities } from '../../src/agent/capabilities.js';
import { agentPrompt, builtInPrompt } from '../../src/agent/prompts.js';
import { PiProvider, CodexProvider } from '../../src/agent/provider.js';
import { Config } from '../../src/config.js';
import { AgentSettings } from '../../src/agent/settings.js';
import { env, temp } from '../helpers.js';
import { managedPiRun } from './managed-runtime-fixture.js';

const cli = fileURLToPath(new URL('../../bin/lushc', import.meta.url));
const ids = ['progress', 'delegation', 'auto-title', 'context'];
const flags = Object.fromEntries(AGENT_CAPABILITIES.map(entry => [entry.setting, false]));
function promptConfig(root, settings = {}) {
  return { project: root, home: path.join(root, '.lush'), runtimeSettings: { get: () => settings } };
}
function selected(args, flag) { return args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []); }

// These tests use a settings model stub. Production storage is exercised by the settings/UI sibling.
test('built-in Skill registry has fixed IDs/settings, portable thin entries and complete matching guides', () => {
  expect(listCapabilityGuides().map(entry => entry.id)).toEqual(ids);
  expect(listCapabilityGuides().map(entry => entry.setting)).toEqual(['progress_reporting', 'worker_delegation', 'worker_auto_title', 'context_retrieval']);
  for (const entry of AGENT_CAPABILITIES) {
    const skill = fs.readFileSync(entry.skill, 'utf8');
    expect(skill).toStartWith(`---\nname: lush-${entry.id}\ndescription:`);
    expect(Buffer.byteLength(skill)).toBeLessThan(2000);
    expect(skill).toContain(`lushc skills get ${entry.id}`);
    const guide = capabilityGuide(entry.id);
    expect(guide).toMatchObject({ id: entry.id, name: entry.name, setting: entry.setting });
    expect(guide.content.length).toBeGreaterThan(500);
    expect(listCapabilityGuides().find(item => item.id === entry.id)).not.toHaveProperty('skill');
    expect(listCapabilityGuides().find(item => item.id === entry.id)).not.toHaveProperty('enabled');
  }
  expect(capabilityGuide('progress').content).toContain('lushc progress plan');
  expect(capabilityGuide('delegation').content).toContain('lushc worker spawn');
  expect(capabilityGuide('auto-title').content).toContain('lushc worker auto-title');
  for (const rule of ['不照抄输入第一行', '首次成功后保持稳定', '不要为了标题另开模型调用', 'changed:false']) expect(capabilityGuide('auto-title').content).toContain(rule);
  expect(capabilityGuide('context').content).toContain('lushc worker transcript');
  for (const id of ['unknown', '../progress/guide.md', '/tmp/a', 'lush-progress']) expect(() => capabilityGuide(id)).toThrow('unknown built-in skill');
});

test('delegation guide keeps intermediate delivery runnable and names independent/integrated verification owners', () => {
  const guide = capabilityGuide('delegation').content;
  for (const rule of [
    '公共组件的导出／参数', '生命周期', '文件不重叠不代表没有代码依赖',
    '当前已提交、可运行的父基线', '验证并提交可运行骨架，再派工',
    '等其实际合入后再创建依赖方', '不提前引用尚未交付的文件',
    '不伪造兄弟模块、跳过构建或放宽预算',
    'child 可独立完成的验证', '集成验证', '分别写明范围和负责人',
    '受阻测试与最终补验负责人', '不能报告通过',
  ]) expect(guide).toContain(rule);
  // Optional delegation details stay in the guide, not in the always-on prompt.
  expect(builtInPrompt('agent')).not.toContain('### 可构建的中间交付');
});

test('actual prompts inject short triggers, not long optional workflows, and preserve mandatory core', () => {
  const root = temp();
  try {
    const view = agentPrompt(promptConfig(root), 'agent', {}, 'order');
    expect(view.builtin_skills).toEqual(AGENT_CAPABILITIES.map(entry => entry.skill));
    expect(view.parts.filter(part => part.name === 'capabilities')).toHaveLength(1);
    expect(view.parts.some(part => ['progress', 'auto_title'].includes(part.name))).toBe(false);
    for (const id of ids) expect(view.text).toContain(`lushc skills get ${id}`);
    for (const workflow of ['lushc progress plan', "lushc worker auto-title '简短标题'", "lushc worker spawn '目标'", 'lushc worker list --brief']) expect(view.text).not.toContain(workflow);
    expect(view.text).toContain('开始实质工作前必须加载');
    expect(view.text).toContain('auto_title 为空时');
    for (const rule of ['唯一可写的代码副本', 'LUSH_AGENT_TOKEN', '合法普通消息仍可持久入箱', '必须检查 child 成果',
      '验收即归档', '最终全量由直接交付 main/owner', '不是操作系统管家', '不要 wait / poll']) expect(view.text).toContain(rule);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('single-item and all-disabled policies remove Skill paths/active guides, announce stale-context policy and reset cleanly', () => {
  const root = temp();
  try {
    for (const entry of AGENT_CAPABILITIES) {
      for (const value of [false, { value: false }]) {
        const view = agentPrompt(promptConfig(root, { [entry.setting]: value }), 'agent', {}, 'child');
        expect(view.builtin_skills).not.toContain(entry.skill);
        expect(view.text).not.toContain(`lushc skills get ${entry.id}`);
        expect(view.text).not.toContain(entry.skill);
        expect(view.text).toContain(`已关闭：${entry.id}`);
        expect(view.builtin_skills).toHaveLength(3);
      }
    }
    const closed = agentPrompt(promptConfig(root, flags), 'agent', {}, 'order');
    expect(closed.builtin_skills).toEqual([]);
    expect(closed.text).not.toContain('指南：lushc skills get');
    expect(closed.text).toContain('优先于旧会话中的能力入口');
    expect(closed.text).toContain('不撤销 CLI/RPC 权限');
    expect(closed.text).toContain('不取消已有后代');
    expect(closed.text).toContain('不以其中的旧指令重新启用');
    const restored = agentPrompt(promptConfig(root, {}), 'agent', {}, 'order');
    expect(restored.builtin_skills).toHaveLength(4);
    expect(restored.text).not.toContain('已关闭：');
    expect(builtInPrompt('agent', { progressReporting: false, capabilities: flags })).not.toContain('指南：lushc skills get');
    expect(builtInPrompt('agent', { capabilities: flags })).not.toContain('指南：lushc skills get');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('isolated roles never read capability settings; analysis and legacy roles do not obtain delegation or titles', () => {
  const root = temp();
  try {
    const config = promptConfig(root); config.runtimeSettings.get = () => { throw new Error('settings read'); };
    for (const role of ['manager', 'explainer', 'butler']) {
      const view = agentPrompt(config, role, {}, role === 'manager' ? 'management' : null);
      expect(view.builtin_skills).toEqual([]); expect(view.capabilities).toEqual([]);
      expect(view.text).not.toContain('可选 Agent 能力');
    }
    for (const [role, kind] of [['agent', 'analysis'], ['research', null], ['worker', null], ['planner', null]]) {
      const view = agentPrompt(promptConfig(root), role, {}, kind);
      expect(view.builtin_skills).toEqual(AGENT_CAPABILITIES.filter(entry => ['progress', 'context'].includes(entry.id)).map(entry => entry.skill));
      expect(view.text).not.toContain('lushc skills get delegation'); expect(view.text).not.toContain('lushc skills get auto-title');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('replacement and append Prompts remain unchanged, followed by the current policy; Pi-default excludes overlays', () => {
  const root = temp();
  try {
    const config = promptConfig(root, flags), custom = 'CUSTOM RULES\nlush progress plan from-old-custom';
    fs.mkdirSync(path.join(root, '.lush-agent'));
    fs.writeFileSync(path.join(root, '.lush-agent', 'common.md'), 'REPO OVERLAY');
    const view = agentPrompt(config, 'agent', { default_prompt: custom, append_prompt: 'USER APPEND' }, 'order');
    expect(view.parts[0].content).toBe(custom);
    expect(view.text).toStartWith(custom); expect(view.text).toContain('USER APPEND'); expect(view.text).toContain('REPO OVERLAY');
    expect(view.parts.at(-1).name).toBe('capabilities'); expect(view.text).toContain('已关闭：');
    expect(view.builtin_skills).toEqual([]);
    const pi = agentPrompt(config, 'agent', { config_mode: 'pi', default_prompt: custom, append_prompt: 'USER APPEND' }, 'order');
    for (const value of [custom, 'USER APPEND', 'REPO OVERLAY']) expect(pi.text).not.toContain(value);
    expect(pi.text).toContain('已关闭：'); expect(pi.text).toContain('唯一可写的代码副本');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('minimum configuration defaults on; existing progress fallback remains compatible', () => {
  expect(resolveAgentCapabilities({}, 'agent', 'child').every(entry => entry.enabled)).toBe(true);
  expect(resolveAgentCapabilities({ progressReporting: false }, 'agent', 'child').filter(entry => entry.enabled).map(entry => entry.id)).toEqual(ids.slice(1));
  expect(resolveAgentCapabilities({ runtimeSettings: { get: () => ({ progress_reporting: { value: true } }) }, progressReporting: false }, 'agent', 'order').every(entry => entry.enabled)).toBe(true);
});

test('persisted shared capability settings drive both project invocations and all role previews after parent integration', () => {
  const root = temp(), global = path.join(root, 'device');
  const configs = ['a', 'b'].map(name => {
    const project = path.join(root, name); fs.mkdirSync(project, { mode: 0o700 });
    return new Config({ project, env: env({ LUSH_GLOBAL_CONFIG: global }) });
  });
  try {
    const [a, b] = configs;
    a.configureRuntime(flags);
    // Consumer b has stale Config fields but must reread the shared settings for every invocation.
    expect(b.progressReporting).toBe(true);
    for (const config of configs) {
      for (const config_mode of ['lush', 'pi']) {
        const view = agentPrompt(config, 'agent', { config_mode }, 'child');
        expect(view.builtin_skills).toEqual([]);
        expect(view.text).not.toContain('指南：lushc skills get');
        const preview = new AgentSettings(config).get().options.default_prompts.agent;
        expect(preview).toBe(builtInPrompt('agent', { capabilities: flags }));
      }
    }
    b.configureRuntime({ worker_auto_title: null, context_retrieval: true });
    for (const config of configs) {
      const view = agentPrompt(config, 'agent', {}, 'order');
      expect(view.capabilities.filter(entry => entry.enabled).map(entry => entry.id)).toEqual(['auto-title', 'context']);
      expect(view.builtin_skills).toEqual(AGENT_CAPABILITIES.filter(entry => ['auto-title', 'context'].includes(entry.id)).map(entry => entry.skill));
      const preview = new AgentSettings(config).get().options.default_prompts.agent;
      expect(preview).toContain('lushc skills get auto-title'); expect(preview).toContain('lushc skills get context');
      expect(preview).not.toContain('lushc skills get delegation'); expect(preview).not.toContain('lushc skills get progress');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ['lush', 'pi']) {
  test(`Pi ${mode} receives only enabled built-in Skill paths from the exact Prompt snapshot and keeps third-party mode boundaries`, async () => {
    const root = temp(), fake = path.join(root, 'fake-pi'), output = path.join(root, 'argv.json');
    fs.writeFileSync(fake, `#!/usr/bin/env bun\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2))); console.log('done');\n`, { mode: 0o755 });
    const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device'), LUSH_PI_COMMAND: fake }) }); config.prepare();
    try {
      let reads = 0;
      config.runtimeSettings.get = () => { reads++; return reads === 1 ? { worker_delegation: { value: false } } : flags; };
      const options = { task: { id: 40, role: 'agent', task_kind: 'order', goal: 'capability test' }, context: {}, messages: [], cwd: root,
        token: 'fixture', signal: new AbortController().signal, onSpawn() {},
        agent: { agent: 'pi', ...(mode === 'pi' ? { config_mode: 'pi' } : {}), extensions: ['/tmp/third-party.js'],
          skills: ['/tmp/third-party/SKILL.md', AGENT_CAPABILITIES[0].skill, path.dirname(AGENT_CAPABILITIES[1].skill)] } };
      await new PiProvider(config).run(mode === 'pi' ? options : managedPiRun(options));
      expect(reads).toBe(1);
      const args = JSON.parse(fs.readFileSync(output, 'utf8')), loaded = selected(args, '--skill');
      const enabled = AGENT_CAPABILITIES.filter(entry => entry.id !== 'delegation');
      expect(loaded).toEqual([...(mode === 'lush' ? ['/tmp/third-party/SKILL.md'] : []), ...enabled.map(entry => entry.skill)]);
      const system = fs.readFileSync(path.join(config.home, 'sessions/task-40-system.md'), 'utf8');
      for (const entry of enabled) expect(system).toContain(entry.skill);
      expect(system).not.toContain(AGENT_CAPABILITIES[1].skill); expect(system).toContain('已关闭：delegation');
      expect(args.includes('--no-skills')).toBe(mode === 'lush');
      expect(args.includes('/tmp/third-party.js')).toBe(mode === 'lush');
      // Next invocation, including a resumed thread, must receive the newly closed policy and no stubs.
      await new PiProvider(config).run(mode === 'pi' ? options : managedPiRun(options));
      expect(selected(JSON.parse(fs.readFileSync(output, 'utf8')), '--skill')).toEqual(mode === 'lush' ? ['/tmp/third-party/SKILL.md'] : []);
      expect(fs.readFileSync(path.join(config.home, 'sessions/task-40-system.md'), 'utf8')).toContain('没有已开启且适用');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('Codex uses the same thin current policy and public CLI guides, never Pi resource flags', async () => {
  const root = temp(), fake = path.join(root, 'fake-codex'), output = path.join(root, 'codex.json');
  fs.writeFileSync(fake, `#!/usr/bin/env bun\nimport fs from 'node:fs'; const args=process.argv.slice(2); fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(args)); fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'done'); console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));\n`, { mode: 0o755 });
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device'), LUSH_CODEX_COMMAND: fake }) }); config.prepare();
  try {
    let policy = { worker_auto_title: false }, reads = 0;
    config.runtimeSettings.get = () => { reads++; return policy; };
    const options = { task: { id: 41, role: 'agent', task_kind: 'child', goal: 'test' }, context: {}, messages: [], cwd: root,
      token: 'fixture', signal: new AbortController().signal, onSpawn() {}, agent: { agent: 'codex', skills: ['/tmp/third-party/SKILL.md'] } };
    const provider = new CodexProvider(config);
    await provider.run(options);
    let system = fs.readFileSync(path.join(config.home, 'sessions/task-41-system.md'), 'utf8');
    expect(reads).toBe(1); expect(system).toContain('lushc skills get delegation'); expect(system).not.toContain('lushc skills get auto-title');
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).not.toContain('--skill');
    policy = flags; await provider.run(options);
    expect(reads).toBe(2); expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toContain('resume');
    system = fs.readFileSync(path.join(config.home, 'sessions/task-41-system.md'), 'utf8');
    expect(system).toContain('优先于旧会话中的能力入口'); expect(system).not.toContain('指南：lushc skills get');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('public skills CLI is offline, needs no project or device reads, and has strict text/JSON arguments', () => {
  const root = temp();
  try {
    fs.mkdirSync(path.join(root, 'device/shared'), { recursive: true, mode: 0o700 });
    const broken = path.join(root, 'device/shared/settings.json'); fs.writeFileSync(broken, 'MALFORMED SECRET', { mode: 0o600 });
    const values = env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device'), LUSH_PROJECT: path.join(root, 'no-project'),
      LUSH_HOME: path.join(root, 'wrong-home'), LUSH_AGENT_TOKEN: 'fixture-invalid-token' });
    const run = args => cp.spawnSync(process.execPath, [cli, ...args], { cwd: root, env: values, encoding: 'utf8', timeout: 10000 });
    const list = run(['skills', 'list', '--json']); expect(list.status).toBe(0); expect(JSON.parse(list.stdout)).toEqual(listCapabilityGuides());
    for (const entry of AGENT_CAPABILITIES) {
      const text = run(['skills', 'get', entry.id]); expect(text.status).toBe(0); expect(text.stdout.trim()).toBe(capabilityGuide(entry.id).content);
      const json = run(['--json', 'skills', 'get', entry.id]); expect(json.status).toBe(0); expect(JSON.parse(json.stdout)).toEqual(capabilityGuide(entry.id));
    }
    expect(run(['skills', 'list']).stdout).toContain('context\t上下文检索');
    for (const args of [['get'], ['get', '../progress/guide.md'], ['list', 'extra'], ['get', 'progress', 'extra'], ['install', 'foo'], ['list', '--scope', 'device'], ['list', '--json', '--json']]) {
      const failure = run(['skills', ...args]); expect(failure.status).not.toBe(0); expect(failure.stdout).toBe('');
      expect(failure.stderr).not.toContain('MALFORMED SECRET');
    }
    expect(fs.readFileSync(broken, 'utf8')).toBe('MALFORMED SECRET'); expect(fs.existsSync(path.join(root, '.lush'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'device/shared'))).toEqual(['settings.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
