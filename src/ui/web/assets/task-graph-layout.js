import { mergePriority } from './task-graph-merge.js';

// A task's parent is the only structural edge; branch and worktree belong to the task card.
// Missing parents (including a truncated page) become visible roots, never silently disappear.
export function taskForest(graph = {}) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const byId = new Map(nodes.map(node => [node.id, { ...node, children: [] }]));
  const roots = [];
  const parentOf = node => node.layout_parent_id ?? node.parent_id;
  for (const node of byId.values()) {
    let parent = byId.get(parentOf(node));
    // Corrupt cycles must not recursively hang the browser.
    const seen = new Set([node.id]);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      parent = byId.get(parentOf(parent));
    }
    if (parent) { roots.push(node); continue; }
    if (byId.has(parentOf(node))) byId.get(parentOf(node)).children.push(node);
    else roots.push(node);
  }
  const newest = (a, b) => b.id - a.id;
  roots.sort(newest);
  for (const node of byId.values()) {
    node.children.sort(newest);
    // Virtual ancestors must not turn unrelated descendants into delivery siblings.
    const siblings = node.children.filter(child => child.parent_id === node.id)
      .sort((a, b) => mergePriority(a) - mergePriority(b) || newest(a, b));
    let index = 0;
    node.children = node.children.map(child => child.parent_id === node.id ? siblings[index++] : child);
  }
  return roots;
}
