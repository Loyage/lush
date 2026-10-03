import { test, expect, afterAll } from 'bun:test';
import { installDom, findByText } from '../dom-stub.js';
import { makeWorld, NOW, iso } from './dom-world.js';

// 旧 Notice 仍可读取；不再手动挂载休眠面板或模拟已移除的 worker.merge_many。
const world = makeWorld();
const dom = installDom({ fetch: world.fetchImpl });
const { noticePanel } = await import('../../src/ui/web/assets/render-notices.js');
afterAll(() => dom.restore());

test('resolver 的首次 notice 使用明确动作，不再让“任意回复”承担批准语义', () => {
  const panel = noticePanel({ id: 99, task_id: 5, status: 'open', kind: 'question', title: '要开解冲突任务吗？', body: '冲突文件：a.js', created_at: iso(NOW) },
    { id: 5, role: 'merger', resolves_task_id: 2, agent_wakes: 0 });
  expect(panel.querySelector('textarea')).toBeNull();
  expect(findByText(panel, '开始解冲突')).toBeTruthy();
  expect(findByText(panel, '暂不处理')).toBeTruthy();
});
