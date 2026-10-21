import { check, id as workerId } from '../types.js';
import { graphOID } from '../workspaces/version-graph.js';
import { lineageSnapshot, lineageTokens, readLineage } from '../workspaces/worker-version-lineage.js';
import { graphWorker, associations, bounded } from './version-graph.js';
import { lineageReceipts as receipts, verifyLineageReceipt, lineageChildren } from './version-lineage-children.js';

function initial(project, task) {
  check(['order', 'child'].includes(task.task_kind) && typeof task.branch === 'string' && task.branch.length > 0
    && task.branch.length <= 4096 && graphOID(task.base_commit), 'Worker has no readable recorded version lineage');
  const parent = graphWorker(project, task.parent_id), record = project.store.branch(task.branch);
  check(record && record.task_id === task.id && record.parent_relation === 'recorded'
    && record.parent === task.target_branch && record.parent === parent.branch && record.created_from_commit === task.base_commit,
  'version lineage is not traceable: branch ownership or creation baseline changed');
  const { event_max, child_max } = project.store.get(`SELECT
    (SELECT COALESCE(MAX(id),0) FROM events) AS event_max,
    (SELECT COALESCE(MAX(id),0) FROM tasks) AS child_max`);
  return { value: { id: task.id, branch: task.branch, scope: 'lineage', range: 'first-parent', base: task.base_commit,
    parent: { id: parent.id, worker_number: parent.worker_number, branch: parent.branch }, event_max, child_max,
    tip_evidence: 'branch.ref', tip_delivery_id: null }, active: record.status === 'active' };
}
async function mappings(project, value, page, items, offset, deadline, verifyLatest = false) {
  const commits = new Set(page.commits.map(row => row.commit));
  // Origin is an anchor, not a development commit. A no-change delivery whose
  // source is origin is still shown on the first page (or its node detail).
  if (offset === 0) commits.add(value.base);
  const deliveries = [], untraceable_deliveries = [], verifiedRanges = new Map();
  for (const { range, mapping } of items) {
    if (range.reason === null && mapping.source_commit !== value.base && !page.chain.has(mapping.source_commit)) {
      mapping.delivery_available = false;
      mapping.delivery_unavailable_reason = '固定源提交不在此 Worker 的第一父来源链中，无法作为开发节点映射';
    }
    if (!mapping.delivery_available) { untraceable_deliveries.push(mapping); continue; }
    if (!commits.has(mapping.source_commit)) continue;
    await verifyLineageReceipt(project, value, range, mapping, deadline, verifiedRanges);
    deliveries.push(mapping);
  }
  if (value.tip_evidence === 'delivery.source') {
    const latest = [...deliveries, ...untraceable_deliveries].find(row => row.delivery_id === value.tip_delivery_id);
    // Later pages may not contain the tip mapping, but the first page must verify
    // the *latest* successful receipt. Never fall back past a bad newest Event.
    if (verifyLatest) check(latest?.delivery_available, 'latest successful delivery is not traceable; cannot recover the Worker lineage');
  }
  return { deliveries, untraceable_deliveries };
}
function nodes(project, value, commits, detail = false) {
  const own = associations(project, { ...value, delivery: null }, commits.filter(row => row.commit !== value.base), detail);
  const byCommit = new Map(own.map(row => [row.commit, row]));
  return commits.map(row => row.commit === value.base ? { ...row, association: 'unassociated', tasks: [] } : byCommit.get(row.commit));
}

export default {
  async workerVersionLineage({ id, cursor, limit = 30 } = {}) {
    const task = graphWorker(this, workerId(id));
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'version lineage limit must be 1..100');
    const deadline = Date.now() + 15000;
    let value, offset = 0, active = false;
    if (cursor !== undefined) {
      value = lineageSnapshot(this.workspaces, cursor, task.id, 'cursor');
      check(value.page_limit === limit, 'version lineage page width changed; refresh the lineage');
      offset = value.offset; delete value.offset; delete value.kind;
    } else {
      ({ value, active } = initial(this, task));
      value.page_limit = limit;
    }
    const items = receipts(this, value), latest = items[0];
    const fallback = latest?.range.reason === null ? { tip: latest.range.tip, delivery_id: latest.mapping.delivery_id } : null;
    if (cursor === undefined && !active) {
      check(fallback, 'Worker branch is unavailable and latest successful delivery has no traceable fixed source');
      Object.assign(value, { tip: fallback.tip, tip_evidence: 'delivery.source', tip_delivery_id: fallback.delivery_id });
    }
    const page = await readLineage(this.workspaces, value, { offset, limit, sample: cursor === undefined && active, fallback, deadline });
    const links = await mappings(this, value, page, items, offset, deadline, cursor === undefined);
    const child_branches = await lineageChildren(this, value, page, offset, deadline);
    return bounded({ scope: 'lineage', range: value.range, worker: { id: task.id, worker_number: task.worker_number },
      branch: value.branch, parent: value.parent, origin: page.origin, tip: value.tip, tip_evidence: value.tip_evidence,
      tip_delivery_id: value.tip_delivery_id, commits: nodes(this, value, page.commits), ...links, child_branches,
      ...lineageTokens(this.workspaces, value, offset, limit, page.has_more), has_more: page.has_more });
  },
  async workerVersionLineageCommit({ id, snapshot, commit } = {}) {
    const task = graphWorker(this, workerId(id)), value = lineageSnapshot(this.workspaces, snapshot, task.id);
    delete value.kind;
    const deadline = Date.now() + 15000, items = receipts(this, value);
    // Validate before Git so undefined never accidentally becomes a page read.
    check(graphOID(commit), 'version lineage commit must be a full object ID');
    const page = await readLineage(this.workspaces, value, { commit, deadline });
    const links = await mappings(this, value, page, items, commit === value.base ? 0 : 1, deadline);
    return bounded({ worker: { id: task.id, worker_number: task.worker_number }, scope: 'lineage', delivery: null,
      tip: value.tip, base: value.base, commit: nodes(this, value, page.commits, true)[0], ...links });
  },
};
