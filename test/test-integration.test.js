import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  INTEGRATION_GROUPS, parseIntegrationArgs, selectIntegrationFiles, runIntegration,
} from '../scripts/test-integration.js';
import { env, temp } from './helpers.js';

const ROOT = new URL('../', import.meta.url).pathname;
const types = Object.keys(INTEGRATION_GROUPS);
function capture(extra = {}) {
  const output = [], errors = [], calls = [];
  return { output, errors, calls, options: {
    stdout: text => output.push(text), stderr: text => errors.push(text),
    spawn: (command, options) => { calls.push({ command, options }); return { exited: Promise.resolve(0) }; },
    ...extra,
  } };
}

function scriptFixture() {
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

test('types/options are explicit, order preserving and deduplicated; list alone selects all', () => {
  expect(parseIntegrationArgs(['rpc', '--list', 'page', 'rpc'])).toEqual({ list: true, types: ['rpc', 'page'] });
  expect(parseIntegrationArgs(['--list'])).toEqual({ list: true, types });
  expect(parseIntegrationArgs(['component'])).toEqual({ list: false, types: ['component'] });
  expect(parseIntegrationArgs(['--help'])).toEqual({ help: true });
  for (const args of [[], ['Page'], ['all'], ['--timeout=30000'], ['--list', 'unknown'], ['toString'], ['__proto__'], ['--help', 'rpc']]) {
    expect(() => parseIntegrationArgs(args)).toThrow();
  }
});

test('central groups refer only to existing tests; overlapping groups deduplicate file paths', () => {
  expect(types).toEqual(['page', 'rpc', 'component', 'cli']);
  for (const group of Object.values(INTEGRATION_GROUPS)) {
    expect(group.length).toBeGreaterThan(0);
    expect(new Set(group).size).toBe(group.length);
    for (const file of group) {
      expect(file.startsWith('test/')).toBe(true); expect(file.endsWith('.test.js')).toBe(true);
      expect(fs.statSync(path.join(ROOT, file)).isFile()).toBe(true);
    }
  }
  const selected = selectIntegrationFiles(['component', 'page', 'component']);
  expect(selected).toEqual([...new Set([...INTEGRATION_GROUPS.component, ...INTEGRATION_GROUPS.page])]);
  expect(selected.filter(file => file === 'test/web/dom-navigation.test.js')).toHaveLength(1);
  expect(() => selectIntegrationFiles(['missing'])).toThrow('Unknown integration type');
});

test('quick groups include navigation/polling and real CLI/permission migration regressions before the full suite', () => {
  expect(INTEGRATION_GROUPS.page).toContain('test/web/core-api.test.js');
  expect(INTEGRATION_GROUPS.component).toContain('test/web/dom-refresh-performance.test.js');
  expect(INTEGRATION_GROUPS.rpc).toContain('test/web/management-permissions-api.test.js');
  for (const file of ['test/cli-entrypoints.test.js', 'test/cli-surfaces.test.js', 'test/cli-catalog.test.js',
    'test/cli-prompt-boundaries.test.js', 'test/integration/pi.test.js', 'test/integration/questionnaire.test.js']) {
    expect(INTEGRATION_GROUPS.cli).toContain(file);
  }
  expect(parseIntegrationArgs(['cli', 'rpc', 'cli'])).toEqual({ list: false, types: ['cli', 'rpc'] });
});

test('list emits the exact one-shot command as JSON without spawning; help does not validate paths', async () => {
  const c = capture();
  expect(await runIntegration(['--list', 'page', 'component', 'page'], c.options)).toBe(0);
  const files = selectIntegrationFiles(['page', 'component']);
  expect(JSON.parse(c.output[0])).toEqual({ types: ['page', 'component'], files, command: [process.execPath, 'run', 'test', ...files] });
  expect(c.calls).toHaveLength(0); expect(c.errors).toHaveLength(0);
  expect(await runIntegration(['--help'], { ...c.options, root: '/not-a-project' })).toBe(0);
  expect(c.output[1]).toContain('Usage: bun run test:integration');
});

for (const code of [0, 1, 37, 143]) test(`execution delegates once to the existing test script and propagates exit ${code}`, async () => {
  const c = capture({ spawn: (command, options) => {
    c.calls.push({ command, options }); return { exited: Promise.resolve(code) };
  } });
  expect(await runIntegration(['rpc', 'page', 'rpc'], c.options)).toBe(code);
  expect(c.calls).toEqual([{ command: [process.execPath, 'run', 'test', ...selectIntegrationFiles(['rpc', 'page'])],
    options: { cwd: ROOT, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' } }]);
  expect(c.output).toHaveLength(0);
});

test('CLI migrations and permissions execute in one shared test invocation, with repeated types deduplicated', async () => {
  const f = scriptFixture();
  try {
    const listing = await cli(f.root, ['--list', 'cli', 'rpc', 'cli']);
    expect(listing.code).toBe(0);
    const selection = JSON.parse(listing.stdout);
    expect(selection).toEqual({ types: ['cli', 'rpc'], files: selectIntegrationFiles(['cli', 'rpc']),
      command: [process.execPath, 'run', 'test', ...selectIntegrationFiles(['cli', 'rpc'])] });
    expect(fs.existsSync(path.join(f.root, 'runs.jsonl'))).toBe(false);
    const result = await cli(f.root, ['cli', 'rpc', 'cli']);
    expect(result.code).toBe(37);
    expect(result.stdout).toContain('fixture stdout');
    expect(result.stderr).toContain('fixture stderr');
    const runs = fs.readFileSync(path.join(f.root, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(runs).toEqual([{ cwd: f.root, args: selection.files }]);
  } finally { f.close(); }
});

test('invalid input and missing/non-file selections fail before any spawn, even in list mode', async () => {
  const f = scriptFixture();
  try {
    const file = path.join(f.root, INTEGRATION_GROUPS.rpc[0]);
    fs.rmSync(file);
    for (const args of [['rpc'], ['--list', 'rpc'], ['page', 'rpc']]) {
      const c = capture({ root: f.root });
      expect(await runIntegration(args, c.options)).toBe(1);
      expect(c.errors.join('\n')).toContain(`path unavailable: ${INTEGRATION_GROUPS.rpc[0]} (ENOENT)`);
      expect(c.calls).toHaveLength(0); expect(c.output).toHaveLength(0);
    }
    fs.mkdirSync(file);
    const c = capture({ root: f.root });
    expect(await runIntegration(['rpc'], c.options)).toBe(1);
    expect(c.errors[0]).toContain('not a file'); expect(c.calls).toHaveLength(0);
    for (const args of [[], ['--list', 'unknown']]) {
      const invalid = capture();
      expect(await runIntegration(args, invalid.options)).toBe(1);
      expect(invalid.errors).toHaveLength(1); expect(invalid.calls).toHaveLength(0);
    }
  } finally { f.close(); }
});

test('spawn errors and exit-promise errors are reported without retry', async () => {
  for (const asynchronous of [false, true]) {
    let count = 0;
    const c = capture({ spawn() {
      count++;
      if (!asynchronous) throw new Error('fixture launch failure');
      return { exited: Promise.reject(new Error('fixture wait failure')) };
    } });
    expect(await runIntegration(['page'], c.options)).toBe(1);
    expect(c.errors.at(-1)).toContain(asynchronous ? 'fixture wait failure' : 'fixture launch failure');
    expect(count).toBe(1);
  }
});

test('real CLI preserves cwd/argv, test output and nonzero exit without rerunning or swallowing errors', async () => {
  const f = scriptFixture();
  try {
    const result = await cli(f.root, ['component', 'page', 'component']);
    expect(result.code).toBe(37);
    expect(result.stdout).toContain('fixture stdout'); expect(result.stderr).toContain('fixture stderr');
    const runs = fs.readFileSync(path.join(f.root, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(runs).toEqual([{ cwd: f.root, args: selectIntegrationFiles(['component', 'page']) }]);
    const listing = await cli(f.root, ['--list']);
    expect(listing.code).toBe(0); expect(JSON.parse(listing.stdout).types).toEqual(types);
    const unknown = await cli(f.root, ['--list', 'bad']);
    expect(unknown.code).not.toBe(0); expect(unknown.stderr).toContain('Unknown integration type');
    fs.rmSync(path.join(f.root, INTEGRATION_GROUPS.page[0]));
    const missing = await cli(f.root, ['page']);
    expect(missing.code).not.toBe(0); expect(missing.stderr).toContain(INTEGRATION_GROUPS.page[0]);
    expect(fs.readFileSync(path.join(f.root, 'runs.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { f.close(); }
});

test('package entrypoint remains a thin script over the existing shared test budget', () => {
  const { scripts } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(scripts['test:integration']).toBe('bun ./scripts/test-integration.js');
  expect(scripts.test).toBe('bun test --parallel=4 --timeout=20000');
});
