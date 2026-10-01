// Provider wire formats are intentionally parsed here rather than loading Pi extensions.
// Endpoint references: pi-usage (MIT), https://github.com/ajarellanod/pi-usage-bars.
// No provider response text, error message, credential or environment value is returned.
export const USAGE_ENDPOINTS = Object.freeze({
  deepseek: 'https://api.deepseek.com/user/balance',
  openrouter: 'https://openrouter.ai/api/v1/key',
  'openai-codex': 'https://chatgpt.com/backend-api/wham/usage',
  zai: 'https://api.z.ai/api/monitor/usage/quota/limit',
  'kimi-coding': 'https://api.kimi.com/coding/v1/usages',
});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const positiveInt = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const fail = code => { throw Object.assign(new Error('Usage query failed'), { usageCode: code }); };
export function unavailableBalance(status, reason, checked_at, error_code = 'unsupported', queried = false) {
  return { status, kind: null, items: [], reason, checked_at, queried, error_code };
}
function available(kind, items, checked_at, reason = null) {
  if (!items.length || items.length > 10 || !items.some(item => [item.remaining, item.total, item.used].some(value => value !== null))) fail('invalid_response');
  return { status: 'available', kind, items, reason, checked_at, queried: true, error_code: null };
}
function item(id, label, unit, values = {}) {
  return { id, label, unit, remaining: null, total: null, used: null, reset_at: null, window_seconds: null, ...values };
}
function iso(value, milliseconds = false) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = milliseconds ? value : value * 1000;
    if (ms <= 8640000000000000) return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}
function reset(window, checkedAt) {
  return iso(window?.reset_at) || (number(window?.reset_after_seconds) !== null && window.reset_after_seconds >= 0
    ? iso(Date.parse(checkedAt) / 1000 + Number(window.reset_after_seconds)) : null);
}
function percent(value) { const parsed = number(value); return parsed !== null && parsed >= 0 && parsed <= 100 ? parsed : null; }
function percentageItem(id, label, raw, checkedAt) {
  const used = percent(raw?.used_percent);
  return item(id, label, '%', { used, remaining: used === null ? null : 100 - used, total: used === null ? null : 100,
    window_seconds: positiveInt(raw?.limit_window_seconds), reset_at: reset(raw, checkedAt) });
}
function bucket(id, label, raw, windowSeconds = null) {
  let used = number(raw?.used), remaining = number(raw?.remaining), total = number(raw?.limit);
  if (total === null && used !== null && remaining !== null) total = number(used + remaining);
  if (remaining === null && total !== null && used !== null) remaining = number(total - used);
  return item(id, label, '额度单位', { used, remaining, total, reset_at: iso(raw?.resetTime), window_seconds: positiveInt(windowSeconds) });
}
function parseBuiltin(provider, data, checkedAt) {
  if (provider === 'deepseek') {
    if (!Array.isArray(data?.balance_infos) || data.balance_infos.length > 10) fail('invalid_response');
    const items = data.balance_infos.map(raw => {
      const remaining = number(raw?.total_balance);
      if (remaining === null || !/^[A-Z]{3}$/.test(raw?.currency || '')) fail('invalid_response');
      return item(`balance-${raw.currency}`, '账户余额', raw.currency, { remaining });
    });
    if (new Set(items.map(row => row.id)).size !== items.length) fail('invalid_response');
    return available('balance', items, checkedAt);
  }
  if (provider === 'openrouter') {
    const raw = data?.data, total = number(raw?.limit), remaining = number(raw?.limit_remaining), used = number(raw?.usage);
    if (!object(raw) || used === null || (raw.limit !== null && total === null) || (raw.limit_remaining !== null && remaining === null)) fail('invalid_response');
    return available('quota', [item('key-limit', 'API Key 消费额度', 'USD', { total, remaining, used })], checkedAt,
      total === null ? '此 API Key 未设置消费上限；显示的是 Key 用量，不是账户现金余额。' : '这是 API Key 消费额度，不是账户现金余额。');
  }
  if (provider === 'openai-codex') {
    const raw = data?.rate_limit;
    const items = [percentageItem('primary', '主要额度窗口', raw?.primary_window, checkedAt),
      percentageItem('secondary', '次要额度窗口', raw?.secondary_window, checkedAt)];
    return available('quota', items, checkedAt, '来自 ChatGPT 网页后端接口（非稳定公开 API）；订阅额度不是现金余额，未知窗口不视为零。');
  }
  if (provider === 'kimi-coding') {
    const items = [bucket('membership', '会员额度', data?.usage)];
    if (Array.isArray(data?.limits)) for (const [index, raw] of data.limits.slice(0, 9).entries()) {
      // Duration is used only when explicitly supplied in seconds; never assume a daily quota.
      const seconds = positiveInt(raw?.window?.duration) && ['TIME_UNIT_SECOND', 'SECOND'].includes(raw?.window?.timeUnit)
        ? raw.window.duration : positiveInt(raw?.window_seconds);
      items.push(bucket(`rolling-${index}`, '滚动窗口额度', raw?.detail, seconds));
    }
    return available('quota', items, checkedAt, '数值沿用服务商额度单位；未提供单位时不推测为 token 或货币。');
  }
  if (provider === 'zai') {
    const limits = data?.data?.limits ?? data?.limits ?? data?.quota?.limits ?? data?.data?.quota?.limits;
    if (!Array.isArray(limits) || !limits.length || limits.length > 10) fail('invalid_response');
    const seen = new Set();
    const items = limits.map((raw, index) => {
      const type = ['TIME_LIMIT', 'TOKENS_LIMIT', 'TOKEN_LIMIT', 'SESSION_LIMIT', 'WEEKLY_LIMIT', 'WEEK_LIMIT', 'REQUEST_LIMIT', 'DAILY_LIMIT'].includes(raw?.type) ? raw.type.toLowerCase() : `limit-${index}`;
      if (seen.has(type)) fail('invalid_response'); seen.add(type);
      const used = percent(raw?.percentage ?? raw?.used_percent);
      const values = used !== null ? { used, remaining: 100 - used, total: 100 }
        : { used: number(raw?.currentValue), remaining: number(raw?.remaining), total: number(raw?.total) };
      if (values.total === null && values.used !== null && values.remaining !== null) values.total = number(values.used + values.remaining);
      if (values.remaining === null && values.total !== null && values.used !== null) values.remaining = number(values.total - values.used);
      return item(type, `额度窗口 ${index + 1}`, used !== null ? '%' : '额度单位', { ...values,
        reset_at: iso(raw?.nextResetTime, true) || iso(raw?.reset_at), window_seconds: positiveInt(raw?.window_seconds) });
    });
    return available('quota', items, checkedAt, '各限制独立展示；未公开窗口时长时不推测为每日或每周额度。');
  }
  fail('unsupported');
}
async function responseJson(response) {
  if (response.status === 401 || response.status === 403) fail('unauthorized');
  if (!response.ok) fail('network');
  if (Number(response.headers.get('content-length')) > 65536) fail('invalid_response');
  const reader = response.body?.getReader(); if (!reader) fail('invalid_response');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 65536) fail('invalid_response'); chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_response'); }
  } finally { await reader.cancel().catch(() => {}); }
}
async function query(url, init, checkedAt, parse, { fetch: fetcher = globalThis.fetch, timeout = 8000 } = {}) {
  const controller = new AbortController(); let timer;
  // Test seams cannot disable the production bound accidentally.
  const duration = Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 30000) : 8000;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(Object.assign(new Error('Usage timeout'), { usageCode: 'network' }));
    }, duration); });
    const data = await Promise.race([deadline, (async () => responseJson(await fetcher(url, {
      ...init, redirect: 'error', signal: controller.signal,
    })))()]);
    try { return parse(data); } catch (error) { if (error?.usageCode) throw error; fail('invalid_response'); }
  } catch (error) {
    const code = ['unauthorized', 'invalid_response', 'unconfigured'].includes(error?.usageCode) ? error.usageCode : 'network';
    return unavailableBalance('error', code === 'unauthorized' ? '额度查询授权失败，请检查或更新凭证。'
      : code === 'invalid_response' ? '额度查询响应格式无效或超出安全大小，未取得数值。' : '余额/额度查询失败（网络、超时或服务异常），未取得数值。', checkedAt, code, true);
  } finally { clearTimeout(timer); controller.abort(); }
}
/** Fixed HTTPS builtins; a caller must first validate the credential belongs to this provider. */
export function queryAccountBalance(provider, key, checkedAt, options = {}) {
  const url = USAGE_ENDPOINTS[provider];
  if (!url) return Promise.resolve(unavailableBalance('unsupported', '此服务商尚无已接入的余额/额度查询接口。', checkedAt));
  return query(url, { method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }, checkedAt,
    data => parseBuiltin(provider, data, checkedAt), options);
}
const forbiddenEnv = name => name.startsWith('LUSH_') || name.startsWith('PI_SESSION')
  || ['PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL'].includes(name);
function expand(value, env) {
  if (typeof value !== 'string' || value.length > 32768) fail('invalid_response');
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (forbiddenEnv(name) || typeof env[name] !== 'string' || !env[name]) fail('unconfigured');
    return env[name];
  });
  if (expanded.includes('\0') || expanded.length > 65536) fail('invalid_response');
  return expanded;
}
function expandBody(raw, env) {
  const walk = value => {
    if (typeof value === 'string') return expand(value, env);
    if (Array.isArray(value)) return value.map(walk);
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, walk(val)]));
    return value;
  };
  return JSON.stringify(walk(JSON.parse(raw)));
}
function field(data, path) {
  if (path === null || path === undefined || path === '') return undefined;
  if (typeof path !== 'string' || path.length > 256 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)) fail('invalid_response');
  for (const key of path.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('invalid_response');
    if (data === null || typeof data !== 'object' || !Object.hasOwn(data, key)) return undefined;
    data = data[key];
  }
  return data;
}
function customItems(custom, data) {
  if (!Array.isArray(custom.items) || custom.items.length < 1 || custom.items.length > 10) fail('invalid_response');
  return custom.items.map(mapping => {
    const used = number(field(data, mapping.used)), total = number(field(data, mapping.total));
    let remaining = number(field(data, mapping.remaining));
    if (remaining === null && total !== null && used !== null) remaining = number(total - used);
    return item(mapping.id, mapping.label, mapping.unit, { remaining, total, used,
      reset_at: iso(field(data, mapping.reset_at)), window_seconds: positiveInt(mapping.window_seconds) });
  });
}
/** Custom endpoints receive ONLY explicitly named environment variables, never the Pi key map. */
export async function queryCustomBalance(custom, env, checkedAt, options = {}) {
  let url, headers, body;
  try {
    url = new URL(custom.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || custom.url.includes('${')
      || !['GET', 'POST'].includes(custom.method) || !['balance', 'quota'].includes(custom.kind)) fail('invalid_response');
    headers = { Accept: 'application/json' };
    if (!object(custom.headers) || Object.keys(custom.headers).length > 32) fail('invalid_response');
    for (const [key, value] of Object.entries(custom.headers)) {
      if (!/^[A-Za-z0-9-]+$/.test(key) || ['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade'].includes(key.toLowerCase())) fail('invalid_response');
      const expanded = expand(value, env);
      if (/[\r\n]/.test(expanded)) fail('invalid_response');
      headers[key] = expanded;
    }
    if (custom.method === 'GET' && custom.body) fail('invalid_response');
    if (custom.method === 'POST' && custom.body) {
      body = expandBody(custom.body, env);
      if (Buffer.byteLength(body) > 65536) fail('invalid_response');
      if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
  } catch (error) {
    return unavailableBalance(error?.usageCode === 'unconfigured' ? 'unconfigured' : 'error',
      '自定义额度查询配置或环境引用不可用，未发送请求。', checkedAt, error?.usageCode === 'unconfigured' ? 'unconfigured' : 'invalid_response', true);
  }
  return query(url.href, { method: custom.method, headers, ...(body ? { body } : {}) }, checkedAt,
    data => available(custom.kind, customItems(custom, data), checkedAt, '来自用户配置的 HTTPS 查询；数值与单位按配置映射。'), options);
}
