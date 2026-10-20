import { check, isPlainObject } from '../core/types.js';
import { ADMINISTRATOR_MAX_RESULT_BYTES } from './runtime-protocol.js';
import { administratorSafeText } from './delegation.js';

const PRIVATE_KEY = /(?:^_|token|credential|password|secret|authorization|cookie|private.?prompt|system.?prompt|refresh.?token|api.?key|control.?key|\benv\b)/i;
export function strictFields(value, allowed, required = []) {
  check(isPlainObject(value) && Object.keys(value).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(value, key)), 'invalid administrator request fields');
}
export function userBinding(value) {
  check(typeof value === 'string' && value.length >= 16 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value), 'trusted user session binding required');
  return value;
}
export function stableJSON(value) {
  const visit = (node, depth = 0) => {
    check(depth <= 20, 'administrator tool parameters are too deeply nested');
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return node;
    if (typeof node === 'number') { check(Number.isFinite(node), 'invalid administrator tool number'); return node; }
    if (Array.isArray(node)) return node.map(item => visit(item, depth + 1));
    check(isPlainObject(node), 'administrator tool parameters must be JSON');
    return Object.fromEntries(Object.keys(node).sort().map(key => [key, visit(node[key], depth + 1)]));
  };
  const result = JSON.stringify(visit(value));
  check(Buffer.byteLength(result) <= 128 * 1024, 'administrator tool parameters exceed the byte budget');
  return result;
}
function cleanText(value, secrets) {
  let result = value;
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) result = result.replaceAll(secret, '[redacted]');
  return administratorSafeText(result).replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|LUSH_[A-Z_]*TOKEN)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b((?:private|system)[_-]?prompt\s*[=:]\s*)[\s\S]*/gi, '$1[redacted private prompt]');
}
/** Final defense in depth; the executor must also protect its source-specific secret surfaces. */
export function safeRuntimeValue(value, secrets = []) {
  let entries = 0;
  const visit = (node, depth = 0) => {
    check(depth <= 24 && ++entries <= 20000, 'administrator result exceeds the structural budget');
    if (node === null || typeof node === 'boolean') return node;
    if (typeof node === 'number') return Number.isFinite(node) ? node : null;
    if (typeof node === 'string') return cleanText(node, secrets);
    if (Array.isArray(node)) return node.map(item => visit(item, depth + 1));
    check(isPlainObject(node), 'administrator result must be JSON');
    return Object.fromEntries(Object.entries(node).filter(([key]) => !PRIVATE_KEY.test(key))
      .map(([key, val]) => [key, visit(val, depth + 1)]));
  };
  const safe = visit(value);
  check(Buffer.byteLength(JSON.stringify(safe)) <= ADMINISTRATOR_MAX_RESULT_BYTES, 'administrator result exceeds the output budget');
  return safe;
}
export function runtimeFailure(stage, effect = 'unknown') {
  const messages = {
    execution: '管理员执行失败；保留首次失败与副作用证据，不自动重放。',
    persistence: '管理员审计或完成记录保存失败；结果未获可靠确认，不自动重放。',
    recovery: '管理员执行曾中断，缺少完成证明；副作用未知，不自动重放。',
    stopping: '管理员停止已请求；已发生的副作用不撤回，未确认的在途操作保留未知。',
    configuration: '管理员运行器或工具执行器尚未配置；本轮未开始执行。',
  };
  return { version: 1, stage, code: `${stage}_failed`, message: messages[stage] ?? messages.execution,
    effect, evidence: effect === 'not_started' ? 'trusted_pre_dispatch' : 'completion_not_observed' };
}
/** Sample only diagnostic scalars, never stack/cause/stderr/response/body or arbitrary Error properties.
 * Sampling does not classify side effects: effect is fixed by the trusted call boundary. */
export function sampledRuntimeFailure(stage, effect, value, source, secrets = []) {
  const failure = runtimeFailure(stage, effect);
  try {
    const sample = {};
    const scalar = (item, limit) => {
      if (typeof item === 'number' && Number.isFinite(item)) return item;
      if (typeof item !== 'string') return undefined;
      if (item.length > 16384) return '[diagnostic sample omitted: size limit]';
      return cleanText(item, secrets).slice(0, limit);
    };
    if (value && typeof value === 'object') {
      const name = scalar(value.name, 128), code = scalar(value.code, 128);
      if (name !== undefined) sample.name = name;
      if (code !== undefined) sample.code = code;
      if (['stderr', 'response', 'body', 'stdout'].some(key => Object.hasOwn(value, key))) {
        sample.message = '[raw transport/authentication response omitted]';
      } else {
        const message = scalar(value.message, 2048);
        if (message !== undefined) sample.message = /(?:private|system)[_-]?prompt\s*[=:]/i.test(message)
          ? '[private prompt diagnostic omitted]' : message;
      }
    } else {
      const message = scalar(value, 2048);
      if (message !== undefined) sample.message = /(?:private|system)[_-]?prompt\s*[=:]/i.test(message)
        ? '[private prompt diagnostic omitted]' : message;
    }
    const detail = safeRuntimeValue({ source, error: sample }, secrets);
    return { ...failure, detail };
  } catch { return { ...failure, detail: { source, sample_unavailable: true } }; }
}
export const decodeStored = value => value === null || value === undefined ? null : JSON.parse(value);
