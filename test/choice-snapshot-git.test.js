import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from './helpers.js';

async function prepared() {
  const f = fixture(); await repo(f.root);
  const w = f.project.workspaces, head = await git(f.root, 'rev-parse', 'HEAD');
  const row = f.store.create({ role: 'agent', task_kind: 'child', name: 'snapshot', goal: 'snapshot test', status: 'paused' });
  await w.exclusive(() => w.forkTaskUnsafe(row, 'main', head));
  return { ...f, w, task: f.store.task(row.id) };
}
const write = (task, name, text) => { const file = path.join(task.workspace, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const ref = id => `refs/lush/choice-snapshots/${id}`;
async function missing(f, id) { expect(await git(f.root, 'for-each-ref', '--format=%(refname)', ref(id))).toBe(''); }

test('snapshot captures worktree bytes, deletion, executable and binary without changing source index or HEAD', async () => {
  const f = await prepared();
  try {
    const { task, w } = f;
    write(task, 'delete.txt', 'delete'); write(task, 'script.sh', 'echo hi\n');
    await git(task.workspace, 'add', '.'); await git(task.workspace, 'commit', '-m', 'seed');
    const head = await git(task.workspace, 'rev-parse', 'HEAD');
    write(task, 'file.txt', 'staged'); await git(task.workspace, 'add', 'file.txt'); write(task, 'file.txt', 'working');
    fs.unlinkSync(path.join(task.workspace, 'delete.txt'));
    fs.chmodSync(path.join(task.workspace, 'script.sh'), 0o755);
    write(task, 'binary.dat', Buffer.from([0, 255, 128, 42]));
    write(task, 'a, b\nfile.txt', 'odd name');
    const indexPath = await git(task.workspace, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const index = fs.readFileSync(indexPath);
    const result = await w.captureChoiceSnapshot(task, 11);
    expect(result.source_head).toBe(head);
    expect(await git(task.workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(fs.readFileSync(indexPath)).toEqual(index);
    expect(await git(f.root, 'show', `${result.commit}:file.txt`)).toBe('working');
    expect(await git(f.root, 'show', `${result.commit}:a, b\nfile.txt`)).toBe('odd name');
    expect(await git(f.root, 'ls-tree', result.commit, 'script.sh')).toStartWith('100755');
    expect(await git(f.root, 'ls-tree', result.commit, 'delete.txt')).toBe('');
    expect(await git(f.root, 'rev-parse', `${result.commit}^`)).toBe(head);
    expect(await git(f.root, 'rev-parse', `${result.commit}:binary.dat`)).toBe(
      await git(task.workspace, 'hash-object', '--no-filters', 'binary.dat'));
    expect(await git(f.root, 'rev-parse', result.ref)).toBe(result.commit);
    const second = await w.captureChoiceSnapshot(task, 12);
    expect(second.commit).not.toBe(result.commit);
    expect(await git(f.root, 'rev-parse', `${second.commit}^{tree}`)).toBe(await git(f.root, 'rev-parse', `${result.commit}^{tree}`));
  } finally { await f.close(); }
});

test('ignored, internal and named credential files are not copied; filters never execute', async () => {
  const f = await prepared();
  try {
    const { task, w } = f;
    write(task, '.gitignore', '.lush/\nignored.txt\n'); write(task, 'ignored.txt', 'ignore');
    write(task, '.lush/private', 'private'); write(task, '.env', 'TOKEN=secret'); write(task, 'auth.json', 'secret');
    write(task, '.gitattributes', '*.txt filter=bad\n');
    await git(task.workspace, 'config', 'filter.bad.clean', `touch ${path.join(f.root, 'filter-ran')}`);
    const common = await git(task.workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    fs.appendFileSync(path.join(common, 'info', 'exclude'), '\nlocal-ignore\n'); write(task, 'local-ignore', 'secret');
    const result = await w.captureChoiceSnapshot(task, 20);
    const files = await git(f.root, 'ls-tree', '-r', '--name-only', result.commit);
    for (const name of ['ignored.txt', '.lush/private', '.env', 'auth.json', 'local-ignore']) expect(files.split('\n')).not.toContain(name);
    expect(fs.existsSync(path.join(f.root, 'filter-ran'))).toBe(false);
  } finally { await f.close(); }
});

for (const [name, committed] of [['.env', true], ['auth.json', false], ['.lush/private', false]]) {
  for (const deleted of [false, true]) test(`tracked excluded ${name}, committed=${committed}, deleted=${deleted} refuses an incomplete snapshot`, async () => {
    const f = await prepared();
    try {
      write(f.task, name, 'private bytes');
      await git(f.task.workspace, 'add', '--force', '--', name);
      if (committed) await git(f.task.workspace, 'commit', '-m', 'tracked private file');
      if (deleted) fs.unlinkSync(path.join(f.task.workspace, name));
      const head = await git(f.task.workspace, 'rev-parse', 'HEAD');
      const indexPath = await git(f.task.workspace, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
      const index = fs.readFileSync(indexPath);
      await expect(f.w.captureChoiceSnapshot(f.task, 25)).rejects.toThrow('tracked internal or credential');
      expect(await git(f.task.workspace, 'rev-parse', 'HEAD')).toBe(head);
      expect(fs.readFileSync(indexPath)).toEqual(index);
      await missing(f, 25);
    } finally { await f.close(); }
  });
}

test('canonical, foreign identity, symbolic links and intermediate link paths fail closed', async () => {
  const f = await prepared();
  try {
    await expect(f.w.captureChoiceSnapshot({ ...f.task, workspace: f.root }, 30)).rejects.toThrow();
    await expect(f.w.captureChoiceSnapshot({ ...f.task, id: 99999 }, 30)).rejects.toThrow();
    fs.symlinkSync(f.root, path.join(f.task.workspace, 'link'));
    await expect(f.w.captureChoiceSnapshot(f.task, 30)).rejects.toThrow();
    fs.unlinkSync(path.join(f.task.workspace, 'link'));
    write(f.task, 'dir/file', 'tracked'); await git(f.task.workspace, 'add', 'dir'); await git(f.task.workspace, 'commit', '-m', 'nested');
    fs.rmSync(path.join(f.task.workspace, 'dir'), { recursive: true }); fs.symlinkSync(f.root, path.join(f.task.workspace, 'dir'));
    await expect(f.w.captureChoiceSnapshot(f.task, 30)).rejects.toThrow();
    await missing(f, 30);
  } finally { await f.close(); }
});

test('conflicted index and gitlinks are rejected', async () => {
  const f = await prepared();
  try {
    const hash = await git(f.task.workspace, 'rev-parse', 'HEAD:file.txt');
    const indexInfo = `100644 ${hash} 1\tfile.txt\n100644 ${hash} 2\tfile.txt\n`;
    const proc = Bun.spawn(['git', '-C', f.task.workspace, 'update-index', '--index-info'], { stdin: Buffer.from(indexInfo), stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(0);
    await expect(f.w.captureChoiceSnapshot(f.task, 40)).rejects.toThrow('conflict-free');
    await git(f.task.workspace, 'read-tree', 'HEAD');
    await git(f.task.workspace, 'update-index', '--add', '--cacheinfo', `160000,${await git(f.root, 'rev-parse', 'HEAD')},module`);
    await expect(f.w.captureChoiceSnapshot(f.task, 40)).rejects.toThrow('submodules');
    await missing(f, 40);
  } finally { await f.close(); }
});

test('guard rejection and concurrent worktree mutation never publish a snapshot', async () => {
  const f = await prepared();
  try {
    await expect(f.w.captureChoiceSnapshot(f.task, 50, () => { throw new Error('blocked'); })).rejects.toThrow('blocked');
    let calls = 0;
    await expect(f.w.captureChoiceSnapshot(f.task, 50, () => { if (++calls === 2) throw new Error('late block'); })).rejects.toThrow('late block');
    expect(calls).toBe(2); await missing(f, 50);
    calls = 0;
    await expect(f.w.captureChoiceSnapshot(f.task, 50, () => { if (++calls === 2) write(f.task, 'file.txt', 'changed during capture'); })).rejects.toThrow('changed');
    await missing(f, 50);
  } finally { await f.close(); }
});

test('publication repeats synchronous admission after asynchronous validation', async () => {
  const f = await prepared();
  try {
    let calls = 0, cancelled = false;
    await expect(f.w.captureChoiceSnapshot(f.task, 55, () => {
      calls++;
      if (cancelled) throw new Error('cancelled during validation');
      if (calls === 2) queueMicrotask(() => { cancelled = true; });
    })).rejects.toThrow('cancelled during validation');
    expect(calls).toBe(3); await missing(f, 55);
    calls = 0;
    await expect(f.w.captureChoiceSnapshot(f.task, 55, () => {
      if (++calls === 3) f.store.update(f.task.id, { workspace: f.root });
    })).rejects.toThrow('identity changed');
    await missing(f, 55);
    f.store.update(f.task.id, { workspace: f.task.workspace });
    await expect(f.w.captureChoiceSnapshot(f.task, 55, async () => {})).rejects.toThrow('must be synchronous');
    await missing(f, 55);
    calls = 0;
    await f.w.captureChoiceSnapshot(f.task, 55, () => { calls++; });
    expect(calls).toBe(3);
  } finally { await f.close(); }
});

test('snapshot refs are immutable; removal is strict compare-and-delete', async () => {
  const f = await prepared();
  try {
    const result = await f.w.captureChoiceSnapshot(f.task, 60);
    await expect(f.w.captureChoiceSnapshot(f.task, 60)).rejects.toThrow('already exists');
    await expect(f.w.removeChoiceSnapshot(60, result.source_head)).rejects.toThrow();
    expect(await git(f.root, 'rev-parse', result.ref)).toBe(result.commit);
    await f.w.removeChoiceSnapshot(60, result.commit); await missing(f, 60);
    expect(() => f.w.removeChoiceSnapshot('../main', result.commit)).toThrow();
    expect(() => f.w.removeChoiceSnapshot(60, 'HEAD')).toThrow();
    expect(() => f.w.captureChoiceSnapshot(f.task, 0)).toThrow();
  } finally { await f.close(); }
});

test('file count and aggregate byte limits fail closed', async () => {
  const f = await prepared();
  try {
    fs.mkdirSync(path.join(f.task.workspace, 'many'));
    for (let i = 0; i < 10001; i++) write(f.task, `many/${i}`, '');
    await expect(f.w.captureChoiceSnapshot(f.task, 71)).rejects.toThrow('10000 files');
    fs.rmSync(path.join(f.task.workspace, 'many'), { recursive: true });
    const block = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < 9; i++) write(f.task, `large-${i}`, block);
    await expect(f.w.captureChoiceSnapshot(f.task, 71)).rejects.toThrow('64 MiB');
    await missing(f, 71);
  } finally { await f.close(); }
});

test('source branch movement or new untracked files during capture are rejected', async () => {
  const f = await prepared();
  try {
    let calls = 0;
    await expect(f.w.captureChoiceSnapshot(f.task, 72, async () => {
      if (++calls === 2) { write(f.task, 'added', 'later'); }
    })).rejects.toThrow('changed');
    calls = 0;
    await expect(f.w.captureChoiceSnapshot(f.task, 72, async () => {
      if (++calls === 2) { await git(f.task.workspace, 'add', 'added'); await git(f.task.workspace, 'commit', '-m', 'concurrent'); }
    })).rejects.toThrow('变化');
    await missing(f, 72);
  } finally { await f.close(); }
});

test('oversized individual files fail without a protected ref', async () => {
  const f = await prepared();
  try {
    write(f.task, 'big', Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(f.w.captureChoiceSnapshot(f.task, 70)).rejects.toThrow('8 MiB');
    await missing(f, 70);
  } finally { await f.close(); }
});
