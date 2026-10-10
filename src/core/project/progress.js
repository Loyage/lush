import { check, isPlainObject, TERMINAL } from '../types.js';

const KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_STEPS = 32;
const MAX_LABEL = 160;

const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const elapsed = (startedAt, completedAt) => {
  const start = Date.parse(startedAt), end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
};

/**
 * 等待行是运行时生成的读模型条目，不是 Agent 汇报的里程碑：key 用下划线开头，和 Agent 的稳定 key 空间天然隔离。
 * 它把任务所有非 running（等子 Task / 等用户 / 排队）的时间单独累计，让 Agent 步骤只保留真正执行的时间。
 */
const WAIT_KEY = '__wait__';
const WAIT_LABEL = { waiting: '静息 · 等待后续事件', awaiting: '等待你答复', awaiting_acceptance: '等待你验收', queued: '排队等待调用槽' };
const millis = value => { const at = Date.parse(value); return Number.isFinite(at) ? at : null; };

/** Agent 实际被调用的区间（run 起止；未结束的 run 以 now 收口），合并重叠避免重复累计。 */
function runIntervals(runs, now) {
  const spans = [];
  for (const run of runs) {
    const start = millis(run.started_at);
    if (start === null) continue;
    const end = millis(run.ended_at) ?? now;
    if (end > start) spans.push([start, end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** [start,end] 与调用区间的重叠毫秒数；这就是步骤的「工作用时」。 */
function overlapMs(start, end, spans) {
  let total = 0;
  for (const [spanStart, spanEnd] of spans) {
    const lo = Math.max(start, spanStart), hi = Math.min(end, spanEnd);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

/** 调用区间之间的空隙（非 running），按时间顺序给出每段等待的起止。 */
function waitGaps(spans, start, end) {
  const gaps = [];
  let cursor = start;
  for (const [spanStart, spanEnd] of spans) {
    if (spanStart > cursor) gaps.push([cursor, Math.min(spanStart, end)]);
    cursor = Math.max(cursor, spanEnd);
  }
  if (cursor < end) gaps.push([cursor, end]);
  return gaps.filter(([from, to]) => to > from);
}

/**
 * 用 agent_runs 把存储的计划投影成「工作用时 + 等待行」的读模型：步骤 duration_ms 只含真正被调用的时间，
 * 非 running 的等待单独成一条 kind='wait' 条目插在已完成步骤与当前步骤之间。历史与进行中的任务用同一套重算，
 * 所以旧计划也会按同样口径显示，不再把等待算成 Agent 的工作时间。
 */
export function projectProgress(progress, runs, status, now = Date.now(), taskKind = null) {
  if (!progress || !Array.isArray(runs) || !runs.length) return progress;
  const spans = runIntervals(runs, now);
  const openRun = runs.find(run => !run.ended_at) ?? null;
  const openStart = openRun ? millis(openRun.started_at) : null;
  const terminal = TERMINAL.has(status);
  const stepStartTimes = progress.items.map(item => millis(item.started_at)).filter(value => value !== null);
  const planStart = stepStartTimes.length ? Math.min(...stepStartTimes) : now;
  const stepEndTimes = progress.items.map(item => item.status === 'completed' ? millis(item.completed_at) : null).filter(value => value !== null);
  const runEndTimes = runs.map(run => millis(run.ended_at)).filter(value => value !== null);
  // 终态任务的结束时间取最后一次调用 / 完成步骤，不能用 now：否则结算之后的空闲会被当成等待，且越看越大。
  const planEnd = terminal
    ? Math.max(planStart, ...stepEndTimes, ...runEndTimes)
    : now;

  const steps = progress.items.map(item => {
    // 缺失切换边界时，不能把未知投影成 0，也不能继续把后续调用计入漏报步骤。
    if (item.timing_unknown) return { ...item, kind: 'step', work_ms: null, active_since: null, wait_ms: 0, duration_ms: null };
    const stepStart = millis(item.started_at);
    if (stepStart === null) return { ...item, kind: 'step', work_ms: 0, active_since: null, wait_ms: 0 };
    const stepEnd = item.status === 'completed' ? (millis(item.completed_at) ?? stepStart) : planEnd;
    // 正在进行且此刻真有 run 在跑：把这条未结束的 run 交给前端自己推进，避免读模型每一帧都变。
    if (!terminal && openStart !== null && item.status !== 'completed' && stepEnd === now) {
      const activeSince = Math.max(stepStart, openStart);
      const work = overlapMs(stepStart, activeSince, spans);
      return { ...item, kind: 'step', work_ms: work, active_since: new Date(activeSince).toISOString(),
        wait_ms: Math.max(0, activeSince - stepStart - work), duration_ms: null };
    }
    const work = overlapMs(stepStart, stepEnd, spans);
    return { ...item, kind: 'step', work_ms: work, active_since: null, wait_ms: Math.max(0, (stepEnd - stepStart) - work),
      duration_ms: item.status === 'completed' ? work : null };
  });

  const gaps = waitGaps(spans, planStart, planEnd);
  const totalWait = gaps.reduce((sum, [from, to]) => sum + (to - from), 0);
  if (totalWait <= 0) return { ...progress, items: steps, updated_at: progress.updated_at };
  // 当前仍在等：最后一段空隙还开着，等待行本身是要持续计时的当前步骤。
  const last = gaps[gaps.length - 1];
  const waiting = !terminal && last[1] >= planEnd;
  const waitItem = {
    key: WAIT_KEY, kind: 'wait',
    label: waiting ? (status === 'awaiting_acceptance' && taskKind === 'child'
      ? '等待父Worker确认' : WAIT_LABEL[status] ?? '等待信号') : '等待信号',
    reason: waiting ? status : null,
    status: waiting ? 'pending' : 'completed',
    started_at: new Date(gaps[0][0]).toISOString(),
    completed_at: waiting ? null : new Date(planEnd).toISOString(),
    duration_ms: waiting ? null : totalWait,
    wait_ms: waiting ? totalWait - (planEnd - last[0]) : totalWait,
    waiting_since: waiting ? new Date(last[0]).toISOString() : null,
  };
  const currentIndex = steps.findIndex(item => item.status !== 'completed' && !item.unconfirmed && item.started_at);
  const pendingIndex = currentIndex === -1 ? steps.findIndex(item => item.status !== 'completed' && !item.unconfirmed) : currentIndex;
  const at = pendingIndex === -1 ? steps.length : pendingIndex;
  return { ...progress, items: [...steps.slice(0, at), waitItem, ...steps.slice(at)], updated_at: progress.updated_at };
}

/** A receipt is delivery, not consumption. Ordinary user input is identified by its message Event,
 * never by JSON-looking body text (notice answers also have sender_id=NULL).
 * The message high-water mark deduplicates redelivery after failures/restarts. */
export function receivedProgressInput(store, taskId, { through = null, messages = [] } = {}) {
  const delivered = store.get(`WITH ordinary AS MATERIALIZED (
      SELECT json_extract(data,'$.message_id') AS id FROM events
      WHERE task_id=? AND type='message' AND json_extract(data,'$.sender') IS NULL
    ), receipts AS MATERIALIZED (
      SELECT DISTINCT j.value AS id FROM events e, json_each(e.data,'$.message_ids') j
      WHERE e.task_id=? AND e.type='invocation.inputs_delivered' ${through === null ? '' : 'AND e.id<=?'}
    ) SELECT max(m.id) AS boundary FROM receipts r JOIN ordinary u ON u.id=r.id
      JOIN messages m ON m.id=r.id WHERE m.task_id=? AND m.sender_id IS NULL AND m.signal_type IS NULL`,
    taskId, taskId, ...(through === null ? [] : [through]), taskId)?.boundary ?? 0;
  const ids = messages.filter(message => message.sender_id === null && !message.signal_type).map(message => message.id);
  const direct = ids.length ? store.get(`SELECT max(json_extract(data,'$.message_id')) AS boundary FROM events
    WHERE task_id=? AND type='message' AND json_extract(data,'$.sender') IS NULL
      AND json_extract(data,'$.message_id') IN (${ids.map(() => '?').join(',')})`, taskId, ...ids)?.boundary ?? 0 : 0;
  return Math.max(delivered, direct);
}

function inputMarker(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Number.isSafeInteger(value?.input_message_id) && value.input_message_id >= 0 ? value.input_message_id : null;
  } catch { return null; }
}

/** Freeze both the runtime projection and the no-Run legacy fallback at this one instant. */
function freezeProgress(progress, runs, task, now) {
  // Close open Runs at the archive instant so projectProgress includes all work instead of a live base.
  const closed = runs.map(run => ({ ...run, ended_at: run.ended_at ?? new Date(now).toISOString() }));
  const projected = projectProgress(progress, closed, task.status, now, task.task_kind);
  return { ...projected, frozen: true, frozen_at: new Date(now).toISOString(), items: projected.items.map(item => {
    if (item.kind === 'wait') return { ...item, wait_ms: (item.wait_ms ?? 0)
      + (item.waiting_since ? elapsed(item.waiting_since, new Date(now).toISOString()) ?? 0 : 0),
      duration_ms: item.duration_ms ?? (item.wait_ms ?? 0)
        + (item.waiting_since ? elapsed(item.waiting_since, new Date(now).toISOString()) ?? 0 : 0), waiting_since: null };
    const work = item.timing_unknown ? null : item.work_ms ?? (item.started_at
      ? elapsed(item.started_at, item.completed_at ?? new Date(now).toISOString()) : 0);
    return { ...item, kind: 'step', work_ms: work, wait_ms: item.wait_ms ?? 0,
      duration_ms: work, active_since: null };
  }) };
}

function decode(raw) {
  if (!raw) return null;
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.items)) return null;
    const items = value.items.filter(item => isPlainObject(item) && typeof item.key === 'string' && typeof item.label === 'string')
      .map(item => {
        const status = item.status === 'completed' ? 'completed' : 'pending';
        const started_at = timestamp(item.started_at);
        const completed_at = status === 'completed' ? timestamp(item.completed_at) : null;
        const storedDuration = typeof item.duration_ms === 'number' ? item.duration_ms : NaN;
        const timing_unknown = item.timing_unknown === true;
        const duration_ms = status === 'completed' && !timing_unknown
          ? (Number.isFinite(storedDuration) && storedDuration >= 0 ? storedDuration : elapsed(started_at, completed_at)) : null;
        return { key: item.key, label: item.label, status, started_at, completed_at, duration_ms,
          ...(timing_unknown ? { timing_unknown: true } : {}),
          ...(status === 'pending' && item.unconfirmed === true ? { unconfirmed: true } : {}) };
      });
    if (!items.length) return null;
    return { version: 1, items, updated_at: timestamp(value.updated_at) };
  } catch { return null; }
}

/** 预约里带交付语义的状态；version 2 的合并请求另有一个 resolving（已退回源侧解分歧）。 */
const RESERVATION_STATUSES = new Set(['pending','preparing','requested','started','integrated','completed','failed','cancelled']);
const MERGE_RESERVATION_STATUSES = new Set([...RESERVATION_STATUSES, 'executing', 'resolving', 'suspended', 'blocked', 'withdrawn']);

/** 存储形态解码：version 1 是旧形态（merge / showcase），version 2 是新式 order/child 的合并预约。
 *  两者都要原样交给 UI（`render-delivery.js` 按 `version === 2` 分支已被设计好），
 *  认不出的形态才降级成 `{status:'invalid'}`，让它以「预约状态需检查」的形式可见而不是消失。 */
function decodeReservation(raw) {
  if (!raw) return null;
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isPlainObject(value) || !['merge','showcase'].includes(value.kind)) return { status: 'invalid' };
    const statuses = value.version === 2 ? MERGE_RESERVATION_STATUSES : value.version === 1 ? RESERVATION_STATUSES : null;
    if (!statuses || !statuses.has(value.status)) return { status: 'invalid' };
    return value;
  } catch { return { status: 'invalid' }; }
}

function normalizeSteps(steps) {
  check(Array.isArray(steps) && steps.length > 0, 'progress plan needs at least one step');
  check(steps.length <= MAX_STEPS, `progress plan accepts at most ${MAX_STEPS} steps`);
  const seen = new Set();
  return steps.map((step, index) => {
    check(isPlainObject(step), `progress step ${index + 1} must be an object`);
    const key = typeof step.key === 'string' ? step.key.trim() : '';
    const label = typeof step.label === 'string' ? step.label.trim() : '';
    check(KEY.test(key), `progress step key '${key}' must match ${KEY}`);
    check(label.length > 0 && label.length <= MAX_LABEL, `progress step '${key}' label must be 1-${MAX_LABEL} characters`);
    check(!seen.has(key), `duplicate progress step '${key}'`);
    seen.add(key);
    return { key, label };
  });
}

/** task 执行计划：附属 JSON 的读模型与 agent 汇报入口。 */
export default {
  /** Hide serialized storage columns and expose structured task read models. */
  progressView(task, runs) {
    const { progress_plan, reservation, hooks: _privateHooks, ...row } = task;
    const progress = this.config.progressReporting === false ? null : decode(progress_plan);
    return { ...row,
      progress: Array.isArray(runs) ? projectProgress(progress, runs, task.status, Date.now(), task.task_kind) : progress,
      reservation: decodeReservation(reservation) };
  },

  /** Only details read archives; lists/graphs/provider startup keep progressView history-free. */
  progressHistory(taskId, { before = null, limit = 10 } = {}, byteBudget = 900000) {
    const task = this.store.task(taskId);
    const cursor = before === null || before === undefined ? null : Number(before);
    const size = Number(limit);
    check(cursor === null || (Number.isSafeInteger(cursor) && cursor > 0), 'invalid progress history cursor');
    check(Number.isInteger(size) && size >= 1 && size <= 100, 'progress history limit must be 1..100');
    if (this.config.progressReporting === false) return { items: [], cursor: null, has_more: false, limit: size };
    const rows = this.store.all(`SELECT id,created_at,data FROM events WHERE task_id=? AND type='progress.archived'
      ${cursor === null ? '' : 'AND id<?'} ORDER BY id DESC LIMIT ?`, task.id, ...(cursor === null ? [] : [cursor]), size + 1);
    const items = []; let bytes = 0;
    for (const row of rows.slice(0, size)) {
      const data = JSON.parse(row.data);
      const item = { id: row.id, archived_at: data.archived_at ?? row.created_at, reason: data.reason, progress: data.progress };
      const itemBytes = Buffer.byteLength(JSON.stringify(item));
      // Production snapshots are bounded by MAX_STEPS/MAX_LABEL; always return at least one
      // so a valid snapshot never strands the cursor. Preserve entire snapshots, not prefixes.
      if (items.length && bytes + itemBytes > byteBudget) break;
      items.push(item); bytes += itemBytes;
    }
    return { items, cursor: items.at(-1)?.id ?? cursor, has_more: rows.length > items.length, limit: size };
  },

  reportProgressPlan(taskId, steps) {
    const task = this.store.task(taskId);
    check(!TERMINAL.has(task.status), 'cannot update progress for a terminal worker');
    const normalized = normalizeSteps(steps);
    const previous = decode(task.progress_plan);
    const run = this.running?.get(task.id);
    // Never look at an evolving unread inbox while a real invocation is running.
    // Direct in-process callers have no running entry: their bounded unread batch models received input.
    const input = run ? (run.progressInputMessageId ?? 0)
      : receivedProgressInput(this.store, task.id, { messages: this.store.unreadPage(task.id).messages });
    const lastPlan = this.store.get("SELECT id FROM events WHERE task_id=? AND type='progress.plan' ORDER BY id DESC LIMIT 1", task.id);
    const previousInput = inputMarker(task.progress_plan) ?? (lastPlan
      ? receivedProgressInput(this.store, task.id, { through: lastPlan.id }) : 0);
    const newInput = !!previous && input > previousInput;
    const changed = !!previous && JSON.stringify(normalized) !== JSON.stringify(previous.items.map(({ key, label }) => ({ key, label })));
    if (previous && !newInput && !changed) return { task_id: task.id, progress: previous, unchanged: true };
    const previousByKey = new Map((newInput ? [] : previous?.items || []).map(item => [item.key, item]));
    const previousCurrent = (newInput ? [] : previous?.items || []).find(item => item.status === 'pending' && !item.unconfirmed && item.started_at) ?? null;
    const nowMs = Date.now(), now = new Date(nowMs).toISOString();
    const progress = { version: 1, items: normalized.map(step => {
      const old = previousByKey.get(step.key);
      return old ? { ...old, ...step }
        : { ...step, status: 'pending', started_at: null, completed_at: null, duration_ms: null };
    }), updated_at: now };
    const current = progress.items.find(item => item.key === previousCurrent?.key)
      ?? progress.items.find(item => item.status === 'pending' && !item.unconfirmed);
    if (current && !current.started_at) current.started_at = now;
    const preserved = progress.items.filter(item => item.status === 'completed').length;
    this.store.transaction(() => {
      if (previous && (newInput || changed)) {
        const runs = this.store.all('SELECT started_at,ended_at FROM agent_runs WHERE task_id=? ORDER BY id LIMIT 1000', task.id);
        this.store.event(task.id, 'progress.archived', { archived_at: now, reason: newInput ? 'new_input' : 'replan',
          progress: freezeProgress(previous, runs, task, nowMs) });
      }
      this.store.setProgressPlan(task.id, { ...progress, input_message_id: Math.max(input, previousInput) });
      this.store.event(task.id, 'progress.plan', { steps: progress.items.map(item => ({ key: item.key, label: item.label })), preserved });
    });
    return { task_id: task.id, progress };
  },

  completeProgressStep(taskId, rawKey) {
    const task = this.store.task(taskId);
    check(!TERMINAL.has(task.status), 'cannot update progress for a terminal worker');
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    check(KEY.test(key), 'progress step key is invalid');
    const progress = decode(task.progress_plan);
    check(progress, 'report a progress plan before completing a step');
    const item = progress.items.find(step => step.key === key);
    check(item, `progress step '${key}' is not in the current plan`);
    if (item.status === 'completed') return { task_id: task.id, progress, unchanged: true };
    const now = new Date().toISOString();
    const current = progress.items.find(step => step.status === 'pending' && !step.unconfirmed && step.started_at)
      ?? progress.items.find(step => step.status === 'pending' && !step.unconfirmed);
    const index = progress.items.indexOf(item), currentIndex = progress.items.indexOf(current);
    const advances = current && index >= currentIndex && !item.unconfirmed;
    if (advances && item !== current) {
      // 后续完成证明执行已经越过这些待办，但不证明它们已完成或何时切换。
      for (const step of progress.items.slice(currentIndex, index)) {
        if (step.status === 'pending') {
          step.unconfirmed = true;
          step.timing_unknown = true;
          step.duration_ms = null;
        }
      }
      item.timing_unknown = true;
    } else if (!item.started_at && current === item) {
      // 旧计划缺失开始时间时保留顺序汇报的既有恢复口径。
      item.started_at = progress.updated_at ?? now;
    } else if (!item.started_at) item.timing_unknown = true;
    item.status = 'completed'; item.completed_at = now;
    item.duration_ms = item.timing_unknown ? null : elapsed(item.started_at, now);
    delete item.unconfirmed;
    progress.updated_at = now;
    // 补报被跳过的旧步骤只改完成度，不能把当前步骤重置或倒退。
    const next = advances ? (progress.items.slice(index + 1).find(step => step.status === 'pending' && !step.unconfirmed)
      ?? progress.items.find(step => step.status === 'pending' && !step.unconfirmed)) : null;
    if (next && !next.started_at) next.started_at = now;
    this.store.transaction(() => {
      this.store.setProgressPlan(task.id, { ...progress,
        ...(inputMarker(task.progress_plan) !== null ? { input_message_id: inputMarker(task.progress_plan) } : {}) });
      this.store.event(task.id, 'progress.completed', { step: key, label: item.label, duration_ms: item.duration_ms,
        completed: progress.items.filter(step => step.status === 'completed').length, total: progress.items.length,
        timing_unknown: item.timing_unknown === true,
        unconfirmed: progress.items.filter(step => step.unconfirmed).map(step => step.key) });
    });
    return { task_id: task.id, progress, unchanged: false };
  },
};
