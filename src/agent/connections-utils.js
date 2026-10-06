import { createHash } from 'node:crypto';
import { LushError, check, isPlainObject } from '../core/types.js';
import { THINKING_LEVELS } from './settings.js';

export const DEFAULT_ENDPOINTS = Object.freeze({
  deepseek: 'https://api.deepseek.com', openrouter: 'https://openrouter.ai/api/v1',
  zai: 'https://api.z.ai/api/coding/paas/v4', 'kimi-coding': 'https://api.kimi.com/coding',
  'openai-codex': 'https://chatgpt.com/backend-api',
});
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const object = isPlainObject;
export const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 16384
  && !/[\s\x00-\x1f\x7f$]/.test(value) && !value.startsWith('!');
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
export function fields(value, allowed, label) {
  check(object(value) && Object.keys(value).every(key => allowed.includes(key)), `${label} fields are invalid`);
}
export function safeText(value, label, max = 256) {
  check(typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= max
    && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value), `${label} is invalid`);
  return value.trim();
}
export function connectionError(code) {
  const error = new LushError('Connection operation unavailable', -32010);
  error.connectionCode = code;
  return error;
}
export function fail(code) { throw connectionError(code); }
export const codes = new Set(['unconfigured','disabled','expired','unsupported','unauthorized','rate_limited',
  'network','timeout','invalid_response','auth_changed','auth_locked','login_expired','invalid_callback','stopped','unsupported_platform']);
export const safeCode = error => codes.has(error?.connectionCode) ? error.connectionCode : 'network';
export function unavailable(status, checked_at, error_code, source = 'none') {
  const reasons = {
    unconfigured: '尚未配置此连接的凭证。', disabled: '此连接已禁用。', expired: '登录凭证已过期，需要重新登录。',
    unsupported: '自定义端点没有已授权的官方额度查询来源；未将凭证发送到官方查询接口。',
    unauthorized: '查询或登录授权失败；不代表资源已经耗尽。', rate_limited: '查询接口限制频率，请稍后再试；不代表套餐额度已耗尽。',
    timeout: '连接请求超时，未取得最新资源数据。', invalid_response: '响应格式无效或超出安全大小，未取得最新资源数据。',
    auth_changed: '连接或凭证已变化，本次结果未写回。', auth_locked: '凭证正在被其他调用更新，请稍后再试。',
    stopped: '项目已停止，本次请求已取消。',
    unsupported_platform: '当前系统缺少可验证的私有凭证文件权限实现，未读取或保存秘密。',
  };
  return { status, checked_at, source, resources: [], error_code,
    reason: reasons[error_code] || '连接请求失败，未取得最新资源数据。' };
}
export function normalizeSampling(value) {
  fields(value, ['enabled','interval_minutes','retention_days'], 'sampling');
  check(typeof value.enabled === 'boolean', 'sampling enabled must be boolean');
  check(Number.isInteger(value.interval_minutes) && value.interval_minutes >= 1 && value.interval_minutes <= 1440, 'sampling interval must be 1..1440');
  check(Number.isInteger(value.retention_days) && value.retention_days >= 1 && value.retention_days <= 3650, 'retention must be 1..3650');
  return { enabled: value.enabled, interval_minutes: value.interval_minutes, retention_days: value.retention_days };
}
export function normalizeConnection(value, id) {
  fields(value, ['id','label','provider','endpoint','auth_type','enabled','models','default_model','default_thinking','notify_reset'], 'connection');
  check(validId(id), 'connection id is invalid');
  const compatible = value.provider === 'openai-compatible';
  check(compatible || Object.hasOwn(DEFAULT_ENDPOINTS, value.provider), 'connection provider is unsupported');
  const auth_type = value.provider === 'openai-codex' ? 'oauth' : 'api_key';
  check(value.auth_type === auth_type, 'connection authentication type is unsupported');
  if (compatible) check(typeof value.endpoint === 'string' && value.endpoint.trim().length > 0, 'compatible API requires an explicit endpoint');
  const endpoint = value.endpoint === undefined || value.endpoint === '' ? DEFAULT_ENDPOINTS[value.provider] : value.endpoint;
  check(typeof endpoint === 'string' && endpoint.length <= 2048, 'connection endpoint is invalid');
  let url; try { url = new URL(endpoint); } catch { check(false, 'connection endpoint is invalid'); }
  check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'connection endpoint must be HTTPS without secrets, query or fragment');
  const models = value.models ?? [];
  check(Array.isArray(models) && models.length <= 100, 'connection models must be a bounded list');
  if (compatible) check(models.length > 0, 'compatible API requires explicit model IDs');
  const normalizedModels = models.map(model => safeText(model, 'model', 256));
  check(new Set(normalizedModels).size === normalizedModels.length, 'connection models must be unique');
  check(value.enabled === undefined || typeof value.enabled === 'boolean', 'connection enabled must be boolean');
  // 额度刷新提醒只影响本地页面是否在缓存 reset_at 到达时提醒，不参与连接身份、凭证或额度缓存命名空间。
  check(value.notify_reset === undefined || typeof value.notify_reset === 'boolean', 'connection notify_reset must be boolean');
  const optionalText = (input, label, max) => input === undefined || input === null || input === ''
    ? '' : safeText(input, label, max);
  // 默认设定只影响运行设置的一次「快速填入」，不参与连接身份、凭证或额度历史。
  const default_model = optionalText(value.default_model, 'connection default model', 256);
  const default_thinking = optionalText(value.default_thinking, 'connection default thinking', 32);
  check(THINKING_LEVELS.pi.includes(default_thinking), 'connection default thinking is unsupported');
  if (default_model && normalizedModels.length) check(normalizedModels.includes(default_model), 'connection default model must be within the model range');
  return { id, label: safeText(value.label, 'connection label'), provider: value.provider,
    endpoint: url.href.replace(/\/$/, ''), auth_type, enabled: value.enabled ?? true, models: normalizedModels,
    default_model, default_thinking, notify_reset: value.notify_reset ?? false };
}

/** Bounded JSON request. Includes headers AND body in the deadline; no error response body is read. */
export async function requestJson(url, init = {}, options = {}) {
  const fetcher = options.fetch || globalThis.fetch;
  const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? Math.min(options.timeout, 8000) : 8000;
  const controller = new AbortController(); let timer;
  const parent = options.signal;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => { controller.abort(); rejectAbort(connectionError('stopped')); };
  parent?.addEventListener('abort', onAbort, { once: true });
  if (parent?.aborted) onAbort();
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(connectionError('timeout'));
  }, timeout); });
  try {
    return await Promise.race([deadline, aborted, (async () => {
      if (parent?.aborted) fail('stopped');
      let response; try { response = await fetcher(url, { ...init, signal: controller.signal, redirect: 'error' }); }
      catch { if (parent?.aborted) fail('stopped'); fail('network'); }
      if (response.redirected || response.status >= 300 && response.status < 400) fail('network');
      // Device-start 404 means the provider has not enabled this login flow.
      // Do not read its potentially sensitive error body.
      if (options.deviceAuthStart === true && response.status === 404) fail('unsupported');
      // Only the fixed Codex device-poll adapter opts in. Error bodies stay private
      // and bounded; ordinary balance/login requests never read error bodies.
      const devicePoll = options.deviceAuthPoll === true;
      if (devicePoll && [403,404].includes(response.status)) return { status: response.status, data: null };
      const deviceError = devicePoll && [400,429].includes(response.status);
      if (response.status === 401 || response.status === 403) fail('unauthorized');
      if (!deviceError && response.status === 429) fail('rate_limited');
      if (!deviceError && !response.ok) fail('network');
      if (Number(response.headers?.get?.('content-length')) > 65536) fail('invalid_response');
      const reader = response.body?.getReader(); if (!reader) fail('invalid_response');
      const chunks = []; let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.byteLength; if (length > 65536) fail('invalid_response'); chunks.push(value);
        }
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          return devicePoll ? { status: response.status, data } : data;
        } catch { fail('invalid_response'); }
      } finally { void reader.cancel().catch(() => {}); }
    })()]);
  } catch (error) { throw connectionError(safeCode(error)); }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); controller.abort(); }
}
