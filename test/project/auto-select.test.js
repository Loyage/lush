import { test, expect, setDefaultTimeout } from 'bun:test';
import path from 'node:path';
import { fixture, repo, until, gate } from '../helpers.js';
import { Project } from '../../src/core/project.js';
import { Store } from '../../src/persistence/store.js';
import { NOTICE_SELECT } from '../../src/persistence/notice-projection.js';

setDefaultTimeout(20000);
const DELEGATE = '请由 Agent 自行判断并继续。';
const questions = () => [
  { header: '单选', question: '选哪项？', options: [
    { label: '第一项', description: '没有推荐标记也选第一项' }, { label: '第二项（推荐）', description: '不按标签猜测' },
  ] },
  { header: '多选', question: '选哪些？', multiSelect: true, options: [
    { label: '甲', description: '甲' }, { label: '乙', description: '乙' },
  ] },
];
function enable(f, value = true) { return f.project.setDaemonAutoSelect(value, f.project.daemonHooks().revision); }
async function automaticNotice(f, ...args) {
  const notice = f.project.notice(...args);
  await until(() => f.store.get('SELECT status FROM notices WHERE id=?', notice.id)?.status === 'answered');
  return f.store.get(`${NOTICE_SELECT} WHERE id=?`, notice.id);
}
function controlled(ignoreAbort = false) {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    if (!ignoreAbort) ctx.signal.addEventListener('abort', () => done.resolve('interrupted'), { once: true });
    return done.promise;
  } };
}
async function quiet() {
  const f = fixture(); f.project.kick = () => {}; await repo(f.root);
  const task = (await f.project.order('job', 'main', [], null, false)).task;
  return { ...f, task };
}

test('daemon Hook defaults off, reads are inert and authorization revision is independent of templates', async () => {
  const f = await quiet();
  try {
    const initial = f.project.hooksList();
    expect(initial.daemon_hooks.mounts[0]).toMatchObject({ id: 'auto-select', trigger: 'notice.received', enabled: false, mode: 'persistent', builtin: true });
    const notice = f.project.notice(f.task.id, 'Waiting', '', 'question', questions());
    expect(notice).toMatchObject({ status: 'open', answer_source: null });
    f.project.daemonHooks(); f.project.hooksList();
    expect(f.store.unread(f.task.id)).toHaveLength(0);
    const updated = enable(f);
    expect(updated.revision).toBe(initial.revision);
    expect(updated.daemon_hooks.revision).not.toBe(initial.daemon_hooks.revision);
    expect(() => f.project.setDaemonAutoSelect(false, initial.daemon_hooks.revision)).toThrow('revision changed');
    expect(() => f.project.setDaemonAutoSelect('true', updated.daemon_hooks.revision)).toThrow('boolean');
    const current = updated.daemon_hooks.revision;
    f.project.notice(f.task.id, 'Next', '', 'question', questions());
    expect(f.project.daemonHooks().revision).toBe(current);
  } finally { await f.close(); }
});

test('new single questions select the first option; multi and text answers delegate with persistent automatic provenance', async () => {
  const f = await quiet();
  try {
    enable(f);
    const notice = await automaticNotice(f, f.task.id, 'Choose', 'context', 'question', questions());
    expect(notice).toMatchObject({ status: 'answered', answer_source: 'lush' });
    expect(JSON.parse(notice.answer).answers).toMatchObject([
      { selected: [0], labels: ['第一项'], custom: '' }, { selected: [], labels: [], custom: DELEGATE },
    ]);
    const message = JSON.parse(f.store.unread(f.task.id)[0].body);
    expect(message).toMatchObject({ notice_id: notice.id, answer_source: 'lush', automatic: true, dismissed: false });
    expect(message.instruction).toContain('不是用户亲自决断');
    const event = f.store.get("SELECT data FROM events WHERE type='notice.answered' AND task_id=?", f.task.id);
    expect(JSON.parse(event.data).answer_source).toBe('lush');
    expect(f.store.get('SELECT answer_source FROM notices WHERE id=?', notice.id).answer_source).toBe('lush');
    expect(f.project.autoAnswerNotice(notice.id)).toBe(false);
    expect(f.store.unread(f.task.id)).toHaveLength(1);
    const text = await automaticNotice(f, f.task.id, 'Text question');
    expect(text).toMatchObject({ status: 'answered', answer: DELEGATE, answer_source: 'lush' });
    expect(f.project.daemonHooks().mounts[0].last_execution).toMatchObject({ notice_id: text.id, status: 'succeeded' });
    expect(f.store.task(f.task.id).status).toBe('paused'); // User pause is not overridden.
    enable(f, false);
    const manual = f.project.notice(f.task.id, 'Manual');
    expect(f.project.answer(manual.id, 'my decision', false, 'lush').answer_source).toBe('user'); // extra args cannot spoof origin
    const dismissed = f.project.notice(f.task.id, 'Ignore');
    expect(f.project.answer(dismissed.id, '', true).answer_source).toBe('user');
  } finally { await f.close(); }
});

test('explicit enable drains all existing questions in bounded batches, never plan/info/already answered', async () => {
  const f = await quiet();
  try {
    const existing = [];
    existing.push(f.project.notice(f.task.id, 'Choose', '', 'question', questions()).id);
    for (let i = 0; i < 40; i++) existing.push(f.project.notice(f.task.id, `Question ${i}`).id);
    const manual = f.project.notice(f.task.id, 'Manual answered'); f.project.answer(manual.id, 'keep me');
    const plan = f.project.notice(f.task.id, 'Plan approval', '', 'plan');
    const info = f.project.notify(f.task.id, 'Info');
    enable(f);
    await until(() => f.store.get("SELECT count(*) AS n FROM notices WHERE answer_source='lush'").n === existing.length);
    expect(f.store.get('SELECT status FROM notices WHERE id=?', plan.id).status).toBe('open');
    expect(f.store.get('SELECT status FROM notices WHERE id=?', info.id).status).toBe('sent');
    expect(f.store.get('SELECT answer,answer_source FROM notices WHERE id=?', manual.id)).toEqual({ answer: 'keep me', answer_source: 'user' });
    expect(f.store.unread(f.task.id)).toHaveLength(existing.length + 1);
  } finally { await f.close(); }
});

test('malformed legacy questionnaires stay open with a safe failed receipt rather than crashing background processing', async () => {
  const f = await quiet();
  try {
    for (let i = 0; i < 16; i++) f.project.notice(f.task.id, `Question ${i}`);
    const row = f.store.run("INSERT INTO notices(task_id,title,body,kind) VALUES (?,?,?,'questionnaire')", f.task.id, 'legacy malformed', '{private invalid body');
    enable(f);
    await until(() => f.project.daemonHooks().mounts[0].last_execution?.status === 'failed');
    const mount = f.project.daemonHooks().mounts[0];
    expect(mount).toMatchObject({ state: 'failed', last_execution: { notice_id: Number(row.lastInsertRowid), status: 'failed' } });
    expect(JSON.stringify(mount)).not.toContain('private invalid body');
    expect(f.store.get('SELECT status,answer_source FROM notices WHERE id=?', Number(row.lastInsertRowid))).toEqual({ status: 'open', answer_source: null });
    expect(f.store.unread(f.task.id)).toHaveLength(16);
  } finally { await f.close(); }
});

test('disabling cancels remaining queued backlog batches, not answers already committed', async () => {
  const f = await quiet();
  try {
    for (let i = 0; i < 40; i++) f.project.notice(f.task.id, `Question ${i}`);
    enable(f); enable(f, false);
    await Promise.resolve();
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE answer_source='lush'").n).toBe(16);
    expect(f.store.get("SELECT count(*) AS n FROM notices WHERE status='open'").n).toBe(24);
  } finally { await f.close(); }
});

test('automatic questionnaire aborts and resumes only after actual exit with one new token and no lost wakeup', async () => {
  const provider = controlled(true), f = fixture(provider, { LUSH_CONCURRENCY: '1' });
  try {
    await repo(f.root); enable(f);
    const task = (await f.project.order('race')).task;
    await until(() => provider.calls.length === 1);
    const oldToken = f.project.running.get(task.id).token;
    const notice = await automaticNotice(f, task.id, 'Choose', '', 'question', questions());
    expect(notice).toMatchObject({ status: 'answered', answer_source: 'lush' });
    expect(provider.calls[0].signal.aborted).toBe(true);
    expect(() => f.project.actor(oldToken)).toThrow();
    expect(f.project.running.size).toBe(1);
    await Promise.resolve(); expect(provider.calls.length).toBe(1);
    provider.calls[0].done.resolve('old output');
    await until(() => provider.calls.length === 2);
    expect(provider.calls[1].token).not.toBe(oldToken);
    expect(provider.calls[1].messages).toHaveLength(1);
    expect(JSON.parse(provider.calls[1].messages[0].body)).toMatchObject({ notice_id: notice.id, answer_source: 'lush' });
    provider.calls[1].done.resolve('continued');
    await until(() => f.store.task(task.id).status === 'waiting');
    expect(f.store.get("SELECT count(*) AS n FROM events WHERE task_id=? AND type='notice.answered'", task.id).n).toBe(1);
  } finally { for (const c of provider.calls) c.done.resolve('stop'); await f.close(); }
});

test('cancellation while automatic answer is unwinding never resurrects the Worker', async () => {
  const provider = controlled(true), f = fixture(provider);
  try {
    await repo(f.root); enable(f);
    const task = (await f.project.order('cancel race')).task;
    await until(() => provider.calls.length === 1);
    f.project.notice(task.id, 'Choose', '', 'question', questions());
    f.project.cancel(task.id);
    provider.calls[0].done.resolve('old');
    await until(() => !f.project.running.size);
    expect(f.store.task(task.id).status).toBe('cancelled'); expect(provider.calls).toHaveLength(1);
  } finally { for (const c of provider.calls) c.done.resolve('stop'); await f.close(); }
});

test('automatic settlement is transactional and respects frozen/sync/terminal gates', async () => {
  const f = await quiet();
  try {
    const notice = f.project.notice(f.task.id, 'existing');
    enable(f); // supply a second question with automatic configuration enabled below
    f.store.run("INSERT INTO notices(task_id,title,body,kind) VALUES (?,?,?,'question')", f.task.id, 'atomic', '');
    const atomic = f.store.get("SELECT id FROM notices WHERE title='atomic'");
    const original = f.store.message; f.store.message = () => { throw new Error('injected persistence failure'); };
    expect(() => f.project.autoAnswerNotice(atomic.id)).toThrow('injected'); f.store.message = original;
    expect(f.store.get('SELECT status,answer_source FROM notices WHERE id=?', atomic.id)).toEqual({ status: 'open', answer_source: null });
    f.store.update(f.task.id, { reservation: JSON.stringify({ version: 2, status: 'blocked' }) });
    expect(f.project.autoAnswerNotice(atomic.id)).toBe(false);
    f.store.update(f.task.id, { reservation: null });
    f.project.taskSyncBusy = new Set([f.task.id]);
    expect(f.project.autoAnswerNotice(atomic.id)).toBe(false);
    f.project.taskSyncBusy.clear(); f.store.update(f.task.id, { status: 'completed' });
    expect(f.project.autoAnswerNotice(atomic.id)).toBe(false);
    expect(f.store.get('SELECT status FROM notices WHERE id=?', notice.id).status).toBe('answered');
    f.project.stopping = true;
    expect(() => enable(f)).toThrow('stopping');
  } finally { await f.close(); }
});

test('persistent authorization survives new Project instances; recovery never replays unknown invocation effects', async () => {
  const f = await quiet();
  try {
    enable(f);
    const before = f.project.daemonHooks();
    f.store.update(f.task.id, { status: 'running' });
    await f.project.shutdown();
    const restarted = new Project(f.config, f.store); restarted.kick = () => {};
    try {
      expect(restarted.daemonHooks().revision).toBe(before.revision);
      restarted.recover();
      expect(f.store.task(f.task.id).status).toBe('failed');
      expect(restarted.running.size).toBe(0);
      expect(restarted.daemonHooks().mounts[0].enabled).toBe(true);
    } finally { await restarted.shutdown(); }
  } finally { await f.close(); }
});

test('old Notice schema gains nullable provenance without rewriting historical answers', async () => {
  const f = await quiet();
  try {
    f.store.run("INSERT INTO notices(task_id,title,body,kind,status,answer) VALUES (?,?,?,'question','answered',?)", f.task.id, 'legacy', '', 'historical');
    f.store.run('ALTER TABLE notices DROP COLUMN answer_source');
    const reopened = new Store(path.join(f.config.home, 'project.db'), f.root);
    try {
      expect(reopened.get("SELECT answer,answer_source FROM notices WHERE title='legacy'")).toEqual({ answer: 'historical', answer_source: null });
      expect(reopened.get(`${NOTICE_SELECT} WHERE title='legacy'`).answer_source).toBe('user');
    } finally { reopened.close(); }
  } finally { await f.close(); }
});
