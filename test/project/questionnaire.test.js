import { test, expect } from 'bun:test';
import { fixture, repo, until, gate } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';
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

test('questionnaire validates shape, limits, options and complete answers before mutation', () => {
  const body = questionnaire('Context', questions());
  expect(JSON.parse(body)).toMatchObject({ version: 1, body: 'Context' });
  expect(questionnaireAnswer(body, answer()).answers[0]).toMatchObject({ question: 'Which layout?', selected: [1], labels: ['Tabs'], custom: '' });
  expect(questionnaireAnswer(body, { answers: [{ selected: [], custom: '  Neither: use a drawer  ' }, { selected: [0] }] }).answers[0].custom).toBe('Neither: use a drawer');
  for (const invalid of [null, [], [...questions(), ...questions(), ...questions()], [{ ...questions()[0], multiSelect: 'yes' }],
    [{ ...questions()[0], options: [questions()[0].options[0]] }], [{ ...questions()[0], surprise: true }],
    [{ ...questions()[0], options: questions()[0].options.map(o => ({ ...o, label: 'Other' })) }],
    [{ ...questions()[0], options: questions()[0].options.map(o => ({ ...o, label: 'same' })) }]]) {
    expect(() => questionnaire('', invalid)).toThrow();
  }
  const tooLarge = questions(); tooLarge.forEach(q => q.options.forEach(o => { o.previewHtml = '中'.repeat(16000); }));
  expect(() => questionnaire('', tooLarge)).toThrow('64000 bytes');
  for (const invalid of ['A', {}, { answers: [] }, { answers: [{ selected: [2] }, { selected: [0] }] },
    { answers: [{ selected: [0, 1] }, { selected: [0] }] }, { answers: [{ selected: [0] }, { selected: [0, 0] }] },
    { answers: [{ selected: [0], custom: 'ambiguous' }, { selected: [0] }] },
    { answers: [{ selected: [], custom: '   ' }, { selected: [0] }] },
    { answers: [{ selected: [0], labels: ['spoof'] }, { selected: [0] }] }]) {
    expect(() => questionnaireAnswer(body, invalid)).toThrow();
  }
});

test('posting stops the invocation, releases its slot, gates other messages, and resumes with canonical answers', async () => {
  const provider = controlled(), f = fixture(provider, { LUSH_CONCURRENCY: '1' });
  try {
    await repo(f.root);
    const task = (await f.project.submit('choose')).task;
    const other = (await f.project.submit('independent')).task;
    await until(() => provider.calls.length === 1);
    const token = f.project.running.get(task.id).token;
    const rpc = new Dispatcher(f.project, createSignal(), {});
    await expect(rpc.dispatch('notice.post', { _token: token, task: other.id, title: 'spoof', questions: questions() })).rejects.toThrow('own task');
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
    await until(() => f.store.task(task.id).status === 'completed');
  } finally { await f.close(); }
});

test('answer during abort unwinding is not lost; cancellation still wins', async () => {
  const calls = [], f = fixture({ run(ctx) { const done = gate(); calls.push({ ...ctx, done }); return done.promise; } });
  try {
    await repo(f.root);
    const task = (await f.project.submit('race')).task;
    await until(() => calls.length === 1);
    const notice = f.project.notice(task.id, 'Choose', '', 'question', questions());
    f.project.answer(notice.id, answer());
    expect(f.project.running.has(task.id)).toBe(true);
    calls[0].done.resolve('aborted output must not replace waiting result');
    await until(() => calls.length === 2);
    expect(calls[1].messages.length).toBe(1);
    const next = f.project.notice(task.id, 'Choose again', '', 'question', questions());
    f.project.cancel(task.id);
    calls[1].done.resolve('aborted');
    await until(() => !f.project.running.size);
    expect(f.store.task(task.id).status).toBe('cancelled');
    expect(() => f.project.answer(next.id, answer())).toThrow('not open');
  } finally { for (const c of calls) c.done.resolve('stop'); await f.close(); }
});

test('awaiting questionnaires survive shutdown/recovery, unrelated inbox does not unblock; dismissal is explicit', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    await repo(f.root);
    const task = (await f.project.submit('recover')).task;
    await until(() => provider.calls.length === 1);
    const notice = f.project.notice(task.id, 'Choose', '', 'question', questions());
    f.project.message(task.id, 'extra');
    await f.project.shutdown();
    expect(f.store.task(task.id).status).toBe('awaiting');
    f.project.recover(); // also exercises the durable gate when no invocation exists
    expect(f.store.task(task.id).status).toBe('awaiting');
    expect(f.store.get('SELECT status FROM notices WHERE id=?', notice.id).status).toBe('open');
    f.project.stopping = false;
    f.project.answer(notice.id, '', true);
    await until(() => provider.calls.length === 2);
    expect(JSON.parse(provider.calls[1].messages.at(-1).body)).toMatchObject({ dismissed: true, answer: '' });
    provider.calls[1].done.resolve('did not implement an unapproved choice');
  } finally { await f.close(); }
});

test('a child completing cannot wake a parent gated on a questionnaire', async () => {
  const provider = controlled(), f = fixture(provider);
  try {
    const parent = f.store.create({ role: 'coordinator', goal: 'parent' }); f.project.kick();
    await until(() => provider.calls.length === 1);
    const child = f.project.spawn(parent.id, 'child', 'research');
    await until(() => provider.calls.length === 2);
    const notice = f.project.notice(parent.id, 'Choose', '', 'question', questions());
    provider.calls.find(c => c.task.id === child.id).done.resolve('child result');
    await until(() => f.project.running.size === 0);
    expect(f.store.task(parent.id).status).toBe('awaiting');
    f.project.answer(notice.id, answer());
    await until(() => provider.calls.length === 3);
    expect(provider.calls[2].messages.length).toBe(2);
    provider.calls[2].done.resolve('done');
  } finally { await f.close(); }
});
