import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, git, repo } from '../helpers.js';
import { workerSnapshot } from '../../src/core/workspaces/worker-version-graph.js';

async function world(sha256 = false) {
  const f = fixture(); f.project.stopping = true; f.project.kick = () => {}; f.project.scheduleTaskMerge = () => {};
  if (sha256) {
    await git(f.root, 'init', '-b', 'main', '--object-format=sha256'); await git(f.root, 'config', 'user.name', 'Test');
    await git(f.root, 'config', 'user.email', 'test@example.invalid'); await git(f.root, 'commit', '--allow-empty', '-m', 'root');
  } else await repo(f.root);
  f.task = (await f.project.order('original order')).task;
  await git(f.task.workspace, 'commit', '--allow-empty', '-m', 'one'); f.one = await git(f.task.workspace, 'rev-parse', 'HEAD');
  await git(f.task.workspace, 'commit', '--allow-empty', '-m', 'two\n\noriginal body'); f.tip = await git(f.task.workspace, 'rev-parse', 'HEAD');
  return f;
}

test('current and lazy commit use sterile SHA-256 object reads, real parents, signed fixed range, no config/replace/graft/process injection', async () => {
  const f = await world(true), foreign = fixture();
  try {
    const tree = await git(f.root, 'rev-parse', `${f.tip}^{tree}`), replacement = await git(f.root, 'commit-tree', tree, '-m', 'fake root');
    await git(f.root, 'replace', f.tip, replacement); await git(f.task.workspace, 'notes', 'add', '-m', 'private note');
    fs.writeFileSync(path.join(f.root, '.git', 'info', 'grafts'), `${f.tip}\n`);
    await git(f.root, 'config', 'log.showSignature', 'true'); await git(f.root, 'config', 'core.fsmonitor', 'touch injected');
    const before = fs.readFileSync(path.join(f.root, '.git', 'config'), 'utf8');
    for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CONFIG']) f.config.env[key] = '/missing/injection';
    const first = await f.project.workerVersionGraph({ id: f.task.id, limit: 1 });
    expect(first.tip).toHaveLength(64); expect(first.commits[0].parents).toEqual([f.one]);
    const next = await f.project.workerVersionGraph({ id: f.task.id, cursor: first.cursor }); expect(next.commits[0].commit).toBe(f.one);
    const detail = await f.project.workerVersionCommit({ id: f.task.id, snapshot: first.snapshot, commit: f.tip });
    expect(detail.commit).toMatchObject({ parents: [f.one], message: 'two\n\noriginal body' });
    expect(JSON.stringify(detail)).not.toContain('private note'); expect(JSON.stringify(detail)).not.toContain('fake root');
    expect(() => workerSnapshot(foreign.project.workspaces, first.snapshot, f.task.id)).toThrow('expired');
    expect(fs.readFileSync(path.join(f.root, '.git', 'config'), 'utf8')).toBe(before); expect(fs.existsSync(path.join(f.root, 'injected'))).toBe(false);
  } finally { await f.close(); await foreign.close(); }
});

test('current refuses parent rewrites past fixed synchronization evidence; snapshot remains immutable, missing objects explicitly fail', async () => {
  const f = await world();
  try {
    await git(f.root, 'commit', '--allow-empty', '-m', 'other parent work'); const parent = await git(f.root, 'rev-parse', 'HEAD');
    await git(f.task.workspace, 'merge', 'main', '-m', 'sync'); const tip = await git(f.task.workspace, 'rev-parse', 'HEAD');
    f.store.event(f.task.id, 'task.parent_synced', { source_commit: f.tip, parent_commit: parent, head_commit: tip, parent_id: f.task.parent_id });
    const snapshot = await f.project.workerVersionGraph({ id: f.task.id, limit: 1 });
    await git(f.root, 'reset', '--hard', f.task.base_commit);
    await expect(f.project.workerVersionGraph({ id: f.task.id })).rejects.toThrow('parent ref no longer');
    expect((await f.project.workerVersionCommit({ id: f.task.id, snapshot: snapshot.snapshot, commit: tip })).commit.commit).toBe(tip);
    const object = path.join(f.root, '.git', 'objects', tip.slice(0, 2), tip.slice(2));
    fs.renameSync(object, object + '.saved');
    try {
      await expect(f.project.workerVersionCommit({ id: f.task.id, snapshot: snapshot.snapshot, commit: tip })).rejects.toThrow('Git');
      await expect(f.project.workerVersionGraph({ id: f.task.id, cursor: snapshot.cursor })).rejects.toThrow('Git');
    } finally { fs.renameSync(object + '.saved', object); }
  } finally { await f.close(); }
});

test('huge Worker/Input text is not fetched for compact graph; detail and evidence limits are explicit rather than silent truncation', async () => {
  const f = await world();
  try {
    f.store.run('UPDATE tasks SET goal=? WHERE id=?', 'g'.repeat(16385), f.task.id);
    f.store.run('UPDATE inputs SET content=? WHERE id=?', 'i'.repeat(131073), f.task.input_id);
    const readTask = f.store.task;
    f.store.task = () => { throw new Error('compact graph must not read full Worker row'); };
    let graph;
    try { graph = await f.project.workerVersionGraph({ id: f.task.id }); expect(graph.commits).toHaveLength(2); }
    finally { f.store.task = readTask; }
    await expect(f.project.workerVersionCommit({ id: f.task.id, snapshot: graph.snapshot, commit: f.tip })).rejects.toThrow('safe size');
    f.store.run('UPDATE tasks SET goal=? WHERE id=?', 'normal', f.task.id);
    await expect(f.project.workerVersionCommit({ id: f.task.id, snapshot: graph.snapshot, commit: f.tip })).rejects.toThrow('safe size');
    f.store.event(f.task.id, 'task.merge_integrated', { excess: 'x'.repeat(8193) });
    expect(() => f.project.workerVersionDeliveries({ id: f.task.id })).toThrow('evidence exceeds');
  } finally { await f.close(); }
});
