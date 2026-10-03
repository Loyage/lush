import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git } from '../helpers.js';
import { setup, fetch } from './harness.js';

const post = (url, params, headers = {}, method = 'worker.delete') => fetch(url + '/api/action', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ method, params }),
});

test('delete HTTP endpoints retain login, Origin, exact parameters and explicit confirmation gates', async () => {
  const f = await setup({ auth: { username: 'owner', password: 'test-only-password' } });
  const calls = [], revision = 'resource-revision';
  f.project.deleteTaskPreview = id => { calls.push(['preview', id]); return { id, revision, can_delete: true }; };
  f.project.deleteTask = (id, options) => { calls.push(['delete', id, options]); return { deleted: { ids: [id] } }; };
  try {
    expect((await fetch(f.url + '/api/worker/7/delete-preview')).status).toBe(401);
    expect((await post(f.url, { id: 7, revision, confirm: true })).status).toBe(401);
    const login = await fetch(f.url + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=owner&password=test-only-password&next=%2F' });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(f.url + '/api/worker/7/delete-preview', { headers: { Cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ id: 7, revision, can_delete: true });
    for (const suffix of ['?confirm=true','?revision=x','?_token=forged','?path=/etc','?id=8'])
      expect((await fetch(f.url + '/api/worker/7/delete-preview' + suffix, { headers: { Cookie } })).status).toBe(400);
    for (const params of [{ id: 7 }, { id: 7, confirm: true }, { id: 7, revision, confirm: false },
      { id: 7, revision, confirm: true, force: true }, { id: 7, revision, confirm: true, _token: 'forged' }])
      expect((await post(f.url, params, { Cookie })).status).toBe(400);
    expect((await post(f.url, { id: 7 }, { Cookie }, 'worker.delete_preview')).status).toBe(400);
    expect((await post(f.url, { id: 7, revision, confirm: true }, { Cookie, Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await fetch(f.url + '/api/worker/7/delete-preview', { headers: { Cookie, Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await fetch(f.url + '/api/task/7/delete-preview', { headers: { Cookie } })).status).toBe(404);
    expect(calls).toEqual([['preview', 7]]);
    const deletion = await post(f.url, { id: 7, revision, confirm: true }, { Cookie });
    expect(deletion.status).toBe(200);
    expect(await deletion.json()).toEqual({ deleted: { ids: [7] } });
    expect(calls.at(-1)).toEqual(['delete', 7, { confirm: true, revision }]);
  } finally { await f.close(); }
});

test('HTTP deletion clears a real temporary Git subtree, original Input and exclusive sessions after confirmation', async () => {
  const f = await setup();
  f.project.stopping = true; // No provider invocation; real resources, not mocked cleanup.
  try {
    await repo(f.root);
    const { task } = await f.project.order('mistyped input');
    const child = await f.project.spawn(task.id, 'unwanted child', undefined, [], 'typo-child');
    const cwd = f.store.task(child.id).workspace;
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'unmerged implementation');
    await git(cwd, 'add', 'file.txt'); await git(cwd, 'commit', '-m', 'unwanted implementation');
    fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'discard on final confirmation');
    const sessions = path.join(f.config.home, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
    const owned = path.join(sessions, `test_lush-task-${child.id}.jsonl`);
    const unrelated = path.join(sessions, `test_lush-task-${child.id + 100}.jsonl`);
    fs.writeFileSync(owned, 'exclusive history'); fs.writeFileSync(unrelated, 'keep');
    const active = await (await fetch(f.url + `/api/worker/${task.id}/delete-preview`)).json();
    expect(active.can_delete).toBe(false); expect(active.blockers.join(' ')).toContain('cancel');
    expect((await post(f.url, { id: task.id, confirm: true, revision: active.revision })).status).toBe(400);
    expect((await post(f.url, { id: task.id }, {}, 'worker.cancel')).status).toBe(200);
    const preview = await (await fetch(f.url + `/api/worker/${task.id}/delete-preview`)).json();
    expect(preview.can_delete).toBe(true);
    expect(preview.workers.map(row => row.id)).toEqual([task.id, child.id]);
    expect(preview.inputs.map(row => row.id)).toEqual([task.input_id]);
    expect(preview.resources.worktrees).toContain(cwd); expect(preview.resources.files).toContain(owned);
    expect((await post(f.url, { id: task.id, revision: preview.revision })).status).toBe(400);
    expect(fs.existsSync(cwd)).toBe(true);
    const response = await post(f.url, { id: task.id, revision: preview.revision, confirm: true });
    expect(response.status).toBe(200);
    expect((await response.json()).deleted.ids).toEqual([task.id, child.id]);
    for (const file of [...preview.resources.worktrees, ...preview.resources.files]) expect(fs.existsSync(file)).toBe(false);
    for (const branch of preview.resources.branches) expect(await git(f.root, 'branch', '--list', branch)).toBe('');
    for (const id of [task.id, child.id]) expect(f.store.get('SELECT id FROM tasks WHERE id=?', id)).toBeNull();
    expect(f.store.get('SELECT id FROM inputs WHERE id=?', task.input_id)).toBeNull();
    expect((await fetch(f.url + `/api/worker/${task.id}/delete-preview`)).status).toBe(400);
    expect((await (await fetch(f.url + '/api/inputs?q=mistyped')).json()).items).toEqual([]);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(await git(f.root, 'show', 'main:file.txt')).toBe('base');
    expect(f.store.nextTaskId()).toBeGreaterThan(child.id);
  } finally { await f.close(); }
}, 15000);

test('HTTP stale resource revision refuses without side effects and a fresh preview can delete', async () => {
  const f = await setup(); f.project.stopping = true;
  try {
    await repo(f.root);
    const { task } = await f.project.order('typo');
    f.project.cancel(task.id);
    const preview = await (await fetch(f.url + `/api/worker/${task.id}/delete-preview`)).json();
    const file = path.join(task.workspace, 'late.txt'); fs.writeFileSync(file, 'new work after preview');
    const stale = await post(f.url, { id: task.id, revision: preview.revision, confirm: true });
    expect(stale.status).toBe(400); expect((await stale.json()).error).toContain('changed');
    expect(fs.existsSync(file)).toBe(true); expect(f.store.task(task.id).status).toBe('cancelled');
    const fresh = await (await fetch(f.url + `/api/worker/${task.id}/delete-preview`)).json();
    expect(fresh.revision).not.toBe(preview.revision);
    const deleted = await post(f.url, { id: task.id, revision: fresh.revision, confirm: true });
    expect(deleted.status).toBe(200); expect(fs.existsSync(task.workspace)).toBe(false);
  } finally { await f.close(); }
}, 15000);
