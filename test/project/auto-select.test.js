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
