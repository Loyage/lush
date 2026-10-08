import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { gate } from '../helpers.js';
import { ui, resetUiState } from '../../src/ui/web/assets/state.js';
import { openTaskGraph, loadTaskGraph } from '../../src/ui/web/assets/render-task-graph.js';

const graph = (pending = false, title = '立即可读') => ({ nodes: [{ id: 1, parent_id: null, task_kind: 'main', role: 'agent',
  status: 'waiting', title, details_pending: pending, resources: null }], edges: [], total: 1,
  ...(pending ? { details_pending: true } : {}) });
const json = value => ({ ok: true, json: async () => value });

test('first open returns after summary, slow full enrichment does not block cache reopening and stays single flight', async () => {
  const full = gate(), requests = [];
  const dom = installDom({ fetch: async url => {
    requests.push(String(url));
    return String(url).includes('details=0') ? json(graph(true)) : full.promise;
  } });
  resetUiState();
  try {
    await openTaskGraph();
    expect(deepText(dom.node('detail'))).toContain('立即可读');
    expect(deepText(dom.node('detail'))).toContain('Git 诊断与累计用量加载中');
    expect(requests).toEqual(['/api/worker-graph?details=0', '/api/worker-graph']);
    ui.view = { id: 'overview' };
    await openTaskGraph();
    expect(deepText(dom.node('detail'))).toContain('立即可读');
    expect(requests).toHaveLength(2);
    full.resolve(json(graph(false, '补充完成'))); await loadTaskGraph();
    expect(deepText(dom.node('detail'))).toContain('补充完成');
    expect(deepText(dom.node('detail'))).not.toContain('Git 诊断与累计用量加载中');
    ui.view = { id: 'overview' }; await openTaskGraph();
    expect(requests).toHaveLength(2);
  } finally { full.resolve(json(graph())); resetUiState(); dom.restore(); }
});

test('enrichment failure preserves summary and is retryable without presenting missing diagnostics as zero', async () => {
  const full = gate(); let recovered = false;
  const dom = installDom({ fetch: async url => String(url).includes('details=0') ? json(graph(true))
    : recovered ? json(graph(false, '重试成功')) : full.promise });
  resetUiState();
  try {
    await openTaskGraph();
    const completion = loadTaskGraph(); full.resolve({ ok: false, json: async () => ({ error: '诊断失败' }) });
    await expect(completion).rejects.toThrow('诊断失败');
    expect(deepText(dom.node('detail'))).toContain('立即可读');
    expect(deepText(dom.node('detail'))).toContain('保留上次可用内容');
    recovered = true; await loadTaskGraph();
    expect(deepText(dom.node('detail'))).toContain('重试成功');
  } finally { full.resolve(json(graph())); resetUiState(); dom.restore(); }
});

test('late full graph cannot render another view or populate a reset/project cache', async () => {
  const full = gate();
  const dom = installDom({ fetch: async url => String(url).includes('details=0') ? json(graph(true)) : full.promise });
  resetUiState();
  try {
    await openTaskGraph(); const completion = loadTaskGraph();
    resetUiState(); ui.view = { id: 'overview' }; dom.node('detail').textContent = '新页面';
    full.resolve(json(graph(false, '过期响应'))); await completion;
    expect(dom.node('detail').textContent).toBe('新页面'); expect(ui.taskGraphPage).toBeNull();
  } finally { full.resolve(json(graph())); resetUiState(); dom.restore(); }
});
