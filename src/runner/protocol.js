import { createHash, timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const IMPLEMENTATION_VERSION = '1.0.0';
export const LIMITS = Object.freeze({ frame_bytes: 2 * 1024 * 1024, file_bytes: 1024 * 1024,
  output_chunk_bytes: 64 * 1024, output_bytes: 8 * 1024 * 1024, context_bytes: 128 * 1024,
  lease_ms: 30000, max_lease_ms: 120000, command_ms: 120000, max_command_ms: 3600000,
  queue_ms: 120000, request_ms: 15000, max_pending: 64 });
export const ERROR_CODES = Object.freeze(['INVALID_REQUEST', 'VERSION_MISMATCH', 'UNAUTHORIZED', 'UNSUPPORTED',
  'NOT_FOUND', 'STALE', 'BUSY', 'CONFLICT', 'CONTEXT_REQUIRED', 'LIMIT_EXCEEDED', 'UNKNOWN', 'CANCELLED',
  'TIMEOUT', 'UNAVAILABLE', 'INTERNAL']);
export class RunnerError extends Error {
  constructor(code, message, details = undefined) {
    super(message); this.name = 'RunnerError'; this.code = ERROR_CODES.includes(code) ? code : 'INTERNAL';
    if (details !== undefined) this.details = details;
  }
}
export function fail(code, message, details) { throw new RunnerError(code, message, details); }
export function check(condition, code, message, details) { if (!condition) fail(code, message, details); }
// One registry for admission, dispatch, handshake and client capability checks.
export const OPERATIONS = Object.freeze(Object.fromEntries(Object.entries({
  hello: { authority: 'either' },
  'workspace.register': { authority: 'control', workspace: false, mutation: true },
  'workspace.inspect': { authority: 'either', workspace: true },
  'lease.grant': { authority: 'control', workspace: true, mutation: true },
  'lease.renew': { authority: 'run', workspace: true, mutation: true },
  'lease.revoke': { authority: 'control', workspace: true, mutation: true, concurrent: true },
  'lease.release': { authority: 'either', workspace: true, mutation: true, concurrent: true },
  'request.status': { authority: 'either', workspace: true },
  'file.context': { authority: 'either', workspace: true },
  'file.read': { authority: 'either', workspace: true },
  'file.write': { authority: 'either', workspace: true, mutation: true, context: true, tool_effect: true },
  'file.edit': { authority: 'either', workspace: true, mutation: true, context: true, tool_effect: true },
  'artifact.register': { authority: 'control', workspace: true, mutation: true },
  'artifact.read': { authority: 'either', workspace: true },
  'artifact.upload': { authority: 'control', workspace: true, mutation: true },
  'artifact.download': { authority: 'control', workspace: true },
  'workspace.git.apply': { authority: 'control', workspace: true, mutation: true },
  'workspace.git.inspect': { authority: 'control', workspace: true, mutation: true, live_control: true },
  'workspace.code.read': { authority: 'control', workspace: true, observation: true, idle_read: true },
  'workspace.git.export': { authority: 'control', workspace: true, mutation: true, live_control: true },
  'workspace.cleanup': { authority: 'control', workspace: true, mutation: true },
  'command.start': { authority: 'either', workspace: true, mutation: true, context: true, retain_busy: true, tool_effect: true },
  'command.status': { authority: 'either', workspace: true },
  'command.output': { authority: 'either', workspace: true },
  'command.cancel': { authority: 'either', workspace: true, mutation: true, concurrent: true, tool_effect: true },
  'workspace.barrier': { authority: 'either', workspace: true },
}).map(([name, value]) => [name, Object.freeze(value)])));
export const CAPABILITIES = Object.freeze(Object.keys(OPERATIONS));
export const definitiveRunnerRejection = error => error?.runner_response === true
  && ['INVALID_REQUEST', 'VERSION_MISMATCH', 'UNAUTHORIZED', 'UNSUPPORTED', 'NOT_FOUND', 'STALE',
    'BUSY', 'CONFLICT', 'CONTEXT_REQUIRED', 'LIMIT_EXCEEDED'].includes(error.code);
export const hash = value => createHash('sha256').update(value).digest('hex');
export function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
}
export function validToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) return false;
  if (/^[a-fA-F0-9]+$/.test(token) && token.length >= 64 && token.length % 2 === 0) return true;
  const decoded = Buffer.from(token, 'base64url');
  return decoded.length >= 32 && decoded.toString('base64url') === token;
}
export function tokenMatches(token, digest) {
  if (!validToken(token) || !/^[a-f0-9]{64}$/.test(digest ?? '')) return false;
  return timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(digest, 'hex'));
}
export function identifier(value, name) {
  check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value), 'INVALID_REQUEST', `Invalid ${name}`);
  return value;
}
export function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_REQUEST', `Invalid ${name}`); return value;
}
export function validateRequest(request) {
  check(request && typeof request === 'object' && !Array.isArray(request), 'INVALID_REQUEST', 'Expected request object');
  check(request.version === PROTOCOL_VERSION, 'VERSION_MISMATCH', 'Incompatible Runner protocol');
  identifier(request.request_id, 'request_id');
  check(Object.hasOwn(OPERATIONS, request.method), 'UNSUPPORTED', 'Unknown Runner operation');
  const identity = request.identity;
  check(identity && typeof identity === 'object', 'INVALID_REQUEST', 'Missing identity');
  for (const field of ['project_id', 'node_id', 'workspace_id']) identifier(identity[field], field);
  for (const field of ['worker_id', 'generation']) integer(identity[field], field);
  if (request.method !== 'hello' || identity.runner_id !== undefined && identity.runner_id !== null)
    identifier(identity.runner_id, 'runner_id');
  check((identity.run_id !== undefined) !== (identity.operation_id !== undefined), 'INVALID_REQUEST', 'Use exactly one run_id or operation_id');
  if (identity.run_id !== undefined) integer(identity.run_id, 'run_id');
  else identifier(identity.operation_id, 'operation_id');
  check(request.params && typeof request.params === 'object' && !Array.isArray(request.params), 'INVALID_REQUEST', 'Expected params object');
  check(request.auth && typeof request.auth === 'object', 'UNAUTHORIZED', 'Missing authorization');
  return OPERATIONS[request.method];
}
export function workspaceKey(identity) {
  return hash(stable(Object.fromEntries(['project_id', 'node_id', 'runner_id', 'worker_id', 'workspace_id', 'generation'].map(key => [key, identity[key]]))));
}
export function requestSecrets(request) {
  return [...new Set([request?.auth?.machine_token, request?.auth?.control_token, request?.auth?.run_token,
    ...(request?.method === 'lease.grant' ? [request?.params?.run_token] : [])].filter(validToken))];
}
export function redact(value, secrets) {
  if (value === undefined) return undefined;
  let text = JSON.stringify(value);
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return JSON.parse(text);
}
export function publicError(error) {
  // Native paths, SQL text and transport diagnostics are not part of the wire error contract.
  return error instanceof RunnerError ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
    : { code: 'INTERNAL', message: 'Runner operation failed; inspect node-local diagnostics' };
}
