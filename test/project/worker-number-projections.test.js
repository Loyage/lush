import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../helpers.js';
import { install } from './agent-connection-fixture.js';

function numberedRoot(f) {
  f.store.create({ role: 'worker', goal: 'historical' });
  const inputId = f.store.nextInputId();
  f.store.run('INSERT INTO inputs(id,content) VALUES (?,?)', inputId, 'numbered');
  return f.store.create({ role: 'agent', task_kind: 'order', input_id: inputId, goal: 'numbered' });
}
const child = (f, parent, extra = {}) => f.store.create({ parent_id: parent.id, input_id: parent.input_id,
  role: 'agent', task_kind: 'child', goal: 'child', ...extra });

function usageFile(f, taskId, runId) {
  const dir = path.join(f.config.home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `sample_lush-task-${taskId}.jsonl`), JSON.stringify({ type: 'message',
    timestamp: '2026-01-01T00:00:01.000Z', lush: { task_id: taskId, run_id: runId, role: 'agent' },
    message: { role: 'assistant', usage: { input: 10, output: 3, totalTokens: 13, cost: { total: 0.2 } } } }) + '\n');
}

test('existing usage attribution exposes nullable labels for tasks and invocations without changing integer identities or totals', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const root = numberedRoot(f), deep = child(f, child(f, root));
    const old = f.store.create({ role: 'agent', task_kind: 'order', input_id: null, goal: 'legacy' });
    expect(root.id).not.toBe(root.input_id);
    for (const taskId of [deep.id, old.id, 987654]) usageFile(f, taskId, taskId + 100);
    const result = await f.project.usageStatistics({});
    expect(result.totals.requests).toBe(3);
    for (const rows of [result.tasks, result.invocations]) {
      expect(rows.find(row => row.task_id === deep.id)).toMatchObject({ task_id: deep.id, task_worker_number: deep.worker_number });
      expect(rows.find(row => row.task_id === old.id).task_worker_number).toBeNull();
      expect(rows.find(row => row.task_id === 987654).task_worker_number).toBeNull();
    }
    expect(result.invocations.find(row => row.task_id === deep.id).run_id).toBe(deep.id + 100);
    // The cached session rows must not cache a stale live Worker association after deletion.
    f.store.hardDeleteTasks([deep.id]);
    const deleted = await f.project.usageStatistics({});
    expect(deleted.totals).toEqual(result.totals);
    expect(deleted.tasks.find(row => row.task_id === deep.id).task_worker_number).toBeNull();
    expect(deleted.invocations.find(row => row.task_id === deep.id).task_worker_number).toBeNull();
  } finally { await f.close(); }
});

test('live connection consumers expose deep Worker numbers and null for historical or missing associations, without guessing', async () => {
  const f = fixture(); f.project.stopping = true;
  const { manager, service } = install(f);
  try {
    const root = numberedRoot(f), deep = child(f, child(f, root));
    const old = f.store.create({ role: 'agent', goal: 'legacy' });
    const binding = { id: 'conn-one', ...manager.identity('conn-one') };
    for (const taskId of [deep.id, old.id, 987654]) f.project.running.set(taskId, {
      agent: { model: 'deepseek/chat' }, connectionBinding: binding, controller: new AbortController() });
    expect(service.list().connections[0].consumers).toEqual([
      { task_id: deep.id, task_worker_number: deep.worker_number, model: 'deepseek/chat' },
      { task_id: old.id, task_worker_number: null, model: 'deepseek/chat' },
      { task_id: 987654, task_worker_number: null, model: 'deepseek/chat' },
    ]);
    expect(manager.calls).toBe(0);
    f.store.hardDeleteTasks([deep.id]);
    expect(service.list().connections[0].consumers[0]).toMatchObject({ task_id: deep.id, task_worker_number: null });
  } finally { f.project.running.clear(); await f.close(); }
});

test('inspect retains historical verification and resolution lists with nullable Worker labels and verifier target labels', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const root = numberedRoot(f), deep = child(f, child(f, root));
    const target = f.store.create({ role: 'worker', goal: 'historical target' });
    // Seed only existing association facts; this does not restore a retired verifier creation API.
    const verification = child(f, deep, { verifies_task_id: target.id });
    const resolution = child(f, deep, { resolves_task_id: target.id });
    const oldVerification = f.store.create({ role: 'verifier', goal: 'old verification', verifies_task_id: target.id });
    const oldResolution = f.store.create({ role: 'merger', goal: 'old resolution', resolves_task_id: target.id });
    const before = f.store.task(target.id);
    const view = f.project.inspect(target.id);
    expect(view.verifications.find(row => row.id === verification.id)).toMatchObject({ id: verification.id, worker_number: verification.worker_number });
    expect(view.resolutions.find(row => row.id === resolution.id)).toMatchObject({ id: resolution.id, worker_number: resolution.worker_number });
    expect(view.verifications.find(row => row.id === oldVerification.id).worker_number).toBeNull();
    expect(view.resolutions.find(row => row.id === oldResolution.id).worker_number).toBeNull();
    const verifier = f.store.create({ role: 'verifier', goal: 'target association', verifies_task_id: deep.id });
    expect(f.project.inspect(verifier.id)).toMatchObject({ verifies_task_id: deep.id, verifies_task_worker_number: deep.worker_number });
    expect(f.project.inspect(oldVerification.id)).toMatchObject({ verifies_task_id: target.id, verifies_task_worker_number: null });
    const candidateVerifier = f.store.create({ role: 'verifier', goal: 'no target' });
    expect(f.project.inspect(candidateVerifier.id).verifies_task_worker_number).toBeNull();
    expect(f.store.task(target.id)).toEqual(before);
  } finally { await f.close(); }
});

test('historical specs still read by inspect carry associated numbers for the parent UI without changing stored records', async () => {
  const f = fixture(); f.project.stopping = true;
  try {
    const root = numberedRoot(f), deep = child(f, child(f, root));
    const planner = f.store.create({ role: 'planner', goal: 'historical planner' });
    const old = f.store.create({ role: 'worker', goal: 'historical work' });
    const numbered = f.store.addSpec({ planner_task_id: planner.id, goal: 'numbered association' });
    const historical = f.store.addSpec({ planner_task_id: planner.id, goal: 'historical association' });
    const missing = f.store.addSpec({ planner_task_id: planner.id, goal: 'missing association' });
    f.store.plannedSpec(numbered.id, deep.id);
    f.store.plannedSpec(historical.id, old.id);
    f.store.plannedSpec(missing.id, 987654);
    const stored = f.store.all('SELECT * FROM task_specs ORDER BY id');
    const rows = f.project.inspect(planner.id).specs;
    expect(rows.find(row => row.id === numbered.id)).toMatchObject({ id: numbered.id, task_id: deep.id, task_worker_number: deep.worker_number });
    expect(rows.find(row => row.id === historical.id).task_worker_number).toBeNull();
    expect(rows.find(row => row.id === missing.id).task_worker_number).toBeNull();
    expect(f.store.all('SELECT * FROM task_specs ORDER BY id')).toEqual(stored);
  } finally { await f.close(); }
});
