import { test, expect, afterEach } from 'bun:test';
import { installDom, deepText } from './project-dom.js';
import { renderTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { deliveryStage } from '../../src/ui/web/assets/delivery-model.js';
import { sourceDelivery } from '../../src/ui/web/assets/delivery-ui.js';
import { integrationSummary } from '../../src/ui/web/assets/render-integration.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

let dom;
afterEach(() => { ui.disposeTaskGraph?.(); dom?.restore(); });
const operation = { id: 8, revision: 'r1', target_branch: 'main', state: 'integrated', member_count: 1,
  members: [], worker: { id: 9, worker_number: 'W9', status: 'completed' } };

for (const minimal of [true, false]) {
  test(`工作树${minimal ? '极简' : '详细'}模式内联合并状态并去除暂存计数，仅在更多操作提供整合`, () => {
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
    expect(root.querySelectorAll('.badge').filter(node => node.textContent === '已合并')).toHaveLength(1);
    expect(deepText(root)).not.toContain('暂存输入：');
    expect(root.querySelector('.integration-control')).toBeNull();
    expect(dom.requests).toHaveLength(0);
    expect(deepText(root)).toContain('1 个来源 · main');
    expect(deepText(root)).toContain('需要核查收据');
    expect(deepText(root)).toContain('预约已截断');
    expect(deepText(root)).toContain('落地待核查');
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
    const usage = source.querySelector('.task-graph-usage');
    expect(usage.parentNode.children[usage.parentNode.children.indexOf(usage) + 1].textContent).toBe('已合并');
    expect(source.querySelector('.source-delivery')).toBeNull();
    expect(deepText(source)).toContain('待验收');
  });
}

for (const minimal of [true, false]) {
  for (const stage of ['pending', 'integrated']) {
    test(`工作树合并阶段紧跟用量且只出现一次（极简=${minimal}，阶段=${stage}）`, () => {
      dom = installDom({ fetch: () => Response.json({}) }); resetUiState();
      activateDetailView({ view: 'task-graph' }); ui.taskGraphMinimal = minimal;
      const label = stage === 'pending' ? '未合并' : '已合并';
      renderTaskGraph({ total: 1, nodes: [{ id: 2, task_kind: 'order', status: 'waiting', title: '来源', branch: 'source',
        integration: stage === 'integrated' ? 'merged' : 'pending', reservation: { version: 2, status: stage },
        delivery_summary: { stage },
        resources: { own: { run_ms: 61000, input: 1200, output: 300, cost: 0.24 } },
      }] });
      const card = dom.node('detail').querySelector('[data-task-id="2"]');
      const usage = card.querySelector('.task-graph-usage'), siblings = usage.parentNode.children;
      expect(deepText(usage)).toContain('$0.24');
      expect(siblings[siblings.indexOf(usage) + 1].textContent).toBe(label);
      expect(card.querySelectorAll('.badge').filter(node => node.textContent === label)).toHaveLength(1);
      expect(deepText(card)).not.toContain('等待合并条件');
      expect(card.querySelector('.source-delivery')?.querySelector('.badge')).toBeFalsy();
      expect(card.querySelector('.source-delivery')).toBeNull();
    });
  }
}

for (const minimal of [true, false]) test(`无阶段摘要时仍内联待合并状态，未知预约保留警告（极简=${minimal}）`, () => {
  dom = installDom({ fetch: () => Response.json({}) }); resetUiState();
  activateDetailView({ view: 'task-graph' }); ui.taskGraphMinimal = minimal;
  for (const version of [2, 3, 99]) {
    renderTaskGraph({ total: 1, nodes: [{ id: 2, task_kind: 'order', status: 'waiting', title: '来源', branch: 'source',
      reservation: { version, status: 'pending' }, integration: 'none',
    }] });
    const card = dom.node('detail').querySelector('[data-task-id="2"]');
    if (version === 99) {
      if (minimal) card.querySelector('.task-graph-more-trigger').onclick();
      expect(deepText(card)).toContain('预约版本未知');
    } else {
      const usage = card.querySelector('.task-graph-usage'), siblings = usage.parentNode.children;
      expect(siblings[siblings.indexOf(usage) + 1].textContent).toBe('未合并');
      expect(deepText(card)).not.toContain('等待合并条件');
    }
  }
});

for (const minimal of [true, false]) for (const version of [2, 3]) {
  for (const stage of ['requested', 'executing', 'resolving', 'suspended', 'blocked']) {
    test(`活动交付只在用量旁显示一次（极简=${minimal}，v${version}，${stage}）`, () => {
      dom = installDom({ fetch: () => Response.json({}) }); resetUiState();
      activateDetailView({ view: 'task-graph' }); ui.taskGraphMinimal = minimal;
      renderTaskGraph({ total: 1, nodes: [{ id: 2, task_kind: 'order', status: 'waiting', title: '来源', branch: 'source',
        integration: 'pending', reservation: { version, kind: 'merge', status: stage },
        delivery_summary: { version, stage },
      }] });
      const card = dom.node('detail').querySelector('[data-task-id="2"]');
      const usage = card.querySelector('.task-graph-usage'), siblings = usage.parentNode.children;
      const label = deliveryStage(stage, version);
      expect(siblings[siblings.indexOf(usage) + 1].textContent).toBe(label);
      expect(card.querySelector('.source-delivery')).toBeNull();
      // Opening the same-source controls must not reintroduce a second stage badge.
      if (minimal) card.querySelector('.task-graph-more-trigger').onclick();
      expect(card.querySelectorAll('.badge').filter(node => node.textContent === label)).toHaveLength(1);
    });
  }
}

for (const version of [2, 3]) for (const stage of ['requested', 'executing', 'resolving', 'integrated']) {
  test(`详情交付阶段去重但保留诊断与输入（v${version}，${stage}）`, () => {
    dom = installDom({ fetch: () => Response.json({}) }); resetUiState();
    const label = deliveryStage(stage, version);
    renderDetail({ id: 2, task_kind: 'order', role: 'agent', status: 'waiting', branch: 'source', goal: '来源',
      reservation: { version, kind: 'merge', status: stage },
      delivery_summary: { version, stage, current: false, reservation_truncated: true, input_queue: { buffered: 2 } },
      children: [], messages: [], notices: [],
    }, null, null, null);
    const panel = dom.node('detail').querySelector('.delivery-controls');
    const stages = panel.querySelectorAll('.badge');
    expect(stages).toHaveLength(1);
    expect(stages[0].textContent).toBe(version === 2 && stage === 'integrated' ? '已合并 · 待验收' : label);
    expect(deepText(panel)).toContain('暂存输入：2 条');
    expect(deepText(panel)).toContain('非当前合并请求');
    expect(deepText(panel)).toContain('预约已截断');
    if (version === 2 && stage === 'requested')
      expect(panel.querySelectorAll('button').some(button => button.textContent === '复查合并队列')).toBe(true);
  });
}

test('详情摘要仍保留合并结果和暂存输入，工作树选项不改变默认行为', () => {
  dom = installDom({ fetch: () => Response.json({}) });
  expect(deepText(sourceDelivery({ stage: 'integrated', input_queue: { buffered: 0 } }))).toContain('暂存输入：0 条');
  expect(deepText(sourceDelivery({ stage: 'integrated', input_queue: { buffered: 0 } }))).toContain('已合并');
  expect(deepText(integrationSummary({ merge_operation: operation }))).toContain('上次整合 · 已合并');
});
