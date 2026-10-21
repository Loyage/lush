import { lineageMappingPath } from './version-lineage-mappings.js';
import { workerLabel } from './worker-label.js';

// A selected Worker's provenance/delivery relation, never a fabricated Git parent.
export function createLineageChildPath(root, canvas, current) {
  const host = root.ownerDocument?.defaultView || globalThis.window || globalThis;
  let layer = null, branch = null, sources = new Map(), page = 0, panel = null, frame = null, disposed = false;
  const svg = (tag, attrs) => {
    const node = (root.ownerDocument || document).createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };
  const clearMarkers = () => { for (const node of sources.values()) node.classList.remove('is-child-path'); };
  const draw = () => {
    frame = null;
    if (disposed || !current() || !layer || !branch) return;
    clearMarkers();
    const local = endpoint => endpoint.available && endpoint.page === page ? sources.get(endpoint.commit) : null;
    const origin = local(branch.origin), landings = branch.deliveries.map(m => local(m.landing)).filter(Boolean);
    for (const marker of [origin, ...landings]) marker?.classList.add('is-child-path');
    layer.replaceChildren();
    if (!canvas.getBoundingClientRect) return;
    const base = canvas.getBoundingClientRect();
    if (!base.width || !base.height) return;
    layer.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    // Missing/off-page origins must not create a plausible but invented branch.
    if (!origin) return;
    const centre = node => {
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width / 2 - base.left, y: box.top + box.height / 2 - base.top };
    };
    const from = centre(origin), rail = origin.parentNode.getBoundingClientRect();
    const channel = rail.right - base.left - 7;
    const arrowId = `lineage-child-arrow-${root.dataset.workerId}`;
    const arrow = svg('marker', { id: arrowId, viewBox: '0 0 10 10', refX: 18, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto' });
    arrow.append(svg('path', { d: 'M 1 1 L 9 5 L 1 9', class: 'lineage-child-arrow' }));
    const defs = svg('defs', {}); defs.append(arrow); layer.append(defs);
    const crossesGap = origin.classList.contains('lineage-parent-node') && canvas.querySelector('.lineage-gap');
    const targets = [...new Set(landings)].filter(target => !crossesGap || target === origin);
    // An open branch ends beside its explanatory panel, not at a fictitious commit.
    const end = { x: channel, y: Math.max(from.y + 28, panel.getBoundingClientRect().top - base.top + 24) };
    for (const target of targets.length ? targets : [null]) {
      const to = target ? centre(target) : end;
      const path = svg('path', { class: 'lineage-child-edge', d: lineageMappingPath(from, to, channel),
        'vector-effect': 'non-scaling-stroke', role: 'img',
        'aria-label': `${workerLabel(branch.worker)} 的引出与合入关系（不是 Git 父边）` });
      if (target) path.setAttribute('marker-end', `url(#${arrowId})`);
      Object.assign(path.dataset, { workerId: String(branch.worker.id), origin: branch.origin.commit,
        landing: target ? [...sources].find(([, node]) => node === target)?.[0] : '', sourceNode: origin.id, targetNode: target?.id || '' });
      layer.append(path);
    }
    const y = targets.length ? from.y + Math.sign(centre(targets[0]).y - from.y || 1) * Math.min(28, Math.abs(centre(targets[0]).y - from.y) / 2) : end.y;
    layer.append(svg('path', { class: 'lineage-child-symbol', d: `M ${channel} ${y - 4} l 4 4 l -4 4 l -4 -4 Z`, 'aria-label': '子 Worker 支线标记，不是提交节点', role: 'img' }));
  };
  const changed = () => {
    if (disposed || !current() || frame !== null) return;
    if (typeof host.requestAnimationFrame === 'function') frame = host.requestAnimationFrame(draw); else draw();
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(changed) : null;
  observer?.observe(canvas); host.addEventListener?.('resize', changed); root.addEventListener('toggle', changed, true);
  const present = (selected, markers, pageIndex, detail) => {
    clearMarkers(); branch = selected; sources = markers; page = pageIndex; panel = detail;
    if (frame !== null) host.cancelAnimationFrame?.(frame); frame = null;
    if (!branch) { layer?.remove(); layer = null; return; }
    if (!layer) { layer = svg('svg', { class: 'lineage-child-lines', role: 'group', 'aria-label': '选中子 Worker 的分合路径', focusable: 'false' }); canvas.append(layer); }
    changed();
  };
  const dispose = () => {
    disposed = true; clearMarkers(); if (frame !== null) host.cancelAnimationFrame?.(frame);
    observer?.disconnect(); host.removeEventListener?.('resize', changed); root.removeEventListener('toggle', changed, true);
    layer?.remove(); branch = null; sources.clear();
  };
  return { present, changed, dispose };
}
