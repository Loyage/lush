import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { AgentSettings, AGENT_ROLES } from '../../src/agent/settings.js';
import { builtInPrompt, agentPrompt } from '../../src/agent/prompts.js';
import { AGENT_CAPABILITIES } from '../../src/agent/capabilities.js';
import { DeviceSettingsService } from '../../src/host/device-settings.js';
import { Config } from '../../src/config.js';
import { temp, env } from '../helpers.js';

test('Host saves drive matching previews and Skills in two projects without starting a daemon', async () => {
  const root = temp(), global = path.join(root, 'device');
  const values = env({ LUSH_GLOBAL_CONFIG: global });
  const service = new DeviceSettingsService(values);
  const configs = ['a', 'b'].map(name => {
    const project = path.join(root, name); fs.mkdirSync(project, { mode: 0o700 });
    return new Config({ project, env: values });
  });
  const verify = async enabledIds => {
    const host = await service.request('agent.config');
    const expectedSkills = AGENT_CAPABILITIES.filter(entry => enabledIds.includes(entry.id)).map(entry => entry.skill);
    for (const config of configs) {
      const preview = new AgentSettings(config).get().options.default_prompts.agent;
      expect(preview).toBe(host.options.default_prompts.agent);
      for (const config_mode of ['lush', 'pi']) {
        const prompt = agentPrompt(config, 'agent', { config_mode }, 'order');
        expect(prompt.builtin_skills).toEqual(expectedSkills);
        for (const entry of AGENT_CAPABILITIES) {
          const instruction = `lushc skills get ${entry.id}`;
          expect(prompt.text.includes(instruction)).toBe(enabledIds.includes(entry.id));
          expect(preview.includes(instruction)).toBe(enabledIds.includes(entry.id));
        }
        expect(prompt.text).toContain('唯一可写的代码副本');
        expect(prompt.text).toContain('必须检查 child 成果');
      }
      expect(fs.existsSync(config.home)).toBe(false);
    }
    for (const role of ['manager', 'butler', 'explainer']) expect(host.options.default_prompts[role]).not.toContain('可选 Agent 能力');
  };
  try {
    const ids = AGENT_CAPABILITIES.map(entry => entry.id);
    await verify(ids);
    for (const entry of AGENT_CAPABILITIES) {
      await service.request('system.configure', { settings: { [entry.setting]: false } });
      ids.splice(ids.indexOf(entry.id), 1);
      await verify(ids);
    }
    const reset = Object.fromEntries(AGENT_CAPABILITIES.map(entry => [entry.setting, null]));
    await service.request('system.configure', { settings: reset });
    await verify(AGENT_CAPABILITIES.map(entry => entry.id));
    expect(JSON.parse(fs.readFileSync(path.join(global, 'shared/settings.json'), 'utf8'))).toEqual({ version: 1 });
    expect(service.config.project).toBeNull();
  } finally { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

// This adapter exercises preview snapshots without touching real device settings.
test('Agent previews share one capability settings snapshot across all roles', () => {
  const root = temp();
  let reads = 0;
  const capabilities = { progress_reporting: false, worker_delegation: false,
    worker_auto_title: false, context_retrieval: true };
  const config = { home: root, project: root, env: {}, provider: 'mock', runtimeSettings: {
    get(scope) {
      expect(scope).toBe('project'); reads++;
      return Object.fromEntries(Object.entries(reads === 1 ? capabilities : {})
        .map(([key, value]) => [key, { value }]));
    },
  } };
  try {
    const model = new AgentSettings(config).get();
    expect(reads).toBe(1);
    const options = { progressReporting: false, capabilities };
    expect(model.options.default_prompt).toBe(builtInPrompt('planner', options));
    for (const role of AGENT_ROLES) {
      expect(model.options.default_prompts[role]).toBe(builtInPrompt(role, options));
    }
    expect(model.options.default_prompts.agent).not.toContain('lushc skills get delegation');
    expect(model.options.default_prompts.agent).not.toContain('lushc skills get auto-title');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('preview compatibility keeps minimal configurations and progress fallback', () => {
  const root = temp();
  const config = { home: root, project: root, env: {}, provider: 'mock', progressReporting: false };
  try {
    const model = new AgentSettings(config).get();
    expect(model.options.default_prompts.agent).toBe(builtInPrompt('agent', { progressReporting: false, capabilities: {} }));
    expect(fs.existsSync(path.join(root, 'agent.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'settings.json'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
