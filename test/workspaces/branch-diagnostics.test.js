import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, git, repo } from '../helpers.js';

async function setup() {
  const f = fixture();
  await repo(f.root);
  f.base = await git(f.root, 'rev-parse', 'HEAD');
  f.read = async (base = f.base, name = 'main') => {
    const head = await git(f.root, 'rev-parse', `refs/heads/${name}`);
    return (await f.project.workspaces.branchDiagnostics([{ name, head_commit: head, created_from_commit: base }])).get(name);
  };
  return f;
}

test('branch diagnostics counts net text/binary/deletion/rename changes with unusual filenames', async () => {
  const f = await setup();
  try {
    fs.writeFileSync(path.join(f.root, 'delete.txt'), 'gone\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'baseline');
    f.base = await git(f.root, 'rev-parse', 'HEAD');
    const renamed = 'renamed\tfile\n.txt';
    await git(f.root, 'mv', 'file.txt', renamed);
    fs.unlinkSync(path.join(f.root, 'delete.txt'));
    fs.writeFileSync(path.join(f.root, 'new\tfile\n.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(f.root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', '<b>changes</b>');
    const data = await f.read();
    expect(data.changes).toMatchObject({ status: 'ok', files_total: 4, added: 2, deleted: 1, binary_files: 1, truncated: false });
    expect(data.changes.files).toContainEqual({ path: renamed, previous_path: 'file.txt', added: 0, deleted: 0 });
    expect(data.changes.files).toContainEqual({ path: 'binary.dat', added: null, deleted: null });
    expect(data.changes.files).toContainEqual({ path: 'new\tfile\n.txt', added: 2, deleted: 0 });
    expect(data.latest_commit.subject).toBe('<b>changes</b>');
    expect(Number.isFinite(Date.parse(data.latest_commit.committed_at))).toBe(true);
    expect(data.working_tree).toMatchObject({ status: 'clean', files_total: 0, path: f.root });
  } finally { await f.close(); }
});

test('branch diagnostics separates pending files, does not mutate index, and caches only immutable facts', async () => {
  const f = await setup();
  try {
    const workspaces = f.project.workspaces;
    const original = workspaces.gitOutput;
    let diffs = 0;
    workspaces.gitOutput = async function(cwd, ...args) {
      if (args[0] === 'diff') diffs++;
      return original.call(this, cwd, ...args);
    };
    expect((await f.read()).changes).toMatchObject({ files_total: 0, added: 0, deleted: 0 });
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'staged\n');
    await git(f.root, 'add', 'file.txt');
    fs.appendFileSync(path.join(f.root, 'file.txt'), 'unstaged\n');
    fs.writeFileSync(path.join(f.root, 'pending\nname'), 'untracked');
    const indexPath = path.join(f.root, '.git', 'index');
    const index = fs.readFileSync(indexPath), mtime = fs.statSync(indexPath).mtimeMs;
    const data = await f.read();
    expect(data.changes.files_total).toBe(0);
    expect(data.working_tree).toMatchObject({ status: 'dirty', files_total: 2, staged: 1, unstaged: 1, untracked: 1, conflicts: 0 });
    expect(fs.readFileSync(indexPath)).toEqual(index);
    expect(fs.statSync(indexPath).mtimeMs).toBe(mtime);
    expect(diffs).toBe(1);
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'advance');
    expect((await f.read()).changes.files_total).toBe(2);
    expect(diffs).toBe(2);
  } finally { await f.close(); }
});

test('branch diagnostics discovers actual worktrees and handles staged rename as one pending file', async () => {
  const f = await setup();
  try {
    const tree = path.join(f.config.home, 'worktrees', 'feature with space');
    await git(f.root, 'worktree', 'add', '-b', 'feature', tree);
    await git(tree, 'mv', 'file.txt', 'new\tname\n.txt');
    expect((await f.read(f.base, 'feature')).working_tree).toMatchObject({ status: 'dirty', path: tree, files_total: 1, staged: 1, unstaged: 0 });
    expect((await f.read()).working_tree.status).toBe('clean');
    await git(f.root, 'branch', 'not-checked-out');
    expect((await f.read(f.base, 'not-checked-out')).working_tree.status).toBe('not_checked_out');
  } finally { await f.close(); }
});

test('branch diagnostics distinguishes unavailable baseline/head/status and recovers after read failure', async () => {
  const f = await setup();
  try {
    expect((await f.read(null)).changes).toEqual({ status: 'unavailable', reason: 'missing_baseline' });
    expect((await f.read('0'.repeat(40))).changes.reason).toBe('read_failed');
    const missing = (await f.project.workspaces.branchDiagnostics([{ name: 'gone', head_commit: null, created_from_commit: f.base }])).get('gone');
    expect(missing.changes.reason).toBe('missing_head');
    expect(missing.latest_commit).toBeNull();
    const workspaces = f.project.workspaces, original = workspaces.gitOutput;
    workspaces.gitOutput = async function(cwd, ...args) {
      if (args[0] === 'diff' || args[0] === 'worktree') throw new Error('unavailable');
      return original.call(this, cwd, ...args);
    };
    const failed = await f.read();
    expect(failed.changes.reason).toBe('read_failed');
    expect(failed.working_tree.status).toBe('unknown');
    workspaces.gitOutput = original;
    expect((await f.read()).changes.status).toBe('ok');
    expect((await f.read()).working_tree.status).toBe('clean');
  } finally { await f.close(); }
});

test('branch diagnostics reports conflicted files and never resolves or alters an in-progress merge', async () => {
  const f = await setup();
  try {
    await git(f.root, 'checkout', '-b', 'other');
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'other\n');
    await git(f.root, 'commit', '-am', 'other');
    await git(f.root, 'checkout', 'main');
    fs.writeFileSync(path.join(f.root, 'file.txt'), 'main\n');
    await git(f.root, 'commit', '-am', 'main');
    await expect(git(f.root, 'merge', 'other')).rejects.toThrow();
    const before = fs.readFileSync(path.join(f.root, 'file.txt'));
    const mergeHead = await git(f.root, 'rev-parse', 'MERGE_HEAD');
    expect((await f.read()).working_tree).toMatchObject({ status: 'dirty', files_total: 1, conflicts: 1, staged: 0, unstaged: 0 });
    expect(fs.readFileSync(path.join(f.root, 'file.txt'))).toEqual(before);
    expect(await git(f.root, 'rev-parse', 'MERGE_HEAD')).toBe(mergeHead);
  } finally { await f.close(); }
});

test('branch diagnostics bounds file list bytes without truncating totals', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(f.root, `${i}-${'文件'.repeat(25)}.txt`), 'line\n');
    await git(f.root, 'add', '.'); await git(f.root, 'commit', '-m', 'many files');
    const { changes } = await f.read();
    expect(changes).toMatchObject({ files_total: 80, added: 80, deleted: 0, truncated: true });
    expect(changes.files.length).toBeGreaterThan(0);
    expect(changes.files.length).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(JSON.stringify(changes.files))).toBeLessThanOrEqual(2048);
  } finally { await f.close(); }
});
