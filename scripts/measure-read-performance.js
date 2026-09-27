import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Config } from '../src/config.js';
import { Store } from '../src/persistence/store.js';
import { Project } from '../src/core/project.js';
import { Dispatcher } from '../src/rpc/dispatcher.js';
import { UIClient } from '../src/ui/client.js';
import { readUsage, transcriptReadStats } from '../src/core/transcript.js';
import { installDom, deepText } from '../test/dom-stub.js';

const dom = installDom({ fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'measurement has no network' }) }) });
const { renderTree } = await import('../src/ui/web/assets/render-tree.js');
renderTree({ tasks: [], inputs: [], notices: [], status: { concurrency: 1 }, task_page: { total: 0, active: 0, historical: 0, shown: 0, truncated: false, has_more: false } });

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
  const config = new Config({ project: root, env: cleanEnv() }); config.prepare();
  const store = new Store(path.join(config.home, 'project.db'), root);
  const project = new Project(config, store);
  const dispatcher = new Dispatcher(project, { request() {} }, { version: 'measure', fingerprint: 'measure' });
  const client = new UIClient(config);
  client.request = (method, params = {}) => dispatcher.dispatch(method, params);
  return { root, config, store, project, client,
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

async function taskDataset(count) {
  const f = fixture();
  try {
    f.store.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const task = f.store.create({ input_id: null, role: 'research', goal: `task ${index} ${'x'.repeat(80)}` });
        f.store.update(task.id, { status: 'completed', result: 'done' });
      }
    });
    // These are the real homepage and compatibility client paths, including summary, ladder and activity.
    const overview = await timedAsync(() => f.client.overview());
    const legacy = await timedAsync(() => f.client.snapshot());
    renderTree(overview.value); // warm this data shape before measuring recurring refresh work
    const render = timed(() => renderTree(overview.value));
    const treeText = deepText(dom.node('tasks'));
    return { tasks: count, overview_bytes: bytes(overview.value), legacy_bytes: bytes(legacy.value),
      overview_ms: +overview.ms.toFixed(3), legacy_ms: +legacy.ms.toFixed(3), render_ms: +render.ms.toFixed(3),
      shown: overview.value.tasks.length, historical: overview.value.task_page.historical,
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
      cold_ms: +cold.ms.toFixed(3), warm_ms: +warm.ms.toFixed(3), timer_delay_ms: +(firedAt - start).toFixed(3),
      bytes_read: coldStats.bytes, budget_bytes: coldStats.budget_bytes, truncated: cold.value.truncated };
  } finally { f.close(); }
}

const thresholds = { overview: 100, render: 50, large_log_cold: 100, unchanged_usage: 10, other_rpc_timer_delay: 150 };
const taskSets = [];
for (const count of [20, 1000, 10000]) taskSets.push(await taskDataset(count));
const logSets = [];
for (const [label, size] of [['small', 64 * 1024], ['medium', 2 * 1024 * 1024], ['large', 12 * 1024 * 1024]]) {
  logSets.push(await logDataset(label, size));
}
const report = {
  environment: { bun: Bun.version, platform: `${process.platform}/${process.arch}` },
  task_sets: taskSets, log_sets: logSets, thresholds_ms: thresholds,
};
const violations = [];
for (const set of report.task_sets) {
  if (set.overview_ms > thresholds.overview) violations.push(`${set.tasks} tasks overview ${set.overview_ms}ms > ${thresholds.overview}ms`);
  if (set.render_ms > thresholds.render) violations.push(`${set.tasks} tasks render ${set.render_ms}ms > ${thresholds.render}ms`);
  if (set.tasks >= 1000 && (set.shown !== 50 || !set.truncated || !set.has_more || !set.ui_truncation || !set.ui_paging)) {
    violations.push(`${set.tasks} tasks did not expose the bounded UI truncation/page controls`);
  }
}
const large = report.log_sets.find(set => set.label === 'large');
if (large.cold_ms > thresholds.large_log_cold) violations.push(`large log cold ${large.cold_ms}ms > ${thresholds.large_log_cold}ms`);
if (large.warm_ms > thresholds.unchanged_usage) violations.push(`unchanged usage ${large.warm_ms}ms > ${thresholds.unchanged_usage}ms`);
if (large.timer_delay_ms > thresholds.other_rpc_timer_delay) violations.push(`timer delay ${large.timer_delay_ms}ms > ${thresholds.other_rpc_timer_delay}ms`);
if (large.bytes_read > 8 * 1024 * 1024) violations.push(`large log read ${large.bytes_read} bytes > 8 MiB`);
report.ok = violations.length === 0;
report.violations = violations;
console.log(JSON.stringify(report, null, 2));
dom.restore();
if (violations.length) process.exitCode = 1;
