// Receipt paths are deliberately separate from Git edges. Coordinates are measured
// from the actual node markers so details, fonts, viewport changes and shared anchors
// cannot turn a receipt into a line to a guessed/duplicated commit.
export function lineageMappingPath(source, target, channel) {
  if (source.x === target.x && source.y === target.y) {
    return `M ${source.x} ${source.y} C ${source.x + 10} ${source.y - 16} ${source.x - 10} ${source.y - 16} ${target.x} ${target.y}`;
  }
  return `M ${source.x} ${source.y} H ${channel} V ${target.y} H ${target.x}`;
}
const svg = (tag, attrs) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
};
export function createLineageMappings(root, canvas, current) {
  let layer = null;
  const host = globalThis.window || globalThis;
  let disposed = false, frame = null, connections = [], gitEdges = [], observer = null;
  const active = () => !disposed && current();
  const draw = () => {
    frame = null;
    if (!active() || !layer || !canvas.getBoundingClientRect) return;
    const base = canvas.getBoundingClientRect();
    if (!base.width || !base.height) return;
    layer.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    for (const [index, entry] of [...connections, ...gitEdges].entries()) {
      const a = entry.source.getBoundingClientRect(), b = entry.target.getBoundingClientRect();
      const from = { x: a.left + a.width / 2 - base.left, y: a.top + a.height / 2 - base.top };
      const to = { x: b.left + b.width / 2 - base.left, y: b.top + b.height / 2 - base.top };
      const cell = entry.sourceCell.getBoundingClientRect();
      const channel = entry.git ? (entry.secondary ? from.x + 8 : from.x)
        : entry.origin ? Math.max(2, from.x - 8) : cell.left - base.left + 21 + (index % 7) * 3;
      entry.path.setAttribute('d', lineageMappingPath(from, to, channel));
      entry.path.dataset.sourceX = String(from.x); entry.path.dataset.sourceY = String(from.y);
      entry.path.dataset.targetX = String(to.x); entry.path.dataset.targetY = String(to.y);
    }
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
    for (const entry of connections) entry.path.classList.toggle('is-active', entry.events.includes(event));
  };
  const enter = event => highlight(event.target), leave = event => highlight(event.relatedTarget);
  root.addEventListener('pointerover', enter); root.addEventListener('focusin', enter);
  root.addEventListener('pointerout', leave); root.addEventListener('focusout', leave);
  // Details toggles bubble only through a capturing listener in browsers.
  root.addEventListener('toggle', changed, true);
  host.addEventListener?.('resize', changed);
  if (typeof ResizeObserver === 'function') observer = new ResizeObserver(changed);
  const present = (model, sources, targets, cells) => {
    cancel(); observer?.disconnect(); connections = []; gitEdges = [];
    if (!layer) { layer = svg('svg', { class: 'lineage-delivery-lines', 'aria-label': '持久 Event 交付映射（不是 Git 父边）', role: 'group', focusable: 'false' }); canvas.append(layer); }
    for (const pair of model.connections) {
      const source = sources.get(pair.source), target = targets.get(pair.landing);
      if (!source || !target) throw new Error('交付映射缺少来源节点或真实父侧锚点');
      const path = svg('path', { class: 'lineage-delivery-edge', 'vector-effect': 'non-scaling-stroke', role: 'img',
        'aria-label': `交付 Event ${pair.events.join('、')}：来源 ${pair.source} → 父侧 ${pair.landing}（不是 Git 父边）` });
      path.id = `lineage-delivery-${root.dataset.workerId}-${pair.source}-${pair.landing}`;
      Object.assign(path.dataset, { source: pair.source, landing: pair.landing, deliveries: pair.events.join(','), sourceNode: source.id, targetNode: target.id });
      connections.push({ ...pair, source, target, path, sourceCell: cells.get(pair.source), origin: pair.source === model.origin.commit.commit });
    }
    for (const row of model.rows || []) row.edges.forEach((edge, index) => {
      if (edge.boundary || edge.external) return;
      const source = sources.get(edge.child), target = sources.get(edge.parent);
      if (!source || !target) throw new Error('真实 Git 父边缺少节点');
      const path = svg('path', { class: `lineage-git-edge${index ? ' lineage-secondary-edge' : ''}${edge.parent === model.origin.commit.commit ? ' lineage-fork' : ''}`,
        'vector-effect': 'non-scaling-stroke', 'aria-hidden': 'true' });
      Object.assign(path.dataset, { child: edge.child, parent: edge.parent, sourceNode: source.id, targetNode: target.id });
      gitEdges.push({ source, target, path, sourceCell: cells.get(edge.child), git: true, secondary: index > 0 });
    });
    layer.replaceChildren(...gitEdges.map(entry => entry.path), ...connections.map(entry => entry.path));
    observer?.observe(canvas);
    for (const row of canvas.querySelectorAll('.lineage-row')) observer?.observe(row);
    changed();
  };
  const dispose = () => {
    disposed = true; cancel(); observer?.disconnect(); observer = null; connections = []; gitEdges = [];
    root.removeEventListener('pointerover', enter); root.removeEventListener('focusin', enter);
    root.removeEventListener('pointerout', leave); root.removeEventListener('focusout', leave);
    root.removeEventListener('toggle', changed, true); host.removeEventListener?.('resize', changed);
    layer?.replaceChildren();
  };
  return { present, changed, dispose };
}
