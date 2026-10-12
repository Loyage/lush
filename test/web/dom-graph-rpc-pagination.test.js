import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setup, fetch as httpFetch } from './harness.js';
import { installDom, deepText } from './project-dom.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { setPref } from '../../src/ui/web/assets/prefs.js';
import { openTaskGraph, loadTaskGraph, loadNextTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';

function create(f, kind, parent_id = null, name = '') {
  const task = f.store.create({ role: 'agent', task_kind: kind, parent_id, goal: `实际协议 ${kind}`, name });
  f.store.update(task.id, { status: 'completed' });
  return task;
}
function browser(f) {
  const reads = [];
  const dom = installDom({ fetch: async (url, options) => {
    const response = await httpFetch(f.url + url, options);
    const value = await response.json();
    reads.push({ query: new URL(url, 'http://fixture').searchParams, status: response.status, value });
    return { ok: response.ok, status: response.status, json: async () => value };
  } });
  resetUiState(); dom.node('modal').hidden = true;
  return { dom, reads, close: () => { resetUiState(); dom.restore(); } };
}

test('DOM receives real byte-bounded HTTP/RPC pages, enriches differing summary/full boundaries, and renders giant/unknown details safely', async () => {
  const f = await setup(); f.project.stopping = true;
  let b;
  try {
    const root = create(f, 'main'), ids = [root.id];
    f.store.transaction(() => {
      for (let i = 0; i < 224; i++) ids.push(create(f, 'child', root.id, `节点 ${i} ` + '😀漢\\"'.repeat(500)).id);
    });
    const retired = create(f, null, root.id);
    const hidden = create(f, 'child', root.id); f.store.update(hidden.id, { status: 'failed' });
    const sessions = path.join(f.config.home, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `hidden_lush-task-${hidden.id}.jsonl`), JSON.stringify({ type: 'message',
      message: { role: 'assistant', usage: { input: 50, output: 3, cost: { total: 1 } } } }) + '\n');
    const giant = create(f, 'child', root.id); ids.push(giant.id); f.store.update(giant.id, { branch: 'giant' });
    f.project.workspaces.branchDiagnostics = async () => new Map([['giant', { error: '漢'.repeat(400000) }]]);
    b = browser(f); setPref('taskGraphStatuses', new Set(['failed']));
    await openTaskGraph(); await loadTaskGraph();
    const summary = b.reads.find(read => read.query.get('details') === '0').value;
    const full = b.reads.find(read => read.query.get('details') === '1').value;
    expect(summary.cursor).not.toBe(full.cursor);
    expect(full.nodes.length).toBeLessThan(summary.nodes.length);
    expect(ui.taskGraphPage.cursor).toBe(full.cursor);
    expect(full.nodes.find(node => node.id === giant.id).details_unavailable).toBe(true);
    expect(deepText(b.dom.node('detail'))).toContain('详情过大不可用');
    let pages = 0;
    while (ui.taskGraphPage.hasMore) {
      const before = b.reads.length; await loadNextTaskGraph(); expect(b.reads.length).toBe(before + 1);
      expect(++pages).toBeLessThan(20);
    }
    expect(ui.taskGraphPage.graph.nodes.map(node => node.id).toSorted((a, z) => a - z)).toEqual(ids.toSorted((a, z) => a - z));
    expect(b.dom.node('detail').querySelectorAll('.task-graph-card')).toHaveLength(ids.length);
    expect(ui.taskGraphPage.graph.nodes.some(node => node.id === retired.id || node.id === hidden.id)).toBe(false);
    expect(ui.taskGraphPage.graph.details_pending).toBe(false);
    const loaded = new Set(ids);
    expect(ui.taskGraphPage.graph.edges.every(edge => loaded.has(edge.from) && loaded.has(edge.to))).toBe(true);
    for (const read of b.reads) {
      expect(read.status).toBe(200); expect(read.query.get('scope')).toBe('tree');
      expect(read.query.get('hidden_statuses')).toBe('["failed"]'); expect(read.query.get('include_archived')).toBe('0');
    }
    const rootCard = b.dom.node('detail').querySelector(`[data-task-id="${root.id}"]`);
    await rootCard.querySelector('[data-graph-focus="fold-' + root.id + '"]').onclick();
    const folded = b.dom.node('detail').querySelector(`[data-task-id="${root.id}"]`);
    expect(deepText(folded.querySelector('.task-graph-usage'))).toContain('↑—');
    expect(deepText(folded.querySelector('.task-graph-usage'))).toContain('↓—');
  } finally { b?.close(); await f.close(); }
});

test('DOM recovers the actual backend stale prefix with one full first-batch read and keeps filtered real/layout parents coherent', async () => {
  const f = await setup(); f.project.stopping = true;
  let b;
  try {
    const root = create(f, 'main');
    f.store.transaction(() => { for (let i = 0; i < 225; i++) create(f, 'child', root.id); });
    b = browser(f); setPref('taskGraphStatuses', new Set(['failed']));
    await openTaskGraph(); await loadTaskGraph();
    expect(ui.taskGraphPage.graph.nodes).toHaveLength(200); const cursor = ui.taskGraphPage.cursor;
    f.store.update(root.id, { status: 'failed' });
    const before = b.reads.length; await loadNextTaskGraph();
    expect(b.reads).toHaveLength(before + 2);
    expect(b.reads[before].status).toBe(400);
    expect(b.reads[before].value.error.startsWith('Worker graph cursor stale; refresh from first page')).toBe(true);
    expect(b.reads.at(-1).query.has('cursor')).toBe(false); expect(b.reads.at(-1).query.get('details')).toBe('1');
    expect(ui.taskGraphPage.cursor).not.toBe(cursor); expect(ui.taskGraphPage.graph.matched_total).toBe(225);
    expect(ui.taskGraphPage.graph.nodes.every(node => node.parent_id === root.id && node.layout_parent_id === null)).toBe(true);
    expect(ui.taskGraphPage.graph.edges).toEqual([]);
    expect(b.dom.node('detail').querySelector(`[data-task-id="${root.id}"]`)).toBeNull();
    expect(deepText(b.dom.node('detail'))).toContain('已从首批重新加载');
    await loadNextTaskGraph(); expect(ui.taskGraphPage.graph.nodes).toHaveLength(225);
    expect(ui.taskGraphPage.graph.details_pending).toBe(false); expect(ui.taskGraphPage.staleRestarts).toBe(0);
  } finally { b?.close(); await f.close(); }
});
