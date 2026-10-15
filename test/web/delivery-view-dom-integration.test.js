import { test, expect } from 'bun:test';
import { installDom, deepText } from './project-dom.js';
import { fetch } from './harness.js';
import { deliveryViewFixture, deliveryDatabase } from './delivery-view-fixture.js';
import { PARAMS, USER_ONLY } from '../../src/rpc/registry.js';

test('real Host/HTTP/RPC/SQLite shaped delivery pages reach DOM, counts/pagination/locator/readonly and true parent edges', async () => {
  const f = await deliveryViewFixture();
  const dom = installDom({ projectId: f.projectId, fetch: (url, options) => fetch(f.url + url, options) });
  try {
    const { openDeliveryView } = await import('../../src/ui/web/assets/render-delivery-view.js');
    const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
    const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
    const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js'); resetUiState();
    expect(USER_ONLY.has('worker.delivery_graph')).toBe(true); expect(PARAMS['worker.delivery_graph']).toEqual(['history','cursor','limit']);
    const before = deliveryDatabase(f);
    const wire = await (await fetch(f.url + '/api/worker-delivery-graph?limit=1')).json();
    expect(wire).toMatchObject({ counts: { attention: 1 }, items: [{ run_id: f.focusRun.id, attention: true }] });
    const attentionText = '待处理 1';
    console.info(`Real Host/RPC delivery count: ${attentionText}`);
    await openDeliveryView({ locator: { run_id: f.focusRun.id, node_id: f.node.id } });
    expect(deepText(dom.node('detail'))).toContain('落地待核查');
    expect(deepText(dom.node('detail'))).toContain(`#${f.helper.id}`);
    expect(deepText(dom.node('detail'))).toContain('当前暂存输入：1 条');
    expect(deepText(dom.node('detail'))).not.toContain('BUFFERED_PRIVATE_BODY');
    const count = dom.node('detail').querySelector('.delivery-count-summary'); expect(count.textContent).toContain('活动 26');
    expect(count.textContent).toContain(attentionText);
    expect(deepText(dom.node('detail'))).toContain('历史合并记录');
    expect(deepText(dom.node('detail'))).not.toContain('阶段异常');
    await dom.node('detail').querySelectorAll('button').find(node => node.textContent === '继续加载').onclick();
    expect(dom.node('detail').querySelectorAll('.delivery-card')).toHaveLength(26);
    expect(deepText(dom.node('detail'))).toContain('未固定交付意图'); expect(deepText(dom.node('detail'))).toContain('普通串行');
    await openDeliveryView({ history: true });
    expect(dom.node('detail').querySelectorAll('.delivery-card')).toHaveLength(20);
    await dom.node('detail').querySelectorAll('button').find(node => node.textContent === '继续加载').onclick();
    expect(dom.node('detail').querySelectorAll('.delivery-card')).toHaveLength(22);
    expect(dom.node('detail').querySelectorAll('.delivery-exception')).toHaveLength(0);
    expect(dom.node('detail').querySelector('.delivery-count-summary').textContent).toContain(attentionText);
    expect(deepText(dom.node('detail'))).toContain('非当前预约交付');
    const graph = await (await fetch(f.url + '/api/worker-graph?details=0&scope=tree')).json();
    activateDetailView({ view: 'task-graph' }); renderTaskGraph(graph);
    expect(dom.node('detail').querySelector(`[data-task-id="${f.helper.id}"]`)).toBeNull();
    expect(dom.node('detail').querySelector(`[data-task-id="${f.sources[0].id}"]`).querySelector('.source-delivery')).toBeTruthy();
    expect(f.store.task(f.sources[0].id).parent_id).toBe(f.parent.id);
    expect(deliveryDatabase(f)).toBe(before); expect(f.providerCalls).toBe(0);
    expect(dom.requests.every(row => !row.options?.method || row.options.method === 'GET')).toBe(true);
    ui.disposeDeliveryView?.();
  } finally { dom.restore(); await f.close(); }
});

test('real attention lifecycle reaches sidebar/page/tree without treating ready or old-generation helpers as actionable', async () => {
  const f = await deliveryViewFixture();
  const dom = installDom({ projectId: f.projectId, fetch: (url, options) => fetch(f.url + url, options) });
  try {
    const { openDeliveryView } = await import('../../src/ui/web/assets/render-delivery-view.js');
    const { renderTaskGraph } = await import('../../src/ui/web/assets/render-task-graph.js');
    const { activateDetailView } = await import('../../src/ui/web/assets/sidebar-ui.js');
    const { resetUiState, ui } = await import('../../src/ui/web/assets/state.js'); resetUiState();
    const verify = async attention => {
      const before = deliveryDatabase(f);
      activateDetailView({ view: 'overview' });
      await openDeliveryView({ locator: { run_id: f.focusRun.id } });
      expect(dom.node('detail').querySelector('.delivery-count-summary').textContent).toContain(`待处理 ${Number(attention)}`);
      expect(dom.node('detail').querySelector(`[data-delivery-key="batch:${f.focusRun.id}"]`).classList.contains('delivery-exception')).toBe(attention);
      const graph = await (await fetch(f.url + '/api/worker-graph?details=0&scope=tree')).json();
      const src = graph.nodes.find(row => row.id === f.sources[0].id);
      expect(src.delivery_summary.attention).toBe(attention);
      activateDetailView({ view: 'task-graph' }); renderTaskGraph(graph);
      expect(dom.node('detail').querySelector(`[data-task-id="${src.id}"]`).querySelector('.source-delivery')).toBeTruthy();
      expect(dom.node('detail').querySelector(`[data-task-id="${f.helper.id}"]`)).toBeNull();
      expect(deliveryDatabase(f)).toBe(before);
      return src.delivery_summary;
    };
    f.store.updateDeliveryRun(f.focusRun.id, { state: 'resolving' });
    expect((await verify(true)).blocked_code).toBe('integration_decision');
    f.store.update(f.helper.id, { status: 'awaiting_acceptance' });
    expect((await verify(false)).blocked_code).toBe('integration_ready');
    f.store.update(f.helper.id, { status: 'paused' });
    expect((await verify(true)).blocked_code).toBe('integration_paused');
    // Old helper belongs to generation 1 and cannot supply generation 2's status.
    f.store.updateDeliveryRun(f.focusRun.id, { state: 'ready', generation: 2, integration_worker_id: f.helper.id });
    expect((await verify(false)).integration_workers.items[0].current).toBe(false);
    const missing = f.store.createDeliveryNode({ run_id: f.focusRun.id, generation: 2, node_key: 'missing-current', state: 'resolving', data: '{}', helper_id: f.helper.id });
    // Corrupt only the isolated fixture to exercise a persisted missing identity.
    f.store.run('UPDATE delivery_nodes SET helper_id=? WHERE id=?', 999999, missing.id);
    expect((await verify(true)).blocked_code).toBe('integration_unavailable');
    expect(f.providerCalls).toBe(0);
    expect(dom.requests.every(row => !row.options?.method || row.options.method === 'GET')).toBe(true);
    expect(f.store.task(f.sources[0].id).parent_id).toBe(f.parent.id);
    ui.disposeDeliveryView?.();
  } finally { dom.restore(); await f.close(); }
});
