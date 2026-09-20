import { test, expect } from 'bun:test';
import { fixture } from '../helpers.js';
import { Dispatcher } from '../../src/rpc/protocol.js';
import { createSignal } from '../../src/signal.js';

/** 直接造一个「有自己分支」的 worker：这些用例只验证结算提醒，不碰 git，所以手动写分支字段。 */
function workerTask(f, patch = {}) {
  const task = f.store.create({ input_id: null, role: 'worker', name: 'notice-info',
    goal: '实现结算提醒：任务结算时落一条不需要回复的提醒' });
  f.store.update(task.id, { status: 'waiting', branch: 'lush/ns/108-notice-info',
    target_branch: 'lush/ns/input-11', base_commit: 'a'.repeat(40), integration: 'pending', ...patch });
  return f.store.task(task.id);
}
const noticesOf = (f, taskId) => f.store.all('SELECT * FROM notices WHERE task_id=? ORDER BY id', taskId);

test('worker completed 落且只落一条 info 提醒，写清分支、父分支、状态与是否要处理', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const task = workerTask(f);
    f.project.finish(task.id, 'completed', 'done');
    const rows = noticesOf(f, task.id);
    expect(rows).toHaveLength(1);
    const [note] = rows;
    expect(note.kind).toBe('info');
    expect(note.status).toBe('sent');
    expect(note.title).toContain(task.branch);
    expect(note.title).toContain(`#${task.id}`);
    expect(note.title).toContain('已完成');
    expect(note.body).toContain(`任务 #${task.id}`);
    expect(note.body).toContain('worker');
    expect(note.body).toContain(task.branch);
    expect(note.body).toContain(task.target_branch);
    expect(note.body).toContain('已完成');
    expect(note.body).toContain('尚未合入父分支');
    // 事件带 kind: info，历史才能把它显示成「提醒」而不是「向你提问」。
    const event = f.store.history(task.id).find(row => row.type === 'notice.opened');
    expect(event.data).toMatchObject({ notice_id: note.id, kind: 'info' });
    // 已合入父分支时口径改成「不需要你处理」。
    const merged = workerTask(f, { integration: 'merged' });
    f.project.finish(merged.id, 'completed', 'done');
    expect(noticesOf(f, merged.id)[0].body).toContain('已合入父分支，不需要你处理');
  } finally { await f.close(); }
});

test('failed 落提醒、cancelled 不落、无分支的 planner 不落', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const failed = workerTask(f);
    f.project.cancel(failed.id, 'boom', 'failed');
    expect(noticesOf(f, failed.id).map(row => [row.kind, row.status])).toEqual([['info', 'sent']]);
    expect(noticesOf(f, failed.id)[0].body).toContain('失败');

    const cancelled = workerTask(f);
    f.project.cancel(cancelled.id, 'user cancelled');
    expect(noticesOf(f, cancelled.id)).toEqual([]);

    const planner = f.store.create({ input_id: null, role: 'planner', goal: '拆解一条需求' });
    f.store.update(planner.id, { status: 'waiting' });
    f.project.finish(planner.id, 'completed', 'planned');
    expect(noticesOf(f, planner.id)).toEqual([]);
  } finally { await f.close(); }
});

test('提醒不进待决口径：status.notices 不涨，answer / dismiss 被拒且不唤醒任务', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const task = workerTask(f);
    f.project.finish(task.id, 'completed', 'done');
    const before = f.project.status().notices;
    expect(before).toBe(0);
    for (let i = 0; i < 3; i++) f.project.notify(task.id, `再来一条 ${i}`, 'body');
    expect(f.project.status().notices).toBe(0);

    const note = noticesOf(f, task.id)[0];
    expect(() => f.project.answer(note.id, 'hi')).toThrow('not open');
    expect(() => f.project.answer(note.id, '', true)).toThrow('not open');
    expect(f.store.get('SELECT status FROM notices WHERE id=?', note.id).status).toBe('sent');
    expect(f.store.task(task.id).status).toBe('completed');
    expect(f.project.running.size).toBe(0);
  } finally { await f.close(); }
});

test('结算时已有 open question 仍按原逻辑 dismissed，同一次结算的 info 不受影响', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const task = workerTask(f);
    const question = f.project.notice(task.id, '要继续吗？', '需要你的判断');
    f.project.finish(task.id, 'completed', 'done');
    const rows = noticesOf(f, task.id);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.kind === 'question')).toMatchObject({ id: question.id, status: 'dismissed' });
    expect(rows.find(row => row.kind === 'info')).toMatchObject({ status: 'sent' });
  } finally { await f.close(); }
});

test('retry 后再次结算算新的一条提醒', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const task = workerTask(f);
    f.project.cancel(task.id, 'boom', 'failed');
    expect(noticesOf(f, task.id)).toHaveLength(1);
    f.project.stopping = true; // 只测结算，不让 retry 真的把任务跑起来
    f.project.retry(task.id);
    f.project.finish(task.id, 'completed', 'done');
    expect(noticesOf(f, task.id).map(row => row.kind)).toEqual(['info', 'info']);
  } finally { await f.close(); }
});

test('notice.list 仍返回 info 行，200 条提醒也挤不掉那条 open 问题', async () => {
  const f = fixture({ async run() { return 'ok'; } });
  try {
    const settled = workerTask(f);
    f.project.finish(settled.id, 'completed', 'done');
    for (let i = 0; i < 200; i++) f.project.notify(settled.id, `提醒 ${i}`, 'body');

    const holder = f.store.create({ input_id: null, role: 'worker', name: 'holder', goal: '还停在等你答复' });
    f.store.update(holder.id, { status: 'waiting' });
    const question = f.project.notice(holder.id, '需要你决定');

    const list = await new Dispatcher(f.project, createSignal(), {}).dispatch('notice.list', {});
    expect(list).toHaveLength(200);
    expect(list[0]).toMatchObject({ id: question.id, status: 'open', kind: 'question' });
    expect(list.some(row => row.kind === 'info' && row.status === 'sent')).toBe(true);
    // 排序口径与 LIMIT 200 不变：待决问题排在最前，info 只是填充列表。
    expect(f.project.status().notices).toBe(1);
  } finally { await f.close(); }
});
