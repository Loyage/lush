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
    config.runtimeSettings.get = () => Object.fromEntries(AGENT_CAPABILITIES.map(entry => [entry.setting, false]));
    expect(agentPrompt(config, 'agent', {}, 'order').builtin_skills).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
