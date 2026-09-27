// A task's parent is the only structural edge; branch and worktree belong to the task card.
// Missing parents (including a truncated page) become visible roots, never silently disappear.
export function taskForest(graph = {}) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const byId = new Map(nodes.map(node => [node.id, { ...node, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    let parent = byId.get(node.parent_id);
    // Corrupt cycles must not recursively hang the browser.
    const seen = new Set([node.id]);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      parent = byId.get(parent.parent_id);
    }
    if (parent) { roots.push(node); continue; }
    if (byId.has(node.parent_id)) byId.get(node.parent_id).children.push(node);
    else roots.push(node);
  }
  const newest = (a, b) => b.id - a.id;
  roots.sort(newest);
  for (const node of byId.values()) node.children.sort(newest);
  return roots;
}
