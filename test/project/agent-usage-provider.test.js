import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../helpers.js';
import { UsageSettings } from '../../src/agent/usage-settings.js';

// Project composition regression: diagnostics bypass both profile/config and retired usage services.
test('Project.agentStatus only diagnoses software, leaving old credentials/config/history untouched', async () => {
  const f = fixture();
  try {
    const command = name => {
      const file = path.join(f.root, name);
      fs.writeFileSync(file, `#!${process.execPath}\nif(process.argv.slice(2).join(' ')!=='--version') throw new Error('unsafe'); console.log('1.2.3');`, { mode: 0o755 });
      return file;
    };
    f.config.env.LUSH_PI_COMMAND = command('pi'); f.config.env.LUSH_CODEX_COMMAND = command('codex');
    const piHome = path.join(f.config.home, 'pi'); fs.mkdirSync(piHome, { mode: 0o700 });
    const auth = path.join(piHome, 'auth.json'); fs.writeFileSync(auth, '{"SECRET":"expired-oauth"}', { mode: 0o600 });
    new UsageSettings(f.config).save({ enabled: true, providers: ['openai-codex'], retention_days: 1 });
    const usageFile = path.join(f.config.home, 'agent-usage.json');
    const before = [auth, usageFile].map(file => fs.readFileSync(file, 'utf8'));
    const fail = () => { throw new Error('legacy entry triggered'); };
    f.project.agentUsage.query = fail; f.project.agentUsage.config = fail;
    f.project.agentSettings.resolve = fail; f.project.agentUsage.discoverUsage = fail; f.project.agentUsage.discoverStatus = fail;
    const first = f.project.agentStatus(), second = f.project.agentStatus(); expect(first).toBe(second);
    const result = await first; expect(result.version).toBe(2); expect(result.software.map(item => item.agent)).toEqual(['pi','codex']);
    expect(result.software.every(item => item.status === 'available')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect([auth, usageFile].map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
    expect(f.store.get('SELECT COUNT(*) AS n FROM agent_usage_queries').n).toBe(0);
    expect(fs.existsSync(auth + '.lock')).toBe(false);
  } finally { await f.close(); }
});

test('retired project query cannot start old custom HTTP mapping or independent OAuth refresh', async () => {
  const f = fixture();
  try {
    const settings = new UsageSettings(f.config);
    settings.save({ enabled: true, providers: ['custom-test'], custom: [{ provider: 'custom-test', label: 'Custom quota',
      url: 'https://quota.example.test/status', method: 'GET', headers: { Authorization: 'Bearer ${USAGE_TEST_TOKEN}' }, body: null,
      kind: 'quota', items: [{ id: 'credits', label: 'Credits', unit: 'USD', remaining: 'data.remaining' }] }] });
    f.project.agentUsage.discoverUsage = () => { throw new Error('network'); };
    f.project.agentUsage.start(); expect(() => f.project.agentUsage.query(false)).toThrow('retired');
    expect(() => f.project.configureAgentUsage({ enabled: false })).toThrow('retired');
    expect(f.project.agentUsageConfig().enabled).toBe(true);
    expect(f.project.agentUsageHistory().series).toEqual([]);
  } finally { await f.close(); }
});
