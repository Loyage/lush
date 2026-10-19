import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../../src/config.js';
import { PiProvider } from '../../src/agent/provider.js';
import { env, temp } from '../helpers.js';
import { managedPiRun } from './managed-runtime-fixture.js';

const PI_RUNTIME = fileURLToPath(new URL('../../src/agent/pi-runtime.js', import.meta.url));

test('PiDefault and Lush invocations differ in argv, environment, and session identity', async () => {
  const root = temp(), file = path.join(root, 'fake-pi'), out = path.join(root, 'pi-run.json');
  fs.writeFileSync(file, `#!/usr/bin/env bun
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }));
console.log('pi finished');
`, { mode: 0o755 });
  const values = env();
  for (const key of ['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SESSION_ID', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL']) delete values[key];
  const config = new Config({ project: root, env: { ...values, LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: file, OPENAI_API_KEY: 'ambient-key' } });
  config.prepare();
  try {
    const provider = new PiProvider(config); let delivered = 0;
    const common = { task: { id: 42, parent_id: 3, role: 'agent', goal: 'mode test' }, context: {}, messages: [], cwd: root,
      token: 'secret', signal: new AbortController().signal, onSpawn() {}, onInputDelivered() { delivered++; } };
    expect(await provider.run({ ...common, agent: { agent: 'pi', config_mode: 'pi', model: '', thinking: '',
      default_prompt: '', append_prompt: '', extensions: [], skills: [] } })).toBe('pi finished');
    expect(delivered).toBe(1);
    const piRun = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(piRun.args).toContain('--print'); expect(piRun.args).not.toContain('--no-extensions');
    expect(piRun.args.slice(piRun.args.indexOf('--extension'), piRun.args.indexOf('--extension') + 2)).toEqual(['--extension', PI_RUNTIME]);
    expect(piRun.args.slice(piRun.args.indexOf('--session-id'), piRun.args.indexOf('--session-id') + 2)).toEqual(['--session-id', 'lush-task-42-pi']);
    expect(piRun.env.OPENAI_API_KEY).toBe('ambient-key');
    expect(JSON.parse(piRun.env.LUSH_RUNTIME_CONTEXT).config_mode).toBe('pi');
    const managed = managedPiRun({ agent: { agent: 'pi', model: 'deepseek/deepseek-chat', thinking: 'low',
      default_prompt: '', append_prompt: '', extensions: ['/tmp/selected-extension.ts'], skills: [] } });
    expect(await provider.run({ ...common, agent: managed.agent, connectionRuntime: managed.connectionRuntime })).toBe('pi finished');
    expect(delivered).toBe(2);
    const lushRun = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(lushRun.args).toContain('--no-extensions'); expect(lushRun.args).toContain('--no-approve');
    expect(lushRun.args.slice(lushRun.args.indexOf('--session-id'), lushRun.args.indexOf('--session-id') + 2)).toEqual(['--session-id', 'lush-task-42']);
    expect(lushRun.args.slice(lushRun.args.indexOf('--model'), lushRun.args.indexOf('--model') + 2)).toEqual(['--model', 'deepseek/deepseek-chat']);
    expect(lushRun.env.OPENAI_API_KEY).toBeUndefined();
    expect(lushRun.env.PI_CODING_AGENT_DIR).not.toBeUndefined();
    expect(JSON.parse(lushRun.env.LUSH_RUNTIME_CONTEXT).config_mode).toBe('lush');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
