import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, fetch as httpFetch } from './harness.js';
import { gate } from '../helpers.js';
import { installDom, deepText } from './project-dom.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { setPref } from '../../src/ui/web/assets/prefs.js';
import { openTaskGraph, loadTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { UsageIndex } from '../../src/core/usage-index.js';
import { readCompactUsageFile } from '../../src/core/usage-statistics.js';

function save(config, id, input, cost = .2) {
  const dir = path.join(config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dom_lush-task-${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'message', lush: { task_id: id }, message: {
    role: 'assistant', usage: { input, output: 1, ...(cost === null ? {} : { cost: { total: cost } }) },
  } }) + '\n');
  return file;
}

// Real DOM -> authenticated HTTP -> registry/dispatcher -> worker.graph -> durable index.
// No older page is requested to obtain the folded lifetime total.
test('folded main shows known subtotal then complete indexed total through real HTTP/RPC without loading hidden, archived or older Worker pages', async () => {
  const f = await setup(), entered = gate(), release = gate();
  let dom, backfill;
  const original = fs.createReadStream, reads = [], requests = [];
  try {
    const main = f.store.create({ role: 'agent', task_kind: 'main', goal: 'main' });
    f.store.update(main.id, { status: 'waiting' }); save(f.config, main.id, 5);
    const hidden = f.store.create({ role: 'agent', task_kind: 'child', parent_id: main.id, goal: 'hidden expense' });
    f.store.update(hidden.id, { status: 'failed' }); const hiddenFile = save(f.config, hidden.id, 10);
    const archived = f.store.create({ role: 'agent', task_kind: 'child', parent_id: main.id, goal: 'archived expense' });
    f.store.update(archived.id, { status: 'completed', branch: 'archived' });
    f.store.recordBranch({ branch: 'archived' }); f.store.markBranchArchived('archived');
    save(f.config, archived.id, 20);
    const offpage = f.store.create({ role: 'agent', task_kind: 'child', parent_id: hidden.id, goal: 'old expense' });
    f.store.update(offpage.id, { status: 'completed' }); save(f.config, offpage.id, 30);
    f.store.transaction(() => {
      for (let i = 0; i < 205; i++) {
        const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: main.id, goal: 'recent' });
        f.store.update(child.id, { status: 'completed' });
      }
    });
    f.project.usageIndex = new UsageIndex(f.config, { intervalMs: 100000, batchSize: 1, parse: async (file, stat) => {
      if (file === hiddenFile) { entered.resolve(); await release.promise; }
      return readCompactUsageFile(file, stat);
    } });
    fs.createReadStream = function(file, ...args) { reads.push(file); return original.call(this, file, ...args); };
    dom = installDom({ fetch: async (url, options) => {
      const response = await httpFetch(f.url + url, options), value = await response.json();
      requests.push({ url: new URL(url, f.url), value, status: response.status });
      return { ok: response.ok, status: response.status, json: async () => value };
    } });
    resetUiState(); dom.node('modal').hidden = true;
    setPref('taskGraphStatuses', new Set(['failed']));
    await openTaskGraph(); await loadTaskGraph();
    const card = () => dom.node('detail').querySelector(`[data-task-id="${main.id}"]`);
    const usage = () => card().querySelector('.task-graph-usage');
    await card().querySelector(`[data-graph-focus="fold-${main.id}"]`).onclick();
    expect(dom.node('detail').querySelectorAll('.task-graph-card')).toHaveLength(1);
    expect(deepText(usage())).toContain('统计不完整');
    expect(usage().querySelector('.task-graph-usage-input').textContent).toBe('已知 ↑5');
    expect(usage().querySelector('.task-graph-usage-cost').textContent).toBe('已知 $0.20');
    expect(usage().getAttribute('data-help')).toContain('后台补齐中');
    expect(reads).toHaveLength(1);
    expect(ui.taskGraphPage.hasMore).toBe(true);
    f.project.usageIndex.start(); await entered.promise;
    backfill = f.project.usageIndex.refresh(); release.resolve(); await backfill;
    reads.length = 0; await loadTaskGraph();
    expect(usage().querySelector('.task-graph-usage-input').textContent).toBe('↑65');
    expect(usage().querySelector('.task-graph-usage-output').textContent).toBe('↓4');
    expect(usage().querySelector('.task-graph-usage-cost').textContent).toBe('$0.80');
    expect(deepText(usage())).not.toContain('统计不完整');
    expect(reads).toHaveLength(0);
    expect(ui.taskGraphPage.graph.nodes).toHaveLength(200);
    expect(ui.taskGraphPage.graph.nodes.some(n => [hidden.id, archived.id, offpage.id].includes(n.id))).toBe(false);
    // Missing cost must not suppress the complete token total, nor fabricate a bill.
    save(f.config, offpage.id, 40, null); await f.project.usageIndex.refresh();
    await loadTaskGraph();
    expect(usage().querySelector('.task-graph-usage-input').textContent).toBe('↑75');
    expect(usage().querySelector('.task-graph-usage-cost').textContent).toBe('已知 $0.60');
    expect(usage().getAttribute('data-help')).toContain('记录缺失');
    expect(requests.every(r => r.status === 200 && r.url.pathname === '/api/worker-graph' && !r.url.searchParams.has('cursor'))).toBe(true);
  } finally {
    release.resolve(); await backfill;
    resetUiState(); dom?.restore(); fs.createReadStream = original; await f.close();
  }
});
