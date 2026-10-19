import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo } from '../helpers.js';

async function setup() {
  const f = fixture(); await repo(f.root); f.project.kick = () => {};
  const task = (await f.project.order('CLI history deletion', null, [], null, false)).task;
  f.store.update(task.id, { status: 'failed' });
  const directory = path.join(f.config.home, 'worker-cli-history');
  fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, `${task.id}.json`);
  fs.writeFileSync(file, 'opaque encrypted history', { mode: 0o600 });
  return { ...f, task, directory, file };
}

test('confirmed subtree deletion removes only its CLI history and retains other histories and the shared key', async () => {
  const f = await setup();
  try {
    const child = f.store.create({ role: 'agent', task_kind: 'child', parent_id: f.task.id, goal: 'child history' });
    const sibling = f.store.create({ role: 'agent', task_kind: 'order', goal: 'unrelated history' });
    f.store.update(child.id, { status: 'failed' }); f.store.update(sibling.id, { status: 'failed' });
    const childFile = path.join(f.directory, `${child.id}.json`), siblingFile = path.join(f.directory, `${sibling.id}.json`);
    const key = path.join(f.config.home, 'worker-cli-history.key');
    const temporary = path.join(f.directory, `${f.task.id}.json.${'a'.repeat(32)}.tmp`);
    const siblingTemporary = path.join(f.directory, `${sibling.id}.json.${'b'.repeat(32)}.tmp`);
    const unrelated = path.join(f.directory, `${f.task.id}xjsonx${'c'.repeat(32)}xtmp`);
    for (const file of [temporary, siblingTemporary, unrelated]) fs.writeFileSync(file, 'crash residue');
    fs.writeFileSync(childFile, 'child ciphertext'); fs.writeFileSync(siblingFile, 'other ciphertext');
    fs.writeFileSync(key, 'shared secret key', { mode: 0o600 });
    const preview = await f.project.deleteTaskPreview(f.task.id);
    expect(preview.blockers).toEqual([]); expect(preview.can_delete).toBe(true);
    expect(preview.resources.files).toContain(f.file); expect(preview.resources.files).toContain(childFile);
    expect(preview.resources.files).not.toContain(siblingFile); expect(preview.resources.files).not.toContain(key);
    expect(preview.resources.files).toContain(temporary);
    expect(preview.resources.files).not.toContain(siblingTemporary); expect(preview.resources.files).not.toContain(unrelated);
    const result = await f.project.deleteTask(f.task.id, { confirm: true, revision: preview.revision });
    expect(result.deleted.ids).toEqual([f.task.id, child.id]);
    expect(fs.existsSync(f.file)).toBe(false); expect(fs.existsSync(childFile)).toBe(false);
    expect(fs.existsSync(temporary)).toBe(false);
    expect(fs.readFileSync(siblingTemporary, 'utf8')).toBe('crash residue');
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('crash residue');
    expect(fs.readFileSync(siblingFile, 'utf8')).toBe('other ciphertext');
    expect(fs.readFileSync(key, 'utf8')).toBe('shared secret key');
    expect(f.store.task(sibling.id).goal).toBe('unrelated history');
  } finally { await f.close(); }
});

test('history changes invalidate deletion confirmation before resources are removed', async () => {
  const f = await setup();
  try {
    const preview = await f.project.deleteTaskPreview(f.task.id);
    expect(preview.can_delete).toBe(true);
    fs.appendFileSync(f.file, 'changed');
    await expect(f.project.deleteTask(f.task.id, { confirm: true, revision: preview.revision })).rejects.toThrow('changed');
    expect(fs.existsSync(f.task.workspace)).toBe(true); expect(fs.existsSync(f.file)).toBe(true);
    expect(f.store.task(f.task.id).status).toBe('failed');
  } finally { await f.close(); }
});

for (const target of ['file', 'directory', 'temporary']) test(`deletion refuses a CLI history ${target} symlink without following it`, async () => {
  const f = await setup();
  try {
    const outside = path.join(f.root, 'outside-history');
    if (target !== 'directory') {
      const linked = target === 'file' ? f.file : path.join(f.directory, `${f.task.id}.json.${'a'.repeat(32)}.tmp`);
      fs.writeFileSync(outside, 'do not delete');
      if (target === 'file') fs.unlinkSync(f.file);
      fs.symlinkSync(outside, linked);
    } else {
      fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, `${f.task.id}.json`), 'do not delete');
      fs.rmSync(f.directory, { recursive: true }); fs.symlinkSync(outside, f.directory);
    }
    const preview = await f.project.deleteTaskPreview(f.task.id);
    expect(preview.can_delete).toBe(false); expect(preview.blockers.join(' ')).toContain('symlink');
    await expect(f.project.deleteTask(f.task.id, { confirm: true, revision: preview.revision })).rejects.toThrow('symlink');
    expect(fs.readFileSync(target !== 'directory' ? outside : path.join(outside, `${f.task.id}.json`), 'utf8')).toBe('do not delete');
  } finally { await f.close(); }
});

test('direct deletion preview and execution block while a CLI or its dispatched effect retains the lease', async () => {
  const f = await setup();
  try {
    const before = await f.project.deleteTaskPreview(f.task.id); expect(before.can_delete).toBe(true);
    f.project.cliRunning = new Map([['controlled', { taskId: f.task.id }]]);
    const busy = await f.project.deleteTaskPreview(f.task.id);
    expect(busy.can_delete).toBe(false); expect(busy.blockers.join(' ')).toContain('CLI execution');
    await expect(f.project.deleteTask(f.task.id, { confirm: true, revision: before.revision })).rejects.toThrow('CLI execution');
    expect(fs.existsSync(f.file)).toBe(true); expect(fs.existsSync(f.task.workspace)).toBe(true);
  } finally { f.project.cliRunning?.clear(); await f.close(); }
});
