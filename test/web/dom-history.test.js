import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, allByTag } from '../dom-stub.js';

// 结算提醒（notice.opened + data.kind='info'）在任务历史里显示成「提醒」，
// 普通问答 notice 保持「向你提问」。只有这一处显示变化，别的事件语义不变。
const dom = installDom({ fetch: async () => new Response('{}') });
const { renderHistory } = await import('../../src/ui/web/assets/render-history.js');
afterAll(() => dom.restore());

test('kind=info 的 notice.opened 显示为「提醒」，question 仍是「向你提问」', () => {
  const at = new Date().toISOString();
  const list = renderHistory([
    { id: 1, type: 'notice.opened', created_at: at,
      data: { notice_id: 9, title: '分支 lush/ns/3-work：任务 #3 已完成', kind: 'info' } },
    { id: 2, type: 'notice.opened', created_at: at, data: { notice_id: 10, title: '要继续吗？', kind: 'question' } },
    { id: 3, type: 'completed', created_at: at, data: { result: 'done' } },
  ]);
  const text = deepText(list);
  expect(text).toContain('提醒');
  expect(text).toContain('向你提问');
  expect(text).toContain('分支 lush/ns/3-work：任务 #3 已完成');
  expect(text).toContain('完成');
});

test('事件历史明确显示截断，并可连续向前加载多页', async () => {
  const at = new Date().toISOString();
  const pages = [
    { events: [{ id: 2, type: 'tick', created_at: at, data: { page: 2 } }], cursor: 2, truncated: true },
    { events: [{ id: 1, type: 'tick', created_at: at, data: { page: 1 } }], cursor: 1, truncated: false },
  ];
  const list = renderHistory([{ id: 3, type: 'tick', created_at: at, data: { page: 3 } }], {
    truncated: true, cursor: 3, onMore: async () => pages.shift(), taskId: 9,
  });
  expect(deepText(list)).toContain('更早记录尚未加载');
  await allByTag(list, 'button')[0].onclick();
  expect(deepText(list)).toContain('最近 2 条');
  await allByTag(list, 'button')[0].onclick();
  expect(deepText(list)).not.toContain('尚未加载');
  expect([...list.children].filter(node => node.tagName === 'LI')).toHaveLength(3);
});

// 任务信号事件只带 message_id，正文在后端附上的 event.message 里；时间线要把内容显示出来。
test('信号事件显示被引用消息的正文与来源，而不是只有 message_id', () => {
  const at = new Date().toISOString();
  const body = JSON.stringify({ version: 1, signal: 'child.completed', key: 'child:7:settlement:3',
    source_task_id: 7, target_task_id: 1, payload: { result: '子任务完成的结果正文', commit: 'abc1234' } });
  const list = renderHistory([{ id: 9, type: 'task.signal', created_at: at,
    data: { message_id: 4, source_task_id: 7, signal: 'child.completed', key: 'child:7:settlement:3' },
    message: { id: 4, task_id: 1, sender_id: 7, signal_type: 'child.completed', body } }], { taskId: 1 });
  const text = deepText(list);
  expect(text).toContain('子任务完成');
  expect(text).toContain('来自任务 #7');
  expect(text).toContain('信号 child.completed');
  expect(text).toContain('子任务完成的结果正文');
  expect(text).not.toContain('message_id');
});

// 源任务自己记的合并请求信号是「发给父任务」；普通文本消息仍显示正文并标出来源。
test('时间线区分消息方向，普通消息按原文显示', () => {
  const at = new Date().toISOString();
  const list = renderHistory([
    { id: 5, type: 'task.merge_requested', created_at: at, data: { branch: 'lush/x/23-work', commit: 'abc1234', message_id: 8 },
      message: { id: 8, task_id: 1, sender_id: 23, signal_type: 'merge.requested',
        body: JSON.stringify({ version: 1, signal: 'merge.requested', key: 'k', source_task_id: 23, target_task_id: 1,
          payload: { branch: 'lush/x/23-work', commit: 'abc1234', baseline: 'def5678' } }) } },
    { id: 6, type: 'message', created_at: at, data: { sender: null, body: '请继续处理这个边界情况' } },
  ], { taskId: 23 });
  const text = deepText(list);
  expect(text).toContain('发给任务 #1');
  expect(text).toContain('信号 merge.requested');
  expect(text).toContain('lush/x/23-work');
  expect(text).toContain('来自你');
  expect(text).toContain('请继续处理这个边界情况');
});
