import { check, isPlainObject, TERMINAL } from '../types.js';

const KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_STEPS = 32;
const MAX_LABEL = 160;

const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const elapsed = (startedAt, completedAt) => {
  const start = Date.parse(startedAt), end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
};

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
        const duration_ms = status === 'completed'
          ? (Number.isFinite(storedDuration) && storedDuration >= 0 ? storedDuration : elapsed(started_at, completed_at)) : null;
        return { key: item.key, label: item.label, status, started_at, completed_at, duration_ms };
      });
    if (!items.length) return null;
    return { version: 1, items, updated_at: timestamp(value.updated_at) };
  } catch { return null; }
}

function decodeReservation(raw) {
  if (!raw) return null;
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isPlainObject(value) || value.version !== 1 || !['merge','showcase'].includes(value.kind)
      || !['pending','preparing','requested','started','integrated','completed','failed','cancelled'].includes(value.status)) return { status: 'invalid' };
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
  progressView(task) {
    const { progress_plan, reservation, ...row } = task;
    return { ...row, progress: decode(progress_plan), reservation: decodeReservation(reservation) };
  },

  reportProgressPlan(taskId, steps) {
    const task = this.store.task(taskId);
    check(!TERMINAL.has(task.status), 'cannot update progress for a terminal task');
    const normalized = normalizeSteps(steps);
    const previous = decode(task.progress_plan);
    const previousByKey = new Map((previous?.items || []).map(item => [item.key, item]));
    const previousCurrent = (previous?.items || []).find(item => item.status === 'pending' && item.started_at)
      ?? (previous?.items || []).find(item => item.status === 'pending') ?? null;
    const now = new Date().toISOString();
    const progress = { version: 1, items: normalized.map(step => {
      const old = previousByKey.get(step.key);
      return old?.status === 'completed'
        ? { ...step, status: 'completed', started_at: old.started_at, completed_at: old.completed_at, duration_ms: old.duration_ms }
        : { ...step, status: 'pending', started_at: null, completed_at: null, duration_ms: null };
    }), updated_at: now };
    const current = progress.items.find(item => item.status === 'pending');
    if (current) current.started_at = current.key === previousCurrent?.key ? previousCurrent.started_at ?? now : now;
    const preserved = progress.items.filter(item => item.status === 'completed').length;
    this.store.transaction(() => {
      this.store.setProgressPlan(task.id, progress);
      this.store.event(task.id, 'progress.plan', { steps: progress.items.map(item => ({ key: item.key, label: item.label })), preserved });
    });
    return { task_id: task.id, progress };
  },

  completeProgressStep(taskId, rawKey) {
    const task = this.store.task(taskId);
    check(!TERMINAL.has(task.status), 'cannot update progress for a terminal task');
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    check(KEY.test(key), 'progress step key is invalid');
    const progress = decode(task.progress_plan);
    check(progress, 'report a progress plan before completing a step');
    const item = progress.items.find(step => step.key === key);
    check(item, `progress step '${key}' is not in the current plan`);
    if (item.status === 'completed') return { task_id: task.id, progress, unchanged: true };
    const now = new Date().toISOString();
    if (!item.started_at) {
      const current = progress.items.find(step => step.status === 'pending');
      // 旧计划没有 started_at 时，以最近一次计划变化近似恢复当前步骤；越序完成的未来步骤从此刻计为 0。
      item.started_at = current === item ? progress.updated_at ?? now : now;
    }
    item.status = 'completed'; item.completed_at = now; item.duration_ms = elapsed(item.started_at, now) ?? 0; progress.updated_at = now;
    const next = progress.items.find(step => step.status === 'pending');
    for (const step of progress.items) if (step.status === 'pending' && step !== next) step.started_at = null;
    if (next && !next.started_at) next.started_at = now;
    this.store.transaction(() => {
      this.store.setProgressPlan(task.id, progress);
      this.store.event(task.id, 'progress.completed', { step: key, label: item.label, duration_ms: item.duration_ms,
        completed: progress.items.filter(step => step.status === 'completed').length, total: progress.items.length });
    });
    return { task_id: task.id, progress, unchanged: false };
  },
};
