import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { AgentSettings } from '../src/agent/settings.js';
import { temp, env } from './helpers.js';

test('Agent settings persist role overrides and reload without restarting', () => {
  const root = temp();
  const config = new Config({ project: root, env: env({ LUSH_GLOBAL_CONFIG: path.join(root, 'device') }) });
  config.prepare();
  try {
    const settings = new AgentSettings(config);
    settings.save({ version: 1, default: { agent: 'pi', model: 'deepseek/deepseek-chat', thinking: '' },
      roles: { worker: { agent: 'codex', model: 'gpt-5.4-mini', thinking: 'high' } } });
    const next = new AgentSettings(config);
    expect(next.resolve('worker')).toMatchObject({ agent: 'codex', model: 'gpt-5.4-mini', thinking: 'high' });
    expect(next.get().default.model).toBe('deepseek/deepseek-chat');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
