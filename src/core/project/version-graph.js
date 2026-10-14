import { check, id as workerId } from '../types.js';
import { workerSnapshot, currentWorkerRange, workerGraphPage, workerGraphCommit } from '../workspaces/worker-version-graph.js';
import { graphOID } from '../workspaces/version-graph.js';
import { convergenceMemberReceipt } from '../workspaces/delivery-publish.js';

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
export function eventData(row) {
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
export function fixedRange(project, row, creationBase) {
  const receipt = eventData(row);
  if (row.type !== 'task.merge_integrated' || row.parent_type !== 'integer' || row.parent_id <= 0
    || !graphOID(receipt.source_commit) || !graphOID(receipt.commit) || receipt.squash !== true)
    return { reason: '缺少成功交付的固定源提交与 Squash 父侧证据' };
  if (typeof row.branch !== 'string' || row.branch.length === 0 || row.branch.length > 4096)
    return { reason: '缺少 Worker 的记录分支身份' };
  const prior = creationBase === undefined ? project.store.get(`SELECT substr(data,1,8193) AS event_data, type FROM events
    WHERE task_id=? AND type IN ${successTypes} AND id<? ORDER BY id DESC LIMIT 1`, row.task_id, row.event_id) : null;
  const priorReceipt = prior ? eventData(prior) : null;
  if (prior && (prior.type !== 'task.merge_integrated' || priorReceipt.squash !== true || !graphOID(priorReceipt.commit)))
    return { reason: '此前成功交付缺少可信的固定源提交证据' };
  const base = creationBase ?? (prior ? priorReceipt.source_commit : row.base_commit);
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
  let convergence = null;
  if (receipt.convergence === true) {
    try {
      // Identity only: never substitute the current HEAD or iteration baseline for fixed evidence.
      convergence = convergenceMemberReceipt(project.workspaces, graphWorker(project, row.task_id), receipt);
      parent_base = convergence.baseline;
    } catch { return { reason: '归并交付缺少可信的精确批次与成员收据' }; }
  }
  if (parent_base === null && receipt.commit === receipt.source_commit)
    return { reason: '无新落点的交付缺少固定父基线审计' };
  return { tip: receipt.source_commit, base, landed: receipt.commit, parent_base, convergence, reason: null };
}
function taskProjection(row, range) {
  textBounds(row);
  return { id: row.task_id, worker_number: row.worker_number, goal: row.goal, task_kind: row.task_kind ?? 'legacy',
    input: row.input_id === null ? null : { id: row.input_id, content: row.input_content }, evidence: row.type,
    delivery_id: row.event_id, delivery_available: range.reason === null, delivery_unavailable_reason: range.reason };
}

const compactProjection = (projection + ', e.created_at AS delivered_at').replace(/, substr\(t.goal,1,16385\) AS goal/, '')
  .replace(/, substr\(i.content,1,131073\) AS input_content/, '');
const compactTask = (row, range) => ({ id: row.task_id, worker_number: row.worker_number, task_kind: row.task_kind ?? 'legacy',
  evidence: row.type, delivery_id: row.event_id, delivery_available: range.reason === null,
  delivery_unavailable_reason: range.reason });
export function graphWorker(project, taskId, text = false) {
  const task = project.store.get(`SELECT id,worker_number,task_kind,parent_id,branch,base_commit,target_branch,input_id
    ${text ? ',substr(goal,1,16385) AS goal' : ''} FROM tasks WHERE id=?`, taskId);
  check(task, `Worker #${taskId} not found`);
  return task;
}
export function bounded(result) {
  check(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024, 'version graph response exceeds safe size; request a smaller page');
  return result;
}
export function successful(project, taskId, before = Number.MAX_SAFE_INTEGER, limit = 1, includeResults = false) {
  const types = includeResults ? `(e.type IN ${successTypes} OR (e.type='task.delivered' AND json_type(${data},'$.no_changes')='true'))`
    : `e.type IN ${successTypes}`;
  return project.store.all(`SELECT ${compactProjection} ${joins} WHERE e.task_id=? AND ${types}
    AND e.id<? ORDER BY e.id DESC LIMIT ?`, taskId, before, limit);
}
function selected(project, taskId, delivery) {
  const row = project.store.get(`SELECT ${compactProjection} ${joins} WHERE e.task_id=? AND e.id=? AND e.type IN ${successTypes}`, taskId, delivery);
  check(row, 'delivery is not traceable: successful delivery Event does not belong to this Worker');
  const range = fixedRange(project, row);
  check(range.reason === null, `delivery is not traceable: ${range.reason}`);
  return { row, range };
}
export function associations(project, value, commits, detail = false) {
  const byCommit = new Map(commits.map(row => [row.commit, []]));
  if (byCommit.size) {
    const rows = project.store.all(`SELECT ${detail ? projection : compactProjection} ${joins}
      WHERE e.type IN ${successTypes} AND e.id<=? AND json_extract(${data},'$.commit') IN (${[...byCommit.keys()].map(() => '?').join(',')})
      ORDER BY e.id DESC LIMIT 1001`, value.event_max, ...byCommit.keys());
    check(rows.length <= 1000, 'version graph associations exceed safe limit; request a smaller page');
    const scope = value.scope === 'main' ? null : { task_id: value.id, branch: value.branch };
    for (const row of rows) {
      if (!targetMatches(row, scope) || scope && (row.task_id === value.id || value.delivery !== null && row.event_id >= value.delivery)) continue;
      byCommit.get(eventData(row).commit).push((detail ? taskProjection : compactTask)(row, fixedRange(project, row)));
    }
  }
  let source = null;
  if (value.scope !== 'main') {
    const task = graphWorker(project, value.id, detail);
    source = { id: task.id, worker_number: task.worker_number, task_kind: task.task_kind ?? 'legacy',
      evidence: value.scope === 'delivery' ? 'delivery.source' : 'worker.source', delivery_id: null,
      delivery_available: false, delivery_unavailable_reason: '普通源开发提交没有独立交付' };
    if (detail) {
      check(task.goal.length <= 16384, 'version graph Worker text exceeds safe size');
      source.goal = task.goal;
      const input = task.input_id ? project.store.get('SELECT id,substr(content,1,131073) AS content FROM inputs WHERE id=?', task.input_id) : null;
      check((input?.content.length ?? 0) <= 131072, 'version graph order text exceeds safe size');
      source.input = input;
    }
  }
  return commits.map(row => {
    const tasks = byCommit.get(row.commit);
    if (!tasks.length && source) tasks.push(source);
    return { ...row, association: tasks.length ? 'verified' : 'unassociated', tasks };
  });
}

export default {
  workerVersionDeliveries({ id, before, limit = 30 } = {}) {
    const task = graphWorker(this, workerId(id));
    check(before === undefined || Number.isSafeInteger(before) && before > 0, 'version deliveries before must be a positive Event ID');
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'version deliveries limit must be 1..100');
    const rows = successful(this, task.id, before, limit + 1), has_more = rows.length > limit;
    const deliveries = rows.slice(0, limit).map(row => {
      const range = fixedRange(this, row), receipt = eventData(row);
      return { ...compactTask(row, range), delivered_at: row.delivered_at, source_commit: graphOID(receipt.source_commit) ? receipt.source_commit : null,
        commit: graphOID(receipt.commit) ? receipt.commit : null };
    });
    return bounded({ id: task.id, deliveries, before: has_more ? deliveries.at(-1).delivery_id : null, has_more });
  },
  async workerVersionGraph({ id, delivery, cursor, limit = 30 } = {}) {
    const task = graphWorker(this, workerId(id));
    check(delivery === undefined || Number.isSafeInteger(delivery) && delivery > 0, 'version graph delivery must be a positive Event ID');
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'version graph limit must be 1..100');
    const deadline = Date.now() + 15000;
    let value, offset = 0;
    if (cursor !== undefined) {
      value = workerSnapshot(this.workspaces, cursor, task.id, delivery ?? null, 'cursor');
      // An archived current graph deliberately retains delivery:null in its request identity.
      offset = value.offset;
      delete value.offset; delete value.kind;
    } else {
      check(typeof task.branch === 'string' && task.branch.length > 0 && task.branch.length <= 4096
        && ['order', 'child', 'main', 'owner'].includes(task.task_kind), 'Worker has no readable development branch');
      const event_max = this.store.get('SELECT COALESCE(MAX(id),0) AS id FROM events').id;
      value = { id: task.id, branch: task.branch, delivery: delivery ?? null, selected_delivery: delivery ?? null, event_max };
      if (delivery !== undefined) {
        const { range } = selected(this, task.id, delivery);
        const page = await this.workspaces.versionGraphPage({ ...range, delivery, limit: 1, event_max, deadline });
        Object.assign(value, { scope: 'delivery', tip: page.tip, base: page.base, exclude: page.exclude });
      } else if (task.task_kind === 'main' && task.branch === 'main') {
        const page = await this.workspaces.versionGraphPage({ limit: 1, event_max, deadline });
        Object.assign(value, { scope: 'main', tip: page.tip, base: null, exclude: [] });
      } else {
        const record = this.store.branch(task.branch), prior = successful(this, task.id)[0];
        let current = null;
        if (record?.status === 'active') {
          const parent = task.parent_id ? graphWorker(this, task.parent_id) : null;
          check(record.task_id === task.id && record.parent_relation === 'recorded' && record.parent === task.target_branch
            && parent?.branch === record.parent && record.created_from_commit === task.base_commit,
          'current Worker graph is not traceable: branch ownership or creation baseline changed');
          const priorRange = prior ? selected(this, task.id, prior.event_id).range : null;
          const base = priorRange?.tip ?? task.base_commit;
          const parent_evidence = [task.base_commit, ...(priorRange ? [priorRange.landed] : [])];
          for (const type of ['task.parent_synced', 'task.sync_resolution_requested', 'merge.baseline_fixed']) {
            const audit = this.store.get('SELECT substr(data,1,8193) AS event_data FROM events WHERE task_id=? AND type=? AND id<=? ORDER BY id DESC LIMIT 1', task.id, type, event_max);
            if (audit) {
              const receipt = eventData(audit);
              check(type === 'merge.baseline_fixed' || receipt.parent_id === task.parent_id, 'current Worker graph parent audit identity changed');
              parent_evidence.push(type === 'merge.baseline_fixed' ? receipt.baseline : receipt.parent_commit);
            }
          }
          current = await currentWorkerRange(this.workspaces, { branch: task.branch, parent: record.parent, base, parent_evidence }, deadline);
        }
        if (current) Object.assign(value, { scope: 'current', ...current });
        else {
          check(prior, 'current Worker branch is unavailable and no successful fixed delivery exists');
          const { range } = selected(this, task.id, prior.event_id);
          const page = await this.workspaces.versionGraphPage({ ...range, delivery: prior.event_id, limit: 1, event_max, deadline });
          Object.assign(value, { scope: 'delivery', selected_delivery: prior.event_id, tip: page.tip, base: page.base, exclude: page.exclude });
        }
      }
    }
    const page = await workerGraphPage(this.workspaces, value, offset, limit, deadline);
    return bounded({ scope: value.scope, branch: value.branch, worker: { id: task.id, worker_number: task.worker_number },
      delivery: value.selected_delivery, tip: value.tip, base: value.base, snapshot: page.snapshot,
      commits: associations(this, { ...value, delivery: value.selected_delivery }, page.commits), cursor: page.cursor, has_more: page.has_more });
  },
  async workerVersionCommit({ id, snapshot, commit } = {}) {
    const task = graphWorker(this, workerId(id)), value = workerSnapshot(this.workspaces, snapshot, task.id);
    const row = await workerGraphCommit(this.workspaces, value, commit);
    return bounded({ worker: { id: task.id, worker_number: task.worker_number }, scope: value.scope,
      delivery: value.selected_delivery, tip: value.tip, base: value.base, commit: associations(this,
        { ...value, delivery: value.selected_delivery }, [row], true)[0] });
  },
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
