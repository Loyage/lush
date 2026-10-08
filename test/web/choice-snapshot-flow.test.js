import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { repo, git, until } from '../helpers.js';
import { setup, fetch } from './harness.js';

const questions = [{ header: '实现', question: '选择哪种实现？', options: [
  { label: '旧方案', description: '初次选择' }, { label: '新方案', description: '从保存点重新开发' }] }];
const answer = n => ({ answers: [{ selected: [n], custom: '' }] });
const profile = { agent: 'pi', config_mode: 'lush', model: '', thinking: '', connection_id: '',
  default_prompt: '', append_prompt: '', env: {}, extensions: [], skills: [], soft_budget: {} };
const action = (url, method, params) => fetch(url + '/api/action', { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) });

test('real HTTP → RPC → runtime restores a historical choice into independent code and context exactly once', async () => {
  const f = await setup();
  let sourceId, notice, session;
  const received = [];
  f.project.provider = { async run({ task, api, context, choiceFork }) {
    if (task.id !== sourceId) { received.push({ task, context, choiceFork }); return 'new route ready'; }
    if (task.calls > 1) return 'old route kept';
    const run = api.running.get(task.id); run.agent = profile;
    session = path.join(f.config.home, 'sessions', `test_lush-task-${task.id}.jsonl`);
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.writeFileSync(session, [
      { type: 'session', version: 3, id: 'choice-flow', cwd: task.workspace },
      { type: 'message', id: 'before', parentId: null, message: { role: 'user', content: 'choice investigation' } },
    ].map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(path.join(f.config.home, 'sessions', `task-${task.id}-context.json`),
      JSON.stringify({ task_id: task.id, run_id: run.recordId, session, entry: 'before' }));
    fs.writeFileSync(path.join(task.workspace, 'file.txt'), 'uncommitted choice state\n');
    fs.writeFileSync(path.join(task.workspace, 'new.txt'), 'untracked choice state\n');
    notice = api.notice(task.id, '实现选择', '', 'question', questions);
    return 'parked';
  } };
  try {
    await repo(f.root);
    const order = await action(f.url, 'order.submit', { content: 'implement feature', start: false });
    expect(order.status).toBe(200);
    const original = (await order.json()).task; sourceId = original.id;
    const mainHead = await git(f.root, 'rev-parse', 'main');
    expect((await action(f.url, 'worker.resume', { id: sourceId })).status).toBe(200);
    await until(() => notice && !f.project.running.has(sourceId));
    expect((await action(f.url, 'notice.answer', { id: notice.id, answer: answer(0) })).status).toBe(200);
    await until(() => !f.project.running.has(sourceId) && f.store.task(sourceId).status !== 'queued');
    const source = f.store.task(sourceId), head = await git(source.workspace, 'rev-parse', 'HEAD');
    const index = await git(source.workspace, 'write-tree');
    const oldNotice = f.store.get('SELECT * FROM notices WHERE id=?', notice.id);
    fs.writeFileSync(path.join(source.workspace, 'file.txt'), 'later old route changes\n');
    fs.appendFileSync(session, JSON.stringify({ type: 'message', id: 'later', parentId: 'before',
      message: { role: 'user', content: 'OLD ANSWER MUST NOT LEAK INTO FORK' } }) + '\n');
    const snapshotResponse = await fetch(f.url + `/api/notice/${notice.id}/snapshot`);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json();
    expect(snapshot.status).toBe('ready'); expect(snapshot.can_rechoose).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(session);
    const params = { id: notice.id, answer: answer(1), revision: snapshot.revision, request_id: randomUUID() };
    const responses = await Promise.all([action(f.url, 'notice.rechoose', params), action(f.url, 'notice.rechoose', params)]);
    expect(responses.map(r => r.status)).toEqual([200,200]);
    const results = await Promise.all(responses.map(r => r.json()));
    expect(results[0].task.id).toBe(results[1].task.id);
    expect(results.map(r => r.reused).sort()).toEqual([false,true]);
    const newId = results[0].task.id;
    await until(() => received.length === 1 && !f.project.running.has(newId));
    const created = f.store.task(newId), call = received[0];
    expect(created.parent_id).toBe(source.parent_id); expect(created.base_commit).toBe(snapshot.commit);
    expect(created.task_kind).toBe('order'); expect(JSON.parse(created.auto_merge).enabled).toBe(false);
    expect(created.workspace).not.toBe(source.workspace);
    expect(fs.readFileSync(path.join(created.workspace, 'file.txt'), 'utf8')).toBe('uncommitted choice state\n');
    expect(fs.readFileSync(path.join(created.workspace, 'new.txt'), 'utf8')).toBe('untracked choice state\n');
    expect(fs.readFileSync(call.choiceFork.file, 'utf8')).not.toContain('OLD ANSWER');
    expect(call.context.choice_reselection.answer.answers[0].labels).toEqual(['新方案']);
    expect(f.store.get('SELECT * FROM notices WHERE id=?', notice.id)).toEqual(oldNotice);
    expect(fs.readFileSync(path.join(source.workspace, 'file.txt'), 'utf8')).toBe('later old route changes\n');
    expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(source.workspace, 'write-tree')).toBe(index);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(mainHead);
    // A lost response is still recoverable even when the parent has since become frozen.
    const admission = f.project.assertBranchWritable;
    f.project.assertBranchWritable = () => { throw new Error('parent frozen after creation'); };
    try {
      const retried = await action(f.url, 'notice.rechoose', params);
      expect(retried.status).toBe(200); expect((await retried.json()).task.id).toBe(newId);
      const blocked = await action(f.url, 'notice.rechoose', { ...params, request_id: randomUUID() });
      expect(blocked.status).toBe(400);
    } finally { f.project.assertBranchWritable = admission; }
    expect(f.store.all('SELECT * FROM choice_rechoices')).toHaveLength(1);
  } finally { await f.close(); }
});
