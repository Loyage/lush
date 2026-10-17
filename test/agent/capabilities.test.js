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
    for (const entry of AGENT_CAPABILITIES) {
      expect(fs.readFileSync(entry.skill, 'utf8')).toContain(`lushc skills get ${entry.id}`);
      expect(capabilityGuide(entry.id).content.length).toBeGreaterThan(500);
      expect(enabled.text).toContain(`lushc skills get ${entry.id}`);
    }
    config.runtimeSettings.get = () => Object.fromEntries(AGENT_CAPABILITIES.map(entry => [entry.setting, false]));
    expect(agentPrompt(config, 'agent', {}, 'order').builtin_skills).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
