import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { AGENT_CAPABILITIES, listCapabilityGuides, capabilityGuide } from '../../src/agent/capabilities.js';
import { agentPrompt } from '../../src/agent/prompts.js';
import { temp } from '../helpers.js';

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
