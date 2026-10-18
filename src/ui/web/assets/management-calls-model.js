// Event IDs are cursors, not a full-history call ordinal. Finished snapshots stand alone.
export const CALL_LIMITS = Object.freeze({ events: 5000, bytes: 8 * 1024 * 1024 });
export function createCallsState(limits = CALL_LIMITS) {
  return { calls: new Map(), events: new Set(), bytes: 0, high: 0, oldest: null,
    hasOlder: false, hasNewer: false, loaded: false, limited: false, limits };
}
export function mergeCalls(state, page, direction) {
  if (!page || page.coverage !== 'trusted_management_rpc_events_only' || !Array.isArray(page.items)
    || page.items.some(row => !Number.isSafeInteger(row.seq) || row.seq < 1 || !Number.isSafeInteger(row.call_id)
      || row.call_id < 1 || !['started', 'finished'].includes(row.phase))) throw new Error('unsupported_call_stream');
  let boundary = null;
  for (const row of [...page.items].sort((a, b) => a.seq - b.seq)) {
    const old = state.calls.get(row.call_id);
    // A late start projection must never undo an already observed finish, nor an older finish a newer one.
    const replace = !old || (old.phase !== 'finished' && row.phase === 'finished')
      || (old.phase === row.phase && row.seq >= old.seq);
    const bytes = replace ? new TextEncoder().encode(JSON.stringify(row)).length : 0;
    const previous = replace && old ? new TextEncoder().encode(JSON.stringify(old)).length : 0;
    if ((!state.events.has(row.seq) && state.events.size >= state.limits.events)
      || state.bytes - previous + bytes > state.limits.bytes) { state.limited = true; break; }
    state.events.add(row.seq);
    if (replace) { state.calls.set(row.call_id, row); state.bytes += bytes - previous; }
    state.high = Math.max(state.high, row.seq);
    state.oldest = Math.min(state.oldest ?? row.seq, row.seq);
    boundary = row.seq;
  }
  if (direction === 'initial' || direction === 'older') state.hasOlder = page.has_more === true;
  if (direction === 'newer') state.hasNewer = page.has_more === true;
  if (direction === 'initial') state.loaded = true;
  return boundary;
}
const LABELS = { pending_confirmation: '待用户确认（尚未执行）', approved: '已批准，等待安全点',
  waiting: '等待安全点', running: '执行中', succeeded: '已提交／执行收据成功', skipped: '已跳过',
  rejected: '已拒绝', failed: '失败', unknown: '结果未知，待核验', cancelled: '已取消' };
export function callStatus(row, management) {
  if (row.phase !== 'finished') return row.status === 'unknown' ? '结果未知（未观察到完成）' : 'RPC 进行中（尚未见完成）';
  if (row.status !== 'succeeded') return row.status === 'rejected' ? 'RPC 参数被拒绝' : 'RPC 失败或被拒绝';
  const executions = [management?.pending_signal, management?.last_execution].filter(Boolean);
  const capability = executions.flatMap(item => item.control_calls || []).find(item =>
    item.receipt_id === row.receipt_id && item.method === row.method && row.receipt_id != null);
  const action = row.action || row.result?.action;
  const receipt = action && executions.flatMap(item => item.actions || []).find(item =>
    action.receipt_id != null && item.receipt_id === action.receipt_id);
  const status = receipt?.status ?? action?.status ?? capability?.status ?? row.result?.status;
  return `RPC 已返回${status ? ` · ${receipt || (!action && capability) ? '当前收据' : '调用时收据'}：${LABELS[status] || '状态未知'}` : '（不代表目标业务完成）'}`;
}
