import { test, expect, afterEach } from 'bun:test';
import { installDom, deepText } from './project-dom.js';
import { renderTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { sourceDelivery } from '../../src/ui/web/assets/delivery-ui.js';
import { integrationSummary } from '../../src/ui/web/assets/render-integration.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

let dom;
afterEach(() => { ui.disposeTaskGraph?.(); dom?.restore(); });
const operation = { id: 8, revision: 'r1', target_branch: 'main', state: 'integrated', member_count: 1,
  members: [], worker: { id: 9, worker_number: 'W9', status: 'completed' } };

for (const minimal of [true, false]) {
  test(`工作树${minimal ? '极简' : '详细'}模式去除已合并和暂存计数，仅在更多操作提供整合`, () => {
    dom = installDom({ fetch: () => Response.json({}) }); resetUiState();
    activateDetailView({ view: 'task-graph' }); ui.taskGraphMinimal = minimal;
    const graph = { total: 3, nodes: [
      { id: 1, task_kind: 'main', status: 'waiting', title: 'main', branch: 'main', merge_operation: operation },
      { id: 2, parent_id: 1, task_kind: 'order', status: 'awaiting_acceptance', title: '来源', branch: 'source', integration: 'merged',
        reservation: { version: 2, status: 'integrated' }, input_queue: { buffered: 0 }, delivery_summary: { stage: 'integrated', input_queue: { buffered: 0 } } },
      { id: 3, parent_id: 1, task_kind: 'order', status: 'waiting', title: '受阻来源', branch: 'blocked', integration: 'conflict',
        delivery_summary: { stage: 'blocked', waiting_reason: '需要核查收据', reservation_truncated: true, input_queue: { buffered: 0 } } },
    ] };
    renderTaskGraph(graph);
    const root = dom.node('detail');
    expect(deepText(root)).not.toContain('已合并');
    expect(deepText(root)).not.toContain('暂存输入：');
    expect(root.querySelector('.integration-control')).toBeNull();
    expect(dom.requests).toHaveLength(0);
    expect(deepText(root)).toContain('1 个来源 · main');
    expect(deepText(root)).toContain('需要核查收据');
    expect(deepText(root)).toContain('预约已截断');
    expect(deepText(root)).toContain('冲突待处理');
    const parent = root.querySelector('[data-task-id="1"]');
    parent.querySelector('.task-graph-more-trigger').onclick();
    const panel = parent.querySelector('.task-graph-actions-popover');
    const start = panel.querySelector('.integration-control').querySelector('button');
    expect(start.textContent).toBe('整合全部');
    expect(start.classList.contains('agent-call')).toBe(true);
    expect(start.getAttribute('data-help')).toContain('token');
    expect(dom.requests).toHaveLength(0);
    expect(parent.children.some(node => node.classList.contains('integration-control'))).toBe(false);
    const source = root.querySelector('[data-task-id="2"]');
    source.querySelector('.task-graph-more-trigger').onclick();
    expect(deepText(source)).not.toContain('已合并');
    expect(deepText(source)).toContain('待验收');
  });
}

test('详情摘要仍保留合并结果和暂存输入，工作树选项不改变默认行为', () => {
  dom = installDom({ fetch: () => Response.json({}) });
  expect(deepText(sourceDelivery({ stage: 'integrated', input_queue: { buffered: 0 } }))).toContain('暂存输入：0 条');
  expect(deepText(sourceDelivery({ stage: 'integrated', input_queue: { buffered: 0 } }))).toContain('已合并');
  expect(deepText(integrationSummary({ merge_operation: operation }))).toContain('上次整合 · 已合并');
});
