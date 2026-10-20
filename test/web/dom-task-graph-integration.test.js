import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { renderTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { integrationSummary } from '../../src/ui/web/assets/render-integration.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

const operation = state => ({ id: 40, revision: 'fixed-operation', target_branch: 'main', state,
  member_count: 2, members: [{ id: 2 }, { id: 3 }], worker: { id: 4, worker_number: 'W700' },
  error: ['failed', 'blocked'].includes(state) ? '完整错误诊断只在详情显示' : null });
const nodes = merge_operation => [
  { id: 1, task_kind: 'main', worker_number: 'W1', title: '目标', branch: 'main', status: 'waiting', merge_operation },
  { id: 2, parent_id: 1, task_kind: 'order', worker_number: 'W2', title: '来源', branch: 'lush/source', status: 'waiting',
    integration: 'pending', merge_operation },
  { id: 4, parent_id: 1, task_kind: 'integration', worker_number: 'W700', title: '不显示的辅助整合 Worker', status: 'running' },
];

for (const minimal of [true, false]) test(`tree ${minimal ? 'minimal' : 'detail'} cards disclose only current integration status`, () => {
  const dom = installDom(); resetUiState(); ui.view = { id: 'task-graph' }; ui.taskGraphMinimal = minimal;
  try {
    for (const [state, label] of [
      ['preparing', '合并处理中'], ['resolving', '合并处理中'], ['ready', '合并处理中'], ['landing', '合并处理中'],
      ['awaiting', '合并等待处理'], ['failed', '合并失败'], ['blocked', '落地待核验'], ['future', '合并状态待核查'],
      ['integrated', null], ['withdrawn', null], ['stale', null],
    ]) {
      const op = operation(state);
      renderTaskGraph({ nodes: nodes(op), edges: [], total: 3 });
      const panel = dom.node('detail'), cards = panel.querySelectorAll('.task-graph-card');
      expect(cards).toHaveLength(2);
      expect(panel.querySelector('.integration-summary')).toBeNull();
      expect(deepText(panel)).not.toContain('W700');
      expect(deepText(panel)).not.toContain('个来源');
      expect(deepText(panel)).not.toContain('完整错误诊断');
      for (const card of cards) {
        const status = card.querySelector('.task-graph-integration-status');
        if (label) {
          expect(status?.textContent).toBe(label);
          expect(status.getAttribute('data-help')).toContain('当前 Worker 详情');
          expect(status.tabIndex).toBe(0);
        } else expect(status).toBeNull();
      }
      // Details retain the original helper link, scope and diagnostics.
      const detail = integrationSummary({ merge_operation: op });
      expect(deepText(detail)).toContain('2 个来源 · main');
      expect(deepText(detail)).toContain('整合 Worker W700');
      if (op.error) expect(deepText(detail)).toContain(op.error);
    }
    const incomplete = { state: 'resolving' };
    renderTaskGraph({ nodes: nodes(incomplete), edges: [], total: 3 });
    expect(dom.node('detail').querySelector('.task-graph-integration-status').textContent).toBe('合并状态待核查');
    expect(deepText(dom.node('detail'))).not.toContain('整合 Worker');
    const fold = dom.node('detail').querySelector('.task-graph-fold');
    expect(deepText(fold)).toBe('');
    expect(fold.getAttribute('aria-label')).toBe('收起 W1 的子 Worker');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fold.onclick();
    expect(dom.node('detail').querySelectorAll('.task-graph-card')).toHaveLength(1);
    const reopen = dom.node('detail').querySelector('.task-graph-fold');
    expect(reopen.getAttribute('aria-expanded')).toBe('false');
    expect(reopen.querySelector('.view-disclosure-icon').dataset.expanded).toBe('false');
    reopen.onclick();
    expect(dom.node('detail').querySelectorAll('.task-graph-card')).toHaveLength(2);
  } finally { resetUiState(); dom.restore(); }
});

test('ordinary serial merge relations remain visible without integration operation facts', () => {
  const dom = installDom(); resetUiState(); ui.view = { id: 'task-graph' }; ui.taskGraphMinimal = true;
  try {
    const rows = nodes(null).slice(0, 2);
    rows[1].reservation = { version: 2, kind: 'merge', queue_protocol: 1, parent_id: 1, status: 'executing' };
    renderTaskGraph({ nodes: rows, edges: [], total: 2 });
    expect(deepText(dom.node('detail'))).toContain('合并中');
    expect(dom.node('detail').querySelector('.task-graph-merge-own')).toBeTruthy();
    expect(dom.node('detail').querySelector('.task-graph-integration-status')).toBeNull();
  } finally { resetUiState(); dom.restore(); }
});
