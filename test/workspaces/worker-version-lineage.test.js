import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, repo, git } from '../helpers.js';
import { readLineage, lineageSnapshot, LINEAGE_COMMIT_LIMIT } from '../../src/core/workspaces/worker-version-lineage.js';

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

test('lineage uses sterile SHA-256 object reads and real parents under config, replace, graft, note and process injection; foreign signatures fail', async () => {
  const f = await world(true), foreign = fixture();
  try {
    const tree = await git(f.root, 'rev-parse', `${f.tip}^{tree}`), replacement = await git(f.root, 'commit-tree', tree, '-m', 'fake root');
    await git(f.root, 'replace', f.tip, replacement); await git(f.task.workspace, 'notes', 'add', '-m', 'private note');
    fs.writeFileSync(path.join(f.root, '.git', 'info', 'grafts'), `${f.tip}\n`);
    await git(f.root, 'config', 'log.showSignature', 'true'); await git(f.root, 'config', 'core.fsmonitor', 'touch injected');
    const before = fs.readFileSync(path.join(f.root, '.git', 'config'), 'utf8');
    for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CONFIG']) f.config.env[key] = '/missing/injection';
    const first = await f.project.workerVersionLineage({ id: f.task.id, limit: 1 });
    expect(first.tip).toHaveLength(64); expect(first.commits[0].parents).toEqual([f.one]);
    expect((await f.project.workerVersionLineage({ id: f.task.id, cursor: first.cursor })).commits[0].commit).toBe(f.one);
    const detail = await f.project.workerVersionLineageCommit({ id: f.task.id, snapshot: first.snapshot, commit: f.tip });
    expect(detail.commit).toMatchObject({ parents: [f.one], message: 'two\n\noriginal body' });
    expect(JSON.stringify(detail)).not.toContain('private note'); expect(JSON.stringify(detail)).not.toContain('fake root');
    expect(() => lineageSnapshot(foreign.project.workspaces, first.snapshot, f.task.id)).toThrow('expired');
    expect(fs.readFileSync(path.join(f.root, '.git', 'config'), 'utf8')).toBe(before); expect(fs.existsSync(path.join(f.root, 'injected'))).toBe(false);
  } finally { await f.close(); await foreign.close(); }
});

test('snapshot never samples moving refs; missing objects explicitly fail and four-reader concurrency slots are released', async () => {
  const f = await world();
  try {
    const reads = await Promise.allSettled(Array.from({ length: 5 }, () => f.project.workerVersionLineage({ id: f.task.id })));
    expect(reads.filter(r => r.status === 'fulfilled')).toHaveLength(4);
    expect(reads.find(r => r.status === 'rejected').reason.message).toContain('busy');
    const first = await f.project.workerVersionLineage({ id: f.task.id, limit: 1 });
    await git(f.task.workspace, 'reset', '--hard', f.task.base_commit);
    expect((await f.project.workerVersionLineage({ id: f.task.id, cursor: first.cursor })).commits[0].commit).toBe(f.one);
    const object = path.join(f.root, '.git', 'objects', f.tip.slice(0, 2), f.tip.slice(2)); fs.renameSync(object, object + '.saved');
    try {
      await expect(f.project.workerVersionLineageCommit({ id: f.task.id, snapshot: first.snapshot, commit: f.tip })).rejects.toThrow('Git');
      await expect(f.project.workerVersionLineage({ id: f.task.id, cursor: first.cursor })).rejects.toThrow('Git');
    } finally { fs.renameSync(object + '.saved', object); }
    expect((await f.project.workerVersionLineageCommit({ id: f.task.id, snapshot: first.snapshot, commit: f.tip })).commit.commit).toBe(f.tip);
    await expect(readLineage(f.project.workspaces, { tip: f.tip, base: f.task.base_commit }, { deadline: Date.now() - 1 })).rejects.toThrow('超时');
  } finally { await f.close(); }
});

test('second-parent-only creation origin is refused, preserving source-chain meaning instead of enumerating foreign first-parent development', async () => {
  const f = await world();
  try {
    const tree = await git(f.root, 'rev-parse', `${f.tip}^{tree}`);
    const foreign = await git(f.root, 'commit-tree', tree, '-m', 'foreign root');
    const reversed = await git(f.root, 'commit-tree', tree, '-p', foreign, '-p', f.tip, '-m', 'wrong first parent');
    await git(f.task.workspace, 'reset', '--hard', reversed);
    await expect(f.project.workerVersionLineage({ id: f.task.id })).rejects.toThrow('first-parent source chain');
  } finally { await f.close(); }
});

test('real 10001-commit source chain and 4MiB Git output are rejected without truncation', async () => {
  const f = await world();
  try {
    let input = '';
    for (let i = 1; i <= LINEAGE_COMMIT_LIMIT + 1; i++) input += `commit refs/heads/${f.task.branch}\nmark :${i}\ncommitter Test <test@example.invalid> ${1000000000 + i} +0000\ndata 1\nx\nfrom ${i === 1 ? f.tip : ':' + (i - 1)}\n\n`;
    const proc = Bun.spawn(['git', '-C', f.root, 'fast-import', '--quiet'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write(input); proc.stdin.end();
    const [error, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]); expect(error).toBe(''); expect(exit).toBe(0);
    await expect(f.project.workerVersionLineage({ id: f.task.id })).rejects.toThrow('10000 commits');
    await git(f.task.workspace, 'reset', '--hard', f.tip);
    const message = path.join(f.config.home, 'large-message'); fs.writeFileSync(message, 'x'.repeat(4 * 1024 * 1024 + 1));
    await git(f.task.workspace, 'commit', '--allow-empty', '-F', message);
    await expect(f.project.workerVersionLineage({ id: f.task.id, limit: 1 })).rejects.toThrow('安全大小上限');
  } finally { await f.close(); }
});
