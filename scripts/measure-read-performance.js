import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { Config } from '../src/config.js';
import { Store } from '../src/persistence/store.js';
import { Project } from '../src/core/project.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { UIClient } from '../src/ui/client.js';
import { readUsage, transcriptReadStats } from '../src/core/transcript.js';
import { installDom, deepText } from '../test/dom-stub.js';

const CODE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const THRESHOLDS = Object.freeze({ overview: 100, render: 50, large_log_cold: 100, unchanged_usage: 10, other_rpc_timer_delay: 150 });
const HELP = `Usage: bun run measure:read-performance [--samples N] [--output PATH]
  --samples N    Independent fixtures per sample, 1..50 (default: 5)
  --output PATH  Also save stdout's JSON to a new file; parent must exist
  --help         Show this help without measuring
Existing budgets are checked for EVERY sample. No socket RPC/browser measurements.
`;

export function parseOptions(args) {
  const options = { samples: 5, output: null, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!['--samples', '--output', '--help'].includes(arg) || seen.has(arg)) throw new Error(`unknown or repeated option: ${arg}`);
    seen.add(arg);
    if (arg === '--help') { options.help = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (arg === '--samples') {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 50) throw new Error('--samples must be an integer from 1 to 50');
      options.samples = Number(value);
    } else options.output = path.resolve(value);
  }
  return options;
}

/** Median averages the middle pair; p95 uses nearest rank, never interpolation. */
export function summarize(values) {
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error('statistics require finite samples');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { count: sorted.length, min: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
}

/** Read code identity, not the caller's project. Git failure is explicit null metadata. */
export function collectEnvironment(root = CODE_ROOT, environment = process.env) {
  const env = { ...environment };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: os.devNull, GIT_CONFIG_GLOBAL: os.devNull });
  const warnings = [];
  function git(...args) {
    const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      warnings.push(`Git metadata unavailable: ${args[0]}`);
      return null;
    }
    return result.stdout.trim();
  }
  const gitVersion = git('--version');
  const commit = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all');
  return { bun: Bun.version, platform: `${process.platform}/${process.arch}`,
    os: { type: os.type(), release: os.release(), version: os.version() },
    git: { version: gitVersion, commit, dirty: status === null ? null : status !== '' }, warnings };
}

const cleanEnv = () => {
  const env = { ...process.env, LUSH_PROVIDER: 'mock' };
  for (const key of Object.keys(env)) if (key.startsWith('LUSH_') && key !== 'LUSH_PROVIDER') delete env[key];
  return env;
};
const timed = fn => { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; };
const timedAsync = async fn => { const start = performance.now(); const value = await fn(); return { value, ms: performance.now() - start }; };
const bytes = value => Buffer.byteLength(JSON.stringify(value));

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-read-measure-')));
  let store;
  try {
    const config = new Config({ project: root, env: cleanEnv() }); config.prepare();
    store = new Store(path.join(config.home, 'project.db'), root);
    const project = new Project(config, store);
    const dispatcher = new Dispatcher(project, { request() {} }, { version: 'measure', fingerprint: 'measure' });
    const client = new UIClient(config);
    client.request = (method, params = {}) => dispatcher.dispatch(method, params);
    return { root, config, store, project, client,
      close() { try { store.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } } };
  } catch (error) {
    try { store?.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
    throw error;
  }
}

async function taskDataset(count, dom, renderTree) {
  const f = fixture();
  try {
    f.store.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const task = f.store.create({ input_id: null, role: 'agent', task_kind: 'order', goal: `task ${index} ${'x'.repeat(80)}` });
        f.store.update(task.id, { status: 'completed', result: 'done' });
      }
    });
    // Same-process dispatcher, not socket RPC. Rendering excludes browser layout.
    const overview = await timedAsync(() => f.client.overview());
    const legacy = await timedAsync(() => f.client.snapshot());
    renderTree(overview.value); // warm this data shape before measuring recurring refresh work
    const render = timed(() => renderTree(overview.value));
    const treeText = deepText(dom.node('tasks'));
    return { tasks: count, overview_bytes: bytes(overview.value), legacy_bytes: bytes(legacy.value),
      overview_ms: overview.ms, legacy_ms: legacy.ms, render_ms: render.ms,
      shown: overview.value.tasks.length, page_limit: overview.value.task_page.limit,
      historical: overview.value.task_page.historical,
      truncated: overview.value.task_page.truncated, has_more: overview.value.task_page.has_more,
      ui_truncation: treeText.includes('列表已截断'), ui_paging: treeText.includes('加载更早 50 个') };
  } finally { f.close(); }
}

function writeLog(config, taskId, targetBytes) {
  const dir = path.join(config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ type: 'message', timestamp: 1000, message: { role: 'assistant', provider: 'mock', model: 'mock',
    content: [{ type: 'text', text: 'x'.repeat(3800) }], usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0 } } } }) + '\n';
  const repeats = Math.ceil(targetBytes / Buffer.byteLength(payload));
  fs.writeFileSync(path.join(dir, `2026-01-01T00-00-00-000Z_lush-task-${taskId}.jsonl`), payload.repeat(repeats));
}

async function logDataset(label, size) {
  const f = fixture();
  try {
    writeLog(f.config, 1, size);
    let firedAt = null; const start = performance.now();
    const timer = new Promise(resolve => setTimeout(() => { firedAt = performance.now(); resolve(); }, 0));
    const cold = timed(() => readUsage(f.config, 1));
    await timer;
    const coldStats = transcriptReadStats(f.config, 1);
    const warm = timed(() => readUsage(f.config, 1));
    return { label, file_bytes: fs.statSync(path.join(f.config.home, 'sessions', '2026-01-01T00-00-00-000Z_lush-task-1.jsonl')).size,
      cold_ms: cold.ms, warm_ms: warm.ms, timer_delay_ms: firedAt - start,
      bytes_read: coldStats.bytes, budget_bytes: coldStats.budget_bytes, truncated: cold.value.truncated };
  } finally { f.close(); }
}

function violationsFor(sample) {
  const violations = [];
  for (const set of sample.task_sets) {
    if (set.overview_ms > THRESHOLDS.overview) violations.push(`${set.tasks} tasks overview ${set.overview_ms}ms > ${THRESHOLDS.overview}ms`);
    if (set.render_ms > THRESHOLDS.render) violations.push(`${set.tasks} tasks render ${set.render_ms}ms > ${THRESHOLDS.render}ms`);
    if (!Number.isInteger(set.page_limit) || set.page_limit < 1 || set.page_limit > 200 ||
        set.shown !== Math.min(set.tasks, set.page_limit) ||
        (set.tasks > set.page_limit && (!set.truncated || !set.has_more || !set.ui_truncation || !set.ui_paging))) {
      violations.push(`${set.tasks} tasks did not expose the bounded UI truncation/page controls`);
    }
  }
  const large = sample.log_sets.find(set => set.label === 'large');
  if (large.cold_ms > THRESHOLDS.large_log_cold) violations.push(`large log cold ${large.cold_ms}ms > ${THRESHOLDS.large_log_cold}ms`);
  if (large.warm_ms > THRESHOLDS.unchanged_usage) violations.push(`unchanged usage ${large.warm_ms}ms > ${THRESHOLDS.unchanged_usage}ms`);
  if (large.timer_delay_ms > THRESHOLDS.other_rpc_timer_delay) violations.push(`timer delay ${large.timer_delay_ms}ms > ${THRESHOLDS.other_rpc_timer_delay}ms`);
  if (large.bytes_read > 8 * 1024 * 1024) violations.push(`large log read ${large.bytes_read} bytes > 8 MiB`);
  return violations;
}

export function buildReport(samples, environment, startedAt, finishedAt) {
  const aggregate = (group, timingKeys) => samples[0][group].map((first, index) => {
    const statistics = Object.fromEntries(timingKeys.map(key => [key, summarize(samples.map(sample => sample[group][index][key]))]));
    return { ...first, ...Object.fromEntries(timingKeys.map(key => [key, statistics[key].median])), statistics };
  });
  const violations = samples.flatMap((sample, index) => violationsFor(sample).map(message => `sample ${index + 1}: ${message}`));
  return { version: 1, started_at: startedAt, finished_at: finishedAt, environment,
    measurement_scope: { overview: 'in-process dispatcher projection', render: 'DOM stub (no browser layout)',
      timer_delay: 'same-process event-loop delay (not competing socket RPC)' },
    sampling: { count: samples.length, percentile_method: 'nearest-rank',
      fixtures: 'rebuilt for every dataset in every sample; same Bun process, not OS-cache cold',
      scalar_timings: 'median', structural_fields: 'first sample; budgets checked on every raw sample' },
    task_sets: aggregate('task_sets', ['overview_ms', 'legacy_ms', 'render_ms']),
    log_sets: aggregate('log_sets', ['cold_ms', 'warm_ms', 'timer_delay_ms']),
    samples, thresholds_ms: THRESHOLDS, ok: violations.length === 0, violations };
}

/** Exclusive output creation protects an earlier report; stdout remains valid JSON. */
export function writeReport(report, output) {
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) fs.writeFileSync(output, json, { flag: 'wx' });
  return json;
}

async function main(args) {
  const options = parseOptions(args);
  if (options.help) { process.stdout.write(HELP); return; }
  const startedAt = new Date().toISOString();
  const environment = collectEnvironment(); // before fixture work/output can change the code checkout
  const dom = installDom({ fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'measurement has no network' }) }) });
  try {
    const { renderTree } = await import('../src/ui/web/assets/render-tree.js');
    renderTree({ tasks: [], inputs: [], notices: [], status: { concurrency: 1 }, task_page: { total: 0, active: 0, historical: 0, shown: 0, truncated: false, has_more: false } });
    const samples = [];
    for (let index = 0; index < options.samples; index++) {
      const taskSets = [];
      for (const count of [20, 1000, 10000]) taskSets.push(await taskDataset(count, dom, renderTree));
      const logSets = [];
      for (const [label, size] of [['small', 64 * 1024], ['medium', 2 * 1024 * 1024], ['large', 12 * 1024 * 1024]]) {
        logSets.push(await logDataset(label, size));
      }
      samples.push({ sample: index + 1, task_sets: taskSets, log_sets: logSets });
    }
    const report = buildReport(samples, environment, startedAt, new Date().toISOString());
    process.stdout.write(writeReport(report, options.output));
    if (!report.ok) process.exitCode = 1;
  } finally { dom.restore(); }
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`read-performance: ${error.message}`); process.exitCode = 1; }
}
