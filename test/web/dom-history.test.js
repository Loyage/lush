import { test, expect, afterAll } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';

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
