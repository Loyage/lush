import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  INTEGRATION_GROUPS, parseIntegrationArgs, selectIntegrationFiles, runIntegration,
} from '../scripts/test-integration.js';
import { env, temp } from './helpers.js';

const ROOT = new URL('../', import.meta.url).pathname;
const types = Object.keys(INTEGRATION_GROUPS);

function fixture() {
  const parent = temp(), root = path.join(parent, 'project with spaces');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(new URL('../scripts/test-integration.js', import.meta.url), path.join(root, 'scripts/test-integration.js'));
  for (const file of selectIntegrationFiles(types)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '');
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: {
    'test:integration': 'bun ./scripts/test-integration.js', test: 'bun ./record.js',
  } }));
  fs.writeFileSync(path.join(root, 'record.js'), `
import fs from 'node:fs';
fs.appendFileSync('runs.jsonl', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
console.log('fixture stdout'); console.error('fixture stderr');
process.exit(37);
`);
  return { root, close: () => fs.rmSync(parent, { recursive: true, force: true }) };
}
async function cli(root, args) {
  const child = Bun.spawn([process.execPath, 'run', 'test:integration', ...args], {
    cwd: root, env: env(), stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test('smoke groups contain existing unique test paths and selections deduplicate in order', () => {
  expect(types).toEqual(['page', 'rpc', 'component', 'cli']);
  for (const group of Object.values(INTEGRATION_GROUPS)) {
    expect(group.length).toBeGreaterThan(0);
    expect(new Set(group).size).toBe(group.length);
    for (const file of group) {
      expect(file.startsWith('test/')).toBe(true);
      expect(file.endsWith('.test.js')).toBe(true);
      expect(fs.statSync(path.join(ROOT, file)).isFile()).toBe(true);
    }
  }
  expect(INTEGRATION_GROUPS.page).toContain('test/web/dom-navigation-links.test.js');
  expect(INTEGRATION_GROUPS.rpc).toContain('test/project/management-tool-chain.test.js');
  expect(INTEGRATION_GROUPS.component).toContain('test/web/dom-inputs.test.js');
  expect(INTEGRATION_GROUPS.cli).toContain('test/integration/pi.test.js');
  expect(INTEGRATION_GROUPS.cli).toContain('test/cli-entrypoints.test.js');
  expect(INTEGRATION_GROUPS.cli).toContain('test/agent/capabilities.test.js');
  // Explicit CI selections must not silently point at a deleted regression.
  const workflow = fs.readFileSync(new URL('../.github/workflows/code-reader-posix.yml', import.meta.url), 'utf8');
  const ciFiles = workflow.match(/test\/[\w/.-]+\.test\.js/g);
  expect(ciFiles?.length).toBeGreaterThan(0);
  for (const file of ciFiles) expect(fs.statSync(path.join(ROOT, file)).isFile()).toBe(true);
  expect(selectIntegrationFiles(['component', 'page', 'component']))
    .toEqual([...new Set([...INTEGRATION_GROUPS.component, ...INTEGRATION_GROUPS.page])]);
  expect(parseIntegrationArgs(['rpc', '--list', 'page', 'rpc'])).toEqual({ list: true, types: ['rpc', 'page'] });
  expect(parseIntegrationArgs(['--list'])).toEqual({ list: true, types });
  expect(() => parseIntegrationArgs(['missing'])).toThrow('Unknown integration type');
});

test('list reports the exact shared command without executing and rejects empty selection', async () => {
  const output = [], errors = [], calls = [];
  const options = {
    stdout: text => output.push(text), stderr: text => errors.push(text),
    spawn: (...args) => { calls.push(args); throw new Error('list must not spawn'); },
  };
  expect(await runIntegration(['--list', 'page', 'component', 'page'], options)).toBe(0);
  const files = selectIntegrationFiles(['page', 'component']);
  expect(JSON.parse(output[0])).toEqual({ types: ['page', 'component'], files,
    command: [process.execPath, 'run', 'test', ...files] });
  expect(await runIntegration([], options)).toBe(1);
  expect(errors.at(-1)).toContain('Select at least one');
  expect(calls).toHaveLength(0);
});

test('real CLI forwards cwd/argv/output and nonzero status once, and validates missing paths', async () => {
  const f = fixture();
  try {
    const listing = await cli(f.root, ['--list', 'cli', 'rpc', 'cli']);
    expect(listing.code).toBe(0);
    const selection = JSON.parse(listing.stdout);
    expect(selection.files).toEqual(selectIntegrationFiles(['cli', 'rpc']));
    expect(fs.existsSync(path.join(f.root, 'runs.jsonl'))).toBe(false);
    const result = await cli(f.root, ['cli', 'rpc', 'cli']);
    expect(result.code).toBe(37);
    expect(result.stdout).toContain('fixture stdout');
    expect(result.stderr).toContain('fixture stderr');
    const runs = fs.readFileSync(path.join(f.root, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(runs).toEqual([{ cwd: f.root, args: selection.files }]);
    fs.rmSync(path.join(f.root, INTEGRATION_GROUPS.rpc[0]));
    const missing = await cli(f.root, ['rpc']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain(INTEGRATION_GROUPS.rpc[0]);
    expect(fs.readFileSync(path.join(f.root, 'runs.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { f.close(); }
});
