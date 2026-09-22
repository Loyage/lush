import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Config } from '../src/config.js';
import { Store } from '../src/persistence/store.js';
import { Project } from '../src/core/project.js';
import { readUsage, transcriptReadStats } from '../src/core/transcript.js';
import { installDom } from '../test/dom-stub.js';

const dom = installDom({ fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'measurement has no network' }) }) });
const { renderTree } = await import('../src/ui/web/assets/render-tree.js');
// Module/style-independent warm-up; measurements below represent recurring browser refreshes.
renderTree({ tasks: [], inputs: [], notices: [], status: { concurrency: 1 }, task_page: { total: 0, active: 0, historical: 0, shown: 0, truncated: false, has_more: false } });

const cleanEnv = () => {
  const env = { ...process.env, LUSH_PROVIDER: 'mock' };
  for (const key of Object.keys(env)) if (key.startsWith('LUSH_') && key !== 'LUSH_PROVIDER') delete env[key];
  return env;
};
const timed = fn => { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; };
const bytes = value => Buffer.byteLength(JSON.stringify(value));

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lush-read-measure-')));
  const config = new Config({ project: root, env: cleanEnv() }); config.prepare();
  const store = new Store(path.join(config.home, 'project.db'), root);
  const project = new Project(config, store);
  return { root, config, store, project, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

function taskDataset(count) {
  const f = fixture();
  try {
    f.store.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const task = f.store.create({ input_id: null, role: 'research', goal: `task ${index} ${'x'.repeat(80)}` });
        f.store.update(task.id, { status: 'completed', result: 'done' });
      }
    });
    const shared = () => ({ timeline: f.project.timeline({ limit: 40 }), ladder: { nodes: [], groups: [], truncated: false },
      inputs: f.project.inputs(), drafts: f.project.drafts(),
      notices: f.store.all("SELECT * FROM notices ORDER BY (status='open') DESC, id DESC LIMIT 200"),
      specs: f.store.specs({ limit: 1000 }), candidates: f.project.candidates() });
    const bounded = timed(() => { const activity = f.project.activity(50); return { status: f.project.status(false),
      tasks: activity.tasks, task_page: activity.page, ...shared() }; });
    const legacy = timed(() => ({ status: f.project.status(), tasks: f.project.decorate(f.store.summaries('work')), ...shared() }));
    const renderData = bounded.value;
    const render = timed(() => renderTree(renderData));
    return { tasks: count, overview_bytes: bytes(bounded.value), legacy_bytes: bytes(legacy.value),
      overview_ms: +bounded.ms.toFixed(3), legacy_ms: +legacy.ms.toFixed(3), render_ms: +render.ms.toFixed(3) };
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

const report = {
  environment: { bun: Bun.version, platform: `${process.platform}/${process.arch}` },
  task_sets: [taskDataset(20), taskDataset(1000), taskDataset(10000)],
  log_sets: [await logDataset('small', 64 * 1024), await logDataset('medium', 2 * 1024 * 1024), await logDataset('large', 12 * 1024 * 1024)],
  thresholds_ms: { overview: 100, render: 50, large_log_cold: 100, unchanged_usage: 10, other_rpc_timer_delay: 150 },
};
console.log(JSON.stringify(report, null, 2));
dom.restore();
