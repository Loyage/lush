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
  has_more: false, deliveries: [delivery(14, 2, 11)], untraceable_deliveries: [] });

function mountDom(fetch) {
  const dom = installDom({ fetch }); resetUiState(); ui.view = 'task';
  dom.document.createElementNS = (_ns, tag) => dom.document.createElement(tag);
  return dom;
}
test('confirmed default hierarchy exposes origin and landing; receipts/technical metadata stay collapsed', async () => {
  const requests = [], input = data();
  const dom = mountDom(async url => { requests.push(String(url)); return Response.json(input); });
  const view = createWorkerLineage(task, () => true), root = view.root; root.isConnected = true; dom.node('detail').append(root);
  try {
    expect(requests).toHaveLength(0);
    await root.querySelector('.versions-load').onclick();
    expect(requests).toHaveLength(1); expect(requests[0]).toContain('/version-lineage?');
    expect(root.querySelector('.versions-feedback').textContent).not.toContain('读取失败');
    expect(deepText(root.querySelector('.lineage-overview'))).toContain('从哪里分出');
    expect(deepText(root.querySelector('.lineage-overview'))).toContain('W300');
    expect(root.querySelectorAll('.lineage-source')).toHaveLength(2);
    expect(root.querySelectorAll('.lineage-delivery-source')).toHaveLength(1);
    expect(root.querySelectorAll('.lineage-tip-badge')).toHaveLength(1);
    const receipt = root.querySelector('.lineage-mapping');
    expect(receipt.open).not.toBe(true);
    expect(receipt.querySelector('summary').textContent).toContain('交付到父轨');
    expect(receipt.querySelector('summary').textContent).not.toContain('Event');
    expect(deepText(receipt)).toContain('Event 14');
    expect(root.querySelector('.lineage-technical').open).not.toBe(true);
    expect(root.querySelectorAll('.lineage-delivery-edge')).toHaveLength(1);
    expect(root.querySelector('.lineage-delivery-edge').getAttribute('marker-end')).toBe('url(#lineage-arrow-5)');
    expect(root.querySelector('.lineage-parent-history').getAttribute('aria-label')).toContain('省略');
  } finally { view.dispose(); dom.restore(); }
});
