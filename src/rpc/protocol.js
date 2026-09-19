import { LushError, check, isPlainObject } from '../core/types.js';

export { Dispatcher } from './dispatcher.js';

export const MAX_FRAME = 1024 * 1024;
export function encode(value) {
  const payload = Buffer.from(JSON.stringify(value) + '\n');
  check(payload.length <= MAX_FRAME, 'RPC frame exceeds 1 MiB; use paginated history');
  return payload;
}
export const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
export function parseRequest(raw) {
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw new LushError('parse error', -32700); }
  check(isPlainObject(value) && value.jsonrpc === '2.0' && typeof value.method === 'string', 'invalid JSON-RPC request');
  check(value.id === undefined || value.id === null || typeof value.id === 'string' || Number.isSafeInteger(value.id), 'invalid request id');
  return value;
}
