const x = lane => 16 + lane * 22;
const y = anchor => ({ top: 0, node: 50, bottom: 100 })[anchor];

/** Stable lanes follow actual Git parent identities. Empty slots are reused, never compacted
 * under a continuing edge; pagination therefore extends rather than rewrites earlier lanes. */
export function versionGraphLayout(commits) {
  const positions = new Map(commits.map((commit, index) => [commit.commit, index]));
  if (positions.size !== commits.length) throw new Error('提交图含重复提交，请刷新后重新读取。');
  const lanes = [], rows = [], edges = [];
  const slot = () => { const free = lanes.indexOf(null); return free < 0 ? lanes.length : free; };
  const segment = (fromLane, fromAnchor, toLane, toAnchor, parent) => ({
    from: { lane: fromLane, anchor: fromAnchor }, to: { lane: toLane, anchor: toAnchor }, parent,
  });
  commits.forEach((commit, index) => {
    let lane = lanes.indexOf(commit.commit);
    const continued = lane >= 0;
    if (!continued) { lane = slot(); lanes[lane] = commit.commit; }
    const segments = [];
    lanes.forEach((parent, column) => {
      if (parent !== null && column !== lane) segments.push(segment(column, 'top', column, 'bottom', parent));
    });
    if (continued) segments.push(segment(lane, 'top', lane, 'node', commit.commit));
    lanes[lane] = null;
    for (const [parentIndex, parent] of [...new Set(commit.parents)].entries()) {
      const targetRow = positions.get(parent);
      if (targetRow !== undefined && targetRow <= index) throw new Error('提交图拓扑顺序不兼容，请更新项目后台。');
      let targetLane = lanes.indexOf(parent);
      if (targetLane < 0) {
        targetLane = parentIndex === 0 && lanes[lane] === null ? lane : slot();
        lanes[targetLane] = parent;
      }
      segments.push(segment(lane, 'node', targetLane, 'bottom', parent));
      edges.push({ child: commit.commit, parent, from: { row: index, lane },
        to: { row: targetRow ?? null, lane: targetLane }, boundary: targetRow === undefined });
    }
    rows.push({ commit: commit.commit, lane, segments });
  });
  const boundaries = lanes.flatMap((parent, lane) => parent === null ? [] : [{ parent, lane }]);
  const count = Math.max(1, lanes.length);
  return { rows, edges, boundaries, lanes: count, width: count * 22 + 10 };
}

/** SVG coordinates use percentages vertically, so variable-height details need no DOM
 * measurement, resize listener, inline style, or rebuilding of commit cards. */
export function versionGraphPath(segment) {
  const fromX = x(segment.from.lane), toX = x(segment.to.lane);
  const fromY = y(segment.from.anchor), toY = y(segment.to.anchor);
  return fromX === toX ? `M ${fromX} ${fromY} L ${toX} ${toY}`
    : `M ${fromX} ${fromY} C ${fromX} ${(fromY + toY) / 2} ${toX} ${(fromY + toY) / 2} ${toX} ${toY}`;
}
