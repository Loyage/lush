import { api } from './api.js';

const GROUPS = ['history', 'runs', 'steps', 'progress'];
const timingEvent = event => ['worker.phase_changed', 'invocation.started', 'invocation.completed', 'invocation.preempted'].includes(event.type);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const positive = value => Number.isSafeInteger(value) && value > 0;

/** Bounded, cancellable evidence collection. No model calls, background scans or descendant reads. */
export function createPerformanceData(taskId, { read = api, maxRecords = 5000, maxChars = 4 * 1024 * 1024, commandsOnly = false } = {}) {
  let task = null, sampledAt = null, scanned = 0, chars = 0, exhausted = false;
  const groups = commandsOnly ? ['steps'] : GROUPS;
  const maps = Object.fromEntries(GROUPS.map(group => [group, new Map()]));
  const cursors = { history: null, runs: null, steps: 0, progress: null };
  const coverage = Object.fromEntries(GROUPS.map(group => [group, false]));
  const loaded = new Set(); let low = null, high = null;
  function snapshot() {
    return { task, sampled_at: sampledAt, now: sampledAt, scanned, exhausted, coverage: { ...coverage },
      events: [...maps.history.values()], runs: [...maps.runs.values()], steps: [...maps.steps.values()],
      progressVersions: [...maps.progress.values()], ranges: low === null ? [] : [[low, high]] };
  }
  const check = signal => { if (signal?.aborted) throw new DOMException('性能分析读取已取消', 'AbortError'); };
  function budget(count, values) {
    const added = JSON.stringify(values).length;
    if (scanned + count > maxRecords || chars + added > maxChars) {
      exhausted = true; throw new Error('达到性能分析读取预算（5000 条／8 MiB 元数据），全部历史尚未完成；已保留当前结果。');
    }
    scanned += count; chars += added;
  }
  async function page(group, signal) {
    check(signal);
    const before = cursors[group], query = new URLSearchParams({ limit: '100' });
    let route;
    if (group === 'history') {
      query.set('before_message', '0'); if (before !== null) query.set('before_event', String(before)); route = 'reading-page';
    } else if (group === 'steps') { query.set('after', String(before)); route = 'transcript-search'; }
    else { if (before !== null) query.set('before', String(before)); route = group === 'runs' ? 'runs-page' : 'progress-history'; }
    const data = await read(`/api/worker/${taskId}/${route}?${query}`, { signal }); check(signal);
    const items = group === 'history' ? data.events : group === 'steps' ? data.steps : data.items;
    if (!Array.isArray(items) || data.errors?.length || data.truncated === true) throw new Error(`${route} 证据读取不完整，不能标为全部历史。`);
    const more = group === 'history' ? data.has_more_events : data.has_more;
    const next = group === 'history' ? data.event_cursor : group === 'steps' ? data.next : data.cursor;
    if (typeof more !== 'boolean' || (more && (!positive(next) || (group === 'steps' ? next <= before : before !== null && next >= before)))) {
      throw new Error(`${route} 分页游标无效，已停止读取。`);
    }
    if (items.some(item => !positive(group === 'steps' ? item.seq : item.id) || (item.task_id != null && item.task_id !== taskId))) {
      throw new Error(`${route} 返回了无效或其他 Worker 的证据，已拒绝。`);
    }
    const retained = group === 'history' ? items.filter(timingEvent).map(item => ({ ...pick(item, ['id', 'task_id', 'type', 'created_at', 'limitations']),
      data: pick(item.data || {}, ['version', 'from', 'to', 'to_status', 'reason', 'run_id', 'call', 'suspended', 'notice_id', 'child_ids', 'notice_ids']) }))
      : group === 'steps' ? items.map(item => pick(item, ['seq', 'file', 'kind', 'at', 'call_id', 'tool_name', 'title', 'is_error', 'error_known', 'shell']))
        : group === 'runs' ? items.map(item => pick(item, ['id', 'task_id', 'attempt', 'status', 'started_at', 'ended_at']))
          : items.map(item => pick(item, ['id', 'progress', 'archived_at']));
    budget(items.length, retained);
    for (const item of retained) maps[group].set(group === 'steps' ? item.seq : item.id, item);
    if (group === 'history' && items.length) {
      const ids = items.map(item => item.id); low = Math.min(low ?? Infinity, ...ids); high = Math.max(high ?? 0, ...ids);
    }
    loaded.add(group); cursors[group] = next; coverage[group] = !more;
  }
  async function load({ all = false, signal, onProgress = () => {} } = {}) {
    check(signal);
    if (exhausted) throw new Error('读取预算已用完；请刷新分析后重试，当前范围不是全部历史。');
    if (!task) {
      const value = await read(`/api/worker/${taskId}`, { signal }); check(signal);
      if (value.id !== taskId) throw new Error('Worker 身份不匹配，已停止读取。');
      task = pick(value, ['id', 'status', 'task_kind', 'calls', 'created_at', 'worker_number', ...(commandsOnly ? [] : ['progress'])]);
      sampledAt = new Date().toISOString(); onProgress(snapshot());
    }
    for (const group of groups) {
      if (coverage[group] || (!all && loaded.has(group))) continue;
      do { await page(group, signal); onProgress(snapshot()); } while (all && !coverage[group]);
    }
    return snapshot();
  }
  return { snapshot, load };
}
