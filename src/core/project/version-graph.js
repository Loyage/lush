import { check } from '../types.js';
import { graphOID } from '../workspaces/version-graph.js';

const data = "CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END";
const projection = `e.id AS event_id, e.type, e.task_id, substr(e.data,1,8193) AS event_data,
  json_type(${data},'$.parent_id') AS parent_type, json_extract(${data},'$.parent_id') AS parent_id,
  json_type(${data},'$.parent') AS target_type, json_extract(${data},'$.parent') AS event_parent,
  json_extract(${data},'$.legacy') AS event_legacy,
  t.worker_number, substr(t.goal,1,16385) AS goal, t.task_kind, t.branch, t.base_commit, t.target_branch,
  i.id AS input_id, substr(i.content,1,131073) AS input_content, p.branch AS parent_branch`;
const joins = `FROM events e JOIN tasks t ON t.id=e.task_id
  LEFT JOIN inputs i ON i.id=t.input_id LEFT JOIN tasks p ON p.id=json_extract(${data},'$.parent_id')`;
const successTypes = "('task.merge_integrated','merged')";
function eventData(row) {
  check(row.event_data.length <= 8192, 'version graph delivery evidence exceeds safe size');
  try { return JSON.parse(row.event_data); } catch { return {}; }
}
function textBounds(row) {
  check(row.goal.length <= 16384 && (row.input_content?.length ?? 0) <= 131072,
    'version graph Worker or order text exceeds safe size');
}
function targetMatches(row, scope) {
  if (row.type === 'task.merge_integrated') return row.parent_type === 'integer'
    && (scope === null ? row.parent_branch === 'main' : row.parent_id === scope.task_id);
  return row.target_type !== null ? row.event_parent === (scope?.branch ?? 'main')
    : scope === null && row.event_legacy === 1 && row.task_kind === null && row.target_branch === 'main';
}

/** The successful Event ID is the public identity, NOT merge.enqueued.delivery_id.
 * No reservation, current HEAD or mutable iteration baseline is a read fallback. */
function fixedRange(project, row) {
  const receipt = eventData(row);
  if (row.type !== 'task.merge_integrated' || row.parent_type !== 'integer' || row.parent_id <= 0
    || !graphOID(receipt.source_commit) || !graphOID(receipt.commit) || receipt.squash !== true)
    return { reason: '缺少成功交付的固定源提交与 Squash 父侧证据' };
  if (typeof row.branch !== 'string' || row.branch.length === 0 || row.branch.length > 4096)
    return { reason: '缺少 Worker 的记录分支身份' };
  const prior = project.store.get(`SELECT substr(data,1,8193) AS event_data, type FROM events
    WHERE task_id=? AND type IN ${successTypes} AND id<? ORDER BY id DESC LIMIT 1`, row.task_id, row.event_id);
  const priorReceipt = prior ? eventData(prior) : null;
  if (prior && (prior.type !== 'task.merge_integrated' || priorReceipt.squash !== true || !graphOID(priorReceipt.commit)))
    return { reason: '此前成功交付缺少可信的固定源提交证据' };
  const base = prior ? priorReceipt.source_commit : row.base_commit;
  if (!graphOID(base)) return { reason: '缺少创建基线或此前成功交付的固定源提交' };
  let parent_base = null;
  if (Number.isSafeInteger(receipt.attempt_id) && receipt.attempt_id > 0) {
    const fixed = project.store.all(`SELECT substr(e.data,1,8193) AS event_data FROM events e
      WHERE e.task_id=? AND e.type='merge.baseline_fixed' AND e.id<?
        AND json_type(${data},'$.attempt_id')='integer' AND json_extract(${data},'$.attempt_id')=?
      ORDER BY e.id DESC LIMIT 2`, row.task_id, row.event_id, receipt.attempt_id);
    if (fixed.length) {
      const values = fixed.map(row => eventData(row).baseline);
      if (fixed.length !== 1 || !values.every(graphOID)) return { reason: '固定父基线审计缺失或相互矛盾' };
      parent_base = values[0];
    }
  }
  if (parent_base === null && receipt.commit === receipt.source_commit)
    return { reason: '无新落点的交付缺少固定父基线审计' };
  return { tip: receipt.source_commit, base, landed: receipt.commit, parent_base, reason: null };
}
function taskProjection(row, range) {
  textBounds(row);
  return { id: row.task_id, worker_number: row.worker_number, goal: row.goal, task_kind: row.task_kind ?? 'legacy',
    input: row.input_id === null ? null : { id: row.input_id, content: row.input_content }, evidence: row.type,
    delivery_id: row.event_id, delivery_available: range.reason === null, delivery_unavailable_reason: range.reason };
}

export default {
  async branchVersionGraph({ delivery, cursor, limit = 50 } = {}) {
    check(delivery === undefined || Number.isSafeInteger(delivery) && delivery > 0, 'version graph delivery must be a positive Event ID');
    let scope = null, range = {};
    if (delivery !== undefined) {
      scope = this.store.get(`SELECT ${projection} ${joins} WHERE e.id=? AND e.type IN ${successTypes}`, delivery);
      check(scope, 'delivery is not traceable: successful delivery Event not found');
      textBounds(scope);
      range = fixedRange(this, scope);
      check(range.reason === null, `delivery is not traceable: ${range.reason}`);
    }
    const event_max = this.store.get('SELECT COALESCE(MAX(id),0) AS id FROM events').id;
    const page = await this.workspaces.versionGraphPage({ ...range, delivery: delivery ?? null, cursor, limit, event_max });
    const byCommit = new Map(page.commits.map(row => [row.commit, []]));
    if (byCommit.size) {
      const rows = this.store.all(`SELECT ${projection} ${joins}
        WHERE e.type IN ${successTypes} AND e.id<=?
          AND json_extract(${data},'$.commit') IN (${[...byCommit.keys()].map(() => '?').join(',')})
        ORDER BY e.id DESC LIMIT 1001`, page.event_max, ...byCommit.keys());
      check(rows.length <= 1000, 'version graph associations exceed safe limit; request a smaller page');
      for (const row of rows) {
        if (!targetMatches(row, scope) || scope && (row.event_id >= scope.event_id || row.task_id === scope.task_id)) continue;
        const receipt = eventData(row);
        byCommit.get(receipt.commit).push(taskProjection(row, fixedRange(this, row)));
      }
    }
    const sourceTask = scope ? { ...taskProjection(scope, { reason: '普通源开发提交没有独立交付，不能递归打开当前图' }),
      evidence: 'delivery.source', delivery_id: null } : null;
    const result = { scope: scope ? 'delivery' : 'main', branch: scope?.branch ?? 'main', tip: page.tip, base: page.base,
      worker: scope ? { id: scope.task_id, worker_number: scope.worker_number, goal: scope.goal } : null,
      delivery: delivery ?? null, commits: page.commits.map(row => {
        const tasks = byCommit.get(row.commit);
        if (!tasks.length && sourceTask) tasks.push(sourceTask);
        return { ...row, association: tasks.length ? 'verified' : 'unassociated', tasks };
      }), cursor: page.cursor, has_more: page.has_more };
    check(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024, 'version graph response exceeds safe size; request a smaller page');
    return result;
  },
};
