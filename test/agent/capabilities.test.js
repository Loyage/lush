import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { AGENT_CAPABILITIES, listCapabilityGuides, capabilityGuide } from '../../src/agent/capabilities.js';
import { agentPrompt } from '../../src/agent/prompts.js';
import { CLI_CATALOG_VERSION } from '../../src/cli/catalog.js';
import { temp } from '../helpers.js';

test('built-in capabilities share their registry, guides and invocation policy', () => {
  const root = temp();
  try {
    const config = { project: root, home: root, runtimeSettings: { get: () => ({}) } };
    expect(listCapabilityGuides().map(entry => entry.id)).toEqual(AGENT_CAPABILITIES.map(entry => entry.id));
    const enabled = agentPrompt(config, 'agent', {}, 'order');
    expect(enabled.builtin_skills).toEqual(AGENT_CAPABILITIES.map(entry => entry.skill));
    expect(enabled.text).toContain('bash 中的 lushw 是 daemon 当前代码所固定的开发协作 CLI');
    expect(enabled.text).toContain('默认不新增测试文件／用例');
    expect(enabled.text).toContain(`catalog_version=${CLI_CATALOG_VERSION}`);
    for (const entry of AGENT_CAPABILITIES) {
      expect(fs.readFileSync(entry.skill, 'utf8')).toContain(`lushw skills show ${entry.id}`);
      expect(capabilityGuide(entry.id).content).toContain('lushw ');
      expect(enabled.text).toContain(`lushw skills show ${entry.id}`);
    }
    config.runtimeSettings.get = () => Object.fromEntries(AGENT_CAPABILITIES.map(entry => [entry.setting, false]));
    const disabled = agentPrompt(config, 'agent', {}, 'order');
    expect(disabled.builtin_skills).toEqual([]);
    expect(disabled.text).toContain('没有已开启且适用的可选模块');
    expect(agentPrompt(config, 'manager').builtin_skills).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
