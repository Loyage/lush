import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { encode, MAX_FRAME } from '../../src/rpc/protocol.js';
import { GRAPH_BYTE_BUDGET, jsonBytes } from '../../src/core/project/graph-pages.js';

function task(f, fields = {}) {
  const row = f.store.create({ role: 'agent', task_kind: 'child', goal: 'graph row', ...fields });
  f.store.update(row.id, { status: 'completed' });
  return row;
}
function session(f, id) {
  const dir = path.join(f.config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `graph_lush-task-${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: 10, output: 2, cost: { total: .1 } } } }) + '\n');
  return file;
}

test('serialized Unicode/escapes paginate below RPC frame budget, with no missing or duplicate nodes and a progressing giant row', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const ids = [];
    f.store.transaction(() => {
      for (let i = 0; i < 223; i++) ids.push(task(f, { name: '\u0001😀漢\\"'.repeat(1300) }).id);
    });
    const giant = task(f, { name: '😀'.repeat(300000) }); ids.push(giant.id);
    const before = f.store.get('SELECT count(*) AS n FROM events').n;
    const dispatcher = new Dispatcher(f.project, { request() {} });
    const seen = [], cursors = new Set(); let cursor, pages = 0;
    do {
      const graph = await dispatcher.dispatch('worker.graph', { details: false, ...(cursor ? { cursor } : {}) });
      expect(jsonBytes(graph)).toBeLessThan(GRAPH_BYTE_BUDGET);
      expect(encode({ jsonrpc: '2.0', id: 'graph'.repeat(1000), result: graph }).length).toBeLessThan(MAX_FRAME);
      expect(graph.nodes.length).toBeGreaterThan(0); expect(graph.nodes.length).toBeLessThanOrEqual(200);
      expect(graph.matched_total).toBe(ids.length); expect(graph.counts.completed).toBe(ids.length);
      expect(graph.has_more).toBe(graph.cursor !== null);
      if (pages === 0) expect(graph.nodes.find(row => row.id === giant.id)).toMatchObject({ node_truncated: true, details_unavailable: true, resources: null });
      seen.push(...graph.nodes.map(row => row.id)); cursor = graph.cursor; pages++;
      if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor); }
    } while (cursor);
    expect(pages).toBeGreaterThan(2); expect(new Set(seen).size).toBe(ids.length);
    expect(seen.toSorted((a, b) => a - b)).toEqual(ids);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
  } finally { await f.close(); }
});

test('status/archive filters count the full drawable scope and bypass hidden ancestors without changing real parent IDs', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const root = task(f, { task_kind: 'main' });
    const hidden = task(f, { parent_id: root.id }); f.store.update(hidden.id, { status: 'failed', branch: 'old' });
    f.store.recordBranch({ branch: 'old' }); f.store.markBranchArchived('old');
    const queue = task(f, { task_kind: 'merge', parent_id: hidden.id });
    const child = task(f, { parent_id: hidden.id });
    task(f, { task_kind: 'management' }); const legacy = task(f, { task_kind: null });
    const graph = await f.project.taskGraph({ details: false, hidden_statuses: ['failed'], include_archived: false });
    expect(graph.archived_count).toBe(2); expect(graph.counts.failed).toBe(0); expect(graph.counts.completed).toBe(2);
    expect(graph.nodes.map(row => row.id).toSorted()).toEqual([root.id, child.id, legacy.id].toSorted());
    expect(graph.matched_total).toBe(3);
    expect(graph.nodes.find(row => row.id === child.id)).toMatchObject({ parent_id: hidden.id, layout_parent_id: root.id });
    expect(graph.edges).toEqual([]);
    const tree = await f.project.taskGraph({ details: false, scope: 'tree', hidden_statuses: ['failed'], include_archived: false });
    expect(tree.nodes.map(row => row.id).toSorted()).toEqual([root.id, child.id].toSorted());
    expect(tree.matched_total).toBe(2); expect(tree.counts).toEqual(graph.counts);
    const included = await f.project.taskGraph({ details: false, hidden_statuses: ['failed'] });
    expect(included.counts.failed).toBe(1); expect(included.counts.completed).toBe(3);
    expect(included.nodes.some(row => row.id === queue.id)).toBe(true);
    expect(included.nodes.find(row => row.id === child.id).layout_parent_id).toBe(root.id);
  } finally { await f.close(); }
});

test('tree scope skips retired intermediary bodies while preserving real parents and nearest drawable layout ancestry', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const root = task(f, { task_kind: 'main' });
    const old = task(f, { task_kind: null, parent_id: root.id });
    const child = task(f, { parent_id: old.id });
    const all = await f.project.taskGraph({ details: false });
    expect(all.matched_total).toBe(3); expect(all.nodes.find(row => row.id === child.id).layout_parent_id).toBe(old.id);
    const tree = await f.project.taskGraph({ details: false, scope: 'tree' });
    expect(tree.matched_total).toBe(2); expect(tree.counts.completed).toBe(2);
    expect(tree.nodes.find(row => row.id === old.id)).toBeUndefined();
    expect(tree.nodes.find(row => row.id === child.id)).toMatchObject({ parent_id: old.id, layout_parent_id: root.id });
  } finally { await f.close(); }
});

test('partial acceptance stays visible under archive filtering and clears only after the durable recovery boundary', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const row = task(f, { task_kind: 'order' });
    const commit = 'a'.repeat(40);
    f.store.update(row.id, { branch: 'recoverable', head_commit: commit });
    f.store.recordBranch({ branch: 'recoverable' }); f.store.markBranchArchived('recoverable');
    f.store.event(row.id, 'task.acceptance_started', { head_commit: commit, tips: { recoverable: commit },
      branches: ['recoverable'], task_ids: [row.id] });
    const graph = await f.project.taskGraph({ details: false, include_archived: false });
    expect(graph.nodes[0]).toMatchObject({ id: row.id, archived: false, acceptance_recovery: true });
    expect(graph.archived_count).toBe(0);
    f.store.event(row.id, 'task.acceptance_reclaimed', {});
    const reclaimed = await f.project.taskGraph({ details: false, include_archived: false });
    expect(reclaimed.nodes).toEqual([]); expect(reclaimed.archived_count).toBe(1);
  } finally { await f.close(); }
});

test('200-node continuation preserves page-external parents; cursor is scoped and refreshes on structural drift, not body changes', async () => {
  const f = fixture(), other = fixture(); f.project.stopping = other.project.stopping = true;
  try {
    const root = task(f, { task_kind: 'main' }); const ids = [];
    f.store.transaction(() => {
      for (let i = 0; i < 202; i++) ids.push(task(f, { parent_id: root.id }).id);
    });
    const first = await f.project.taskGraph({ details: false });
    expect(first.nodes).toHaveLength(200); expect(first.has_more).toBe(true);
    f.store.update(ids[0], { result: 'ordinary body update' });
    const next = await f.project.taskGraph({ details: false, cursor: first.cursor });
    expect(next.nodes).toHaveLength(3); expect(next.cursor).toBeNull(); expect(next.has_more).toBe(false);
    expect(next.nodes.every(row => row.parent_id === root.id && row.layout_parent_id === root.id)).toBe(true);
    await expect(f.project.taskGraph({ details: true, cursor: first.cursor })).rejects.toThrow('cursor filter or project mismatch');
    await expect(f.project.taskGraph({ details: false, include_archived: false, cursor: first.cursor })).rejects.toThrow('cursor filter or project mismatch');
    await expect(f.project.taskGraph({ details: false, hidden_statuses: ['failed'], cursor: first.cursor })).rejects.toThrow('cursor filter or project mismatch');
    await expect(f.project.taskGraph({ details: false, scope: 'tree', cursor: first.cursor })).rejects.toThrow('cursor filter or project mismatch');
    other.store.transaction(() => {
      for (const row of f.store.all('SELECT id,parent_id,task_kind FROM tasks ORDER BY id')) task(other, { task_kind: row.task_kind, parent_id: row.parent_id });
    });
    await expect(other.project.taskGraph({ details: false, cursor: first.cursor })).rejects.toThrow('cursor filter or project mismatch');
    f.store.update(ids[0], { status: 'failed' });
    await expect(f.project.taskGraph({ details: false, cursor: first.cursor })).rejects.toThrow('Worker graph cursor stale; refresh from first page');
    f.store.update(ids[0], { status: 'completed' }); task(f);
    await expect(f.project.taskGraph({ details: false, cursor: first.cursor })).rejects.toThrow('Worker graph cursor stale; refresh from first page');
    for (const mutation of [
      () => f.store.run('UPDATE tasks SET parent_id=NULL WHERE id=?', ids[0]),
      () => { f.store.update(ids[0], { branch: 'archived-during-pagination' });
        f.store.recordBranch({ branch: 'archived-during-pagination' }); f.store.markBranchArchived('archived-during-pagination'); },
      () => f.store.deleteTasks([ids.at(-1)]),
    ]) {
      const current = await f.project.taskGraph({ details: false }); mutation();
      await expect(f.project.taskGraph({ details: false, cursor: current.cursor })).rejects.toThrow('Worker graph cursor stale; refresh from first page');
    }
    for (const offset of [-1, 0, 999999, 1.5]) {
      const current = await f.project.taskGraph({ details: false });
      const value = JSON.parse(Buffer.from(current.cursor, 'base64url').toString()); value.offset = offset;
      await expect(f.project.taskGraph({ details: false, cursor: Buffer.from(JSON.stringify(value)).toString('base64url') })).rejects.toThrow('cursor range');
    }
  } finally { await f.close(); await other.close(); }
});

test('hidden and archived bodies never trigger session or Git diagnostics; unknown hidden subtree spend is explicit', async () => {
  const f = fixture(); f.project.stopping = true; await repo(f.root);
  const read = fs.createReadStream;
  try {
    const root = task(f, { task_kind: 'main' });
    const shown = task(f, { parent_id: root.id }); f.store.update(shown.id, { branch: 'shown' });
    const hidden = task(f, { parent_id: root.id }); f.store.update(hidden.id, { status: 'failed', branch: 'hidden' });
    const archived = task(f, { parent_id: root.id }); f.store.update(archived.id, { branch: 'archived' });
    const retired = task(f, { task_kind: null, parent_id: root.id }); f.store.update(retired.id, { branch: 'retired' });
    for (const name of ['shown', 'hidden', 'archived', 'retired']) f.store.recordBranch({ branch: name });
    f.store.markBranchArchived('archived');
    const shownFile = session(f, shown.id), hiddenFile = session(f, hidden.id), archivedFile = session(f, archived.id);
    const retiredFile = session(f, retired.id);
    const reads = [], diagnostics = [];
    fs.createReadStream = function(file, ...args) { reads.push(file); return read.call(this, file, ...args); };
    f.project.workspaces.branchDiagnostics = async targets => { diagnostics.push(...targets.map(target => target.name)); return new Map(); };
    const graph = await f.project.taskGraph({ scope: 'tree', hidden_statuses: ['failed'], include_archived: false });
    expect(reads).toEqual([shownFile]); expect(diagnostics).toEqual(['shown']);
    expect(graph.nodes.find(row => row.id === root.id).resources.subtree).toMatchObject({ input: 10, incomplete: true });
    // Populate compact totals through the existing unfiltered read, then filtered
    // reads can use signature-valid hidden summaries without touching those bodies.
    await f.project.taskGraph(); reads.length = 0;
    const cached = await f.project.taskGraph({ scope: 'tree', hidden_statuses: ['failed'], include_archived: false });
    expect(reads).toEqual([]);
    expect(cached.nodes.find(row => row.id === root.id).resources.subtree).toMatchObject({ input: 40, incomplete: false });
    fs.appendFileSync(hiddenFile, '\n'); reads.length = 0;
    const stale = await f.project.taskGraph({ scope: 'tree', hidden_statuses: ['failed'], include_archived: false });
    expect(reads).not.toContain(hiddenFile); expect(reads).not.toContain(archivedFile); expect(reads).not.toContain(retiredFile);
    expect(stale.nodes.find(row => row.id === root.id).resources.subtree.incomplete).toBe(true);
  } finally { fs.createReadStream = read; await f.close(); }
});

test('RPC rejects unknown parameters, malformed filters, and malformed cursors before heavy reads', async () => {
  const f = fixture();
  try {
    const dispatcher = new Dispatcher(f.project, { request() {} });
    for (const params of [{ bogus: true }, { details: 0 }, { include_archived: 0 }, { scope: 'bad' }, { scope: null }, { hidden_statuses: null },
      { hidden_statuses: ['bogus'] }, { hidden_statuses: ['failed', 'failed'] }, { hidden_statuses: [1] },
      { cursor: '' }, { cursor: 1 }, { cursor: 'a'.repeat(1025) }, { cursor: 'not-a-cursor' }]) {
      await expect(dispatcher.dispatch('worker.graph', params)).rejects.toThrow();
    }
  } finally { await f.close(); }
});
