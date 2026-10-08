import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { choiceContextPath, choiceForkPath } from '../../src/agent/choice-context.js';

const questions = [{ header: '方案', question: '选择哪条实现路线？', options: [
  { label: 'A', description: '方案 A' }, { label: 'B', description: '方案 B' }] }];
const answer = selected => ({ answers: [{ selected: [selected], custom: '' }] });
const pi = { agent: 'pi', config_mode: 'lush', model: '', thinking: '', connection_id: '',
  default_prompt: '', append_prompt: '', env: {}, extensions: [], skills: [], soft_budget: {} };

function marker(f, task, run) {
  const session = path.join(f.config.home, 'sessions', `test_lush-task-${task.id}.jsonl`);
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, [
    { type: 'session', version: 3, id: 'source', cwd: task.workspace },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'before choice' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'investigation' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(f.config.home, 'sessions', `task-${task.id}-context.json`), JSON.stringify({
    task_id: task.id, run_id: run.recordId, session, entry: 'a1',
  }));
  return session;
}

async function prepared({ automatic = false, wait = false, dirty = true, profile = pi, missingMarker = false } = {}) {
  let f, notice, sourceId, session;
  const exiting = gate(), received = [];
  f = fixture({ async run({ task, api, signal, context, choiceFork }) {
    if (task.id !== sourceId) { received.push({ task, context, choiceFork }); return 'new route'; }
    if (task.calls > 1) return 'original route';
    const run = api.running.get(task.id);
    run.agent = profile;
    session = marker(f, task, run);
    if (missingMarker) fs.unlinkSync(path.join(f.config.home, 'sessions', `task-${task.id}-context.json`));
    if (dirty) {
      fs.writeFileSync(path.join(task.workspace, 'file.txt'), 'choice dirty code\n');
      fs.writeFileSync(path.join(task.workspace, 'new.txt'), 'untracked at choice\n');
    }
    notice = api.notice(task.id, '选择方案', '背景', 'question', questions);
    if (wait) await exiting.promise;
    if (signal.aborted) throw new Error('question suspended');
    return 'parked';
  } });
  await repo(f.root);
  if (automatic) { const hooks = f.project.daemonHooks(); f.project.setDaemonAutoSelect(true, hooks.revision); }
  const input = await f.project.order('implement original', null, [], null, false);
  sourceId = input.task.id;
  f.project.store.update(sourceId, { status: 'queued' }); f.project.kick();
  await until(() => notice);
  if (!wait) await until(() => !f.project.running.has(sourceId));
  return { ...f, sourceId, get notice() { return notice; }, session, exiting, received };
}

async function ready(f) {
  const view = await f.project.noticeSnapshot(f.notice.id);
  expect(view.status).toBe('ready');
  return view;
}

async function settled(f) {
  if (f.store.get('SELECT status FROM notices WHERE id=?', f.notice.id).status === 'open') f.project.answer(f.notice.id, answer(0));
  await until(() => !f.project.running.has(f.sourceId) && f.store.task(f.sourceId).status !== 'queued');
  return ready(f);
}

test('new questionnaire captures dirty/untracked state without changing source HEAD/index; rechoose creates independent user order', async () => {
  const f = await prepared();
  try {
    const source = f.store.task(f.sourceId), head = await git(source.workspace, 'rev-parse', 'HEAD');
    const index = await git(source.workspace, 'write-tree');
    // A legitimate main owner is persisted without a branch genealogy record.
    expect(f.store.task(source.parent_id).branch).toBe('main');
    expect(f.store.branch('main')).toBeNull();
    const view = await ready(f);
    expect(view.can_rechoose).toBe(false);
    expect(view.blockers.join()).toContain('已回答');
    expect(await git(f.root, 'show', `${view.commit}:file.txt`)).toBe('choice dirty code');
    expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(source.workspace, 'write-tree')).toBe(index);
    await settled(f);
    fs.appendFileSync(f.session, JSON.stringify({ type: 'message', id: 'late', parentId: 'a1', message: { role: 'user', content: 'OLD ANSWER AFTER SNAPSHOT' } }) + '\n');
    const before = f.store.get('SELECT * FROM notices WHERE id=?', f.notice.id);
    const result = await f.project.rechooseNotice(f.notice.id, answer(1), view.revision, randomUUID());
    const created = f.store.task(result.task.id);
    expect(created.parent_id).toBe(source.parent_id);
    expect(created.task_kind).toBe('order');
    expect(JSON.parse(created.auto_merge).enabled).toBe(false);
    expect(created.base_commit).toBe(view.commit);
    expect(fs.readFileSync(path.join(created.workspace, 'new.txt'), 'utf8')).toBe('untracked at choice\n');
    expect(fs.readFileSync(choiceForkPath(f.config.home, created.id), 'utf8')).not.toContain('OLD ANSWER');
    expect(f.store.get('SELECT * FROM notices WHERE id=?', f.notice.id)).toEqual(before);
    await until(() => f.received.length === 1 && !f.project.running.has(created.id));
    expect(f.received[0].context.choice_reselection.answer.answers[0].labels).toEqual(['B']);
    expect(f.received[0].choiceFork.file).toBe(choiceForkPath(f.config.home, created.id));
    expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(head);
  } finally { await f.close(); }
});

test('automatic answer and immediate user answer cannot release running before checkpoint completes', async () => {
  const f = await prepared({ automatic: true, wait: true });
  try {
    expect(f.store.get('SELECT answer_source FROM notices WHERE id=?', f.notice.id).answer_source).toBe('lush');
    expect((await f.project.noticeSnapshot(f.notice.id)).status).toBe('pending');
    expect(f.store.task(f.sourceId).calls).toBe(1);
    expect(f.project.running.has(f.sourceId)).toBe(true);
    f.exiting.resolve();
    await until(() => f.store.task(f.sourceId).calls === 2 && !f.project.running.has(f.sourceId));
    expect((await ready(f)).can_rechoose).toBe(true);
  } finally { f.exiting.resolve(); await f.close(); }
});

test('same request is idempotent across concurrent submissions; new request can fork again and changed payload cannot reuse key', async () => {
  const f = await prepared();
  try {
    const view = await settled(f), key = randomUUID();
    const [one, two] = await Promise.all([f.project.rechooseNotice(f.notice.id, answer(1), view.revision, key),
      f.project.rechooseNotice(f.notice.id, answer(1), view.revision, key)]);
    expect(one.task.id).toBe(two.task.id); expect([one.reused, two.reused]).toEqual([false, true]);
    await expect(f.project.rechooseNotice(f.notice.id, answer(0), view.revision, key)).rejects.toThrow('request_id');
    const three = await f.project.rechooseNotice(f.notice.id, answer(0), view.revision, randomUUID());
    expect(three.task.id).not.toBe(one.task.id);
    await expect(f.project.rechooseNotice(f.notice.id, answer(1), 'stale', randomUUID())).rejects.toThrow('revision');
    expect(f.store.all('SELECT * FROM choice_rechoices')).toHaveLength(2);
  } finally { await f.close(); }
});

test('dismissed questionnaire can fork; completed/archived source is not revived', async () => {
  const f = await prepared({ dirty: false });
  try {
    f.project.answer(f.notice.id, '', true);
    await until(() => !f.project.running.has(f.sourceId) && f.store.task(f.sourceId).status !== 'queued');
    const source = f.store.task(f.sourceId);
    f.store.update(source.id, { status: 'completed' });
    await f.project.archiveBranch(source.branch);
    expect(fs.existsSync(source.workspace)).toBe(false);
    const view = await ready(f);
    expect(view.can_rechoose).toBe(true);
    const result = await f.project.rechooseNotice(f.notice.id, answer(1), view.revision, randomUUID());
    expect(result.task.id).not.toBe(source.id);
    expect(f.store.task(source.id).status).toBe('completed');
  } finally { await f.close(); }
});

test('parent ending, freezing, disappearing, and resource tampering refuse creation without changing original notice', async () => {
  const f = await prepared();
  try {
    const view = await settled(f), source = f.store.task(f.sourceId), parent = f.store.task(source.parent_id);
    f.store.update(parent.id, { status: 'completed' });
    await expect(f.project.rechooseNotice(f.notice.id, answer(1), view.revision, randomUUID())).rejects.toThrow('父 Worker');
    f.store.update(parent.id, { status: 'waiting' });
    const original = f.project.assertBranchWritable;
    f.project.assertBranchWritable = () => { throw new Error('frozen parent'); };
    expect((await f.project.noticeSnapshot(f.notice.id)).blockers.join()).toContain('frozen parent');
    f.project.assertBranchWritable = original;
    fs.appendFileSync(choiceContextPath(f.config.home, f.notice.id), '{}\n');
    const invalid = await f.project.noticeSnapshot(f.notice.id);
    expect(invalid.can_rechoose).toBe(false);
    expect(invalid.blockers.join()).toContain('资源');
    await expect(f.project.rechooseNotice(f.notice.id, answer(1), view.revision, randomUUID())).rejects.toThrow('资源');
    expect(f.store.all('SELECT * FROM choice_rechoices')).toHaveLength(0);
  } finally { await f.close(); }
});

test('unsupported mode, absent marker and historical question are explicitly unavailable', async () => {
  const f = fixture({ async run() { return 'idle'; } });
  try {
    await repo(f.root);
    const input = await f.project.order('source', null, [], null, false);
    const notice = f.project.notice(input.task.id, 'manual', '', 'question', questions);
    const view = await f.project.noticeSnapshot(notice.id);
    expect(view.status).toBe('unavailable'); expect(view.reason).toContain('专属工作区');
    const textNotice = f.project.notice(input.task.id, 'text');
    expect((await f.project.noticeSnapshot(textNotice.id)).reason).toContain('没有选择快照');
    expect(JSON.stringify(view)).not.toContain('profile');
    expect(JSON.stringify(view)).not.toContain('session_path');
  } finally { await f.close(); }
});

test('unsupported backend/mode and missing current marker never pretend a full snapshot', async () => {
  for (const options of [{ profile: { ...pi, agent: 'codex' } }, { profile: { ...pi, config_mode: 'pi' } }, { missingMarker: true }]) {
    const f = await prepared(options);
    try {
      const view = await f.project.noticeSnapshot(f.notice.id);
      expect(view.status).toBe('unavailable');
      expect(view.reason).toContain(options.missingMarker ? '可信 Pi' : '仅 Pi/Lush');
      expect(await git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/lush/choice-snapshots')).toBe('');
    } finally { await f.close(); }
  }
});

test('running ownership stays held through asynchronous capture even after fast user answer', async () => {
  const f = await prepared({ wait: true });
  const captureEntered = gate(), captureExit = gate();
  try {
    const capture = f.project.workspaces.captureChoiceSnapshot.bind(f.project.workspaces);
    f.project.workspaces.captureChoiceSnapshot = async (...args) => {
      captureEntered.resolve(); await captureExit.promise; return capture(...args);
    };
    f.project.answer(f.notice.id, answer(1));
    f.exiting.resolve(); await captureEntered.promise;
    expect(f.project.running.has(f.sourceId)).toBe(true);
    expect(f.project.running.get(f.sourceId).invocationEnded).toBe(true);
    expect(f.store.task(f.sourceId).calls).toBe(1);
    expect((await f.project.noticeSnapshot(f.notice.id)).status).toBe('pending');
    captureExit.resolve();
    await until(() => f.store.task(f.sourceId).calls === 2 && !f.project.running.has(f.sourceId));
    expect((await ready(f)).can_rechoose).toBe(true);
  } finally { captureExit.resolve(); f.exiting.resolve(); await f.close(); }
});

test('cancel during asynchronous fork preserves cancellation and cannot start an incomplete route', async () => {
  const f = await prepared();
  const entered = gate(), release = gate();
  try {
    const view = await settled(f), fork = f.project.workspaces.forkTaskUnsafe.bind(f.project.workspaces), key = randomUUID();
    f.project.workspaces.forkTaskUnsafe = async (...args) => { const value = await fork(...args); entered.resolve(); await release.promise; return value; };
    const creating = f.project.rechooseNotice(f.notice.id, answer(1), view.revision, key);
    // Attach rejection before releasing so Bun does not report an unhandled failure.
    const outcome = creating.catch(error => error);
    await entered.promise;
    const row = f.store.get('SELECT * FROM choice_rechoices WHERE request_id=?', key);
    f.project.resumeTask(row.task_id);
    f.project.pump();
    expect(f.project.running.has(row.task_id)).toBe(false);
    f.project.cancel(row.task_id, 'cancelled during fork');
    release.resolve();
    expect((await outcome).message).toContain('保留');
    expect(f.store.task(row.task_id).status).toBe('cancelled');
    expect(f.received).toHaveLength(0);
  } finally { release.resolve(); await f.close(); }
});

test('capture failure leaves original question answerable and original route resumable', async () => {
  const f = await prepared({ wait: true });
  try {
    f.project.workspaces.captureChoiceSnapshot = async () => { throw new Error('secret path and secret provider response'); };
    f.exiting.resolve();
    await until(() => !f.project.running.has(f.sourceId));
    const view = await f.project.noticeSnapshot(f.notice.id);
    expect(view.status).toBe('unavailable'); expect(view.reason).not.toContain('secret');
    f.project.answer(f.notice.id, answer(0));
    await until(() => f.store.task(f.sourceId).calls === 2 && !f.project.running.has(f.sourceId));
  } finally { f.exiting.resolve(); await f.close(); }
});

test('recovery invalidates pending capture and unknown fork, never captures a later worktree', async () => {
  const f = await prepared();
  try {
    const view = await settled(f);
    f.store.run("UPDATE choice_snapshots SET status='pending' WHERE notice_id=?", f.notice.id);
    f.project.recoverChoiceSnapshots();
    expect((await f.project.noticeSnapshot(f.notice.id)).status).toBe('unavailable');
    f.store.run("UPDATE choice_snapshots SET status='ready',revision=? WHERE notice_id=?", view.revision, f.notice.id);
    const fork = f.project.workspaces.forkTaskUnsafe;
    f.project.workspaces.forkTaskUnsafe = async () => { throw new Error('interrupted'); };
    const key = randomUUID();
    await expect(f.project.rechooseNotice(f.notice.id, answer(1), view.revision, key)).rejects.toThrow('保留');
    const row = f.store.get('SELECT * FROM choice_rechoices WHERE request_id=?', key);
    expect(f.store.task(row.task_id).status).toBe('failed');
    await expect(f.project.rechooseNotice(f.notice.id, answer(1), view.revision, key)).rejects.toThrow('不会重放');
    f.store.run("UPDATE choice_rechoices SET status='creating' WHERE request_id=?", key);
    f.project.recoverChoiceSnapshots();
    expect(f.store.get('SELECT status FROM choice_rechoices WHERE request_id=?', key).status).toBe('unknown');
    f.project.workspaces.forkTaskUnsafe = fork;
  } finally { await f.close(); }
});

test('deletion preview protects external routes, reclaims snapshots and keeps request tombstones', async () => {
  const f = await prepared();
  try {
    const view = await settled(f), key = randomUUID();
    const result = await f.project.rechooseNotice(f.notice.id, answer(1), view.revision, key);
    await until(() => !f.project.running.has(result.task.id) && f.store.task(result.task.id).status !== 'queued');
    f.project.cancel(f.sourceId, 'test cleanup');
    const blocked = await f.project.deleteTaskPreview(f.sourceId);
    expect(blocked.can_delete).toBe(false); expect(blocked.blockers.join()).toContain('choice snapshot');
    f.project.cancel(result.task.id, 'test cleanup');
    const route = await f.project.deleteTaskPreview(result.task.id);
    expect(route.can_delete).toBe(true);
    expect(route.resources.files).toContain(choiceForkPath(f.config.home, result.task.id));
    await f.project.deleteTask(result.task.id, { revision: route.revision, confirm: true });
    await expect(f.project.rechooseNotice(f.notice.id, answer(1), view.revision, key)).rejects.toThrow('不会重放');
    const source = await f.project.deleteTaskPreview(f.sourceId);
    expect(source.can_delete).toBe(true);
    expect(source.resources.branches).toContain(`refs/lush/choice-snapshots/${f.notice.id}`);
    expect(source.resources.files).toContain(choiceContextPath(f.config.home, f.notice.id));
    await f.project.deleteTask(f.sourceId, { revision: source.revision, confirm: true });
    expect(f.store.all('SELECT * FROM choice_snapshots')).toHaveLength(0);
    await expect(git(f.root, 'rev-parse', '--verify', `refs/lush/choice-snapshots/${f.notice.id}`)).rejects.toThrow();
  } finally { await f.close(); }
});
