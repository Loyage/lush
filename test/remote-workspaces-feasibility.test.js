import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveNativePi } from '../src/cli/native-pi.js';
import { CONTROLLED_CONFIGURATION, TOOL_NAMES, assertSupportedConfiguration } from './fixtures/remote-workspaces-feasibility/registry.js';

// Like native-watch-smoke, real SDK evidence is explicit; no downloads or paid accounts.
// Set this flag in the verification command. Opt-in with missing/incompatible Pi FAILS.
const realPi = process.env.LUSH_REMOTE_PI_FEASIBILITY === '1' ? test : test.skip;

test('remote feasibility rejects unsupported modes/resources before process admission', () => {
  expect(() => assertSupportedConfiguration(CONTROLLED_CONFIGURATION)).not.toThrow();
  for (const [key, value] of [['agent', 'codex'], ['configMode', 'default'], ['transport', 'ssh'],
    ...['extensions', 'mcp', 'skills', 'prompts', 'packages', 'themes'].map(key => [key, ['unreviewed']])]) {
    expect(() => assertSupportedConfiguration({ ...CONTROLLED_CONFIGURATION, [key]: value })).toThrow('Unsupported');
  }
  expect(TOOL_NAMES).toEqual(['read', 'edit', 'write', 'bash']);
});

for (const scenario of ['routing', 'cancellation', 'disconnect', 'lifecycle']) {
  realPi(`real Pi SDK → permission Bridge → isolated Runner: ${scenario}`, async () => {
    expect(process.platform).toBe('linux');
    const entry = resolveNativePi();
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/remote-workspaces-feasibility/scenario.js', import.meta.url)), entry, scenario], {
      // Isolate the SDK process too: no inherited LUSH token, account or personal Pi config.
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', OPENAI_API_KEY: 'HOST_SECRET_MUST_NOT_REACH_RUNNER' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    // Fixture deadline is stricter than the unchanged 20-second project test budget.
    const deadline = setTimeout(() => child.kill('SIGTERM'), 15000);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
      });
    } finally { clearTimeout(deadline); }

    if (result.code !== 0) throw new Error(`${scenario}: ${JSON.stringify(result)}\n${stdout}\n${stderr}`);
    expect(stdout).toContain('"assertions":"passed"');
    console.log(stdout.trim());
  });
}
