import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText, allByTag } from '../dom-stub.js';

// 中文标题为主，原始事件代码始终可见；提醒与待决问答保持不同语义。
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
  expect(allByTag(list, 'strong').map(node => node.textContent)).toEqual(['提醒', '向你提问', '完成']);
  expect(allByTag(list, 'code').map(node => node.textContent)).toEqual(['notice.opened', 'notice.opened', 'completed']);
  expect(text).toContain('提醒');
  expect(text).toContain('向你提问');
  expect(text).toContain('分支 lush/ns/3-work：任务 #3 已完成');
  expect(text).toContain('完成');
});

test('时间线以中文为主标题，同时保留独立的次要代码字段和事件数据', () => {
  const events = ['task.reserved', 'merge.enqueued', 'task.merge_integrated', 'invocation.started'].map((type, index) => ({
    id: index + 1, type, created_at: new Date().toISOString(), data: { marker: '原始字段', call: 2 },
  }));
  const before = JSON.stringify(events);
  const list = renderHistory(events);
  const labels = ['已预约合并', '合并请求已入队', '已合入父分支', '开始调用'];
  [...list.children].forEach((item, index) => {
    const head = item.children[0];
    expect(head.className).toBe('t-head');
    expect(head.children[0].tagName).toBe('STRONG');
    expect(head.children[0].textContent).toBe(labels[index]);
    expect(head.children[1].tagName).toBe('CODE');
    expect(head.children[1].className).toBe('t-code');
    expect(head.children[1].textContent).toBe(events[index].type);
  });
  expect(JSON.stringify(events)).toBe(before);
  expect(deepText(list)).toContain('原始字段');
});

test('未知事件明确降级为未识别，原始代码按文本安全显示', () => {
  const type = '<script>alert(1)</script>.unknown';
  const list = renderHistory([{ type, created_at: new Date().toISOString(), data: {} }]);
  expect(allByTag(list, 'strong')[0].textContent).toBe('未识别事件');
  expect(allByTag(list, 'code')[0].textContent).toBe(type);
  expect(allByTag(list, 'script')).toHaveLength(0);
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
  expect(text).toContain('Worker 信号');
  expect(text).toContain('子任务完成');
  expect(text).toContain('来自 Worker #7');
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
  expect(text).toContain('发给 Worker #1');
  expect(text).toContain('信号 merge.requested');
  expect(text).toContain('lush/x/23-work');
  expect(text).toContain('来自你');
  expect(text).toContain('请继续处理这个边界情况');
});
