import { check } from '../types.js';
import { graphOID } from '../workspaces/version-graph.js';
import { lineageTokens } from '../workspaces/worker-version-lineage.js';
import { successful, eventData, fixedRange } from './version-graph.js';

export function lineageReceipts(project, value, limit = 1001) {
  // Event identity survives malformed old evidence, repeated sources and shared landings.
  const rows = successful(project, value.id, value.event_max + 1, limit, true);
  check(rows.length < limit, 'version lineage successful delivery evidence exceeds safe limit (1000 Events)');
  return rows.map(row => {
    const receipt = eventData(row), range = fixedRange(project, row, value.base);
    if (row.parent_type !== 'integer' || row.parent_id !== value.parent.id) range.reason = '交付记录缺少匹配的真实直接父身份';
    const resultOnly = row.type === 'task.delivered';
    if (resultOnly) range.reason = '无改动的结果交付没有固定父侧落点证据，不推测对应节点';
    const source = resultOnly ? receipt.commit : receipt.source_commit;
    return { row, range, mapping: { delivery_id: row.event_id, source_commit: graphOID(source) ? source : null,
      commit: !resultOnly && graphOID(receipt.commit) ? receipt.commit : null,
      parent_id: row.parent_type === 'integer' ? row.parent_id : null,
      delivered_at: row.delivered_at, evidence: row.type, delivery_available: range.reason === null,
      delivery_unavailable_reason: range.reason } };
  });
}

export async function verifyLineageReceipt(project, value, range, mapping, deadline, verified) {
  if (!mapping.delivery_available) return;
  try {
    // The full fixed range is the cache identity, never just a source or landing SHA.
    // This is the real source/tree/parent/convergence Git verifier, not associations().
    const key = JSON.stringify(range);
    if (!verified.has(key)) {
      await project.workspaces.versionGraphPage({ ...range, delivery: mapping.delivery_id, limit: 1,
        event_max: value.event_max, deadline });
      verified.set(key, true);
    }
  } catch (error) {
    check(Date.now() < deadline, 'version lineage read exceeded its 15 second budget');
    if (/busy|安全大小上限|safe size/.test(error.message)) throw error;
    mapping.delivery_available = false;
    mapping.delivery_unavailable_reason = '固定源／父侧落点／收据对象核验失败；该成功 Event 保留但不可追溯';
  }
  check(Date.now() < deadline, 'version lineage read exceeded its 15 second budget');
}

export async function lineageChildren(project, value, page, offset, deadline) {
  // No status filter: archived direct Workers and undelivered children are historical facts.
  // IDs never get reused. The signed task high-water freezes the creation set across pages.
  const children = project.store.all(`SELECT t.id,t.worker_number,t.branch,t.base_commit,t.target_branch,
    b.task_id AS branch_task,b.parent,b.parent_relation,b.created_from_commit
    FROM tasks t LEFT JOIN branches b ON b.branch=t.branch
    WHERE t.parent_id=? AND t.id<=? AND t.task_kind IN ('order','say','child') ORDER BY t.id LIMIT 1001`, value.id, value.child_max);
  check(children.length <= 1000, 'version lineage direct children exceed safe limit (1000 Workers)');
  const positions = new Map([...page.chain].map((sha, index) => [sha, Math.floor(index / value.page_limit)]));
  positions.set(value.base, 0);
  const currentPage = offset / value.page_limit, verified = new Map(), cursors = new Map([[0, null]]);
  const endpoint = (commit, reason = null) => {
    const target = positions.get(commit);
    if (reason === null && target === undefined) reason = '固定节点不在此父 Worker 的第一父来源快照中';
    if (reason !== null) return { commit, page: null, cursor: null, available: false, reason };
    if (!cursors.has(target)) cursors.set(target, lineageTokens(project.workspaces, value,
      (target - 1) * value.page_limit, value.page_limit, true).cursor);
    return { commit, page: target, cursor: cursors.get(target), available: true, reason: null };
  };
  const result = [];
  let count = 0;
  for (const child of children) {
    check(Date.now() < deadline, 'version lineage read exceeded its 15 second budget');
    const originCommit = graphOID(child.base_commit) ? child.base_commit : null;
    const originValid = originCommit !== null && typeof child.branch === 'string' && child.branch.length > 0
      && child.branch.length <= 4096 && child.branch_task === child.id && child.parent_relation === 'recorded'
      && child.parent === value.branch && child.target_branch === value.branch && child.created_from_commit === originCommit;
    const origin = endpoint(originCommit, originValid ? null : '子 Worker 的登记分支／直接父／创建基线不一致或缺失');
    const items = lineageReceipts(project, { id: child.id, base: child.base_commit,
      event_max: value.event_max, parent: { id: value.id } }, 1001 - count);
    count += items.length;
    // Explicitly targeted elsewhere is not a delivery to this Worker. Result-only
    // evidence has no target/landing and is retained as unavailable at its origin.
    const targeted = items.filter(({ row }) => row.type === 'task.delivered'
      || row.type === 'task.merge_integrated' && row.parent_type === 'integer' && row.parent_id === value.id
      || row.type === 'merged' && row.target_type === 'text' && row.event_parent === value.branch);
    if (positions.get(originCommit) !== currentPage && !targeted.some(({ mapping }) => positions.get(mapping.commit) === currentPage)) continue;
    const deliveries = [];
    for (const { range, mapping } of targeted) {
      await verifyLineageReceipt(project, value, range, mapping, deadline, verified);
      deliveries.push({ ...mapping, landing: endpoint(mapping.commit, mapping.delivery_unavailable_reason) });
    }
    result.push({ worker: { id: child.id, worker_number: child.worker_number }, origin, deliveries });
  }
  return result;
}
