import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, gate } from '../helpers.js';
import { RPCServer } from '../../src/rpc/server.js';
import { RPCClient } from '../../src/rpc/client.js';
import { Dispatcher } from '../../src/rpc/dispatcher.js';
import { createSignal } from '../../src/signal.js';
import { UsageIndex } from '../../src/core/usage-index.js';
import { readCompactUsageFile } from '../../src/core/usage-statistics.js';

function save(config, id, input) {
  const dir = path.join(config.home, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rpc_lush-task-${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'message', lush: { task_id: id },
    message: { role: 'assistant', usage: { input, output: 1, cost: { total: .2 } } } }) + '\n'); return file;
}

test('real worker.graph bridge returns known first-batch subtotal, automatic backfill includes archived/hidden/off-page descendants, restart reuses index', async () => {
  const f = fixture(), entered = gate(), release = gate(); await repo(f.root);
  const original = fs.createReadStream; let reads = [], blocked = false, rpc;
  try {
    const main = await f.project.ensureMainTask(); save(f.config, main.id, 5);
    const hidden = f.store.create({ role: 'agent', task_kind: 'child', parent_id: main.id, goal: 'hidden old expense' });
    f.store.update(hidden.id, { status: 'failed' }); const hiddenFile = save(f.config, hidden.id, 10);
    const archived = f.store.create({ role: 'agent', task_kind: 'child', parent_id: main.id, goal: 'archived expense' });
    f.store.update(archived.id, { status: 'completed', branch: 'archived' });
    f.store.recordBranch({ branch: 'archived' }); f.store.markBranchArchived('archived');
    const archivedFile = save(f.config, archived.id, 20);
    const offpage = f.store.create({ role: 'agent', task_kind: 'child', parent_id: hidden.id, goal: 'offpage expense' });
    f.store.update(offpage.id, { status: 'completed' }); const offpageFile = save(f.config, offpage.id, 30);
    f.store.transaction(() => {
      for (let i = 0; i < 205; i++) {
        const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: main.id, goal: 'new no expense' });
        f.store.update(child.id, { status: 'completed' });
      }
    });
    f.project.usageIndex = new UsageIndex(f.config, { intervalMs: 100000, batchSize: 1, parse: async (file, stat) => {
      if (file === hiddenFile && !blocked) { blocked = true; entered.resolve(); await release.promise; }
      return readCompactUsageFile(file, stat);
    } });
    rpc = new RPCServer(f.config.socket, new Dispatcher(f.project, createSignal(), {})); await rpc.start();
    const client = new RPCClient(f.config.socket, 10);
    const options = { scope: 'tree', include_archived: false, hidden_statuses: ['failed'] };
    fs.createReadStream = function(file, ...args) { reads.push(file); return original.call(this, file, ...args); };
    const before = f.store.get('SELECT count(*) AS n FROM events').n;
    const summary = await client.request('worker.graph', { ...options, details: false });
    expect(summary.nodes.find(n => n.id === main.id).resources).toBeNull(); expect(reads).toEqual([]);
    const first = await client.request('worker.graph', options);
    expect(first.has_more).toBe(true);
    expect(first.nodes.find(n => n.id === main.id).resources.subtree).toMatchObject({ input: 5, cost: .2,
      known_tokens: 1, known_cost: 1, pending_files: 3, incomplete: true });
    expect(reads).toEqual([path.join(f.config.home, 'sessions', `rpc_lush-task-${main.id}.jsonl`)]);
    expect(first.nodes.some(n => [hidden.id, archived.id, offpage.id].includes(n.id))).toBe(false);
    // recover is the actual daemon startup wiring, not an Agent polling loop.
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(before);
    f.project.recover(); await entered.promise;
    const recoveredFacts = f.store.get('SELECT count(*) AS n FROM events').n;
    const backfill = f.project.usageIndex.refresh(); release.resolve(); await backfill;
    expect(reads).toContain(hiddenFile); expect(reads).toContain(archivedFile); expect(reads).toContain(offpageFile);
    reads = [];
    const full = await client.request('worker.graph', options);
    expect(full.nodes.find(n => n.id === main.id).resources.subtree).toMatchObject({ input: 65, output: 4, cost: .8,
      known_tokens: 4, known_cost: 4, pending_files: 0, incomplete: false });
    expect(reads).toEqual([]);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(recoveredFacts);
    await f.project.usageIndex.stop();
    f.project.usageIndex = new UsageIndex(f.config, { parse: () => { throw new Error('restart must not parse valid summaries'); } });
    await f.project.usageIndex.refresh();
    const restarted = await client.request('worker.graph', options);
    expect(restarted.nodes.find(n => n.id === main.id).resources.subtree).toMatchObject({ input: 65, pending_files: 0, incomplete: false });
    expect(reads).toEqual([]);
    // New/changed off-page history is admitted by the next background reconciliation, not by graph requests.
    fs.appendFileSync(hiddenFile, JSON.stringify({ type: 'message', lush: { task_id: hidden.id },
      message: { role: 'assistant', usage: { input: 9 } } }) + '\n');
    const stale = await client.request('worker.graph', options);
    expect(stale.nodes.find(n => n.id === main.id).resources.subtree).toMatchObject({ input: 55,
      pending_files: 1, known_tokens: 3, known_cost: 3, incomplete: true });
    expect(reads).toEqual([]);
    f.project.usageIndex.parse = readCompactUsageFile; await f.project.usageIndex.refresh();
    const updated = await client.request('worker.graph', options);
    expect(updated.nodes.find(n => n.id === main.id).resources.subtree).toMatchObject({ input: 74,
      known_tokens: 5, known_cost: 4, unknown_tokens: 0, unknown_cost: 1, pending_files: 0, incomplete: false });
    expect(reads).toEqual([hiddenFile]);
    await expect(client.request('worker.graph', { ...options, _token: 'expired-token' })).rejects.toThrow();
  } finally {
    release.resolve(); fs.createReadStream = original; await rpc?.close(); await f.close();
    fs.rmSync(f.config.socket, { force: true });
  }
});
