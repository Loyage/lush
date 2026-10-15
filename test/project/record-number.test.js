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
