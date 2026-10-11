import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { temp, env } from './helpers.js';

const configSource = fs.readFileSync(new URL('../bunfig.toml', import.meta.url), 'utf8');
const config = Bun.TOML.parse(configSource);
const { scripts } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function testArgs(name) {
  const [runtime, command, ...args] = scripts[name].split(/\s+/);
  expect([runtime, command]).toEqual(['bun', 'test']);
  return args;
}

test('all test entrypoints use the same bounded budget without retries or excluded paths', () => {
  expect(config.test.root).toBe('test');
  expect(testArgs('test')).toEqual(['--parallel=4', '--timeout=20000']);
  expect(testArgs('test:all')).toEqual(testArgs('test'));
  expect(testArgs('test:serial')).toEqual(['--timeout=20000']);
});

test('project budget works in real serial/parallel runners and explicit short deadlines still fail', async () => {
  const root = temp(), children = [];
  try {
    // Use actual entrypoint arguments/config, not a duplicate budget or setDefaultTimeout.
    fs.writeFileSync(path.join(root, 'bunfig.toml'), configSource);
    fs.mkdirSync(path.join(root, config.test.root));
    fs.writeFileSync(path.join(root, config.test.root, 'budget.test.js'), `
import { test, expect } from 'bun:test';
test('async fixture exceeds the native five-second budget', async () => {
  await Bun.sleep(5200);
  expect(true).toBe(true);
});
`);
    const childEnv = env();
    async function run(args) {
      const child = Bun.spawn([process.execPath, 'test', ...args], {
        cwd: root, env: childEnv, stdout: 'pipe', stderr: 'pipe',
      });
      children.push(child);
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { code, output: stdout + stderr };
    }
    const results = await Promise.all([
      run(testArgs('test:serial')),
      run(testArgs('test')),
      run([...testArgs('test:serial'), '--timeout', '50']),
    ]);
    for (const result of results.slice(0, 2)) {
      if (result.code !== 0) throw new Error(`Project test budget was not applied:\n${result.output}`);
      expect(result.output).toContain('1 pass');
      expect(result.output).toContain('0 fail');
    }
    expect(results[2].code).not.toBe(0);
    expect(results[2].output).toContain('timed out after 50ms');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map(child => child.exited));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
