import { test, expect } from 'bun:test';
import { setup, fetch } from './harness.js';
import { GRAPH_BYTE_BUDGET } from '../../src/core/project/graph-pages.js';

test('HTTP over a real Worker RPC socket loads byte-bounded full and summary pages without frame errors', async () => {
  const f = await setup(); f.project.stopping = true;
  try {
    const ids = [];
    f.store.transaction(() => {
      for (let i = 0; i < 110; i++) {
        const row = f.store.create({ role: 'agent', task_kind: 'child', goal: '正常正文', name: '😀漢\\\u0001'.repeat(1000) });
        f.store.update(row.id, { status: 'completed' }); ids.push(row.id);
      }
    });
    const giant = f.store.create({ role: 'agent', task_kind: 'child', goal: '超大诊断' });
    f.store.update(giant.id, { status: 'completed', branch: 'giant' }); ids.push(giant.id);
    f.project.workspaces.branchDiagnostics = async () => new Map([['giant', { error: '漢'.repeat(400000) }]]);
    for (const details of [true, false]) {
      const seen = []; let cursor = null, pages = 0;
      do {
        const query = new URLSearchParams({ details: details ? '1' : '0', include_archived: '0', hidden_statuses: '["failed"]', scope: 'tree' });
        if (cursor) query.set('cursor', cursor);
        const response = await fetch(`${f.url}/api/worker-graph?${query}`);
        expect(response.status).toBe(200);
        const body = await response.text(); expect(Buffer.byteLength(body)).toBeLessThan(GRAPH_BYTE_BUDGET);
        const graph = JSON.parse(body); expect(graph.matched_total).toBe(ids.length);
        if (pages === 0 && details) expect(graph.nodes.find(node => node.id === giant.id)).toMatchObject({ details_unavailable: true,
          details_unavailable_reason: 'node exceeds graph byte budget; use worker.inspect/history for details' });
        seen.push(...graph.nodes.map(node => node.id)); cursor = graph.cursor; pages++;
      } while (cursor);
      expect(pages).toBeGreaterThan(1); expect(new Set(seen).size).toBe(ids.length);
      expect(seen.toSorted((a, b) => a - b)).toEqual(ids);
    }
    const first = await (await fetch(`${f.url}/api/worker-graph?details=0&scope=tree`)).json();
    expect(first.cursor).not.toBeNull();
    const mismatch = await fetch(`${f.url}/api/worker-graph?details=0&scope=all&cursor=${first.cursor}`);
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error).toBe('Worker graph cursor filter or project mismatch');
    f.store.update(ids[0], { status: 'failed' });
    const stale = await fetch(`${f.url}/api/worker-graph?details=0&scope=tree&cursor=${first.cursor}`);
    expect(stale.status).toBe(400);
    expect((await stale.json()).error.startsWith('Worker graph cursor stale; refresh from first page')).toBe(true);
  } finally { await f.close(); }
});
