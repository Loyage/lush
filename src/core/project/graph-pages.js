import { createHash } from 'node:crypto';
import { check } from '../types.js';
import { WORKER_GRAPH_STATUSES as STATUSES, validateWorkerQuery } from '../worker-query.js';

// Leaves >148 KiB for the JSON-RPC envelope; measure serialized UTF-8, not characters.
export const GRAPH_BYTE_BUDGET = 900000;
export const GRAPH_PAGE_LIMIT = 200;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

export function graphOptions({ details = true, hidden_statuses = [], include_archived = true, scope = 'all', cursor } = {}) {
  validateWorkerQuery('worker.graph', { details, hidden_statuses, include_archived, scope, cursor });
  return { details, hidden_statuses: [...hidden_statuses].sort(), include_archived, scope, cursor };
}

export function graphPage(project, metadata, options) {
  const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
  let archived_count = 0;
  const filtered = metadata.filter(row => {
    // Keep historical RPC/CLI nodes, but UI counters describe drawable kinds only.
    const drawable = ['main', 'owner', 'order', 'say', 'child', 'merge'].includes(row.task_kind);
    if (options.scope === 'tree' && !drawable) return false;
    if (drawable && row.archived) archived_count++;
    if (!options.include_archived && row.archived) return false;
    if (drawable) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return !options.hidden_statuses.includes(row.status);
  });
  // Ordering depends only on structural metadata. Any structural drift invalidates
  // continuation instead of silently skipping/repeating rows. Body updates are OK.
  const filterIdentity = hash([project, options.details, options.hidden_statuses, options.include_archived, options.scope]);
  const identity = hash(metadata.map(row => [row.id, row.parent_id, row.status, row.task_kind, row.archived]));
  let offset = 0;
  if (options.cursor !== undefined) {
    let value;
    try {
      check(/^[A-Za-z0-9_-]+$/.test(options.cursor), 'invalid graph cursor');
      value = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
    } catch { check(false, 'invalid graph cursor'); }
    check(value?.version === 2 && typeof value.identity === 'string' && typeof value.filter_identity === 'string'
      && Number.isSafeInteger(value.offset) && value.offset > 0, 'invalid graph cursor range');
    check(value.filter_identity === filterIdentity, 'Worker graph cursor filter or project mismatch');
    check(value.identity === identity, 'Worker graph cursor stale; refresh from first page');
    check(value.offset < filtered.length, 'invalid graph cursor range');
    offset = value.offset;
  }
  const byId = new Map(metadata.map(row => [row.id, row]));
  const visible = new Set(filtered.map(row => row.id));
  const layoutParent = row => {
    const seen = new Set([row.id]);
    let parent = row.parent_id;
    while (parent != null && !seen.has(parent)) {
      if (visible.has(parent)) return parent;
      seen.add(parent); parent = byId.get(parent)?.parent_id ?? null;
    }
    return null;
  };
  return { filtered, offset, layoutParent, counts, archived_count, identity,
    cursorAt: next => next < filtered.length ? Buffer.from(JSON.stringify({ version: 2, filter_identity: filterIdentity, identity, offset: next })).toString('base64url') : null };
}

function unavailable(node) {
  return { id: node.id, parent_id: node.parent_id, layout_parent_id: node.layout_parent_id,
    parent_task_kind: node.parent_task_kind, kind: 'task', task_kind: node.task_kind,
    worker_number: String(node.worker_number ?? '').slice(0, 100) || null,
    status: node.status, archived: node.archived, integration: node.integration,
    title: String(node.title ?? '').slice(0, 120), has_result: node.has_result,
    node_truncated: true, details_unavailable: true,
    details_unavailable_reason: 'node exceeds graph byte budget; use worker.inspect/history for details',
    details_pending: false, resources: null, branch_info: null };
}

export function packGraph(nodes, page, total, details) {
  const result = { nodes: [], edges: [], total, truncated: false,
    ...(!details ? { details_pending: true } : {}), cursor: null, has_more: false,
    matched_total: page.filtered.length, counts: page.counts, archived_count: page.archived_count };
  const finalize = () => {
    const next = page.offset + result.nodes.length;
    result.cursor = page.cursorAt(next);
    result.has_more = result.cursor !== null;
    result.truncated = result.has_more || result.nodes.some(node => node.node_truncated);
    const ids = new Set(result.nodes.map(node => node.id));
    result.edges = result.nodes.filter(node => ids.has(node.parent_id)).map(node => ({ from: node.parent_id, to: node.id }));
  };
  for (const full of nodes) {
    // A pathological single node must still advance the cursor, never poison every page.
    let node = jsonBytes(full) > GRAPH_BYTE_BUDGET - 10000 ? unavailable(full) : full;
    result.nodes.push(node); finalize();
    if (jsonBytes(result) >= GRAPH_BYTE_BUDGET) {
      result.nodes.pop(); finalize();
      if (result.nodes.length) break;
      node = unavailable(full); result.nodes.push(node); finalize();
    }
  }
  finalize();
  check(jsonBytes(result) < GRAPH_BYTE_BUDGET, 'graph metadata exceeds byte budget');
  return result;
}
