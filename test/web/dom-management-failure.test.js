import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { renderManagementFailure, renderManagementState } from '../../src/ui/web/assets/management-state.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';

const task = { id: 801, worker_number: 'V12', role: 'manager', task_kind: 'management', goal: '你好',
  status: 'failed', calls: 1, children: [], runs: [],
  management: { version: 1, revision: 'binding-r1', enabled: false, state: 'failed', mode: 'once',
    pending_signal: { due_at: '2026-10-17T07:52:01.893Z' } } };

test('Valet detail shows full actionable failure before reading previews and offers no retry', () => {
  const dom = installDom(); resetUiState();
  try {
    activateDetailView({ view: 'task', key: 'task-801', hash: '#worker-801' }); ui.selected = 801; ui.detailTask = 801;
    const reason = `Pi 扩展加载失败。\n建议：检查 Lush 与 Pi 的运行时兼容性。${'安全诊断。'.repeat(70)}末尾建议可见。`;
    const patches = renderDetail({ ...task, error: reason }, { events: [] }, null, null, null, { current: () => true });
    try {
      const panel = dom.node('detail'), failure = panel.querySelector('.management-failure');
      expect(deepText(failure)).toContain(reason);
      expect(deepText(failure)).toContain('末尾建议可见');
      expect(deepText(failure)).toContain('不会自动重试或重放');
      expect(deepText(failure)).toContain('已开始的操作不会因调用失败而撤回');
      expect(failure.querySelector('.management-diagnostic-unavailable')).toBeNull();
      const children = [...panel.children];
      expect(children.indexOf(failure)).toBeGreaterThan(-1);
      expect(children.indexOf(failure)).toBeLessThan(children.indexOf(panel.querySelector('.conversation-panel')));
      expect(failure.classList.contains('detail-preview')).toBe(false);
      expect(panel.querySelectorAll('.task-error-summary')).toHaveLength(0);
      expect(panel.querySelectorAll('button').some(node => /重试|继续|开始/.test(node.textContent))).toBe(false);
      expect(panel.querySelectorAll('button').find(node => node.textContent === '追加输入')?.disabled).toBe(true);
      expect(deepText(panel.querySelector('.management-state'))).not.toContain('已提交待处理');
      expect(deepText(panel.querySelector('.management-state'))).toContain('不会再次排队');
    } finally { patches.dispose(); }
  } finally { resetUiState(); dom.restore(); }
});

test('legacy Valet failures acknowledge missing diagnostics and unknown effects remain unknown', () => {
  const dom = installDom();
  try {
    const legacy = renderManagementFailure({ ...task, error: '管理调用未完成；绑定已停用，请检查执行记录后另建管理指令。' });
    expect(legacy.querySelector('.management-diagnostic-unavailable').textContent).toContain('无法从现有记录还原失败原因');
    expect(legacy.querySelectorAll('button')).toHaveLength(0);
    const unknown = { ...task, error: null, management: { ...task.management, state: 'unknown',
      last_execution: { status: 'unknown', reason: '副作用未知，不能重放。' } } };
    const failure = renderManagementFailure(unknown);
    expect(deepText(failure)).toContain('管家操作结果未知');
    expect(deepText(failure)).toContain('副作用未知');
    expect(deepText(renderManagementState(unknown))).not.toContain('已提交待处理');
    expect(renderManagementFailure({ ...task, status: 'completed', error: null,
      management: { ...task.management, state: 'succeeded' } })).toBeNull();
  } finally { dom.restore(); }
});
