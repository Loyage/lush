import { test, expect } from 'bun:test';
import fs from 'node:fs';
import { fixture, temp } from './helpers.js';

test('two Projects share device settings while retaining separate project identities', async () => {
  const global = temp(), a = fixture(undefined, { LUSH_GLOBAL_CONFIG: global }),
    b = fixture(undefined, { LUSH_GLOBAL_CONFIG: global });
  try {
    a.project.configureRuntimeSettings({ call_timeout: 6, progress_reporting: false });
    expect(b.project.refreshRuntimeConfiguration()).toBe(true);
    expect(b.config.timeout).toBe(6);
    a.project.configureAgents({ version: 1, default: { agent: 'pi', model: 'shared' }, roles: {} });
    expect(b.project.agentConfig().default.model).toBe('shared');
    await a.project.configureAgentNetwork({ version: 1, mode: 'direct', proxy_url: null, no_proxy: [] });
    expect(b.project.agentNetwork().mode).toBe('direct');
    a.project.configureAgentEnvironment('common', { SHARED: 'yes' });
    expect(b.project.agentEnvironment('common').values.SHARED).toBe('yes');
    expect(a.config.deviceHome).toBe(b.config.deviceHome);
    expect(a.config.home).not.toBe(b.config.home);
    expect(a.config.env.LUSH_HOME).toBe(a.config.home);
    expect(b.config.env.LUSH_HOME).toBe(b.config.home);
  } finally { await Promise.all([a.close(), b.close()]); fs.rmSync(global, { recursive: true, force: true }); }
});
