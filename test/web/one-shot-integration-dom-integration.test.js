import { test, expect } from 'bun:test';
import { installDom, deepText, answerDialog, dialogButton } from './project-dom.js';
import { fetch } from './harness.js';
import { until, git } from '../helpers.js';
import { oneShotIntegrationFixture } from './one-shot-integration-fixture.js';
import { renderTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';
import { renderDetail } from '../../src/ui/web/assets/render-detail.js';
import { activateDetailView } from '../../src/ui/web/assets/sidebar-ui.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';

test('real tree confirmation -> authenticated HTTP/RPC -> autonomous Agent -> one Git landing -> original Worker detail', async () => {
  const f = await oneShotIntegrationFixture({ hold: true });
  const dom = installDom({ projectId: f.projectId, fetch: (url, options) => fetch(f.url + url, options?.method === 'POST'
    ? { ...options, headers: { ...options.headers, Origin: f.url } } : options) });
  try {
    resetUiState(); activateDetailView({ view: 'task-graph' }); ui.taskGraphMinimal = true;
    const graph = await (await fetch(f.url + '/api/worker-graph?details=1&scope=tree')).json();
    renderTaskGraph(graph);
    const parent = dom.node('detail').querySelector(`[data-task-id="${f.parent.id}"]`);
    const start = parent.querySelector('.integration-control').querySelector('button');
    expect(start.textContent).toBe('整合全部'); expect(start.classList.contains('agent-call')).toBe(true);
    expect(dom.requests.some(row => row.path.includes('branch-integrate-plan'))).toBe(false);
    const pending = start.onclick(); await until(() => dialogButton(dom, '开始整合'));
    expect(deepText(dom.node('modal'))).toContain('2 个来源'); expect(f.store.all('SELECT id FROM delivery_runs')).toHaveLength(0);
    await answerDialog(dom, '开始整合'); await pending;
    const run = f.store.get('SELECT * FROM delivery_runs'); expect(run.state).toBe('resolving');
    expect(f.providerCalls).toBe(0); expect(start.disabled).toBe(true);
    const writes = dom.requests.filter(row => row.options?.method === 'POST'); expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].options.body).method).toBe('branch.integrate_start');
    f.start(); await f.entered.promise;
    const live = await (await fetch(f.url + '/api/worker-graph?details=1&scope=tree')).json(); renderTaskGraph(live);
    const summary = dom.node('detail').querySelector(`[data-task-id="${f.sources[0].id}"]`).querySelector('.integration-summary');
    expect(deepText(summary)).toContain('整合中'); expect(summary.querySelector('a').getAttribute('href')).toContain(`#worker-${run.integration_worker_id}`);
    expect(await git(f.root, 'rev-parse', 'main')).toBe(f.baseline);
    f.release.resolve();
    await until(() => ['integrated', 'failed', 'blocked'].includes(f.store.deliveryRun(run.id).state), 12000);
    expect(f.store.deliveryRun(run.id).state, f.store.deliveryRun(run.id).error).toBe('integrated'); expect(f.providerCalls).toBe(1);
    expect(await git(f.root, 'rev-list', '--count', `${f.baseline}..main`)).toBe('1');
    const helper = await (await fetch(f.url + `/api/worker/${run.integration_worker_id}`)).json();
    activateDetailView({ view: 'task', key: String(helper.id) }); renderDetail(helper, { events: [] }, null, null);
    const details = dom.node('detail').querySelector('.integration-details');
    expect(deepText(details)).toContain('已实际合入 main'); expect(details.querySelector('.integration-sources').children).toHaveLength(2);
    expect(details.querySelector('details').open).not.toBe(true); expect(deepText(dom.node('detail'))).toContain('2 项通过');
    expect(deepText(details)).not.toContain('交付');
    expect(details.querySelectorAll('button').some(node => node.textContent === '重试整合')).toBe(false);
    for (const source of f.sources) {
      expect(f.store.task(source.id).parent_id).toBe(f.parent.id);
      expect(await git(source.workspace, 'rev-parse', 'HEAD')).toBe(source.head_commit);
    }
  } finally { ui.disposeTaskGraph?.(); ui.disposeDetailRequests?.(); dom.restore(); await f.close(); }
});
