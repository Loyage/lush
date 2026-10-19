import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';

test('confirmed subtree deletion removes its CLI histories and retains unrelated history and the shared key', async () => {
  const f = fixture(); await repo(f.root); f.project.kick = () => {};
  try {
    const task = (await f.project.order('CLI history deletion', null, [], null, false)).task;
    const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: task.id, goal: 'child history' });
    const sibling = f.store.create({ role: 'agent', task_kind: 'order', goal: 'unrelated history' });
    for (const row of [task, child, sibling]) f.store.update(row.id, { status: 'failed' });
    const directory = path.join(f.config.home, 'worker-cli-history'); fs.mkdirSync(directory, { mode: 0o700 });
    const file = path.join(directory, `${task.id}.json`), childFile = path.join(directory, `${child.id}.json`), siblingFile = path.join(directory, `${sibling.id}.json`);
    const key = path.join(f.config.home, 'worker-cli-history.key');
    fs.writeFileSync(file, 'opaque encrypted history'); fs.writeFileSync(childFile, 'child ciphertext');
    fs.writeFileSync(siblingFile, 'other ciphertext'); fs.writeFileSync(key, 'shared secret key', { mode: 0o600 });
    const preview = await f.project.deleteTaskPreview(task.id);
    expect(preview.can_delete).toBe(true);
    const result = await f.project.deleteTask(task.id, { confirm: true, revision: preview.revision });
    expect(result.deleted.ids).toEqual([task.id, child.id]);
    expect(fs.existsSync(file)).toBe(false); expect(fs.existsSync(childFile)).toBe(false);
    expect(fs.readFileSync(siblingFile, 'utf8')).toBe('other ciphertext');
    expect(fs.readFileSync(key, 'utf8')).toBe('shared secret key');
    expect(f.store.task(sibling.id).goal).toBe('unrelated history');
  } finally { await f.close(); }
});
