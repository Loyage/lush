import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Config } from '../src/config.js';
import { PiProvider, CodexProvider } from '../src/agent/provider.js';
import { temp, env } from './helpers.js';

test('butler uses isolated Pi with no credentials, tools, extensions, skills or context discovery', async () => {
  const root = temp(), fake = path.join(root, 'fake-pi');
  fs.writeFileSync(fake, `#!/usr/bin/env bun\nconsole.log(JSON.stringify({args:process.argv.slice(2),token:process.env.LUSH_AGENT_TOKEN}));\n`, { mode: 0o755 });
  const config = new Config({ project: root, env: env({ LUSH_PROVIDER: 'pi', LUSH_PI_COMMAND: fake }) }); config.prepare();
  const agent = { agent: 'pi', extensions: ['/untrusted'], skills: ['/untrusted'] };
  const options = { task: { id: 1, role: 'butler', goal: '选择' }, context: { butler: { notice: { title: '问题' } } }, messages: [], cwd: root,
    token: 'secret', signal: new AbortController().signal, onSpawn() {}, agent };
  try {
    const result = JSON.parse(await new PiProvider(config).run(options));
    for (const flag of ['--no-tools','--no-context-files','--no-extensions','--no-skills','--no-approve','--system-prompt']) expect(result.args).toContain(flag);
    expect(result.args).not.toContain('--extension'); expect(result.args).not.toContain('--skill'); expect(result.token).toBe('');
    await expect(new CodexProvider(config).run(options)).rejects.toThrow('Pi');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
