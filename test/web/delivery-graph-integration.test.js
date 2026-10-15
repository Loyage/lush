import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, gate, until } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { RPCClient } from '../../src/rpc/client.js';
import { PARAMS, USER_ONLY } from '../../src/rpc/registry.js';
import { historicalConvergencePolicy, pinHistoricalConvergence } from '../convergence-fixtures.js';

async function get(f, route) {
  const response = await fetch(f.url + route);
  const result = await response.json();
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
  expect(response.headers.get('cache-control')).toBe('no-store'); return result;
}
async function post(f, method, params) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const result = await response.json(); if (response.status !== 200) throw new Error(`${method}: ${JSON.stringify(result)}`); return result;
}
async function prepare() {
  const f = await setup();
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  f.project.provider = { run() { throw new Error('no paid model'); } };
  await repo(f.root); await f.project.bootstrapMain();
  // Historical read compatibility must not revive the retired setter.
  historicalConvergencePolicy(f, f.store.get("SELECT * FROM tasks WHERE task_kind='main'"));
  return f;
}
async function source(f, file, content) {
  const { task } = await post(f, 'order.submit', { content: `source ${content}`, branch: 'main', start: false });
  fs.writeFileSync(path.join(task.workspace, file), content + '\n');
  await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', content);
  f.store.update(task.id, { status: 'waiting', result: 'ready' });
  await post(f, 'worker.reserve', { id: task.id, kind: 'merge' });
  await pinHistoricalConvergence(f, task.id); return f.store.task(task.id);
}
const database = f => JSON.stringify(Object.fromEntries(['tasks','events','messages','notices','delivery_runs','delivery_nodes','delivery_members','meta'].map(table => [table, f.store.all(`SELECT * FROM ${table} ORDER BY rowid`)])));

test('delivery graph real authenticated HTTP -> RPC registry -> SQLite; shared source waiting and buffered inputs, successful history separated, no read side effects', async () => {
  const f = await prepare();
  try {
    expect(PARAMS['worker.delivery_graph']).toEqual(['history','cursor','limit']); expect(USER_ONLY.has('worker.delivery_graph')).toBe(true);
    const sources = [await source(f, 'file.txt', 'left'), await source(f, 'file.txt', 'right')];
    const run = await f.project.formConvergenceBatch(sources[0].parent_id);
    await f.project.prepareConvergenceRun(run.id, run.generation, new AbortController().signal);
    const node = f.store.get('SELECT * FROM delivery_nodes WHERE run_id=? AND helper_id IS NOT NULL', run.id);
    await post(f, 'worker.message', { id: sources[0].id, body: 'PRIVATE_BUFFERED_BODY' });
    f.store.update(sources[0].id, { retry_profile: JSON.stringify({ agent: 'pi', config_mode: 'pi', env: { PRIVATE_ENV: 'PRIVATE_SECRET' }, default_prompt: 'PRIVATE_PROMPT' }) });
    const independent = await source(f, 'independent.txt', 'independent');
    const landed = await f.project.formConvergenceBatch(independent.parent_id);
    await f.project.prepareConvergenceRun(landed.id, landed.generation, new AbortController().signal);
    // Persist a real helper pause without changing the resolving batch stage.
    f.store.update(node.helper_id, { status: 'paused' });
    const before = database(f);
    const refs = await git(f.root, 'show-ref');
    const gitRead = f.project.workspaces.git;
    f.project.workspaces.git = () => { throw new Error('delivery read must not query Git'); };
    const active = await get(f, '/api/worker-delivery-graph');
    expect(active).toMatchObject({ history: false, matched_total: 1, counts: { active: 1, history: 1, batches: 2, attention: 1 } });
    const item = active.items[0];
    expect(item).toMatchObject({ key: `batch:${run.id}`, kind: 'batch', run_id: run.id, generation: 1, stage: 'resolving', attention: true,
      target: { id: sources[0].parent_id, branch: 'main', missing: false }, member_count: 2 });
    expect(item.integration_workers.items[0]).toMatchObject({ id: node.helper_id, status: 'paused', missing: false });
    const view = item.sources[0].delivery_summary;
    expect(view).toMatchObject({ current: true, attention: true, run_id: run.id, blocked_code: 'integration_paused', input_queue: { buffered: 1 } });
    expect(view.waiting_reason).toContain('整合 Worker');
    expect((await get(f, `/api/worker/${sources[0].id}`)).delivery_summary).toEqual(view);
    expect((await get(f, '/api/worker-graph?details=0&scope=tree')).nodes.find(row => row.id === sources[0].id).delivery_summary).toEqual(view);
    const history = await get(f, '/api/worker-delivery-graph?history=1');
    expect(history.items.map(row => row.run_id)).toEqual([landed.id]);
    expect(history.items[0]).toMatchObject({ stage: 'integrated', attention: false, member_count: 1 });
    expect(history.counts.attention).toBe(1);
    const rpcRead = await new RPCClient(f.config.socket).request('worker.delivery_graph', { limit: 1 });
    expect(rpcRead).toMatchObject({ counts: { attention: 1 }, items: [{ key: item.key, attention: true }] });
    for (const word of ['PRIVATE_BUFFERED_BODY','PRIVATE_SECRET','PRIVATE_PROMPT','retry_profile','landing_receipt']) expect(JSON.stringify([active, history])).not.toContain(word);
    f.project.workspaces.git = gitRead;
    expect(await git(f.root, 'show-ref')).toBe(refs); expect(database(f)).toBe(before);
    expect(f.store.task(sources[0].id).parent_id).toBe(sources[0].parent_id);
    f.store.update(node.helper_id, { status: 'awaiting_acceptance' });
    expect(await get(f, '/api/worker-delivery-graph')).toMatchObject({ counts: { attention: 0 }, items: [{ attention: false, stage: 'resolving' }] });
    for (const query of ['history=true','history=0&history=1','limit=0','limit=51','limit=1.5','cursor=','profile=x','_token=x'])
      expect((await fetch(f.url + '/api/worker-delivery-graph?' + query)).status).toBe(400);
    expect((await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'worker.delivery_graph', params: {} }) })).status).toBe(400);
  } finally { await f.close(); }
});

test('real live provider invocation token cannot call user-only delivery graph; user RPC still succeeds', async () => {
  const f = await setup(), calls = [];
  f.project.provider = { run(ctx) { const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('aborted'), { once: true }); return done.promise; } };
  const client = new RPCClient(f.config.socket);
  try {
    await repo(f.root);
    const task = (await f.project.order('controlled permission check')).task;
    await until(() => calls.length === 1);
    const token = f.project.running.get(task.id).token;
    await expect(client.request('worker.delivery_graph', { _token: token })).rejects.toThrow('requires user approval');
    expect(await client.request('worker.delivery_graph')).toMatchObject({ version: 1, items: [], counts: { active: 0, attention: 0 } });
  } finally { await f.close(); }
});
