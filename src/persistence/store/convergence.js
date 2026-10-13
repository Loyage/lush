import { check, isPlainObject } from '../../core/types.js';
import { CONVERGENCE_LIMITS, CONVERGENCE_STATES } from '../../core/convergence-contract.js';

const NODE_STATES = ['planned','computing','conflict','ready','resolving','awaiting','failed','stale'];
const ENDED = ['integrated','withdrawn','stale'];
const RUN_PATCH = ['state','generation','baseline','candidate_commit','candidate_tree','validation_result',
  'landing_receipt','integration_worker_id','data','error'];
const NODE_PATCH = ['state','data','result','helper_id'];
const JSON_COLUMNS = ['validation','validation_result','landing_receipt','data','result'];
const integer = value => Number.isSafeInteger(value) && value > 0;
function positive(value, name) { check(integer(value), `${name} must be a positive integer`); return value; }
function object(value, keys, name) {
  check(isPlainObject(value) && Object.keys(value).every(key => keys.includes(key)), `invalid ${name} fields`);
}
function branch(value) { check(typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0'), 'invalid delivery branch'); return value; }
function sha(value) { check(value === null || (typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)), 'invalid fixed Git object'); return value; }
function json(value, nullable = true) {
  if (value === null && nullable) return null;
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { check(false, 'invalid delivery JSON'); } }
  check(isPlainObject(parsed), 'delivery JSON must be an object');
  let encoded;
  try { encoded = JSON.stringify(parsed); } catch { check(false, 'invalid delivery JSON'); }
  check(typeof encoded === 'string' && isPlainObject(JSON.parse(encoded)), 'delivery JSON must encode an object');
  check(Buffer.byteLength(encoded) <= 1048576, 'delivery JSON exceeds its limit'); return encoded;
}
function validation(value) {
  if (value === null) return null;
  const parsed = JSON.parse(json(value)); object(parsed, ['command_id','command_version'], 'validation reference');
  check(typeof parsed.command_id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(parsed.command_id)
    && (parsed.command_version === undefined || integer(parsed.command_version)), 'invalid validation reference'); return JSON.stringify(parsed);
}
function patchValues(patch) {
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, JSON_COLUMNS.includes(key) ? json(value, key !== 'data') : value]));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function immutableInputs(a, b, bindPlannedPair = false) {
  for (const key of ['base','left','right','member_ids','inputs','kind']) if (Object.hasOwn(a, key)) {
    if (bindPlannedPair && ['left','right'].includes(key) && a[key] === null && b[key] !== null && b[key] !== undefined) {
      sha(b[key]); continue;
    }
    check(same(a[key], b[key]), 'fixed delivery node inputs cannot change');
  }
  if (a.seed_commit !== null && a.seed_commit !== undefined)
    check(a.seed_commit === b.seed_commit, 'fixed delivery node inputs cannot change');
}
function helper(store, helperId, run) {
  if (helperId === null) return null;
  positive(helperId, 'integration Worker id');
  const task = store.task(helperId);
  check(task.task_kind === 'integration' && task.parent_id === run.parent_id, 'invalid integration Worker binding'); return task;
}
const snapshotNumber = value => typeof value === 'string' && /^W\d+(?:-\d+)*$/.test(value) ? value : null;
const snapshotText = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : null;
const snapshotTitle = task => snapshotText(task.display_title) || snapshotText(task.auto_title)
  || snapshotText(task.goal?.split('\n')[0]) || snapshotText(task.name) || `Worker #${task.id}`;
const idleHelper = task => !task || ['completed','failed','cancelled','awaiting_acceptance'].includes(task.status);
function workerIds(value) {
  check(Array.isArray(value), 'Worker ids are required'); value.forEach(id => positive(id, 'Worker id')); return [...new Set(value)];
}
function referencedRuns(store, taskIds) {
  if (!taskIds.length) return [];
  const marks = taskIds.map(() => '?').join(',');
  return store.all(`SELECT * FROM delivery_runs WHERE parent_id IN (${marks}) OR integration_worker_id IN (${marks})
    OR id IN (SELECT run_id FROM delivery_members WHERE task_id IN (${marks}))
    OR id IN (SELECT run_id FROM delivery_nodes WHERE helper_id IN (${marks}))`, ...taskIds,...taskIds,...taskIds,...taskIds);
}

/** Nullable additive snapshots only: never backfill historical identities or rebuild existing tables. */
export function ensureConvergenceColumns(db) {
  for (const [table, columns] of Object.entries({ delivery_members: ['worker_number','title'],
    delivery_runs: ['integration_worker_number'], delivery_nodes: ['helper_worker_number'] })) {
    const present = new Set(db.query(`PRAGMA table_info(${table})`).all().map(row => row.name));
    for (const column of columns) if (!present.has(column)) db.query(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).run();
  }
}

export const convergence = {
  createDeliveryRun(value) {
    object(value, ['parent_id','target_branch','baseline','validation','members','data'], 'delivery run');
    positive(value.parent_id, 'parent id'); branch(value.target_branch); sha(value.baseline ?? null);
    const valid = validation(value.validation ?? null), data = json(value.data ?? {}, false);
    check(Array.isArray(value.members) && value.members.length >= 1 && value.members.length <= CONVERGENCE_LIMITS.members,
      'delivery run requires 1..8 members');
    return this.transaction(() => {
      const parent = this.task(value.parent_id);
      check(parent.branch === value.target_branch, 'delivery target must belong to its real parent');
      const seenTasks = new Set(), seenDeliveries = new Set();
      const members = value.members.map((member, ordinal) => {
        object(member, ['task_id','delivery_id','enqueue_seq','source_branch','source_commit','base_commit','ordinal','active'], 'delivery member');
        positive(member.task_id, 'member id'); positive(member.delivery_id, 'delivery id'); positive(member.enqueue_seq, 'enqueue sequence');
        branch(member.source_branch); check(member.source_commit !== null && member.source_commit !== undefined, 'source commit is required');
        sha(member.source_commit); sha(member.base_commit ?? null);
        check(!seenTasks.has(member.task_id) && !seenDeliveries.has(member.delivery_id), 'duplicate delivery member');
        check(member.ordinal === undefined || member.ordinal === ordinal, 'invalid member ordinal');
        check(member.active === undefined || member.active === 1, 'new delivery members must be active');
        seenTasks.add(member.task_id); seenDeliveries.add(member.delivery_id);
        const source = this.task(member.task_id);
        check(source.parent_id === parent.id && source.branch === member.source_branch && source.target_branch === parent.branch,
          'delivery member must target its real direct parent');
        check(!this.get('SELECT run_id FROM delivery_members WHERE active=1 AND (task_id=? OR delivery_id=?)', member.task_id, member.delivery_id),
          'delivery member is already claimed');
        return { ...member, worker_number: snapshotNumber(source.worker_number), title: snapshotTitle(source) };
      });
      const result = this.run(`INSERT INTO delivery_runs(parent_id,target_branch,baseline,validation,data) VALUES (?,?,?,?,?)`,
        parent.id, value.target_branch, value.baseline ?? null, valid, data);
      const runId = Number(result.lastInsertRowid);
      for (const [ordinal, member] of members.entries()) this.run(`INSERT INTO delivery_members
        (run_id,task_id,delivery_id,enqueue_seq,source_branch,source_commit,base_commit,ordinal,worker_number,title) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      runId, member.task_id, member.delivery_id, member.enqueue_seq, member.source_branch, member.source_commit, member.base_commit ?? null, ordinal,
      member.worker_number, member.title);
      return this.deliveryRun(runId);
    });
  },

  deliveryRun(runId) { positive(runId, 'delivery run id'); return this.get('SELECT * FROM delivery_runs WHERE id=?', runId) ?? null; },

  updateDeliveryRun(runId, patch, expectedGeneration = null) {
    positive(runId, 'delivery run id'); object(patch, RUN_PATCH, 'delivery run patch');
    check(Object.keys(patch).length > 0, 'empty delivery run patch');
    if (expectedGeneration !== null) positive(expectedGeneration, 'expected generation');
    const values = patchValues(patch);
    return this.transaction(() => {
      const run = this.deliveryRun(runId); check(run, 'delivery run not found');
      check(expectedGeneration === null || run.generation === expectedGeneration, 'delivery run generation changed');
      if ('state' in patch) check(CONVERGENCE_STATES.includes(patch.state), 'invalid delivery run state');
      if ('generation' in patch) positive(patch.generation, 'delivery generation');
      const generation = patch.generation ?? run.generation;
      check(integer(generation) && (generation === run.generation || generation === run.generation + 1), 'invalid delivery generation transition');
      if ('baseline' in patch) { sha(patch.baseline); check(run.baseline === null || patch.baseline === run.baseline || generation > run.generation,
        'fixed delivery baseline requires a new generation'); }
      for (const key of ['candidate_commit','candidate_tree']) if (key in patch) sha(patch[key]);
      if ('integration_worker_id' in patch) values.integration_worker_number = snapshotNumber(helper(this, patch.integration_worker_id, run)?.worker_number);
      if ('error' in patch) check(patch.error === null || (typeof patch.error === 'string' && patch.error.length <= 4000), 'invalid delivery error');
      const result = this.run(`UPDATE delivery_runs SET ${Object.keys(values).map(key => `${key}=?`).join(',')},
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND generation=?`, ...Object.values(values), runId, run.generation);
      check(result.changes === 1, 'delivery run generation changed'); return this.deliveryRun(runId);
    });
  },

  deliveryRuns(parentId, states = null, limit = 50) {
    positive(parentId, 'parent id'); check(integer(limit) && limit <= 1000, 'invalid delivery run limit');
    check(states === null || (Array.isArray(states) && states.length > 0 && states.every(state => CONVERGENCE_STATES.includes(state))), 'invalid delivery run states');
    return this.all(`SELECT * FROM delivery_runs WHERE parent_id=?${states ? ` AND state IN (${states.map(() => '?').join(',')})` : ''}
      ORDER BY id LIMIT ?`, parentId, ...(states ?? []), limit);
  },

  deliveryMembers(runId, activeOnly = false) {
    positive(runId, 'delivery run id'); check(typeof activeOnly === 'boolean', 'activeOnly must be boolean');
    return this.all(`SELECT * FROM delivery_members WHERE run_id=?${activeOnly ? ' AND active=1' : ''} ORDER BY ordinal`, runId);
  },

  releaseDeliveryMembers(runId, taskId = null) {
    positive(runId, 'delivery run id'); if (taskId !== null) positive(taskId, 'member id');
    return this.transaction(() => this.run(`UPDATE delivery_members SET active=0 WHERE run_id=? AND active=1${taskId === null ? '' : ' AND task_id=?'}`,
      runId, ...(taskId === null ? [] : [taskId])).changes);
  },

  createDeliveryNode(value) {
    object(value, ['run_id','generation','node_key','state','data','result','helper_id'], 'delivery node');
    positive(value.run_id, 'delivery run id'); positive(value.generation, 'node generation');
    check(typeof value.node_key === 'string' && value.node_key.length > 0 && value.node_key.length <= 200 && !value.node_key.includes('\0'), 'invalid delivery node key');
    check(NODE_STATES.includes(value.state ?? 'planned'), 'invalid delivery node state');
    const data = json(value.data ?? {}, false), result = value.result === undefined ? null : json(value.result);
    return this.transaction(() => {
      const run = this.deliveryRun(value.run_id); check(run && run.generation === value.generation, 'delivery run generation changed');
      const helperTask = helper(this, value.helper_id ?? null, run);
      const old = this.get('SELECT * FROM delivery_nodes WHERE run_id=? AND generation=? AND node_key=?', run.id, run.generation, value.node_key);
      if (old) {
        // Idempotent admission never rewinds an already-computing/ready node or rebinds a helper.
        const previous = JSON.parse(old.data), incoming = JSON.parse(data);
        immutableInputs(incoming, previous);
        delete previous.seed_commit; delete incoming.seed_commit;
        check(same(previous, incoming), 'delivery node key already has different inputs');
        if (value.helper_id !== undefined && value.helper_id !== null) check(old.helper_id === value.helper_id, 'delivery node helper changed');
        if (result !== null) check(old.result === result, 'delivery node result changed');
        return old;
      }
      const created = this.run(`INSERT INTO delivery_nodes(run_id,generation,node_key,state,data,result,helper_id,helper_worker_number) VALUES (?,?,?,?,?,?,?,?)`,
        run.id, run.generation, value.node_key, value.state ?? 'planned', data, result, value.helper_id ?? null, snapshotNumber(helperTask?.worker_number));
      return this.deliveryNode(Number(created.lastInsertRowid));
    });
  },

  deliveryNode(nodeId) { positive(nodeId, 'delivery node id'); return this.get('SELECT * FROM delivery_nodes WHERE id=?', nodeId) ?? null; },

  /** Recovery reads fixed historical generations too; it never rewinds or reparses stored results. */
  deliveryNodes(runId, generation) {
    positive(runId, 'delivery run id'); positive(generation, 'node generation');
    return this.all('SELECT * FROM delivery_nodes WHERE run_id=? AND generation=? ORDER BY id', runId, generation);
  },

  updateDeliveryNode(nodeId, patch, expectedGeneration = null) {
    positive(nodeId, 'delivery node id'); object(patch, NODE_PATCH, 'delivery node patch');
    check(Object.keys(patch).length > 0, 'empty delivery node patch');
    if (expectedGeneration !== null) positive(expectedGeneration, 'expected generation');
    const values = patchValues(patch);
    return this.transaction(() => {
      const node = this.deliveryNode(nodeId); check(node, 'delivery node not found');
      const run = this.deliveryRun(node.run_id);
      check(expectedGeneration === null || node.generation === expectedGeneration, 'delivery node generation changed');
      // Retire an obsolete node, but never let its late reply advance the current run.
      check(run.generation === node.generation || (Object.keys(patch).length === 1 && patch.state === 'stale'), 'delivery run generation changed');
      if ('state' in patch) check(NODE_STATES.includes(patch.state), 'invalid delivery node state');
      if ('data' in values) {
        const previous = JSON.parse(node.data);
        immutableInputs(previous, JSON.parse(values.data), node.state === 'planned' && node.result === null
          && node.helper_id === null && previous.kind === 'pair' && previous.inputs?.length === 2);
      }
      if ('helper_id' in patch) {
        values.helper_worker_number = snapshotNumber(helper(this, patch.helper_id, run)?.worker_number);
        check(node.helper_id === null || patch.helper_id === node.helper_id, 'delivery node helper changed');
      }
      const result = this.run(`UPDATE delivery_nodes SET ${Object.keys(values).map(key => `${key}=?`).join(',')},
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND generation=?`, ...Object.values(values), nodeId, node.generation);
      check(result.changes === 1, 'delivery node generation changed'); return this.deliveryNode(nodeId);
    });
  },

  /** Source/helper history is not a live FK. Only actual active/unknown uses prevent independent deletion. */
  deliveryHistoryBlockers(taskIds) {
    const selected = workerIds(taskIds), ids = new Set(selected);
    return referencedRuns(this, selected).filter(run => {
      const members = this.deliveryMembers(run.id);
      const nodes = this.all('SELECT helper_id,generation FROM delivery_nodes WHERE run_id=? AND helper_id IS NOT NULL', run.id);
      const unknown = run.state === 'landing' || (run.state === 'blocked' && run.landing_receipt !== null);
      if (unknown || members.some(member => ids.has(member.task_id) && member.active === 1)) return true;
      const currentHelper = ids.has(run.integration_worker_id)
        || nodes.some(node => ids.has(node.helper_id) && node.generation === run.generation);
      if (currentHelper && (!ENDED.includes(run.state) || members.some(member => member.active === 1))) return true;
      if ([run.integration_worker_id, ...nodes.map(node => node.helper_id)].some(helperId => ids.has(helperId)
        && !idleHelper(this.get('SELECT status FROM tasks WHERE id=?', helperId)))) return true;
      if (!ids.has(run.parent_id)) return false;
      // Only deleting the owning parent can remove a batch. Surviving Workers retain their shared evidence.
      return !ENDED.includes(run.state) || members.some(member => member.active === 1
        || (!ids.has(member.task_id) && this.get('SELECT id FROM tasks WHERE id=?', member.task_id)))
        || [run.integration_worker_id, ...nodes.map(node => node.helper_id)].some(helperId => helperId !== null
          && ((!ids.has(helperId) && this.get('SELECT id FROM tasks WHERE id=?', helperId))
            || !idleHelper(this.get('SELECT status FROM tasks WHERE id=?', helperId))));
    }).map(run => `归并记录 ${run.id}：运行或共享交付证据仍被使用`);
  },

  /** Independent source/helper deletion keeps the whole receipt; parent reclamation alone removes technical rows. */
  deleteDeliveryHistory(taskIds) {
    const selected = workerIds(taskIds);
    if (!selected.length) return 0;
    return this.transaction(() => {
      check(this.deliveryHistoryBlockers(selected).length === 0, 'delivery history is still active or shared');
      const runs = this.all(`SELECT id FROM delivery_runs WHERE parent_id IN (${selected.map(() => '?').join(',')})`, ...selected);
      if (runs.length) this.run(`DELETE FROM delivery_runs WHERE id IN (${runs.map(() => '?').join(',')})`, ...runs.map(run => run.id));
      return runs.length;
    });
  },
};
