import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { AGENT_CAPABILITIES, listCapabilityGuides, capabilityGuide } from '../../src/agent/capabilities.js';
import { agentPrompt } from '../../src/agent/prompts.js';
import { cliCommands } from '../../src/cli/catalog.js';
import { temp } from '../helpers.js';

const retiredWorkerCLI = /\blushw (?:worker|branch|status|progress)\b|\blushw notice (?:list|post)\b/;

test('context-oriented prompts and all Skill command examples match the owned CLI catalogue', () => {
  const root = temp();
  try {
    const config = { project: root, home: root, runtimeSettings: { get: () => ({}) } };
    for (const kind of ['order', 'child', 'analysis', 'integration']) {
      const prompt = agentPrompt(config, 'agent', {}, kind).text;
      expect(prompt).not.toMatch(retiredWorkerCLI);
      if (kind !== 'analysis') expect(prompt).toContain('lushw self notice post');
    }
    const prompt = agentPrompt(config, 'agent', {}, 'order').text;
    for (const phrase of ['有效 invocation token', 'lushw parent inspect', 'lushw children inspect ID',
      'coverage=worker_context', '不含嵌套关系', '用户用 lush worker accept ID', 'Agent 用 lushw children accept ID']) {
      expect(prompt).toContain(phrase);
    }
    const leaves = cliCommands('lushw').filter(entry => !entry.directory).map(entry => entry.path);
    let checked = 0;
    for (const entry of AGENT_CAPABILITIES) {
      const text = fs.readFileSync(entry.skill, 'utf8') + '\n' + capabilityGuide(entry.id).content;
      expect(text).not.toMatch(retiredWorkerCLI);
      for (const match of text.matchAll(/\blushw ((?:[a-z][a-z-]*)(?: [a-z][a-z-]*)*)/g)) {
        expect(leaves.some(leaf => match[1] === leaf || match[1].startsWith(`${leaf} `))).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    const context = capabilityGuide('context').content;
    for (const phrase of ['event_metadata_only', 'worker_context', 'omitted', 'next', 'has_more', '不含事件正文', '直接子 Worker']) {
      expect(context).toContain(phrase);
    }
    const manager = agentPrompt(config, 'manager').text;
    expect(manager).toContain('唯一模型工具是 lush_cli');
    expect(manager).toContain('不继承 lushw 的 invocation 绑定 context.*');
    expect(manager).not.toContain('默认开放全部 lushw RPC');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('built-in capabilities share their registry, guides and invocation policy', () => {
  const root = temp();
  try {
    const config = { project: root, home: root, runtimeSettings: { get: () => ({}) } };
    expect(listCapabilityGuides().map(entry => entry.id)).toEqual(AGENT_CAPABILITIES.map(entry => entry.id));
    const enabled = agentPrompt(config, 'agent', {}, 'order');
    expect(enabled.builtin_skills).toEqual(AGENT_CAPABILITIES.map(entry => entry.skill));
    expect(enabled.text).toContain('bash 中的 lushw 是 daemon 当前代码所固定的开发协作 CLI');
    expect(enabled.text).not.toContain('lushc');
    for (const entry of AGENT_CAPABILITIES) {
      const skill = fs.readFileSync(entry.skill, 'utf8'), guide = capabilityGuide(entry.id).content;
      expect(skill).toContain(`lushw skills get ${entry.id}`);
      expect(guide.length).toBeGreaterThan(500);
      expect(guide).toContain('lushw ');
      expect(skill + guide).not.toContain('lushc');
      expect(enabled.text).toContain(`lushw skills get ${entry.id}`);
    }
    const report = AGENT_CAPABILITIES.find(entry => entry.id === 'result-notice');
    expect(report.setting).toBe('result_notice');
    const guide = capabilityGuide(report.id).content;
    for (const phrase of ['自己的任务只是分析', '用户明确要求', '不能只写最终回答', '--kind info']) expect(enabled.text).toContain(phrase);
    for (const phrase of ['普通进度', '等待子 Worker', '断连', 'runtime', 'integration=merged']) expect(guide).toContain(phrase);
    expect(enabled.text).not.toContain('普通状态与成果汇报写最终结果，不发 notice');
    for (const kind of ['order', 'child', 'analysis']) for (const profile of [{}, { config_mode: 'pi' }, { agent: 'codex' }]) {
      expect(agentPrompt(config, 'agent', profile, kind).builtin_skills).toContain(report.skill);
    }
    for (const role of ['manager', 'butler', 'explainer']) expect(agentPrompt(config, role).builtin_skills).toEqual([]);
    config.runtimeSettings.get = () => ({ result_notice: { value: false } });
    const disabled = agentPrompt(config, 'agent', {}, 'analysis');
    expect(disabled.builtin_skills).not.toContain(report.skill);
    expect(disabled.text).toContain('已关闭：result-notice');
    expect(disabled.text).not.toContain('lushw skills get result-notice');
    expect(disabled.text).not.toContain('必须加载；实际完成后');
    config.runtimeSettings.get = () => Object.fromEntries(AGENT_CAPABILITIES.map(entry => [entry.setting, false]));
    expect(agentPrompt(config, 'agent', {}, 'order').builtin_skills).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
