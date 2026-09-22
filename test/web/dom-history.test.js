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
