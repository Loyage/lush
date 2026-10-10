import { test, expect, setDefaultTimeout } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, until } from '../helpers.js';
import { setup, fetch } from './harness.js';
setDefaultTimeout(20000);

const get = async (f, route) => (await fetch(f.url + route)).json();
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url },
    body: JSON.stringify({ method, params }) });
  const value = await response.json(); expect(response.status).toBe(status); return value;
}
async function configure(f, enabled, level) {
  const catalogue = await get(f, '/api/hooks');
  return post(f, 'hooks.completion_defaults', { enabled, level, expected_revision: catalogue.completion_defaults.revision });
}
function publicOnly(value, authorization) {
  const json = JSON.stringify(value);
  expect(json).not.toContain('"authorization"'); expect(json).not.toContain('"executions"');
  if (authorization) expect(json).not.toContain(authorization);
}

for (const level of ['off', 'merge', 'accept', 'archive']) test(`real HTTP device defaults ${level} authorize only new orders and run the correct completion stages`, async () => {
  const f = await setup(); let calls = 0;
  try {
    await repo(f.root);
    f.project.provider = { resolve() { return { agent: 'mock' }; }, async run({ task }) {
      calls++; fs.writeFileSync(path.join(task.workspace, 'default-result.txt'), 'controlled default result');
      await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'default-authorized result'); return 'done';
    } };
    const { task: existing } = await post(f, 'order.submit', { content: 'existing order', start: false });
    const selected = level === 'off' ? 'archive' : level;
    const result = await configure(f, level !== 'off', selected);
    expect(result.completion_defaults).toMatchObject({ version: 1, enabled: level !== 'off', level: selected });
    expect((await get(f, `/api/worker/${existing.id}/hooks`)).completion.level).toBe('off');
    const { task } = await post(f, 'order.submit', { content: `new default ${level}`, start: false });
    publicOnly(task);
    expect((await get(f, `/api/worker/${task.id}/hooks`)).completion.level).toBe(level);
    const original = f.store.task(task.id).auto_merge;
    // Saving a different device default must neither revoke nor raise this order's saved authorization.
    await configure(f, level === 'off', level === 'off' ? 'accept' : 'merge');
    expect(f.store.task(task.id).auto_merge).toBe(original);
    expect(calls).toBe(0);
    await post(f, 'worker.resume', { id: task.id });
    const desired = level === 'off' ? 'waiting' : level === 'merge' ? 'awaiting_acceptance' : 'completed';
    await until(() => f.store.task(task.id).status === desired && !f.project.running.has(task.id)
      && !f.project.taskMergeBusy?.size && !f.project.completionQueued?.size
      && (level !== 'archive' || f.store.branch(task.branch).status === 'archived'), 15000);
    const history = f.store.history(task.id), merged = history.find(item => item.type === 'task.merge_integrated');
    const accepted = history.find(item => item.type === 'task.accepted'), archived = history.find(item => item.type === 'branch.archive');
    expect(Boolean(merged)).toBe(level !== 'off'); expect(Boolean(accepted)).toBe(['accept', 'archive'].includes(level));
    expect(Boolean(archived)).toBe(level === 'archive');
    if (accepted) { expect(accepted.id).toBeGreaterThan(merged.id); expect(accepted.data.via).toBe('completion_hook'); }
    if (archived) expect(archived.id).toBeGreaterThan(accepted.id);
    expect(calls).toBe(1); expect(fs.existsSync(task.workspace)).toBe(level !== 'archive');
    if (level !== 'off') expect(await git(f.root, 'show', 'main:default-result.txt')).toBe('controlled default result');
    const privateConfig = JSON.parse(f.store.task(task.id).auto_merge);
    for (const route of ['/api/hooks', `/api/worker/${task.id}`, `/api/worker/${task.id}/hooks`, '/api/worker-graph'])
      publicOnly(await get(f, route), privateConfig.completion?.authorization);
    const eventCount = history.length;
    await get(f, '/api/hooks'); f.project.scheduleTaskCompletion(task.id); await f.project.completionQueue;
    expect(f.store.history(task.id)).toHaveLength(eventCount);
  } finally { await f.close(); }
});

test('real HTTP defaults share the device policy revision and remain isolated between different devices', async () => {
  const a = await setup(), b = await setup();
  try {
    const before = await get(a, '/api/hooks'), other = await get(b, '/api/hooks');
    expect(before.completion_defaults).toMatchObject({ enabled: false, level: 'merge' });
    const changed = await configure(a, true, 'archive');
    expect(changed.revision).toBe(before.revision); expect(changed.daemon_hooks.revision).not.toBe(before.daemon_hooks.revision);
    expect(changed.daemon_hooks.mounts[0].enabled).toBe(false);
    expect(changed.completion_defaults.revision).not.toBe(before.completion_defaults.revision);
    for (const expected_revision of [before.completion_defaults.revision, before.revision, before.daemon_hooks.revision]) {
      const error = await post(a, 'hooks.completion_defaults', { enabled: false, level: 'merge', expected_revision }, 400);
      expect(error.error).toContain('revision');
    }
    expect((await get(a, '/api/hooks')).completion_defaults).toEqual(changed.completion_defaults);
    expect((await get(b, '/api/hooks')).completion_defaults).toEqual(other.completion_defaults);
    const disabled = await configure(a, false, 'archive');
    expect(disabled.completion_defaults).toMatchObject({ enabled: false, level: 'archive' });
  } finally { await a.close(); await b.close(); }
});
