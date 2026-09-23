import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { PiProvider, AgentProvider } from '../src/agent/provider.js';
import { temp, env } from './helpers.js';

test('Pi explainer has no tools, extensions, skills, context discovery or invocation credential; prompt is supplied without read tool', async () => {
  const root = temp(), fake = path.join(root, 'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env bun\nimport fs from 'node:fs';\nconsole.log(JSON.stringify({args:process.argv.slice(2),token:process.env.LUSH_AGENT_TOKEN}));\n`, { mode: 0o755 });
  const config = new Config({ project: root, env: env({ LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake }) }); config.prepare();
  const agent = { agent: 'pi', model: '', thinking: '', extensions: ['/untrusted/extension'], skills: ['/untrusted/skill'] };
  try {
    const result = JSON.parse(await new PiProvider(config).run({ task: { id: 1, role: 'explainer', goal: 'Explain selection' },
      context: { explanation: { quote: 'exit code 1' }, recent_tasks: ['DO NOT SEND'] }, messages: ['DO NOT SEND'], cwd: root,
      token: 'private-credential', signal: new AbortController().signal, onSpawn: () => {}, agent }));
    for (const flag of ['--no-tools', '--no-extensions', '--no-skills', '--no-context-files', '--no-approve', '--system-prompt']) expect(result.args).toContain(flag);
    expect(result.args).not.toContain('--extension'); expect(result.args).not.toContain('--skill'); expect(result.token).toBe('');
    expect(result.args).toContain(`@${path.join(config.home, 'sessions', 'task-1-input.md')}`);
    expect(fs.readFileSync(path.join(config.home, 'sessions', 'task-1-input.md'), 'utf8')).not.toContain('DO NOT SEND');
    const routed = new AgentProvider(config, { resolve: () => ({ agent: 'codex' }) });
    expect(() => routed.run({ task: { role: 'explainer' } })).toThrow('Pi');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
