// Git ancestry and delivery receipts are different relations. Both use measured
// marker centres; only verified receipts receive directional mapping arrows.
export function lineageMappingPath(source, target, channel) {
  if (source.x === target.x && source.y === target.y) {
    return `M ${source.x} ${source.y} C ${source.x + 24} ${source.y - 24} ${source.x - 12} ${source.y - 24} ${target.x} ${target.y}`;
  }
  const direction = Math.sign(target.y - source.y) || 1;
  const bend = Math.min(14, Math.abs(target.y - source.y) / 4);
  return `M ${source.x} ${source.y} C ${source.x} ${source.y + direction * bend} ${channel} ${source.y + direction * bend} ${channel} ${source.y + direction * bend * 2} L ${channel} ${target.y - direction * bend * 2} C ${channel} ${target.y - direction * bend} ${target.x} ${target.y - direction * bend} ${target.x} ${target.y}`;
}
export function lineageGitPath(source, target) {
  if (source.x === target.x) return `M ${source.x} ${source.y} L ${target.x} ${target.y}`;
  const turn = Math.sign(source.y - target.y) * Math.min(32, Math.abs(source.y - target.y));
  return `M ${source.x} ${source.y} L ${source.x} ${target.y + turn} C ${source.x} ${target.y + turn / 2} ${target.x} ${target.y + turn / 2} ${target.x} ${target.y}`;
}
// Interval allocation, not index % N: unrelated short receipts reuse space,
// while shared-source/landing and backwards mappings get distinct channels.
export function lineageMappingChannels(entries) {
  const ends = [], slots = new Map();
  const ordered = entries.map((entry, index) => ({ index, low: Math.min(entry.from.y, entry.to.y), high: Math.max(entry.from.y, entry.to.y) }))
    .sort((a, b) => a.low - b.low || a.high - b.high || a.index - b.index);
  for (const { index, low, high } of ordered) {
    let slot = ends.findIndex(end => end < low);
    if (slot < 0) slot = ends.length;
    ends[slot] = high; slots.set(index, slot);
  }
  return entries.map(({ from, to }, index) => {
    const left = Math.min(from.x, to.x), right = Math.max(from.x, to.x);
    return left === right ? left + 12 : left + 10 + (right - left - 20) * (slots.get(index) + 1) / (ends.length + 1);
  });
}
export function createLineageMappings(root, canvas, current) {
  let layer = null;
  const host = root.ownerDocument?.defaultView || globalThis.window || globalThis;
  const svg = (tag, attrs) => {
    const node = (root.ownerDocument || document).createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };
  let disposed = false, frame = null, connections = [], gitEdges = [], parentAnchors = [], parentPath = null, observer = null;
  const active = () => !disposed && current();
  const draw = () => {
    frame = null;
    if (!active() || !layer || !canvas.getBoundingClientRect) return;
    const base = canvas.getBoundingClientRect();
    if (!base.width || !base.height) return;
    layer.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    const centre = node => {
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width / 2 - base.left, y: box.top + box.height / 2 - base.top };
    };
    const measured = connections.map(entry => ({ ...entry, from: centre(entry.source), to: centre(entry.target) }));
    const channels = lineageMappingChannels(measured);
    for (const [index, entry] of [...measured, ...gitEdges.map(entry => ({ ...entry, from: centre(entry.source), to: centre(entry.target) }))].entries()) {
      const { from, to } = entry;
      const d = entry.git ? entry.secondary ? lineageMappingPath(from, to, Math.max(from.x, to.x) + 16) : lineageGitPath(from, to)
        : lineageMappingPath(from, to, channels[index]);
      entry.path.setAttribute('d', d); entry.halo?.setAttribute('d', d);
      entry.path.dataset.sourceX = String(from.x); entry.path.dataset.sourceY = String(from.y);
      entry.path.dataset.targetX = String(to.x); entry.path.dataset.targetY = String(to.y);
    }
    const anchors = parentAnchors.map(centre).sort((a, b) => a.y - b.y);
    parentPath?.setAttribute('d', anchors.length > 1 ? `M ${anchors[0].x} ${anchors[0].y} L ${anchors.at(-1).x} ${anchors.at(-1).y}` : '');
  };
  const changed = () => {
    if (!active() || frame !== null) return;
    if (typeof host.requestAnimationFrame === 'function') frame = host.requestAnimationFrame(draw);
    else draw();
  };
  const cancel = () => { if (frame !== null) host.cancelAnimationFrame?.(frame); frame = null; };
  const receipt = node => { for (let at = node; at && at !== root; at = at.parentNode) if (at.classList?.contains('lineage-receipt')) return at; return null; };
  const highlight = node => {
    if (!active()) return;
    const event = Number(receipt(node)?.dataset.delivery);
    for (const marker of [...parentAnchors, ...connections.map(entry => entry.source)]) marker.classList.remove('is-mapping-active');
    for (const entry of connections) {
      const selected = entry.events.includes(event);
      entry.path.classList.toggle('is-active', selected);
      if (selected) { entry.source.classList.add('is-mapping-active'); entry.target.classList.add('is-mapping-active'); }
    }
  };
  const enter = event => highlight(event.target), leave = event => highlight(event.relatedTarget);
  root.addEventListener('pointerover', enter); root.addEventListener('focusin', enter);
  root.addEventListener('pointerout', leave); root.addEventListener('focusout', leave);
  root.addEventListener('toggle', changed, true);
  host.addEventListener?.('resize', changed);
  if (typeof ResizeObserver === 'function') observer = new ResizeObserver(changed);
  const present = (model, sources, targets) => {
    cancel(); observer?.disconnect(); connections = []; gitEdges = []; parentAnchors = [...targets.values()];
    if (!layer) { layer = svg('svg', { class: 'lineage-delivery-lines', 'aria-label': '真实 Git 父边与独立交付映射', role: 'group', focusable: 'false' }); canvas.append(layer); }
    const arrowId = `lineage-arrow-${root.dataset.workerId}`;
    const defs = svg('defs', {}), arrow = svg('marker', { id: arrowId, viewBox: '0 0 10 10', refX: 18, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto' });
    arrow.append(svg('path', { d: 'M 1 1 L 9 5 L 1 9', class: 'lineage-arrow' })); defs.append(arrow);
    parentPath = svg('path', { class: 'lineage-parent-history', 'aria-label': '父侧外部历史省略，不表示相邻 Git 提交', role: 'img' });
    for (const pair of model.connections) {
      const source = sources.get(pair.source), target = targets.get(pair.landing);
      if (!source || !target) throw new Error('交付映射缺少来源节点或真实父侧锚点');
      const path = svg('path', { class: 'lineage-delivery-edge', 'vector-effect': 'non-scaling-stroke', role: 'img', 'marker-end': `url(#${arrowId})`,
        'aria-label': `交付 Event ${pair.events.join('、')}：来源 ${pair.source} → 父侧 ${pair.landing}（不是 Git 父边）` });
      path.id = `lineage-delivery-${root.dataset.workerId}-${pair.source}-${pair.landing}`;
      Object.assign(path.dataset, { source: pair.source, landing: pair.landing, deliveries: pair.events.join(','), sourceNode: source.id, targetNode: target.id });
      const halo = svg('path', { class: 'lineage-edge-halo', 'aria-hidden': 'true' });
      connections.push({ ...pair, source, target, path, halo });
    }
    for (const row of model.rows || []) row.edges.forEach((edge, index) => {
      if (edge.boundary && !edge.external) return;
      const source = sources.get(edge.child), target = sources.get(edge.parent) || (edge.external ? targets.get(edge.parent) : null);
      if ((edge.boundary || edge.external) && !target) return;
      if (!source || !target) throw new Error('真实 Git 父边缺少节点');
      const secondary = edge.external || index > 0;
      const path = svg('path', { class: `lineage-git-edge${secondary ? ' lineage-secondary-edge' : ''}${edge.parent === model.origin.commit.commit ? ' lineage-fork' : ''}`,
        'vector-effect': 'non-scaling-stroke', 'aria-hidden': 'true' });
      Object.assign(path.dataset, { child: edge.child, parent: edge.parent, sourceNode: source.id, targetNode: target.id, secondary: String(secondary) });
      gitEdges.push({ source, target, path, git: true, secondary });
    });
    layer.replaceChildren(defs, parentPath, ...gitEdges.map(entry => entry.path), ...connections.flatMap(entry => [entry.halo, entry.path]));
    observer?.observe(canvas);
    for (const row of canvas.querySelectorAll('.lineage-row')) observer?.observe(row);
    changed();
  };
  const dispose = () => {
    disposed = true; cancel(); observer?.disconnect(); observer = null; connections = []; gitEdges = []; parentAnchors = [];
    root.removeEventListener('pointerover', enter); root.removeEventListener('focusin', enter);
    root.removeEventListener('pointerout', leave); root.removeEventListener('focusout', leave);
    root.removeEventListener('toggle', changed, true); host.removeEventListener?.('resize', changed);
    layer?.replaceChildren();
  };
  return { present, changed, dispose };
}
