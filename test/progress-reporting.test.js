import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { Config } from '../src/config.js';
import { AGENT_ROLES, agentPrompt, builtInPrompt } from '../src/agent/prompts.js';
import { AgentSettings } from '../src/agent/settings.js';
import { Dispatcher } from '../src/rpc/protocol.js';
import { createSignal } from '../src/signal.js';
import { env, temp } from './helpers.js';
import { setup } from './workspaces/harness.js';
import { assertAllowed } from '../src/rpc/registry.js';

test('progress reporting defaults on, validates booleans, persists false and resets to on', () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env() });
    expect(config.progressReporting).toBe(true);
    expect(config.runtimeSettings.get().progress_reporting).toEqual({ value: true, default: true, overridden: false });
    expect(fs.existsSync(config.runtimeSettings.file)).toBe(false);
    config.configureRuntime({ progress_reporting: false });
    expect(config.progressReporting).toBe(false);
    expect(config.runtimeSettings.get().progress_reporting).toEqual({ value: false, default: true, overridden: true });
    expect(new Config({ project: root, env: env() }).progressReporting).toBe(false);
    const before = fs.readFileSync(config.runtimeSettings.file, 'utf8');
    for (const value of [0, 1, 'false', [], {}]) {
      expect(() => config.configureRuntime({ progress_reporting: value })).toThrow('boolean');
      expect(config.progressReporting).toBe(false);
      expect(fs.readFileSync(config.runtimeSettings.file, 'utf8')).toBe(before);
    }
    config.configureRuntime({ progress_reporting: null });
    expect(config.progressReporting).toBe(true);
    expect(config.runtimeSettings.get().progress_reporting).toEqual({ value: true, default: true, overridden: false });
    expect(JSON.parse(fs.readFileSync(config.runtimeSettings.file, 'utf8'))).toEqual({ version: 1 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('disabled prompts and previews omit all built-in progress instructions in every role/mode', () => {
  const root = temp();
  try {
    const config = new Config({ project: root, env: env() });
    expect(agentPrompt(config, 'agent').text).toContain('lush progress plan');
    config.configureRuntime({ progress_reporting: false });
    const settings = new AgentSettings(config);
    for (const role of AGENT_ROLES) {
      for (const mode of ['lush', 'pi']) {
        for (const kind of [null, 'analysis']) {
          const prompt = agentPrompt(config, role, { config_mode: mode }, kind);
          expect(prompt.parts.some(part => part.name === 'progress')).toBe(false);
          expect(prompt.text).not.toMatch(/lush progress|进度/);
        }
      }
      expect(builtInPrompt(role, { progressReporting: false })).not.toMatch(/lush progress|进度/);
      expect(settings.get().options.default_prompts[role]).not.toMatch(/lush progress|进度/);
    }
    expect(settings.get().options.default_prompt).not.toContain('lush progress');
    // Do not silently rewrite user-owned prompts.
    expect(agentPrompt(config, 'agent', { default_prompt: 'MY PROMPT', append_prompt: 'MY APPEND' }).text).toContain('MY APPEND');
    config.configureRuntime({ progress_reporting: true });
    expect(agentPrompt(config, 'agent').text).toContain('lush progress complete');
    expect(settings.get().options.default_prompts.agent).toContain('lush progress plan');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('user-only RPC switch invalidates overview, hides read models, and preserves stored plans', async () => {
  const f = await setup();
  try {
    const task = f.task;
    expect(() => assertAllowed('system.configure', { settings: { progress_reporting: false } }, task.id)).toThrow('user approval');
    f.project.reportProgressPlan(task.id, [{ key: 'inspect', label: '检查开关' }]);
    const stored = f.store.task(task.id).progress_plan;
    const revision = f.project.overviewRevision();
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await rpc.dispatch('system.configure', { settings: { progress_reporting: false } });
    expect(f.project.summary().settings.progress_reporting.value).toBe(false);
    expect(f.project.overviewRevision()).not.toBe(revision);
    expect(f.project.inspect(task.id).progress).toBeNull();
    expect(f.project.decorate(f.store.summaries('work')).find(row => row.id === task.id).progress).toBeNull();
    for (const graph of [await f.project.taskGraph(), await f.project.graph()]) {
      expect(graph.nodes.find(row => row.id === task.id).progress).toBeNull();
    }
    expect(f.store.task(task.id).progress_plan).toBe(stored);
    // In-flight agents that already received instructions remain compatible.
    f.project.completeProgressStep(task.id, 'inspect');
    await rpc.dispatch('system.configure', { settings: { progress_reporting: true } });
    expect(f.project.inspect(task.id).progress.items[0].status).toBe('completed');
    expect(f.project.inspect(task.id).progress.items[0].label).toBe('检查开关');
  } finally { await f.close(); }
});
