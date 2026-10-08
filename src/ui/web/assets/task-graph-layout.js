import { mergePhase, mergePriority } from './task-graph-merge.js';

// Display attention, never execution order. Only matching persistent requests
// count as merging / requested; Agent status and Git divergence do not.
function attention(node) {
  const merge = mergePriority(node);
  if (merge < 2) return merge;
  const phase = mergePhase(node);
  if (['blocked', 'suspended'].includes(phase) || node.notice_count > 0 || node.notice
    || node.status === 'awaiting' || node.status === 'failed' || node.integration === 'conflict'
    || (node.status === 'completed' && ['pending', 'review'].includes(node.integration))) return 2;
  return { awaiting_acceptance: 3, running: 4, waiting: 5, queued: 6,
    paused: 7, completed: 9, cancelled: 10 }[node.status] ?? 8;
}

function createdAt(node) {
  const value = node.created_at;
  const at = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(at) ? at : 0;
}

const byAttention = (a, b) => attention(a) - attention(b)
  || createdAt(b) - createdAt(a) || b.id - a.id;

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
  // Roots and displayed siblings use their own stage, without descendant roll-up.
  // Layout may skip hidden ancestors, but mergePhase still checks the real parent.
  roots.sort(byAttention);
  for (const node of byId.values()) node.children.sort(byAttention);
  return roots;
}
