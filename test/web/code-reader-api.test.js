import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo } from '../helpers.js';
import { setup, fetch } from './harness.js';

test('code HTTP reader lists unchanged files and reads actual workspace content and diff through RPC', async () => {
  const f = await setup(); f.project.stopping = true; await repo(f.root);
  const read = async (id, route) => {
    const response = await fetch(`${f.url}/api/worker/${id}/${route}`);
    expect(response.status).toBe(200); return response.json();
  };
  try {
    const { task } = await f.project.order('read code', 'main', [], null, false);
    const clean = await read(task.id, 'code-state');
    expect(clean.availability).toBe('available'); expect(clean.summary.changed_total).toBe(0);
    expect((await read(task.id, 'code-tree')).entries.map(row => row.path)).toContain('file.txt');
    expect((await read(task.id, 'code-file?path=file.txt&view=content')).content.text).toBe('base\n');
    // The same real user read boundary exposes a child's persisted creation
    // endpoint even before it has commits or any successful delivery.
    const child = await f.project.spawn(task.id, 'undelivered code child');
    const lineage = await read(task.id, 'version-lineage?limit=1');
    expect(lineage.origin.commit).toBe(task.base_commit);
    expect(lineage.child_branches).toEqual([{ worker: { id: child.id, worker_number: child.worker_number },
      origin: { commit: task.base_commit, page: 0, cursor: null, available: true, reason: null }, deliveries: [] }]);
    expect((await read(task.id, `version-lineage-commit?snapshot=${encodeURIComponent(lineage.snapshot)}&commit=${task.base_commit}`)).commit.commit).toBe(task.base_commit);
    fs.writeFileSync(path.join(task.workspace, 'file.txt'), 'edited\n');
    const changed = await read(task.id, 'code-state');
    expect(changed.files[0]).toMatchObject({ path: 'file.txt', status: 'M', unstaged: true });
    const diff = await read(task.id, 'code-file?path=file.txt');
    expect(diff.diff.hunks[0].lines).toContainEqual({ kind: 'delete', text: 'base', old_line: 1, new_line: null });
    expect(diff.diff.hunks[0].lines).toContainEqual({ kind: 'add', text: 'edited', old_line: null, new_line: 1 });
    expect((await read(task.id, 'code-file?path=file.txt&view=content')).content.text).toBe('edited\n');
  } finally { await f.close(); }
});
