import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repo, git, until } from '../helpers.js';
import { setup, fetch } from './harness.js';

const questions = [{ header: '实现', question: '选择哪种实现？', options: [
  { label: 'A', description: '方案 A' }, { label: 'B', description: '方案 B' }] }];
const answer = { answers: [{ selected: [1], custom: '' }] };
const action = (url, method, params) => fetch(url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });

test('real HTTP → RPC questionnaire answer continues original Worker with no snapshot or new route', async () => {
  const f = await setup();
  let notice, resumed;
  f.project.provider = { async run({ task, api, context }) {
    if (task.calls > 1) { resumed = context; return 'continued'; }
    fs.writeFileSync(path.join(task.workspace, 'file.txt'), 'dirty choice code\n');
    fs.writeFileSync(path.join(task.workspace, 'new.txt'), 'untracked choice code\n');
    notice = api.notice(task.id, '实现选择', '', 'question', questions);
    return 'parked';
  } };
  try {
    await repo(f.root);
    const order = await action(f.url, 'order.submit', { content: 'implement feature', start: false });
    expect(order.status).toBe(200);
    const original = (await order.json()).task;
    const main = await git(f.root, 'rev-parse', 'main'), head = await git(original.workspace, 'rev-parse', 'HEAD');
    const index = await git(original.workspace, 'write-tree');
    expect((await action(f.url, 'worker.resume', { id: original.id })).status).toBe(200);
    await until(() => notice && !f.project.running.has(original.id));
    expect((await action(f.url, 'notice.answer', { id: notice.id, answer })).status).toBe(200);
    await until(() => resumed && !f.project.running.has(original.id));
    const stored = f.store.get('SELECT * FROM notices WHERE id=?', notice.id);
    expect(stored.status).toBe('answered');
    expect(JSON.parse(stored.answer).answers[0].labels).toEqual(['B']);
    const before = f.store.get('SELECT count(*) AS n FROM tasks').n;
    expect((await fetch(f.url + `/api/notice/${notice.id}/snapshot`)).status).toBe(404);
    expect((await action(f.url, 'notice.rechoose', { id: notice.id, answer, revision: 'legacy',
      request_id: '76e2c51f-474a-40da-979c-27c6affb4e23' })).status).toBe(400);
    expect(f.store.get('SELECT count(*) AS n FROM tasks').n).toBe(before);
    expect(f.store.get('SELECT * FROM notices WHERE id=?', notice.id)).toEqual(stored);
    expect(f.store.all('SELECT * FROM choice_snapshots')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM choice_rechoices')).toHaveLength(0);
    expect(await git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/lush/choice-snapshots')).toBe('');
    expect(await git(original.workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(original.workspace, 'write-tree')).toBe(index);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(main);
    expect(fs.readFileSync(path.join(original.workspace, 'file.txt'), 'utf8')).toBe('dirty choice code\n');
    expect(fs.readFileSync(path.join(original.workspace, 'new.txt'), 'utf8')).toBe('untracked choice code\n');
  } finally { await f.close(); }
});
