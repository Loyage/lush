import { test, expect } from 'bun:test';
import { repo } from '../helpers.js';
import { setup, fetch } from './harness.js';
import { historicalConvergencePolicy } from '../convergence-fixtures.js';

async function get(f, suffix) {
  const response = await fetch(f.url + suffix), value = await response.json();
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); return value;
}
async function action(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const value = await response.json(); expect(response.status, value.error).toBe(status); return value;
}
const policy = (f, branch) => get(f, `/api/branch-convergence?branch=${encodeURIComponent(branch)}`);
const defaults = f => get(f, '/api/branch-convergence/defaults');
const hooks = (f, id) => get(f, `/api/worker/${id}/hooks`);
const order = async (f, content) => (await action(f, 'order.submit', { content, branch: 'main', start: false })).task;
async function fixture() {
  const f = await setup(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {}; f.project.scheduleConvergence = () => {};
  f.project.provider = { run() { throw new Error('automation integration must not call a model'); } };
  try { await repo(f.root); const main = await f.project.bootstrapMain(); return { ...f, main }; }
  catch (error) { await f.close(); throw error; }
}
const evidence = f => JSON.stringify({ meta: f.store.all('SELECT * FROM meta ORDER BY key'), events: f.store.all('SELECT * FROM events ORDER BY id') });

test('HTTP automation reads preserve historical policy and reject every continuous write without reinstallation', async () => {
  const f = await fixture();
  try {
    expect(await policy(f, 'main')).toMatchObject({ mounted: false, enabled: false, retired: true, editable: false });
    historicalConvergencePolicy(f, f.main);
    const current = await policy(f, 'main'), before = evidence(f);
    expect(current).toMatchObject({ mounted: true, enabled: true, retired: true, editable: false });
    for (const [mounted, enabled] of [[true,true],[true,false],[false,false]]) {
      expect((await action(f, 'branch.convergence_set', { branch: 'main', mounted, enabled, expected_revision: current.revision }, 400)).error).toContain('retired');
    }
    expect((await hooks(f, f.main.id)).convergence).toEqual(current);
    expect((await get(f, `/api/worker/${f.main.id}`)).hooks.convergence).toEqual(current);
    const list = await get(f, '/api/branch-convergence'); expect(list.items.find(item => item.branch === 'main')).toEqual(current);
    expect(list.defaults).toEqual(await defaults(f));
    await f.project.bootstrapMain();
    expect(await policy(f, 'main')).toEqual(current); expect(evidence(f)).toBe(before);
  } finally { await f.close(); }
});

test('persisted historical defaults remain readable but never attach policies to new order/child or alter completion authorization', async () => {
  const f = await fixture();
  try {
    expect(await defaults(f)).toMatchObject({ mounted: false, scope: 'none', enabled: false, retired: true, editable: false });
    const old = await order(f, 'before historical defaults');
    const saved = JSON.stringify({ version: 1, mounted: true, scope: 'user', enabled: true, generation: 7 });
    f.store.run('INSERT INTO meta(key,value) VALUES (?,?)', 'convergence_defaults:v1', saved);
    const original = await defaults(f);
    expect(original).toMatchObject({ mounted: true, enabled: true, retired: true, editable: false });
    expect((await action(f, 'branch.convergence_defaults_set', { mounted: false, enabled: false, expected_revision: original.revision }, 400)).error).toContain('retired');
    const parent = await order(f, 'after historical defaults');
    const child = await f.project.spawn(parent.id, 'child target defaults', undefined, [], 'target-defaults');
    for (const task of [old, parent, child]) expect(await policy(f, task.branch)).toMatchObject({ mounted: false, enabled: false, retired: true });
    expect((await hooks(f, parent.id)).completion.level).toBe('off');
    expect((await hooks(f, child.id)).completion).toMatchObject({ level: 'merge', locked: true, editable: false });
    expect(f.store.get('SELECT value FROM meta WHERE key=?', 'convergence_defaults:v1').value).toBe(saved);
    expect(await defaults(f)).toEqual(original);
    expect(f.store.get("SELECT count(*) AS n FROM tasks WHERE task_kind='integration'").n).toBe(0);
  } finally { await f.close(); }
});
