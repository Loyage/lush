import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, repo, git, until, gate } from '../helpers.js';
import { choiceContextPath, choiceForkPath, choiceDigest, writeChoiceFile } from '../../src/agent/choice-context.js';

const questions = [{ header: '方案', question: '选择哪条实现路线？', options: [
  { label: 'A', description: '方案 A' }, { label: 'B', description: '方案 B' }] }];
const answer = { answers: [{ selected: [1], custom: '' }] };
const pi = { agent: 'pi', config_mode: 'lush' };

for (const mode of ['human', 'automatic', 'dismiss']) test(`${mode} questionnaire resumes only after actual exit, without capturing code or context`, async () => {
  const exiting = gate(), received = [];
  let f, notice, captures = 0;
  f = fixture({ async run({ task, api, messages }) {
    if (task.calls > 1) { received.push(messages); return 'continued'; }
    const run = api.running.get(task.id); run.agent = { ...run.agent, ...pi };
    const session = path.join(f.config.home, 'sessions', `test_lush-task-${task.id}.jsonl`);
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.writeFileSync(session, [
      { type: 'session', version: 3, id: 'source', cwd: task.workspace },
      { type: 'message', id: 'before', parentId: null, message: { role: 'user', content: 'before choice' } },
    ].map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(path.join(f.config.home, 'sessions', `task-${task.id}-context.json`),
      JSON.stringify({ task_id: task.id, run_id: run.recordId, session, entry: 'before' }));
    fs.writeFileSync(path.join(task.workspace, 'file.txt'), 'dirty choice code\n');
    fs.writeFileSync(path.join(task.workspace, 'new.txt'), 'untracked choice code\n');
    notice = api.notice(task.id, '选择方案', '背景', 'question', questions);
    await exiting.promise;
    return 'parked';
  } });
  try {
    await repo(f.root);
    f.project.workspaces.captureChoiceSnapshot = async () => { captures++; throw new Error('must not capture'); };
    if (mode === 'automatic') f.project.setDaemonAutoSelect(true, f.project.daemonHooks().revision);
    const source = (await f.project.order('implement', null, [], null, false)).task;
    const head = await git(source.workspace, 'rev-parse', 'HEAD'), index = await git(source.workspace, 'write-tree');
    f.project.resumeTask(source.id);
    await until(() => notice);
    if (mode !== 'automatic') f.project.answer(notice.id, mode === 'dismiss' ? '' : answer, mode === 'dismiss');
    expect(f.project.running.has(source.id)).toBe(true);
    expect(f.store.task(source.id).calls).toBe(1);
    exiting.resolve();
    await until(() => received.length === 1 && !f.project.running.has(source.id));
    const stored = f.store.get('SELECT * FROM notices WHERE id=?', notice.id);
    expect(stored.status).toBe(mode === 'dismiss' ? 'dismissed' : 'answered');
    expect(stored.answer_source).toBe(mode === 'automatic' ? 'lush' : 'user');
    expect(received[0].some(message => JSON.parse(message.body).notice_id === notice.id)).toBe(true);
    expect(captures).toBe(0);
    expect(f.store.all('SELECT * FROM choice_snapshots')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM choice_rechoices')).toHaveLength(0);
    expect(await git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/lush/choice-snapshots')).toBe('');
    for (const dir of ['choice-snapshots', 'choice-contexts']) expect(fs.existsSync(path.join(f.config.home, dir))).toBe(false);
    expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(source.workspace, 'write-tree')).toBe(index);
    expect(fs.readFileSync(path.join(source.workspace, 'file.txt'), 'utf8')).toBe('dirty choice code\n');
    expect(fs.readFileSync(path.join(source.workspace, 'new.txt'), 'utf8')).toBe('untracked choice code\n');
    for (const method of ['prepareChoiceSnapshot', 'finishChoiceSnapshot', 'noticeSnapshot', 'rechooseNotice'])
      expect(f.project[method]).toBeUndefined();
  } finally { exiting.resolve(); await f.close(); }
});

async function historical() {
  const f = fixture({ async run() { return 'idle'; } });
  f.project.kick = () => {};
  await repo(f.root);
  const source = (await f.project.order('historical source', null, [], null, false)).task;
  const notice = f.project.notice(source.id, 'historical choice', '', 'question', questions);
  f.project.answer(notice.id, answer);
  const route = (await f.project.order('historical route', null, [], null, false)).task;
  const bytes = Buffer.from('{}\n'), digest = choiceDigest(bytes);
  const capture = await f.project.workspaces.captureChoiceSnapshot(source, notice.id);
  writeChoiceFile(f.config.home, choiceContextPath(f.config.home, notice.id), bytes);
  writeChoiceFile(f.config.home, choiceForkPath(f.config.home, route.id), bytes);
  f.store.run(`INSERT INTO choice_snapshots(notice_id,task_id,status,revision,commit_hash,context_digest)
    VALUES (?,?,'ready','legacy',?,?)`, notice.id, source.id, capture.commit, digest);
  f.store.run(`INSERT INTO choice_rechoices(request_id,notice_id,revision,answer,status,task_id,context_digest)
    VALUES (?,?,'legacy',?,'created',?,?)`, randomUUID(), notice.id, f.store.get('SELECT answer FROM notices WHERE id=?', notice.id).answer, route.id, digest);
  return { ...f, source, route, notice, capture };
}

test('retirement preserves ready historical resources and existing route context with strict mode validation', async () => {
  const f = await historical();
  try {
    const before = f.store.get('SELECT * FROM choice_snapshots');
    f.project.recoverChoiceSnapshots();
    expect(f.store.get('SELECT * FROM choice_snapshots')).toEqual(before);
    expect(f.project.choiceFork(f.route.id, pi).file).toBe(choiceForkPath(f.config.home, f.route.id));
    expect(f.project.choiceReselectionContext(f.route.id).answer.answers[0].labels).toEqual(['B']);
    expect(() => f.project.choiceFork(f.route.id, { agent: 'mock' })).toThrow('Pi/Lush');
    expect(() => f.project.choiceFork(f.route.id, { ...pi, config_mode: 'pi' })).toThrow('Pi/Lush');
    expect(await git(f.root, 'rev-parse', `refs/lush/choice-snapshots/${f.notice.id}`)).toBe(f.capture.commit);
  } finally { await f.close(); }
});

test('historical pending captures expire and incomplete route receipts remain protected, never replayed', async () => {
  const f = await historical();
  try {
    f.store.run("UPDATE choice_snapshots SET status='pending',pointer='{}'");
    f.store.run("UPDATE choice_rechoices SET status='creating'");
    expect(f.project.choiceRouteCreating(f.route.id)).toBe(true);
    f.project.recoverChoiceSnapshots();
    const snapshot = f.store.get('SELECT * FROM choice_snapshots');
    expect(snapshot.status).toBe('unavailable'); expect(snapshot.pointer).toBeNull();
    expect(snapshot.reason).toContain('已停用');
    expect(f.store.get('SELECT status FROM choice_rechoices').status).toBe('unknown');
    expect(f.store.task(f.route.id).status).toBe('failed');
    expect(() => f.project.choiceFork(f.route.id, pi)).toThrow('副作用未知');
    expect(fs.existsSync(choiceForkPath(f.config.home, f.route.id))).toBe(true);
    expect(await git(f.root, 'rev-parse', `refs/lush/choice-snapshots/${f.notice.id}`)).toBe(f.capture.commit);
  } finally { await f.close(); }
});

test('historical external routes still block source deletion; explicit deletion reclaims only owned resources', async () => {
  const f = await historical();
  try {
    f.project.cancel(f.source.id, 'cleanup'); f.project.cancel(f.route.id, 'cleanup');
    const blocked = await f.project.deleteTaskPreview(f.source.id);
    expect(blocked.can_delete).toBe(false); expect(blocked.blockers.join()).toContain('choice snapshot');
    const route = await f.project.deleteTaskPreview(f.route.id);
    expect(route.can_delete).toBe(true);
    expect(route.resources.files).toContain(choiceForkPath(f.config.home, f.route.id));
    await f.project.deleteTask(f.route.id, { revision: route.revision, confirm: true });
    const source = await f.project.deleteTaskPreview(f.source.id);
    expect(source.can_delete).toBe(true);
    expect(source.resources.branches).toContain(`refs/lush/choice-snapshots/${f.notice.id}`);
    expect(source.resources.files).toContain(choiceContextPath(f.config.home, f.notice.id));
    await f.project.deleteTask(f.source.id, { revision: source.revision, confirm: true });
    expect(f.store.all('SELECT * FROM choice_snapshots')).toHaveLength(0);
    await expect(git(f.root, 'rev-parse', '--verify', `refs/lush/choice-snapshots/${f.notice.id}`)).rejects.toThrow();
  } finally { await f.close(); }
});
