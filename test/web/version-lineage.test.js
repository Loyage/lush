import { test, expect } from 'bun:test';
import { installDom, deepText } from '../dom-stub.js';
import { resetUiState, ui } from '../../src/ui/web/assets/state.js';
import { versionLineageLayout } from '../../src/ui/web/assets/version-lineage-layout.js';
import { lineageMappingPath, lineageGitPath, lineageMappingChannels, createLineageMappings } from '../../src/ui/web/assets/version-lineage-mappings.js';
import { createWorkerLineage } from '../../src/ui/web/assets/render-version-lineage.js';

const sha = n => n.toString(16).padStart(40, '0');
const commit = (n, parents = []) => ({ commit: sha(n), parents: parents.map(sha), subject: `提交 ${n}`, committed_at: '2026-10-18T10:00:00Z' });
const delivery = (id, source, landing, available = true) => ({ delivery_id: id, source_commit: sha(source), commit: sha(landing), parent_id: 1,
  delivery_available: available, delivery_unavailable_reason: available ? null : '对象缺失', evidence: 'event', delivered_at: '2026-10-18T11:00:00Z' });
const task = { id: 5, worker_number: 'W344-1', branch: 'lush/example' };
const data = () => ({ scope: 'lineage', range: 'first-parent', worker: task, parent: { id: 1, worker_number: 'W300', branch: 'main' }, branch: task.branch,
  origin: commit(1), commits: [commit(3, [2]), commit(2, [1])], tip: sha(3), tip_evidence: 'branch.ref', snapshot: 'fixed', cursor: null,
  has_more: false, deliveries: [delivery(14, 2, 11)], untraceable_deliveries: [] });

test('lineage layout retains all commits, unique anchors and every verified mapping, never guessed landings', () => {
  const input = data();
  input.deliveries = [delivery(10, 1, 1), delivery(11, 2, 11), delivery(12, 2, 11), delivery(13, 2, 12), delivery(14, 3, 11), delivery(15, 3, 1), delivery(16, 3, 13, false)];
  const model = versionLineageLayout(input);
  expect(model.rows.map(row => row.commit.commit)).toEqual([sha(2), sha(3)]);
  expect(model.rows.flatMap(row => row.landings)).toEqual([sha(11), sha(12)]);
  expect(model.connections).toHaveLength(5);
  expect(model.connections.find(pair => pair.source === sha(2) && pair.landing === sha(11)).events).toEqual([11, 12]);
  expect(model.connections.some(pair => pair.landing === sha(13))).toBe(false);
  expect(model.rows[1].deliveries.some(event => event.delivery_id === 16)).toBe(true);
  const omitted = versionLineageLayout({ ...data(), has_more: true, commits: [commit(3, [2, 11])] });
  expect(omitted.omitted).toBe(true);
  expect(omitted.rows[0].edges).toEqual([
    { child: sha(3), parent: sha(2), boundary: true, external: false },
    { child: sha(3), parent: sha(11), boundary: true, external: true },
  ]);
});

test('overlapping mappings use distinct interval channels beyond seven; disjoint mappings reuse channels', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ from: { x: 78, y: 40 }, to: { x: 22, y: 90 + i * 40 } }));
  const channels = lineageMappingChannels(entries);
  expect(new Set(channels).size).toBe(12);
  expect(channels.every(x => x > 32 && x < 68)).toBe(true);
  expect(lineageMappingChannels(entries)).toEqual(channels);
  const disjoint = [{ from: { x: 78, y: 10 }, to: { x: 22, y: 60 } }, { from: { x: 78, y: 120 }, to: { x: 22, y: 80 } }];
  expect(new Set(lineageMappingChannels(disjoint)).size).toBe(1);
});

test('mapping curves support forward, backwards and origin self-receipts; Git paths stay distinct', () => {
  for (const [from, to] of [[{ x: 78, y: 60 }, { x: 22, y: 140 }], [{ x: 78, y: 220 }, { x: 22, y: 20 }], [{ x: 22, y: 22 }, { x: 22, y: 22 }]]) {
    const path = lineageMappingPath(from, to, 50);
    expect(path.startsWith(`M ${from.x} ${from.y} C `)).toBe(true);
    expect(path.endsWith(`${to.x} ${to.y}`)).toBe(true);
    expect(path).not.toMatch(/NaN|Infinity| H | V /);
  }
  expect(lineageGitPath({ x: 78, y: 140 }, { x: 78, y: 60 })).toBe('M 78 140 L 78 60');
  expect(lineageGitPath({ x: 78, y: 140 }, { x: 22, y: 20 })).toBe('M 78 140 L 78 52 C 78 36 22 36 22 20');
});

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

test('measured edges follow resized nodes; known sync anchors use real secondary edges, missing boundaries do not', () => {
  const dom = mountDom();
  const root = dom.document.createElement('section'), canvas = dom.document.createElement('div'); root.dataset.workerId = '5'; root.append(canvas);
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800 });
  let shift = 0;
  const marker = (id, x, y, cls) => {
    const node = dom.document.createElement('span'); node.id = id; node.className = cls;
    node.getBoundingClientRect = () => ({ left: x - 22, top: y + shift - 22, width: 44, height: 44 }); canvas.append(node); return node;
  };
  const origin = marker('origin', 22, 30, 'lineage-parent-node'), source = marker('source', 78, 160, 'lineage-node'), landing = marker('landing', 22, 90, 'lineage-parent-node');
  const model = versionLineageLayout({ ...data(), commits: [commit(3, [2, 11])], has_more: true, deliveries: [delivery(14, 3, 11)] });
  const mapping = createLineageMappings(root, canvas, () => true);
  try {
    mapping.present(model, new Map([[sha(1), origin], [sha(3), source]]), new Map([[sha(1), origin], [sha(11), landing]]));
    expect(root.querySelectorAll('.lineage-git-edge')).toHaveLength(1);
    expect(root.querySelector('.lineage-git-edge').classList.contains('lineage-secondary-edge')).toBe(true);
    const edge = root.querySelector('.lineage-delivery-edge'), before = edge.getAttribute('d');
    expect(before.startsWith('M 78 160 C ')).toBe(true);
    shift = 100; mapping.changed(); expect(edge.getAttribute('d')).not.toBe(before);
    expect(edge.getAttribute('d').endsWith('22 190')).toBe(true);
    const receipt = dom.document.createElement('details'); receipt.className = 'lineage-receipt'; receipt.dataset.delivery = '14'; root.append(receipt);
    root.listeners.focusin[0]({ target: receipt });
    expect(edge.classList.contains('is-active')).toBe(true);
    expect(source.classList.contains('is-mapping-active')).toBe(true); expect(landing.classList.contains('is-mapping-active')).toBe(true);
    mapping.dispose(); expect(root.listeners.focusin).toHaveLength(0); expect(root.querySelectorAll('.lineage-delivery-edge')).toHaveLength(0);
  } finally { mapping.dispose(); dom.restore(); }
});
