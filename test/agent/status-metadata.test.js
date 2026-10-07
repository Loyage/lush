import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverAgentModels } from '../../src/agent/models.js';

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lush-status-metadata-test-'));
  const piDir = path.join(root, 'pi'), home = path.join(root, '.lush'), configDir = path.join(home, 'pi');
  const core = path.join(piDir, 'dist', 'core'); fs.mkdirSync(core, { recursive: true }); fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  json(path.join(piDir, 'package.json'), { name: '@earendil-works/pi-coding-agent', version: '9.1.2' });
  const command = path.join(piDir, 'pi');
  fs.writeFileSync(command, `#!${process.execPath}\nthrow new Error('Do not execute CLI');`, { mode: 0o755 });
  fs.writeFileSync(path.join(core, 'auth-storage.js'), 'export class AuthStorage { static inMemory() { return {}; } static create() { throw new Error("Do not read auth"); } }');
  fs.writeFileSync(path.join(core, 'model-runtime.js'), `import fs from 'node:fs';
export class ModelRuntime { static async create(options) {
  if (options.refreshOnCreate !== false || options.allowModelNetwork !== false || !options.credentials) throw new Error('Unsafe model runtime');
  const config = JSON.parse(fs.readFileSync(options.modelsPath, 'utf8'));
  if (JSON.stringify(config).includes('SECRET') || JSON.stringify(config).includes('!touch')) throw new Error('Secret reached SDK');
  return { getModels() { return Object.entries(config.providers || {}).flatMap(([provider, value]) => (value.models || []).map(model=>({...model,provider}))); } };
} }`);
  const config = { project: root, home, provider: 'pi', env: { PATH: process.env.PATH, LUSH_PI_COMMAND: command } };
  return { root, core, configDir, config, json, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test('separate Pi model catalog retains sanitized Lush SDK metadata without CLI auth discovery', async () => {
  const f = world();
  try {
    const external = path.join(f.root, 'external'); fs.mkdirSync(external);
    f.json(path.join(external, 'auth.json'), { deepseek: { type: 'api_key', key: '!touch SECRET' } });
    f.json(path.join(external, 'models.json'), { providers: { external: { models: [{ id: 'outside' }] } } });
    f.config.env.PI_CODING_AGENT_DIR = external;
    f.json(path.join(f.configDir, 'models.json'), { providers: { local: { apiKey: '!touch SECRET', headers: { Authorization: 'SECRET' },
      models: [{ id: 'inside', name: 'Lush local model' }] } } });
    const catalog = await discoverAgentModels(f.config, 'pi');
    expect(catalog.source).toBe('local'); expect(catalog.warning).toContain('不读取用户 Pi');
    expect(catalog.models.map(row => row.id)).toEqual(['local/inside']);
    expect(JSON.stringify(catalog)).not.toContain('SECRET');
    expect(fs.readdirSync(external).sort()).toEqual(['auth.json', 'models.json']);
  } finally { f.close(); }
});

test('absent Lush model metadata returns presets without probing SDK or CLI', async () => {
  const f = world();
  try {
    fs.writeFileSync(path.join(f.core, 'model-runtime.js'), 'throw new Error("Should not probe SDK");');
    for (const models of [null, { providers: {} }]) {
      if (models) f.json(path.join(f.configDir, 'models.json'), models);
      const catalog = await discoverAgentModels(f.config, 'pi');
      expect(catalog.source).toBe('presets'); expect(catalog.warning).toContain('尚未配置');
      expect(catalog.warning).toContain('不代表实际可用');
    }
    expect(fs.readdirSync(f.configDir)).toEqual(['models.json']);
  } finally { f.close(); }
});
