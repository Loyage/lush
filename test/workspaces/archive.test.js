import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../helpers.js';
import { setup, change } from './harness.js';

/** 写一条最小的 pi 会话记录，让归档后的 transcript 真的读得到步骤。 */
function writeSession(f, taskId) {
  const dir = path.join(f.config.home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2024-01-01T00-00-00-000Z_lush-task-${taskId}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', id: `s${taskId}` }),
    JSON.stringify({ type: 'message', timestamp: Date.now(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'archived work' }] } }),
  ].join('\n') + '\n');
  return file;
}

test('archiving removes the worktree and ref but keeps the task row, branch field and transcript', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.task);
    const branch = f.store.task(f.task.id).branch;
    const session = writeSession(f, f.task.id);
    const tip = await git(f.root, 'rev-parse', branch);

    const result = await f.project.archiveBranch(branch);
    expect(result.branch).toBe(branch);
    expect(result.archived).toBe(true);
    expect(result.worktree).toBe('removed');
    expect(result.ref).toBe('deleted');
    expect(result.tip).toBe(tip);
    expect(result.tasks).toEqual([{ id: f.task.id, status: 'completed' }]);
    expect(result.sessions).toEqual([session]);

    // 磁盘上确实没有了，库里却还在——这正是「归档」与「删除」的分界。
    expect(fs.existsSync(cwd)).toBe(false);
    expect(await git(f.root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).not.toContain(branch);
    expect(f.store.branch(branch).status).toBe('archived');
    expect(f.store.branch(branch).deleted_at).toBeTruthy();
    const task = f.store.task(f.task.id);
    expect(task.branch).toBe(branch);
    expect(task.workspace).toBe(null);

    // 任务行与会话文件都在，所以执行过程仍读得回来。
    const transcript = f.project.transcript(f.task.id);
    expect(transcript.files).toHaveLength(1);
    expect(transcript.steps.some(step => step.body === 'archived work')).toBe(true);

    // 会话位置写进了归档事件，将来 clear 掉 tasks 行也查得回文件。
    const archivedEvents = f.store.all("SELECT * FROM events WHERE type='branch.archived' ORDER BY id").map(row => JSON.parse(row.data));
    expect(archivedEvents.some(data => Array.isArray(data.sessions) && data.sessions.includes(session))).toBe(true);
  } finally { await f.close(); }
});

test('a dirty worktree is refused by default and discarded only with discard_worktree', async () => {
  const f = await setup();
  try {
    const cwd = await change(f, f.task);
    const branch = f.store.task(f.task.id).branch;
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'uncommitted\n');

    await expect(f.project.archiveBranch(branch)).rejects.toThrow(/discard_worktree/);
    // 拒绝必须无副作用：目录、ref、记录一个都没动。
    expect(fs.existsSync(cwd)).toBe(true);
    expect(await git(f.root, 'branch', '--list', branch)).toContain(branch);
    expect(f.store.branch(branch).status).toBe('active');

    const result = await f.project.archiveBranch(branch, { discard_worktree: true });
    expect(result.worktree).toBe('removed');
    expect(result.discarded).toBe(true);
    expect(fs.existsSync(cwd)).toBe(false);
    expect(f.store.branch(branch).status).toBe('archived');
  } finally { await f.close(); }
});
