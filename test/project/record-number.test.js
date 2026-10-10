import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { checkDraftRevision } from '../../src/core/project/input-history.js';

const questions = [{ header: '路线', question: '选择哪条路线？', options: [
  { label: 'A', description: '路线 A' }, { label: 'B', description: '路线 B' },
] }];

test('new questionnaire waiting report uses D while IDs and historical Notice text stay unchanged', async () => {
  const f = fixture();
  f.project.stopping = true;
  try {
    const task = f.store.create({ role: 'agent', goal: 'choose' });
    const suspend = f.project.suspendTaskMerge, reasons = [];
    f.project.suspendTaskMerge = function (taskId, reason) {
      reasons.push(reason);
      return suspend.call(this, taskId, reason);
    };
    const notice = f.project.notice(task.id, 'historical #1', 'body #1', 'question', questions);
    expect(notice.kind).toBe('questionnaire');
    expect(f.store.task(task.id).result).toBe(`等待用户回答待决问题 D${notice.id}。`);
    expect(reasons).toEqual([`等待用户回答问卷 D${notice.id}`]);
    expect(notice.id).toBeNumber();
    expect(JSON.parse(notice.body).body).toBe('body #1');
    f.project.answer(notice.id, { answers: [{ selected: [0] }] });
    const message = JSON.parse(f.store.unread(task.id).at(-1).body);
    expect(message).toMatchObject({ notice_id: notice.id, notice_kind: 'questionnaire', title: 'historical #1', answer_source: 'user' });
    expect(message.notice_id).toBeNumber();
    expect(f.store.get('SELECT title FROM notices WHERE id=?', notice.id).title).toBe('historical #1');
  } finally { await f.close(); }
});

test('plain question answers carry explicit kind; historical plans cannot be answered via retired CLI advice', async () => {
  const f = fixture();
  f.project.stopping = true;
  try {
    const task = f.store.create({ role: 'agent', goal: 'question' });
    const question = f.project.notice(task.id, 'Question');
    f.project.answer(question.id, 'yes');
    expect(JSON.parse(f.store.unread(task.id)[0].body)).toMatchObject({ notice_id: question.id, notice_kind: 'question', answer: 'yes' });
    const plan = f.project.notice(task.id, 'old plan', 'unchanged #2', 'plan');
    expect(() => f.project.answer(plan.id, 'yes')).toThrow(`Notice D${plan.id} is a historical plan approval`);
    expect(f.store.get('SELECT body,status FROM notices WHERE id=?', plan.id)).toEqual({ body: 'unchanged #2', status: 'open' });
  } finally { await f.close(); }
});

test('input errors show O identity without renumbering drafts or changing their stored integer references', async () => {
  expect(() => checkDraftRevision({ id: 5, input_id: 19, revision: 1 }, 1)).toThrow('draft 5 was already submitted as input O19');
  const f = fixture();
  try {
    expect(() => f.project.inputGet('input', 19)).toThrow('input O19 not found');
    expect(() => f.project.inputGet('draft', 5)).toThrow('draft 5 not found');
  } finally { await f.close(); }
});
