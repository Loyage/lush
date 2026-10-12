import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { settleNoticeAnswer } from '../../src/core/project/messages.js';

const questions = [{ header: '权限', question: '是否执行本次操作？', options: [
  { label: '批准', description: '仅批准固定操作与参数' }, { label: '拒绝', description: '不执行' },
] }];
function setup() {
  const f = fixture(); f.project.stopping = true; f.project.kick = () => {};
  const task = f.store.create({ role: 'manager', task_kind: 'management', goal: 'manage current project' });
  return { ...f, task };
}

test('receipt-backed confirmation resolves after answer provenance commits without waking a model', async () => {
  const f = setup();
  try {
    const notice = f.project.notice(f.task.id, '危险操作', '', 'question', questions);
    const resolved = [], wakes = [];
    f.project.wake = id => wakes.push(id);
    f.project.resolveManagementConfirmation = id => {
      const row = f.store.get('SELECT * FROM notices WHERE id=?', id);
      expect(f.store.db.inTransaction).toBe(false);
      expect(row.status).toBe('answered'); expect(row.answer_source).toBe('user');
      expect(JSON.parse(row.answer).answers[0].selected).toEqual([0]);
      expect(f.store.get("SELECT id FROM events WHERE type='notice.answered' AND task_id=?", f.task.id)).not.toBeNull();
      resolved.push(id); return true;
    };
    const result = settleNoticeAnswer(f.project, notice.id, { answers: [{ selected: [0] }] });
    expect(result.status).toBe('answered'); expect(resolved).toEqual([notice.id]); expect(wakes).toEqual([]);
    expect(() => settleNoticeAnswer(f.project, notice.id, { answers: [{ selected: [0] }] })).toThrow('not open');
    expect(resolved).toHaveLength(1);
  } finally { await f.close(); }
});

test('dismissed management confirmation also settles runtime request rather than calling the model', async () => {
  const f = setup();
  try {
    const notice = f.project.notice(f.task.id, '危险操作', '', 'question', questions);
    const wakes = [];
    f.project.wake = id => wakes.push(id);
    f.project.resolveManagementConfirmation = id => {
      expect(f.store.get('SELECT status,answer_source FROM notices WHERE id=?', id)).toEqual({ status: 'dismissed', answer_source: 'user' });
      return true;
    };
    settleNoticeAnswer(f.project, notice.id, '', true);
    expect(wakes).toEqual([]);
  } finally { await f.close(); }
});

test('unrecognized ordinary question retains normal wake semantics', async () => {
  const f = setup();
  try {
    const notice = f.project.notice(f.task.id, 'ordinary decision'); const wakes = [];
    f.project.wake = id => wakes.push(id); f.project.resolveManagementConfirmation = () => false;
    settleNoticeAnswer(f.project, notice.id, 'yes');
    expect(wakes).toEqual([f.task.id]);
  } finally { await f.close(); }
});

test('approved blocked management actions get a bounded deadline, unapproved confirmations are not polled', async () => {
  const f = setup();
  try {
    const state = { version: 1, enabled: true, pending_signal: { phase: 'returned' }, receipts: [],
      control_calls: [{ status: 'pending_confirmation' }] };
    f.store.update(f.task.id, { management: JSON.stringify(state) });
    expect(f.project.managementTimerDeadline(10000)).toBe(Infinity);
    state.control_calls[0].status = 'approved';
    f.store.update(f.task.id, { management: JSON.stringify(state) });
    expect(f.project.managementTimerDeadline(10000)).toBe(11000);
    state.control_calls[0].status = 'unknown';
    f.store.update(f.task.id, { management: JSON.stringify(state) });
    expect(f.project.managementTimerDeadline(10000)).toBe(Infinity);
  } finally { await f.close(); }
});

test('device automatic selection preserves exact dangerous confirmation as open, without swallowing ordinary questions', async () => {
  const f = setup();
  try {
    f.project.stopping = false;
    const protectedNotice = f.project.notice(f.task.id, 'Approval', '', 'question', questions);
    const ordinary = f.project.notice(f.task.id, 'Regular question');
    f.project.isManagementConfirmationNotice = id => id === protectedNotice.id;
    f.project.setDaemonAutoSelect(true, f.project.daemonHooks().revision);
    expect(f.project.autoAnswerNotice(protectedNotice.id)).toBe(false);
    expect(f.store.get('SELECT status,answer_source FROM notices WHERE id=?', protectedNotice.id)).toEqual({ status: 'open', answer_source: null });
    expect(f.store.get('SELECT status,answer_source FROM notices WHERE id=?', ordinary.id)).toEqual({ status: 'answered', answer_source: 'lush' });
    expect(f.store.all('SELECT * FROM messages WHERE task_id=?', f.task.id)).toHaveLength(1);
    expect(JSON.parse(f.store.all('SELECT * FROM messages WHERE task_id=?', f.task.id)[0].body).notice_id).toBe(ordinary.id);
  } finally { await f.close(); }
});
