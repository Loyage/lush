import { check } from '../types.js';

/** Shared reservation decoding and stable, deduplicated parent-drift diagnostics; no I/O. */
export function storedReservation(raw) {
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('reservation state is invalid; inspect worker before changing it'); }
  check(value && typeof value === 'object' && !Array.isArray(value) && [1,2,3].includes(value.version)
    && value.kind === 'merge' && typeof value.status === 'string',
  'reservation state is invalid; inspect worker before changing it');
  return value;
}

/** Use the same drift reason for branch advance, integration and approval so diagnostics deduplicate. */
export function parentMovedReason(branch, parentHead, commit) {
  return `父分支 ${branch} 在本请求发出后被推进到 ${String(parentHead).slice(0, 12)}，`
    + `固定提交 ${String(commit).slice(0, 12)} 已不能快进：撤销这个请求（Worker、分支与提交保留），`
    + `或先把该固定提交合入 ${branch} 再确认集成。`;
}
