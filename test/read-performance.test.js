import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseOptions, summarize, buildReport, writeReport, collectEnvironment, THRESHOLDS } from '../scripts/measure-read-performance.js';
import { env, temp, repo, git } from './helpers.js';

function sample(overview = 10) {
  return { task_sets: [{ tasks: 1000, page_limit: 100, shown: 100, truncated: true,
    has_more: true, ui_truncation: true, ui_paging: true, overview_bytes: 100,
    legacy_bytes: 100, overview_ms: overview, legacy_ms: 5, render_ms: 3 }],
  log_sets: [{ label: 'large', file_bytes: 12 * 1024 * 1024, bytes_read: 8 * 1024 * 1024,
    budget_bytes: 8 * 1024 * 1024, truncated: true, cold_ms: 20, warm_ms: 1, timer_delay_ms: 25 }] };
}

async function cli(...args) {
  const proc = Bun.spawn([process.execPath, new URL('../scripts/measure-read-performance.js', import.meta.url).pathname, ...args], {
    env: env(), stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test('performance options are bounded and help/invalid CLI arguments do not measure', async () => {
  expect(parseOptions([])).toEqual({ samples: 5, output: null, help: false });
  expect(parseOptions(['--output', 'report.json', '--samples', '50'])).toEqual({ samples: 50, output: path.resolve('report.json'), help: false });
  for (const args of [['--samples'], ['--samples', '0'], ['--samples', '51'], ['--samples', '1.5'],
    ['--samples', '-1'], ['--samples', '1e1'], ['--output'], ['--output', '--samples'],
    ['--samples', '2', '--samples', '3'], ['--unknown'], ['stray']]) expect(() => parseOptions(args)).toThrow();
  const help = await cli('--help');
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('--samples');
  expect(help.stdout).not.toContain('task_sets');
  const invalid = await cli('--samples', '0');
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain('--samples must be');
  expect(invalid.stdout).toBe('');
});

test('median and nearest-rank p95 handle odd/even/single samples without mutating inputs', () => {
  const values = [30, 10, 20];
  expect(summarize(values)).toEqual({ count: 3, min: 10, median: 20, p95: 30, max: 30 });
  expect(values).toEqual([30, 10, 20]);
  expect(summarize([4, 2])).toEqual({ count: 2, min: 2, median: 3, p95: 4, max: 4 });
  expect(summarize([7])).toEqual({ count: 1, min: 7, median: 7, p95: 7, max: 7 });
  expect(summarize(Array.from({ length: 20 }, (_, index) => index + 1)).p95).toBe(19);
  for (const values of [[], [NaN], [Infinity]]) expect(() => summarize(values)).toThrow();
});

test('report retains raw samples and every existing budget even when median hides an outlier', () => {
  const samples = [sample(), sample(101), sample()];
  samples[1].task_sets[0].render_ms = 51;
  samples[1].task_sets[0].ui_paging = false;
  Object.assign(samples[1].log_sets[0], { cold_ms: 101, warm_ms: 11, timer_delay_ms: 151, bytes_read: 8 * 1024 * 1024 + 1 });
  const report = buildReport(samples, { bun: 'test' }, 'start', 'finish');
  expect(report.task_sets[0].overview_ms).toBe(10);
  expect(report.task_sets[0].statistics.overview_ms).toEqual({ count: 3, min: 10, median: 10, p95: 101, max: 101 });
  expect(report.samples).toEqual(samples);
  expect(report.thresholds_ms).toEqual({ overview: 100, render: 50, large_log_cold: 100, unchanged_usage: 10, other_rpc_timer_delay: 150 });
  expect(report.ok).toBe(false);
  expect(report.violations).toHaveLength(7);
  expect(report.violations.every(message => message.startsWith('sample 2:'))).toBe(true);
  expect(report.measurement_scope.timer_delay).toContain('not competing socket RPC');
  const pass = buildReport([sample()], {}, 'start', 'finish');
  expect(pass.ok).toBe(true);
  expect(pass.violations).toEqual([]);
  expect(pass.thresholds_ms).toEqual(THRESHOLDS);
});

test('explicit report output matches stdout JSON and refuses to overwrite an earlier report', () => {
  const root = temp();
  try {
    const output = path.join(root, 'report.json');
    const report = buildReport([sample()], {}, 'start', 'finish');
    const json = writeReport(report, output);
    expect(fs.readFileSync(output, 'utf8')).toBe(json);
    expect(JSON.parse(json)).toEqual(report);
    expect(writeReport(report, null)).toBe(json);
    expect(() => writeReport({ ok: false }, output)).toThrow();
    expect(fs.readFileSync(output, 'utf8')).toBe(json);
    expect(() => writeReport(report, path.join(root, 'missing', 'report.json'))).toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('environment identity is rooted at the code checkout and unknown Git metadata is explicit', async () => {
  const root = temp();
  try {
    await repo(root);
    const polluted = { ...env(), GIT_DIR: path.join(root, 'nonexistent'), GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '/never-execute-this-command' };
    const before = { ...polluted };
    const identity = collectEnvironment(root, polluted);
    expect(identity.git.commit).toBe(await git(root, 'rev-parse', 'HEAD'));
    expect(identity.git.version).toContain('git version');
    expect(identity.git.dirty).toBe(false);
    expect(identity.os.release.length).toBeGreaterThan(0);
    expect(identity.bun).toBe(Bun.version);
    expect(identity.warnings).toEqual([]);
    expect(polluted).toEqual(before);
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'synthetic');
    expect(collectEnvironment(root, polluted).git.dirty).toBe(true);
    const unknown = collectEnvironment(root, { PATH: path.join(root, 'no-executables') });
    expect(unknown.git).toEqual({ version: null, commit: null, dirty: null });
    expect(unknown.warnings).toHaveLength(3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
