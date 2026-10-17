import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { renderWorkerTimeline } from '../../src/ui/web/assets/render-worker-timeline.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const at = '2026-10-12T11:30:00Z';
const worker = { id: 7, worker_number: 'W232', role: 'agent', task_kind: 'order', status: 'running', calls: 0,
  goal: '详情阅读', created_at: at, updated_at: at, deps: [], dependents: [], children: [] };

test('detail separates input/output from timeline, and a timeline reference reveals its original event', async () => {
  const dom = installDom(); resetUiState(); ui.view = { id: 'task', key: 'task-7' };
  ui.hostSession = { status: 'ready', username: '用户' };
  try {
    const patches = renderDetail(worker, { events: [] }, null, null, null, { current: () => true });
    try {
      const titles = dom.node('detail').querySelectorAll('h2').map(node => node.textContent);
      expect(titles.indexOf('输入输出')).toBeLessThan(titles.indexOf('时间线'));
      expect(dom.node('detail').querySelectorAll('.conversation-panel')).toHaveLength(1);
      const conversation = dom.node('detail').querySelector('.conversation-panel');
      patches.update('history', { events: [{ id: 9, type: 'invocation.completed', created_at: at, data: { run_id: 3, result: '阅读结果' } }] }, true);
      expect(dom.node('detail').querySelector('.conversation-panel')).toBe(conversation);
      expect(deepText(conversation)).toContain('阅读结果');
    } finally { patches.dispose(); }
    const timeline = renderWorkerTimeline(worker, { events: [{ id: 10, task_id: 7, type: 'invocation.started', created_at: at, data: { reason: '开始处理' } }] });
    const event = await timeline.revealTimelineReference({ kind: 'history_event', target: { task_id: 7, event_id: 10 } });
    expect(event.expanded).toBe(true); expect(deepText(event)).toContain('开始处理');
    timeline.updateTimeline(worker); expect(timeline.querySelector('[data-lifecycle-record="event:10"]')).toBe(event);
  } finally { resetUiState(); dom.restore(); }
});
