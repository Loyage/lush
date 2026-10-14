import { check, id as workerId } from '../types.js';
import { graphOID } from '../workspaces/version-graph.js';
import { lineageSnapshot, lineageTokens, readLineage } from '../workspaces/worker-version-lineage.js';
import { graphWorker, successful, eventData, fixedRange, associations, bounded } from './version-graph.js';

function receipts(project, value) {
  // Every successful Event remains identifiable, including malformed legacy
  // evidence and several Events with the same source or shared Squash landing.
  const rows = successful(project, value.id, value.event_max + 1, 1001, true);
  check(rows.length <= 1000, 'version lineage successful delivery evidence exceeds safe limit (1000 Events)');
  return rows.map(row => {
    const receipt = eventData(row);
    const range = fixedRange(project, row, value.base);
    if (row.parent_type !== 'integer' || row.parent_id !== value.parent.id) range.reason = '交付记录缺少匹配的真实直接父身份';
    const resultOnly = row.type === 'task.delivered';
    if (resultOnly) range.reason = '无改动的结果交付没有固定父侧落点证据，不推测对应节点';
    const source = resultOnly ? receipt.commit : receipt.source_commit;
    return { range, mapping: { delivery_id: row.event_id, source_commit: graphOID(source) ? source : null,
      commit: !resultOnly && graphOID(receipt.commit) ? receipt.commit : null, parent_id: row.parent_type === 'integer' ? row.parent_id : null,
      delivered_at: row.delivered_at, evidence: row.type, delivery_available: range.reason === null,
      delivery_unavailable_reason: range.reason } };
  });
}
function initial(project, task) {
  check(['order', 'child'].includes(task.task_kind) && typeof task.branch === 'string' && task.branch.length > 0
    && task.branch.length <= 4096 && graphOID(task.base_commit), 'Worker has no readable recorded version lineage');
  const parent = graphWorker(project, task.parent_id), record = project.store.branch(task.branch);
  check(record && record.task_id === task.id && record.parent_relation === 'recorded'
    && record.parent === task.target_branch && record.parent === parent.branch && record.created_from_commit === task.base_commit,
  'version lineage is not traceable: branch ownership or creation baseline changed');
  const event_max = project.store.get('SELECT COALESCE(MAX(id),0) AS id FROM events').id;
  return { value: { id: task.id, branch: task.branch, scope: 'lineage', range: 'first-parent', base: task.base_commit,
    parent: { id: parent.id, worker_number: parent.worker_number, branch: parent.branch }, event_max,
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
    try {
      // Reuse the existing sterile fixed source/tree/parent/convergence verifier.
      // delivery is non-null: this call never samples a mutable ref.
      // Preserve every Event, but do not repeat the same object verification for
      // identical receipts. Exact source/base/landing/parent/convergence scope
      // is the key; sharing just a SHA is never enough to reuse verification.
      const key = JSON.stringify(range);
      if (!verifiedRanges.has(key)) {
        await project.workspaces.versionGraphPage({ ...range, delivery: mapping.delivery_id, limit: 1,
          event_max: value.event_max, deadline });
        verifiedRanges.set(key, true);
      }
    } catch (error) {
      check(Date.now() < deadline, 'version lineage read exceeded its 15 second budget');
      if (/busy|安全大小上限|safe size/.test(error.message)) throw error;
      mapping.delivery_available = false;
      mapping.delivery_unavailable_reason = '固定源／父侧落点／收据对象核验失败；该成功 Event 保留但不可追溯';
    }
    check(Date.now() < deadline, 'version lineage read exceeded its 15 second budget');
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
      offset = value.offset; delete value.offset; delete value.kind;
    } else ({ value, active } = initial(this, task));
    const items = receipts(this, value), latest = items[0];
    const fallback = latest?.range.reason === null ? { tip: latest.range.tip, delivery_id: latest.mapping.delivery_id } : null;
    if (cursor === undefined && !active) {
      check(fallback, 'Worker branch is unavailable and latest successful delivery has no traceable fixed source');
      Object.assign(value, { tip: fallback.tip, tip_evidence: 'delivery.source', tip_delivery_id: fallback.delivery_id });
    }
    const page = await readLineage(this.workspaces, value, { offset, limit, sample: cursor === undefined && active, fallback, deadline });
    const links = await mappings(this, value, page, items, offset, deadline, cursor === undefined);
    return bounded({ scope: 'lineage', range: value.range, worker: { id: task.id, worker_number: task.worker_number },
      branch: value.branch, parent: value.parent, origin: page.origin, tip: value.tip, tip_evidence: value.tip_evidence,
      tip_delivery_id: value.tip_delivery_id, commits: nodes(this, value, page.commits), ...links,
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
