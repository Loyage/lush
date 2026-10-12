import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, gate } from '../helpers.js';
import { setup, fetch } from '../web/harness.js';

const revision = f => f.project.shortcutCommands().revision;
const drain = f => Promise.all([...f.project.shortcutCommandJobs ?? []]);
async function post(f, method, params, status = 200) {
  const response = await fetch(f.url + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });
  expect(response.status).toBe(status); return response.json();
}
async function history(f, id) {
  const response = await fetch(f.url + `/api/hooks/commands/executions?execution_id=${id}`);
  expect(response.status).toBe(200); return (await response.json()).items[0];
}
async function register(f, defaultWorkerId) {
  const definition = { name: 'HTTP prompt', kind: 'prompt', prompt: 'PRIVATE_HTTP_PROMPT', description: 'review', when_to_use: 'before delivery', tags: ['review'], examples: '', warnings: 'Agent cost', default_worker_id: defaultWorkerId };
  const saved = await post(f, 'hooks.command_save', { command: definition, expected_revision: revision(f) });
  return saved.commands.items.at(-1);
}
const authorize = (f, item, authorized) => post(f, 'hooks.command_authorize', { id: item.id, version: item.version, authorized, expected_revision: revision(f) });

test('real HTTP/RPC/core prompt definition, pure export, manual and Hook creation share typed identities and the selected parent tip', async () => {
  const f = await setup(); f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  try {
    await repo(f.root); await f.project.bootstrapMain();
    const parent = (await f.project.order('selected parent', 'main', [], null, false)).task;
    fs.writeFileSync(path.join(parent.workspace, 'new-parent-tip'), 'tip');
    await git(parent.workspace, 'add', '.'); await git(parent.workspace, 'commit', '-m', 'selected parent tip');
    const tip = await git(parent.workspace, 'rev-parse', 'HEAD'), item = await register(f, parent.id);
    expect(item).toMatchObject({ kind: 'prompt', authorized: false, description: 'review', default_worker_id: parent.id });
    const count = f.store.get('SELECT count(*) AS n FROM events').n, before = revision(f);
    const response = await fetch(f.url + `/api/hooks/commands/export?id=${item.id}&version=1`);
    expect(response.status).toBe(200); const exported = await response.json();
    expect(exported.filename).toBe(`shortcut-${item.id}-v1.md`); expect(exported.markdown).toContain('kind: "prompt"');
    expect(exported.markdown).toContain(item.prompt);
    expect(f.store.get('SELECT count(*) AS n FROM events').n).toBe(count); expect(revision(f)).toBe(before);
    await authorize(f, item, true);
    const accepted = await post(f, 'hooks.command_start', { id: item.id, version: 1, worker_id: parent.id, expected_revision: revision(f) });
    expect(accepted.execution).toMatchObject({ id: accepted.execution_id, kind: 'prompt', worker_id: parent.id, source: 'manual', created_worker_id: null });
    await drain(f); const manual = await history(f, accepted.execution_id);
    expect(manual).toMatchObject({ status: 'succeeded', kind: 'prompt', worker_id: parent.id });
    const created = f.store.task(manual.created_worker_id);
    expect(created).toMatchObject({ parent_id: parent.id, task_kind: 'order', target_branch: parent.branch, base_commit: tip, status: 'queued', retry_profile: null });
    expect(manual.created_worker_number).toBe(created.worker_number); expect(manual.input_id).toBe(created.input_id);
    await post(f, 'hooks.command_run', { id: item.id, version: 1, worker_id: parent.id, expected_revision: revision(f) }, 400);
    await post(f, 'worker.hook_attach', { id: parent.id, expected_revision: f.project.taskHooks(parent.id).revision,
      hook: { name: 'HTTP prompt once', trigger: 'worker.parent_ready', mode: 'once', enabled: true, actions: [{ type: 'prompt_command', command_id: item.id, command_version: 1 }] } });
    await Promise.resolve(); await f.project.hookQueue;
    const hook = f.project.shortcutCommandHistory().items.find(row => row.source === 'hook');
    expect(hook).toMatchObject({ kind: 'prompt', status: 'succeeded', worker_id: parent.id });
    expect(f.store.task(hook.created_worker_id)).toMatchObject({ parent_id: parent.id, target_branch: parent.branch, base_commit: tip, status: 'queued' });
    expect(hook.created_worker_id).not.toBe(created.id); expect(hook.input_id).not.toBe(manual.input_id);
    expect(JSON.stringify([manual, hook, f.store.all("SELECT * FROM events WHERE type LIKE 'shortcut.%' OR type LIKE 'hook.%'")])).not.toContain(item.prompt);
    f.project.observeTaskHooks(); await f.project.hookQueue;
    expect(f.project.shortcutCommandHistory().items.filter(row => row.source === 'hook')).toHaveLength(1);
  } finally { await f.close(); }
});

test('real HTTP prompt start returns before Git and rejects revoke/regrant without creating an Input or exposing prompt body', async () => {
  const f = await setup(), held = gate(); let queued;
  f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  try {
    await repo(f.root); const main = await f.project.bootstrapMain();
    const item = await register(f, main.id); await authorize(f, item, true);
    queued = f.project.workspaces.exclusive(() => held.promise);
    const accepted = await post(f, 'hooks.command_start', { id: item.id, version: 1, worker_id: main.id, expected_revision: revision(f) });
    expect(accepted.execution_id).toBeTruthy(); expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0);
    await authorize(f, item, false); await authorize(f, item, true);
    held.resolve(); await queued; await drain(f);
    const failed = await history(f, accepted.execution_id);
    expect(failed).toMatchObject({ kind: 'prompt', status: 'failed', created_worker_id: null, created_worker_number: null, input_id: null });
    expect(f.store.get('SELECT count(*) AS n FROM inputs').n).toBe(0); expect(JSON.stringify(failed)).not.toContain(item.prompt);
    expect(f.project.shortcutCommands().items.find(row => row.id === item.id).authorized).toBe(true);
  } finally { held.resolve(); await queued; await drain(f); await f.close(); }
});
