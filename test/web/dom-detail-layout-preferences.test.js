import { test, expect } from 'bun:test';
import { installDom, deepText, findByText } from '../dom-stub.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { registerNavigation } from '../../src/ui/web/assets/navigate.js';
import { renderWorkerTimeline } from '../../src/ui/web/assets/render-worker-timeline.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const at = '2026-10-12T11:30:00Z';
const worker = { id: 7, worker_number: 'W232', role: 'agent', task_kind: 'order', status: 'running', calls: 0,
  goal: '详情阅读', created_at: at, updated_at: at, deps: [], dependents: [], children: [] };

test('confirmed toolbar puts workbench first, groups safe work and folds low-frequency/danger controls', () => {
  const requests = [], dom = installDom({ fetch: url => { requests.push(url); throw Error('unexpected eager read'); } });
  resetUiState(); ui.view = { id: 'task', key: 'task-7' }; ui.hostSession = { status: 'ready', username: '用户' };
  const task = { ...worker, branch: 'work', workspace: '/tmp/work', base_commit: 'a'.repeat(40), head_commit: 'b'.repeat(40) };
  const paint = changes => renderDetail({ ...task, ...changes }, { events: [] }, null, null);
  try {
    paint({ status: 'paused' });
    const panel = dom.node('detail'), toolbar = panel.querySelector('.task-actions');
    expect(panel.children[2]).toBe(toolbar);
    expect(toolbar.children[0].textContent).toBe('打开工作台');
    expect(findByText(toolbar.querySelector('.worker-action-work'), '追加输入')).toBeTruthy();
    const start = findByText(toolbar.querySelector('.worker-action-work'), '开始');
    expect(start.classList.contains('agent-call')).toBe(true); expect(start.getAttribute('data-help')).toContain('token');
    const more = toolbar.querySelector('.worker-action-more'); expect(more.open).toBe(false); expect(more.hidden).toBe(false);
    expect(findByText(more.querySelector('.worker-action-settings'), '调整运行设置')).toBeTruthy();
    expect(findByText(more.querySelector('.worker-action-danger'), '放弃 Worker').getAttribute('data-help')).toContain('不可恢复');
    more.open = true; paint({ status: 'paused' }); expect(panel.querySelector('.worker-action-more').open).toBe(true);
    paint({ id: 8, status: 'paused' }); expect(panel.querySelector('.worker-action-more').open).toBe(false);
    paint({ status: 'running' }); expect(findByText(panel.querySelector('.worker-action-work'), '中断')).toBeTruthy();
    paint({ status: 'awaiting_acceptance', integration: 'merged' });
    expect(findByText(panel.querySelector('.worker-action-delivery'), '验收')).toBeTruthy();
    expect(panel.querySelector('.iteration-controls').querySelector('button')).toBeNull();
    expect(findByText(panel.querySelector('.iteration-controls'), '本轮工作完成 · 待验收')).toBeTruthy();
    paint({ status: 'waiting', merge_readiness: { ready: true }, reservation: { version: 2, status: 'pending' } });
    expect(findByText(panel.querySelector('.worker-action-delivery'), '合并')).toBeTruthy();
    paint({ status: 'failed', error: '专项失败', branch_archive: { archivable: true } });
    expect(findByText(panel.querySelector('.worker-action-work'), '检查后重试')).toBeTruthy();
    expect(findByText(panel.querySelector('.worker-action-danger'), '清理资源')).toBeTruthy();
    expect(panel.querySelector('.task-error-summary').textContent).toContain('专项失败');
    expect(requests).toEqual([]);
  } finally { resetUiState(); dom.restore(); }
});

test('sync conflict rebuild keeps one live settings control and a direct Agent recovery even if detail refresh fails', async () => {
  const requests = [], dom = installDom({ fetch: (url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ conflict: true, source_commit: 'source', parent_commit: 'parent', reason: '固定父提交有冲突' });
  } });
  resetUiState(); ui.view = { id: 'task', key: 'task-7' }; ui.hostSession = { status: 'ready', username: '用户' };
  const restore = registerNavigation({ refresh: async () => {}, detail: async () => { throw Error('refresh failed'); } });
  try {
    renderDetail({ ...worker, status: 'waiting', branch: 'work', workspace: '/tmp/work' }, { events: [] }, null, null);
    for (let round = 0; round < 2; round++) {
      const panel = dom.node('detail'), sync = panel.querySelector('.iteration-sync-control');
      expect(sync.parentNode).toBe(panel.querySelector('.worker-action-settings'));
      await sync.onclick();
      expect(panel.querySelectorAll('.iteration-sync-control')).toHaveLength(1);
      expect(panel.querySelectorAll('.iteration-actions')).toHaveLength(1);
      const resolve = findByText(panel.querySelector('.worker-action-delivery'), 'Agent 解决同步冲突');
      expect(resolve.classList.contains('agent-call')).toBe(true); expect(resolve.getAttribute('data-help')).toContain('token');
      expect(deepText(panel.querySelector('.iteration-controls'))).toContain('固定父提交有冲突');
    }
    expect(requests.map(row => row.method)).toEqual(['worker.sync_parent', 'worker.sync_parent']);
  } finally { restore(); resetUiState(); dom.restore(); }
});

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
