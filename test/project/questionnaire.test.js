import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
import { Project } from '../../src/core/project.js';
import { questionnaire, questionnaireAnswer } from '../../src/core/questionnaire.js';

const questions = () => [
  { header: 'Layout', question: 'Which layout?', options: [
    { label: 'Sidebar (Recommended)', description: 'More room for categories', previewHtml: '<nav>Account</nav>' },
    { label: 'Tabs', description: 'Wider content', preview: 'Account | Security' },
  ] },
  { header: 'Features', question: 'Which features?', multiSelect: true, options: [
    { label: 'Search', description: 'Find settings' }, { label: 'Shortcuts', description: 'Keyboard control' },
  ] },
];
const answer = () => ({ answers: [{ selected: [1] }, { selected: [0, 1] }] });
function controlled() {
  const calls = [];
  return { calls, run(ctx) {
    const done = gate(); calls.push({ ...ctx, done });
    ctx.signal.addEventListener('abort', () => done.resolve('interrupted'), { once: true });
    return done.promise;
  } };
}

test('posting stops the invocation, releases its slot, gates other messages, and resumes with canonical answers', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '1' });
  try {
    await repo(f.root);
    const task = (await f.project.order('choose')).task;
    const other = (await f.project.order('independent')).task;
    await until(() => provider.calls.length === 1);
    const token = f.project.running.get(task.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('notice.post', { _token: token, task: other.id, title: 'spoof', questions: questions() })).rejects.toThrow('own worker');
    await expect(rpc.dispatch('notice.post', { _token: token, title: 'invalid', questions: [] })).rejects.toThrow();
    expect(f.store.task(task.id).status).toBe('running');
    const notice = await rpc.dispatch('notice.post', { _token: token, title: 'Choose', body: 'context', questions: questions() });
    expect(notice.kind).toBe('questionnaire');
    expect(f.project.status().notices).toBe(1);
    expect(provider.calls[0].signal.aborted).toBe(true);
    expect(f.store.task(task.id).status).toBe('awaiting');
    await expect(rpc.dispatch('task.list', { _token: token })).rejects.toThrow();
    await until(() => provider.calls.length === 2);
    expect(provider.calls[1].task.id).toBe(other.id);
    expect(f.project.running.has(task.id)).toBe(false);
    f.project.message(task.id, 'arrived while waiting');
    expect(f.store.task(task.id).status).toBe('awaiting');
    expect(f.store.unread(task.id).map(m => m.body)).toEqual(['arrived while waiting']);
    expect(() => f.project.notice(task.id, 'duplicate', '', 'question', questions())).toThrow('already');
    expect(() => f.project.answer(notice.id, 'free text')).toThrow();
    expect(f.store.get('SELECT status FROM notices WHERE id=?', notice.id).status).toBe('open');
    const otherToken = f.project.running.get(other.id).token;
    await expect(rpc.dispatch('notice.answer', { _token: otherToken, id: notice.id, answer: answer() })).rejects.toThrow('user approval');
    const settled = await rpc.dispatch('notice.answer', { id: notice.id, answer: answer() });
    expect(JSON.parse(settled.answer).answers[0].labels).toEqual(['Tabs']);
    expect(f.project.status().notices).toBe(0);
    expect(() => f.project.answer(notice.id, answer())).toThrow('not open');
    provider.calls[1].done.resolve('done');
    await until(() => provider.calls.length === 3);
    const resumed = provider.calls[2];
    expect(resumed.task.id).toBe(task.id);
    expect(resumed.messages.length).toBe(2);
    expect(resumed.messages[0].body).toBe('arrived while waiting');
    expect(JSON.parse(resumed.messages[1].body)).toMatchObject({ notice_id: notice.id, dismissed: false, answer: { answers: [{ labels: ['Tabs'] }, { labels: ['Search', 'Shortcuts'] }] } });
    expect(resumed.token).not.toBe(token);
    resumed.done.resolve('implemented choice');
    await until(() => f.store.task(task.id).status === 'waiting');
  } finally { await f.close(); }
});
