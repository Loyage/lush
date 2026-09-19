export class LushError extends Error {
  constructor(message, code = -32010) { super(message); this.name = 'LushError'; this.code = code; }
}
export const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const jsonDump = JSON.stringify;
export const jsonLoad = JSON.parse;
export const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
/** 任务本轮还没跑完（正在跑或还会被调用）：planner 处于这两个状态时，不算「这一轮拆解写完了」。 */
export const EXECUTING = new Set(['queued', 'running']);
export function check(condition, message) { if (!condition) throw new LushError(message, -32602); }
export function text(value, name = 'text') {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= 32000, `${name} must be non-empty text (max 32000 characters)`);
  return value;
}
/** Bound read-model collections by UTF-8 bytes; complete records remain in SQLite. */
export function bounded(rows, bytes = 200000) {
  const result = []; let size = 0;
  for (const row of rows) {
    const length = Buffer.byteLength(JSON.stringify(row));
    if (size + length > bytes) break;
    result.push(row); size += length;
  }
  return result;
}
export function id(value) {
  check((typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0, 'id must be a positive integer');
  return Number(value);
}
