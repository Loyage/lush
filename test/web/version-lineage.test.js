import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { createWorkerLineage } from '../../src/ui/web/assets/render-version-lineage.js';

const sha = n => n.toString(16).padStart(40, '0');
const commit = (n, parents = []) => ({ commit: sha(n), parents: parents.map(sha), subject: `提交 ${n}`, committed_at: '2026-10-18T10:00:00Z' });
const delivery = (id, source, landing, available = true) => ({ delivery_id: id, source_commit: sha(source), commit: sha(landing), parent_id: 1,
  delivery_available: available, delivery_unavailable_reason: available ? null : '对象缺失', evidence: 'event', delivered_at: '2026-10-18T11:00:00Z' });
const task = { id: 5, worker_number: 'W344-1', branch: 'lush/example' };
const data = () => ({ scope: 'lineage', range: 'first-parent', worker: task, parent: { id: 1, worker_number: 'W300', branch: 'main' }, branch: task.branch,
  origin: commit(1), commits: [commit(3, [2]), commit(2, [1])], tip: sha(3), tip_evidence: 'branch.ref', snapshot: 'fixed', cursor: null,
  has_more: false, deliveries: [delivery(14, 2, 11)], untraceable_deliveries: [], child_branches: [] });

function mountDom(fetch) {
  const dom = installDom({ fetch }); resetUiState(); ui.view = 'task';
  dom.document.createElementNS = (_ns, tag) => dom.document.createElement(tag);
  return dom;
}
test('compact graph hides preamble and distinguishes child integration from ordinary commits and delivery source', async () => {
  const requests = [], input = data();
  input.commits[1].association = 'verified';
  input.commits[1].tasks = [{ id: 6, worker_number: 'W344-1-1', delivery_id: 12, evidence: 'task.merge_integrated' }];
  const endpoint = (n, page = 0) => ({ commit: sha(n), page, cursor: page ? 'older-fixed' : null, available: true, reason: null });
  input.has_more = true; input.cursor = 'older-fixed'; input.commits[1].parents = [sha(4)];
  const branch = { worker: { id: 6, worker_number: 'W344-1-1' }, origin: endpoint(4, 1),
    deliveries: [{ ...delivery(12, 20, 2), parent_id: task.id, landing: endpoint(2) }] };
  const undelivered = { worker: { id: 7, worker_number: 'W344-1-2' }, origin: endpoint(3), deliveries: [] };
  const originBranch = { worker: { id: 8, worker_number: 'W344-1-3' }, origin: endpoint(1), deliveries: branch.deliveries };
  input.child_branches = [branch, undelivered, originBranch];
  const older = { ...input, commits: [commit(4, [1])], has_more: false, cursor: null, deliveries: [], child_branches: [branch] };
  const dom = mountDom(async url => { requests.push(String(url)); return Response.json(String(url).includes('cursor=') ? older : input); });
  const view = createWorkerLineage(task, () => true), root = view.root; root.isConnected = true; dom.node('detail').append(root);
  try {
    expect(requests).toHaveLength(0);
    await root.querySelector('.versions-load').onclick();
    expect(requests).toHaveLength(1); expect(requests[0]).toContain('/version-lineage?');
    expect(root.querySelector('.versions-feedback').textContent).not.toContain('读取失败');
    expect(root.querySelector('.versions-feedback').hidden).toBe(true);
    for (const selector of ['.lineage-overview', '.lineage-legend', '.lineage-tracks', '.lineage-technical']) expect(root.querySelector(selector)).toBeNull();
    expect(deepText(root.querySelector('.lineage-origin'))).toContain('W300');
    expect(root.querySelector('.lineage-delivery-source').querySelector('.lineage-kind').textContent).toBe('子 Worker 合入');
    expect(deepText(root.querySelector('.lineage-delivery-source').querySelector('.version-metadata'))).toContain('W344-1-1');
    expect(root.querySelectorAll('.lineage-delivery-badge')).toHaveLength(1);
    expect(deepText(root)).not.toContain('自身提交');
    expect(deepText(root)).not.toContain('第 1 页');
    expect(root.querySelectorAll('.lineage-source')).toHaveLength(2);
    expect(root.querySelectorAll('.lineage-delivery-source')).toHaveLength(1);
    expect(root.querySelectorAll('.lineage-tip-badge')).toHaveLength(1);
    const receipt = root.querySelector('.lineage-mapping');
    expect(receipt.open).not.toBe(true);
    expect(receipt.querySelector('summary').textContent).toContain('交付到父轨');
    expect(receipt.querySelector('summary').textContent).not.toContain('Event');
    expect(deepText(receipt)).toContain('Event 14');
    expect(root.querySelectorAll('.lineage-delivery-edge')).toHaveLength(1);
    expect(root.querySelector('.lineage-delivery-edge').getAttribute('marker-end')).toBe('url(#lineage-arrow-5)');
    expect(root.querySelector('.lineage-parent-history').getAttribute('aria-label')).toContain('省略');
    expect(root.querySelector('.lineage-child-panel')).toBeNull();
    expect(root.querySelector('.lineage-child-lines')).toBeNull();
    await root.querySelector('.lineage-child-toggle[data-worker-id="6"]').onclick();
    expect(requests).toHaveLength(1);
    expect(deepText(root.querySelector('.lineage-child-panel'))).toContain('W344-1-1');
    expect(deepText(root.querySelector('.lineage-child-panel'))).toContain('第 2 段');
    expect(root.querySelectorAll('.lineage-child-lines')).toHaveLength(1);
    await root.querySelector(`.lineage-child-locate[data-commit="${sha(4)}"]`).onclick();
    expect(requests).toHaveLength(2); expect(requests[1]).toContain('cursor=older-fixed');
    expect(root.dataset.pageIndex).toBe('1');
    expect(document.activeElement).toBe(root.querySelector('.lineage-source').querySelector('.lineage-node'));
    await root.querySelector(`.lineage-child-locate[data-commit="${sha(2)}"]`).onclick();
    expect(root.dataset.pageIndex).toBe('0'); expect(requests).toHaveLength(2);
    await root.querySelector('.lineage-child-toggle[data-worker-id="7"]').onclick();
    expect(root.querySelectorAll('.lineage-child-panel')).toHaveLength(1);
    expect(deepText(root.querySelector('.lineage-child-panel'))).toContain('尚未合入');
    expect(deepText(root.querySelector('.lineage-child-panel'))).not.toContain('W344-1-1');
    await root.querySelector('.lineage-child-toggle[data-worker-id="7"]').onclick();
    expect(root.querySelector('.lineage-child-lines')).toBeNull();
    expect(root.querySelector('.lineage-child-panel')).toBeNull();
    await root.querySelector('.lineage-child-toggle[data-worker-id="8"]').onclick();
    const rect = (left, top, width = 20, height = 20) => ({ left, top, right: left + width, bottom: top + height, width, height });
    root.querySelector('.lineage-canvas').getBoundingClientRect = () => rect(0, 0, 112, 1000);
    root.querySelector('.lineage-child-panel').getBoundingClientRect = () => rect(112, 50, 200, 200);
    for (const marker of [...root.querySelectorAll('.lineage-node'), ...root.querySelectorAll('.lineage-anchor-dot')]) {
      marker.getBoundingClientRect = () => rect(12, 10);
      marker.parentNode.getBoundingClientRect = () => rect(0, 0, 112, 1000);
    }
    await root.querySelector('.lineage-child-toggle[data-worker-id="8"]').onclick();
    await root.querySelector('.lineage-child-toggle[data-worker-id="8"]').onclick();
    expect(deepText(root.querySelector('.lineage-child-panel'))).toContain('不绘制跨省略区');
    expect(root.querySelector('.lineage-child-edge').dataset.landing).toBe('');
    expect(root.querySelector('.lineage-child-edge').getAttribute('marker-end')).toBeNull();
    expect(requests).toHaveLength(2);
  } finally { view.dispose(); dom.restore(); }
});
