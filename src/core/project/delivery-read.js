import { check } from '../types.js';
import { convergenceRevision } from '../convergence-contract.js';
import { safeConvergenceError } from './convergence-policy.js';
import { decodeReservation } from './progress.js';

// Explicit projections only: never load profile, environment, Prompt or Shell evidence.
const TASK = `id,worker_number,parent_id,task_kind,status,integration,branch,target_branch,interrupt_state,
  substr(display_title,1,120) AS display_title,substr(auto_title,1,120) AS auto_title,
  substr(goal,1,120) AS goal,length(reservation) AS reservation_length,substr(reservation,1,65536) AS reservation`;
const RUN = `id,parent_id,target_branch,state,generation,baseline,candidate_commit,integration_worker_id,
  integration_worker_number,created_at,updated_at,substr(error,1,200) AS error,
  json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.wait_reason') AS wait_code`;
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = (value, max = 120) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : null;
const number = value => typeof value === 'string' && /^W\d+(?:-\d+)*$/.test(value) && value.length <= 120 ? value : null;
const sha = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? value : null;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const ATTENTION_STAGES = new Set(['invalid','failed','blocked','awaiting','stale']);
const HELPER_STATUSES = ['awaiting','paused','failed','cancelled','running','queued','awaiting_acceptance','completed'];
/** Complete lightweight current-generation facts, independent of helper/member/page limits.
 * A retained old-generation run pointer is not a current helper. An unbound pointer
 * is an identity diagnostic, never permission to borrow that Worker's status. */
function integrationFacts(p, runId = null) {
  const valid = "t.id IS NOT NULL AND t.task_kind='integration' AND t.parent_id=r.parent_id";
  const rows = p.store.all(`SELECT r.id,
    (max(CASE WHEN n.id IS NOT NULL AND (t.id IS NULL OR t.task_kind IS NOT 'integration' OR t.parent_id IS NOT r.parent_id)
      THEN 1 ELSE 0 END)
      OR EXISTS(SELECT 1 FROM delivery_nodes m WHERE m.run_id=r.id AND m.generation=r.generation
        AND m.helper_id IS NULL AND m.state IN ('resolving','awaiting'))
      OR (r.state='resolving' AND count(n.id)=0)
      OR (r.integration_worker_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM delivery_nodes m
        WHERE m.run_id=r.id AND m.helper_id=r.integration_worker_id))) AS missing_helper,
    ${HELPER_STATUSES.map(status => `max(CASE WHEN ${valid} AND t.status='${status}' THEN 1 ELSE 0 END) AS ${status}`).join(',')}
    FROM delivery_runs r LEFT JOIN delivery_nodes n ON n.run_id=r.id AND n.generation=r.generation AND n.helper_id IS NOT NULL
    LEFT JOIN tasks t ON t.id=n.helper_id ${runId === null ? '' : 'WHERE r.id=?'} GROUP BY r.id`, ...(runId === null ? [] : [runId]));
  return new Map(rows.map(row => [row.id, row]));
}
function needsAttention(state, facts = null, historical = false) {
  return !historical && state !== 'integrated' && (ATTENTION_STAGES.has(state)
    || !!(facts?.missing_helper || facts?.awaiting || facts?.paused || facts?.failed || facts?.cancelled));
}
const readTask = (p, id) => positive(id) ? p.store.get(`SELECT ${TASK} FROM tasks WHERE id=?`, id) : null;
const readRun = (p, id) => positive(id) ? p.store.get(`SELECT ${RUN} FROM delivery_runs WHERE id=?`, id) : null;
function bookingOf(task) {
  if ((task?.reservation_length ?? task?.reservation?.length ?? 0) > 65536)
    return { status: 'invalid', read_truncated: true };
  return decodeReservation(task?.reservation);
}
const identity = (task, id = task?.id, savedNumber = null) => ({ id: id ?? null,
  worker_number: number(savedNumber) ?? number(task?.worker_number), status: task?.status ?? null,
  title: text(task?.display_title || task?.auto_title || task?.goal), missing: !task });
function target(p, parentId, branch) {
  const task = readTask(p, parentId);
  return { ...identity(task, parentId), branch: text(branch, 512), identity_mismatch: !!task && task.branch !== branch,
    locator: { worker_id: parentId ?? null } };
}
function integrations(p, run) {
  if (!run) return { items: [], total: 0, truncated: false };
  const rows = p.store.all(`SELECT id,generation,node_key,state,helper_id,helper_worker_number FROM delivery_nodes
    WHERE run_id=? AND generation=? AND helper_id IS NOT NULL ORDER BY id LIMIT 32`, run.id, run.generation);
  const total = p.store.get(`SELECT count(DISTINCT helper_id) AS n FROM delivery_nodes WHERE run_id=? AND generation=? AND helper_id IS NOT NULL`, run.id, run.generation).n;
  const refs = new Map(rows.map(row => [row.helper_id, row]));
  if (run.integration_worker_id && !refs.has(run.integration_worker_id)) {
    if (refs.size >= 32) refs.delete([...refs.keys()].at(-1));
    refs.set(run.integration_worker_id, p.store.get(`SELECT id,generation,node_key,state,helper_id,helper_worker_number FROM delivery_nodes
      WHERE run_id=? AND helper_id=? ORDER BY generation DESC,id DESC LIMIT 1`, run.id, run.integration_worker_id)
      ?? { helper_id: run.integration_worker_id, helper_worker_number: run.integration_worker_number });
  }
  const items = [...refs.values()].map(row => {
    const task = readTask(p, row.helper_id);
    const mismatch = !!task && (task.task_kind !== 'integration' || task.parent_id !== run.parent_id);
    return { ...identity(mismatch ? null : task, row.helper_id, row.helper_worker_number), identity_mismatch: mismatch,
      node_id: row.id ?? null, node_key: text(row.node_key), node_state: row.state ?? null,
      generation: row.generation ?? null, current: row.generation === run.generation,
      locator: { worker_id: row.helper_id, run_id: run.id, generation: row.generation ?? null, node_id: row.id ?? null } };
  });
  const count = total + (run.integration_worker_id && !rows.some(row => row.helper_id === run.integration_worker_id)
    && !p.store.get('SELECT id FROM delivery_nodes WHERE run_id=? AND generation=? AND helper_id=? LIMIT 1', run.id, run.generation, run.integration_worker_id) ? 1 : 0);
  return { items, total: count, truncated: count > items.length };
}
function reason(p, task, booking, run, helpers, facts = null) {
  if (!run && booking?.read_truncated) return { code: 'reservation_truncated', message: '预约超出读面安全长度；原记录未修改，当前内容不可完整核对' };
  if (!run && booking?.status === 'invalid') return { code: 'invalid_reservation', message: '预约损坏或版本未知，请核查' };
  if (booking?.run_id && !run) return { code: 'missing_batch', message: '固定批次记录缺失，请核查' };
  if (run) {
    if (run.state === 'integrated') return { code: null, message: null };
    if (run.wait_code === 'integration_slot') return { code: 'integration_slot', message: '等待整合运行准入' };
    if (run.wait_code === 'withdrawing') return { code: 'withdrawing', message: '等待撤回安全点' };
    if (['failed','blocked','stale','withdrawn'].includes(run.state)) return { code: run.state, message: safeConvergenceError(run.error) ?? '批次未落地，请检查记录' };
    if (facts?.awaiting) return { code: 'integration_decision', message: '等待整合 Worker 的待决答复' };
    if (run.state === 'awaiting') return { code: 'awaiting', message: '批次等待后续事件；未记录具体等待原因' };
    if (facts?.failed || facts?.cancelled) return { code: 'integration_failed', message: '整合 Worker 未成功交付' };
    if (facts?.missing_helper) return { code: 'integration_unavailable', message: '当前整合身份缺失、未关联或与批次类型/父身份不符，请核查' };
    if (facts?.paused) return { code: 'integration_paused', message: '整合 Worker 已暂停，等待显式继续' };
    if (facts?.running) return { code: 'integration_running', message: '整合 Worker 正在执行，来源保持固定' };
    if (facts?.queued) return { code: 'integration_waiting', message: '等待整合 Worker 执行或继续' };
    if (run.state === 'ready') return { code: 'landing_safety', message: '组合已准备，等待目标落地安全点' };
    if (run.state === 'landing') return { code: 'landing', message: '正在核验真实目标落地，不代表已合并' };
    if (facts?.awaiting_acceptance || facts?.completed) return { code: 'integration_ready', message: '整合 Worker 已交付，批次尚未落地' };
    return { code: run.state, message: run.state === 'validating' ? '旧流程正在验证组合' : '等待固定组合准备完成' };
  }
  const status = booking?.status;
  if (task && ['pending','requested'].includes(status)) {
    const dependency = p.store.get(`SELECT d.depends_on,t.worker_number FROM task_deps d LEFT JOIN tasks t ON t.id=d.depends_on
      WHERE d.task_id=? AND d.kind='code' AND (t.id IS NULL OR t.integration<>'merged') ORDER BY d.depends_on LIMIT 1`, task.id);
    if (dependency) return { code: 'code_dependency', message: `等待代码依赖 Worker ${number(dependency.worker_number) ?? `#${dependency.depends_on}`} 落地` };
  }
  if (status === 'pending') {
    if (p.running.has(task.id) || task.status === 'running') return { code: 'source_running', message: '等待来源 Agent 实际退出' };
    if (task.status === 'awaiting' || p.questionPending(task.id)) return { code: 'source_decision', message: '等待来源待决答复' };
    const children = p.store.get("SELECT count(*) AS n FROM tasks WHERE parent_id=? AND status NOT IN ('awaiting_acceptance','completed','failed','cancelled')", task.id).n;
    if (children) return { code: 'children', message: `等待 ${children} 个子 Worker 交付` };
    if (task.status !== 'waiting') return { code: 'source_not_idle', message: '等待来源本轮工作静息' };
    if (p.store.get('SELECT count(*) AS n FROM messages WHERE task_id=? AND consumed=0', task.id).n) return { code: 'source_inputs', message: '等待来源处理输入或信号' };
    return { code: 'intent', message: '合并意图有效，尚未固定本轮成果' };
  }
  const messages = { requested: booking?.version === 3 ? '固定成果等待形成归并批次' : '等待目标串行交付安全点',
    resolving: '固定交付等待源侧分歧修复', executing: '固定交付正在执行，尚未确认落地',
    blocked: '落地或固定交付待核查，禁止盲目重放', suspended: '交付已挂起，等待显式继续',
    failed: '交付失败，请检查记录', withdrawn: '本轮交付已撤回', cancelled: '本轮交付已取消' };
  return { code: messages[status] ? status : null, message: messages[status] ?? null };
}
function queue(p, task, booking, options) {
  if (!task) return { buffered: null, reason: '来源 Worker 记录缺失' };
  // Malformed storage must not throw in inputFreezeReason's JSON parser.
  return p.taskInputQueue({ ...task, reservation: booking?.status === 'invalid' ? null : task.reservation }, options.buffered ?? null, options.freezes ?? null);
}
function summary(p, task, options = {}) {
  const liveBooking = bookingOf(task);
  const booking = options.booking ?? liveBooking;
  const run = options.run ?? (booking?.run_id ? readRun(p, booking.run_id) : null);
  const member = options.member ?? (run && booking?.delivery_id ? p.store.get('SELECT * FROM all_delivery_members WHERE run_id=? AND task_id=? AND delivery_id=?', run.id, task.id, booking.delivery_id) : null);
  const helpers = options.helpers ?? integrations(p, run);
  const facts = run ? options.facts ?? integrationFacts(p, run.id).get(run.id) : null;
  const deliveryId = member?.delivery_id ?? (positive(booking?.delivery_id) ? booking.delivery_id : null);
  const current = !options.historical && !!task && !!booking && booking.status !== 'invalid' && (!member || booking?.run_id === run?.id && booking?.delivery_id === member.delivery_id && booking?.generation === run?.generation && booking.commit === member.source_commit);
  const attemptId = !member && positive(booking?.attempt_id) ? booking.attempt_id : null;
  const stage = run?.state ?? booking?.status ?? null;
  const wait = reason(p, task, booking, run, helpers, facts);
  const parentId = run?.parent_id ?? (positive(booking?.parent_id) ? booking.parent_id : task?.parent_id);
  const branch = run?.target_branch ?? task?.target_branch ?? readTask(p, parentId)?.branch;
  return { key: deliveryId ? `delivery:${task?.id ?? member?.task_id ?? options.sourceId ?? null}:${deliveryId}` : `intent:${task?.id}`,
    kind: 'source', version: member ? 3 : booking?.version ?? null, delivery_id: deliveryId,
    run_id: run?.id ?? (positive(booking?.run_id) ? booking.run_id : null), generation: run?.generation ?? null,
    attempt_id: attemptId,
    stage, attention: needsAttention(stage, facts, options.historical), reservation_status: !member || current ? booking?.status ?? null : null, current,
    reservation_version_unknown: booking?.status === 'invalid', reservation_truncated: booking?.read_truncated === true,
    identity_mismatch: !!run && booking?.run_id === run.id && (!member || booking.generation !== run.generation || booking.parent_id !== run.parent_id || booking.commit !== member.source_commit),
    waiting_reason: wait.message, blocked_code: wait.code,
    target: target(p, parentId, branch), integration_workers: helpers,
    input_queue: queue(p, task, liveBooking, options),
    source_commit: sha(member?.source_commit ?? booking?.commit),
    locator: { worker_id: task?.id ?? member?.task_id ?? options.sourceId ?? null, run_id: run?.id ?? booking?.run_id ?? null,
      generation: run?.generation ?? null, delivery_id: deliveryId, attempt_id: attemptId,
      ...(options.eventId ? { event_id: options.eventId } : {}) } };
}
function source(p, task, options) {
  const member = options?.member;
  return { ...identity(task, task?.id ?? member?.task_id ?? options?.sourceId, member?.worker_number), parent_id: task?.parent_id ?? null,
    delivery_summary: summary(p, task, options) };
}
function batch(p, row, facts) {
  const run = readRun(p, row.id), helpers = integrations(p, run);
  const members = p.store.all('SELECT * FROM all_delivery_members WHERE run_id=? ORDER BY ordinal LIMIT 8', run.id);
  const memberCount = p.store.get('SELECT count(*) AS n FROM all_delivery_members WHERE run_id=?', run.id).n;
  const nodeCount = p.store.get('SELECT count(*) AS n FROM delivery_nodes WHERE run_id=? AND generation=?', run.id, run.generation).n;
  const nodes = p.store.all('SELECT id,node_key,state,helper_id FROM delivery_nodes WHERE run_id=? AND generation=? ORDER BY id LIMIT 32', run.id, run.generation)
    .map(node => ({ ...node, node_key: text(node.node_key), key: `node:${node.id}`, locator: { run_id: run.id, generation: run.generation, node_id: node.id } }));
  const wait = reason(p, null, null, run, helpers, facts);
  return { key: row.key, kind: 'batch', run_id: run.id, generation: run.generation, stage: run.state,
    target: target(p, run.parent_id, run.target_branch), waiting_reason: wait.message, blocked_code: wait.code,
    baseline: sha(run.baseline), commit: sha(run.candidate_commit), error: safeConvergenceError(run.error),
    created_at: text(run.created_at, 40), updated_at: text(run.updated_at, 40), integration_workers: helpers,
    member_count: memberCount, members_truncated: memberCount > members.length,
    sources: members.map(member => source(p, readTask(p, member.task_id), { run, member, helpers, facts })),
    nodes, node_count: nodeCount, nodes_truncated: nodeCount > nodes.length,
    previous_generation_node_count: p.store.get('SELECT count(*) AS n FROM delivery_nodes WHERE run_id=? AND generation<>?', run.id, run.generation).n,
    locator: { worker_id: run.parent_id, run_id: run.id, generation: run.generation } };
}

export default {
  taskDeliverySummary(task, options = {}) { return task.reservation ? this.store.transaction(() => summary(this, task, options)) : null; },

  workerDeliveryGraph({ history = false, cursor, limit = 20 } = {}) {
    check(typeof history === 'boolean', 'history must be boolean');
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'delivery graph limit must be 1..50');
    check(cursor === undefined || typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 1024, 'invalid delivery graph cursor');
    return this.store.transaction(() => {
      // Complete lightweight metadata and counters; bodies only for selected page.
      const runs = this.store.all('SELECT id,parent_id,target_branch,state,generation FROM delivery_runs ORDER BY id DESC');
      const facts = integrationFacts(this);
      const all = runs.map(row => ({ ...row, key: `batch:${row.id}`, kind: 'batch', history: row.state === 'integrated',
        attention: needsAttention(row.state, facts.get(row.id)) }));
      const byRun = new Map(runs.map(run => [run.id, run]));
      for (const task of this.store.all(`SELECT ${TASK} FROM tasks WHERE reservation IS NOT NULL ORDER BY id DESC`)) {
        const booking = bookingOf(task);
        if (booking?.kind !== 'merge' && booking?.status !== 'invalid') continue;
        const run = byRun.get(booking?.run_id);
        if (run && this.store.get('SELECT 1 AS found FROM all_delivery_members WHERE run_id=? AND task_id=? AND delivery_id=?', run.id, task.id, booking.delivery_id)) continue;
        if (booking?.status === 'integrated' && booking.version === 2 && this.store.get(`SELECT id FROM events WHERE task_id=? AND type='task.merge_integrated'
          AND json_valid(data) AND json_extract(data,'$.delivery_id')=? AND json_extract(data,'$.convergence') IS NOT 1 LIMIT 1`, task.id, booking.delivery_id)) continue;
        all.push({ id: task.id, key: positive(booking?.delivery_id) ? `serial:${task.id}:${booking.delivery_id}` : `intent:${task.id}`,
          kind: positive(booking?.delivery_id) ? 'serial' : 'intent', state: booking?.status ?? 'invalid',
          parent_id: positive(booking?.parent_id) ? booking.parent_id : task.parent_id,
          target_branch: task.target_branch, generation: booking?.generation ?? null, history: booking?.status === 'integrated',
          attention: needsAttention(booking?.status ?? 'invalid') });
      }
      // v2 receipts preserve earlier rounds after their current reservation is consumed.
      for (const event of this.store.all(`SELECT id,task_id,json_extract(data,'$.parent_id') AS parent_id,
        json_extract(data,'$.delivery_id') AS delivery_id FROM events WHERE type='task.merge_integrated' AND json_valid(data)
        AND json_extract(data,'$.convergence') IS NOT 1 AND json_type(data,'$.delivery_id')='integer'
        AND json_extract(data,'$.delivery_id')>0 ORDER BY id DESC`)) {
        all.push({ ...event, key: `serial:${event.task_id}:${event.delivery_id}`, kind: 'receipt', state: 'integrated', history: true, attention: false });
      }
      const counts = { active: 0, history: 0, batches: 0, intents: 0, serial: 0, by_stage: {}, sources_by_stage: {},
        attention: new Set(all.filter(row => row.attention).map(row => row.key)).size,
        targets: new Set(all.map(row => row.parent_id ?? null)).size };
      for (const row of this.store.all(`SELECT r.state,count(*) AS n FROM all_delivery_members m JOIN delivery_runs r ON r.id=m.run_id GROUP BY r.state`))
        counts.sources_by_stage[row.state] = row.n;
      for (const row of all.filter(row => row.kind !== 'batch')) counts.sources_by_stage[row.state] = (counts.sources_by_stage[row.state] ?? 0) + 1;
      for (const row of all) { counts[row.history ? 'history' : 'active']++; counts[row.kind === 'batch' ? 'batches' : row.kind === 'intent' ? 'intents' : 'serial']++;
        counts.by_stage[row.state] = (counts.by_stage[row.state] ?? 0) + 1; }
      const filtered = all.filter(row => row.history === history).sort((a, b) =>
        history ? b.id - a.id || a.key.localeCompare(b.key) : Number(b.attention) - Number(a.attention) || a.key.localeCompare(b.key));
      const projectIdentity = convergenceRevision([this.config.project, history]);
      const structure = convergenceRevision([all, this.store.all('SELECT run_id,task_id,delivery_id,ordinal,active,source_commit FROM all_delivery_members ORDER BY run_id,ordinal')]);
      let offset = 0;
      if (cursor !== undefined) {
        let value;
        try { check(/^[A-Za-z0-9_-]+$/.test(cursor), 'invalid delivery graph cursor'); value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
        catch { check(false, 'invalid delivery graph cursor'); }
        check(value?.version === 1 && value.project === projectIdentity && Number.isSafeInteger(value.offset) && value.offset > 0, 'delivery graph cursor project/filter/range mismatch');
        check(value.structure === structure, 'Worker delivery graph cursor stale; refresh from first page');
        check(value.offset < filtered.length, 'invalid delivery graph cursor range'); offset = value.offset;
      }
      const result = { version: 1, history, items: [], counts, matched_total: filtered.length, cursor: null, has_more: false, truncated: false };
      const finalize = () => {
        const next = offset + result.items.length;
        result.has_more = next < filtered.length;
        result.cursor = result.has_more ? Buffer.from(JSON.stringify({ version: 1, project: projectIdentity, structure, offset: next })).toString('base64url') : null;
        result.truncated = result.has_more || result.items.some(item => item.item_truncated || item.members_truncated || item.nodes_truncated || item.integration_workers?.truncated
          || item.sources?.some(source => source.delivery_summary?.reservation_truncated));
      };
      for (const row of filtered.slice(offset, offset + limit)) {
        let item;
        if (row.kind === 'batch') item = batch(this, row, facts.get(row.id));
        else if (row.kind === 'receipt') {
          const event = this.store.get(`SELECT created_at,json_extract(data,'$.commit') AS landed_commit,
            json_extract(data,'$.source_commit') AS source_commit,json_extract(data,'$.attempt_id') AS attempt_id FROM events WHERE id=?`, row.id);
          const task = readTask(this, row.task_id);
          const projection = source(this, task, { sourceId: row.task_id,
            booking: { version: 2, kind: 'merge', status: 'integrated', parent_id: row.parent_id,
              delivery_id: row.delivery_id, attempt_id: event.attempt_id, commit: event.source_commit }, historical: true, eventId: row.id });
          item = { key: row.key, kind: 'serial', stage: 'integrated', target: projection.delivery_summary.target,
            commit: sha(event.landed_commit), created_at: text(event.created_at, 40), sources: [projection],
            locator: { worker_id: row.task_id, delivery_id: row.delivery_id, event_id: row.id } };
        } else {
          const task = readTask(this, row.id), projection = source(this, task);
          item = { key: row.key, kind: row.kind, stage: row.state, target: projection.delivery_summary.target,
            sources: [projection], waiting_reason: projection.delivery_summary.waiting_reason, blocked_code: projection.delivery_summary.blocked_code,
            locator: projection.delivery_summary.locator };
        }
        item.attention = row.attention;
        if (bytes(item) > 800000) item = { key: item.key, kind: item.kind, stage: item.stage, target: item.target, locator: item.locator,
          attention: row.attention, item_truncated: true, unavailable_reason: 'item exceeds delivery graph byte budget' };
        result.items.push(item); finalize();
        if (bytes(result) >= 900000) { result.items.pop(); finalize(); break; }
      }
      finalize(); check(bytes(result) < 900000, 'delivery graph metadata exceeds byte budget');
      return result;
    });
  },
};
