// Protocol parsing adapted from audited MIT sources, not their rendering/probe code.
// Pinned sources and licenses: docs/third-party/agent-connections.md.
import { DEFAULT_ENDPOINTS, object, fail, unavailable, safeCode } from './connections-utils.js';

const ENDPOINTS = Object.freeze({
  deepseek: 'https://api.deepseek.com/user/balance',
  openrouter: 'https://openrouter.ai/api/v1/key',
  zai: 'https://api.z.ai/api/monitor/usage/quota/limit',
  'kimi-coding': 'https://api.kimi.com/coding/v1/usages',
  'openai-codex': 'https://chatgpt.com/backend-api/wham/usage',
});
const number = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const integer = value => Number.isSafeInteger(value) && value > 0 && value <= 315360000 ? value : null;
const percent = value => { const n = number(value); return n !== null && n >= 0 && n <= 100 ? n : null; };
const finite = value => Number.isFinite(value) ? value : null;
const resource = (id, kind, scope, label, unit, values = {}) => ({ id, kind, scope, label, unit,
  remaining: null, total: null, used: null, used_percent: null, reset_at: null, window_seconds: null, models: [], ...values });
function iso(value, milliseconds = false) {
  if (typeof value === 'number' && value > 0 && Number.isFinite(value)) {
    const date = new Date(value * (milliseconds ? 1 : 1000));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
const usable = rows => rows.filter(row => [row.remaining,row.total,row.used,row.used_percent].some(n => n !== null));
function observation(resources, checked_at, status = 'available', reason = null, error_code = null) {
  const valid = usable(resources); if (!valid.length) fail('invalid_response');
  return { status, checked_at, source: 'usage_api', resources: valid, error_code, reason };
}
function quotaWindow(id, label, window, checked_at, scope = 'account') {
  if (!object(window)) return null;
  const used = percent(window.used_percent), duration = integer(window.limit_window_seconds);
  const after = number(window.reset_after_seconds);
  const reset_at = iso(window.reset_at) || (after !== null && after >= 0
    ? iso(Date.parse(checked_at) / 1000 + after) : null);
  return resource(id, 'quota', scope, label, '%', { used, used_percent: used,
    remaining: used === null ? null : 100 - used, total: used === null ? null : 100,
    reset_at, window_seconds: duration });
}
function bucket(id, label, raw, seconds = null) {
  let used = number(raw?.used), total = number(raw?.limit), remaining = number(raw?.remaining);
  if (total === null && used !== null && remaining !== null) total = finite(used + remaining);
  if (remaining === null && used !== null && total !== null) remaining = finite(total - used);
  return resource(id, 'quota', 'account', label, '额度单位', { used, total, remaining,
    reset_at: iso(raw?.resetTime), window_seconds: integer(seconds) });
}

// Adapted from @mtrojnar/pi-usage: budget numerator is NOT lifetime data.usage.
export function openRouterResetAt(period, checked_at) {
  const date = new Date(checked_at); date.setUTCHours(0, 0, 0, 0);
  if (period === 'daily') date.setUTCDate(date.getUTCDate() + 1);
  else if (period === 'weekly') date.setUTCDate(date.getUTCDate() + 7 - (date.getUTCDay() + 6) % 7);
  else if (period === 'monthly') date.setUTCMonth(date.getUTCMonth() + 1, 1);
  else return null;
  return date.toISOString();
}
export function parseOpenRouterKey(data, checked_at) {
  const raw = data?.data; if (!object(raw)) fail('invalid_response');
  const total = number(raw.limit), remaining = number(raw.limit_remaining);
  const resources = [];
  if (total !== null && total >= 0) resources.push(resource('key-budget', 'quota', 'key', 'Key 消费预算（非账户余额）', 'USD', {
    total, remaining, used: remaining !== null ? finite(total - remaining) : null,
    reset_at: openRouterResetAt(raw.limit_reset, checked_at) }));
  const daily = number(raw.usage_daily), lifetime = number(raw.usage);
  if (daily !== null) resources.push(resource('key-daily-spend', 'quota', 'key', 'Key 当日消费（非剩余额度）', 'USD', {
    used: daily, reset_at: openRouterResetAt('daily', checked_at), window_seconds: 86400 }));
  if (lifetime !== null) resources.push(resource('key-lifetime-spend', 'quota', 'key', 'Key 累计消费（非剩余额度）', 'USD', { used: lifetime }));
  if (!resources.length) fail('invalid_response');
  return resources;
}
export function parseOpenRouterCredits(data) {
  const raw = data?.data, total = number(raw?.total_credits), used = number(raw?.total_usage);
  if (!object(raw) || total === null || used === null || !Number.isFinite(total - used)) fail('invalid_response');
  return resource('account-credits', 'balance', 'account', '账户余额（跨 Key 共享）', 'USD', { remaining: total - used });
}
function parse(provider, data, checked_at) {
  if (!object(data)) fail('invalid_response');
  if (provider === 'deepseek') {
    if (!Array.isArray(data.balance_infos) || data.balance_infos.length > 10) fail('invalid_response');
    const seen = new Set();
    const resources = data.balance_infos.map(raw => {
      const remaining = number(raw?.total_balance), currency = raw?.currency;
      if (remaining === null || !/^[A-Z]{3}$/.test(currency || '') || seen.has(currency)) fail('invalid_response');
      seen.add(currency);
      return resource(`balance-${currency}`, 'balance', 'account', '账户余额', currency, { remaining });
    });
    return observation(resources, checked_at);
  }
  if (provider === 'openai-codex') {
    const rate = data.rate_limit, resources = [];
    for (const [id,label] of [['primary','主要套餐窗口'],['secondary','次要套餐窗口']]) {
      const window = quotaWindow(id, label, rate?.[`${id}_window`], checked_at);
      if (window) resources.push(window);
    }
    const additional = data.additional_rate_limits ?? rate?.additional_rate_limits;
    if (Array.isArray(additional)) for (const [index, entry] of additional.slice(0, 8).entries()) {
      for (const [id,label] of [['primary','主要'],['secondary','次要']]) {
        const window = quotaWindow(`model-${index}-${id}`, `模型专属限制 ${index + 1} · ${label}`,
          (entry.rate_limit ?? entry)?.[`${id}_window`], checked_at, 'model');
        if (window) resources.push(window);
      }
    }
    const balance = number(data.credits?.balance);
    if (balance !== null) resources.push(resource('extra-credits', 'quota', 'account', '额外使用点数（非现金）', 'credits', { remaining: balance }));
    const valid = usable(resources);
    return observation(resources, checked_at, valid.length < resources.length ? 'partial' : 'available',
      '来自 ChatGPT 网页后端兼容接口（非稳定公开 API）；百分比不是绝对 token、请求数或现金余额。');
  }
  if (provider === 'kimi-coding') {
    const resources = [bucket('membership', '会员套餐额度', data.usage)];
    if (Array.isArray(data.limits)) for (const [index, raw] of data.limits.slice(0, 9).entries()) {
      // Interpret only an explicitly supplied unit; never assume five-hour or weekly windows.
      const units = { TIME_UNIT_SECOND: 1, SECOND: 1, TIME_UNIT_MINUTE: 60, MINUTE: 60,
        TIME_UNIT_HOUR: 3600, HOUR: 3600, TIME_UNIT_DAY: 86400, DAY: 86400 };
      const multiplier = units[raw?.window?.timeUnit];
      const seconds = multiplier && integer(raw?.window?.duration)
        ? integer(raw.window.duration * multiplier) : integer(raw?.window_seconds);
      resources.push(bucket(`rolling-${index}`, '滚动窗口额度', raw?.detail, seconds));
    }
    return observation(resources, checked_at, usable(resources).length < resources.length ? 'partial' : 'available',
      '沿用服务商额度单位；未公开窗口时长时不推测每日或每周额度。');
  }
  if (provider === 'zai') {
    const limits = data?.data?.limits ?? data.limits ?? data?.quota?.limits ?? data?.data?.quota?.limits;
    if (!Array.isArray(limits) || !limits.length || limits.length > 10) fail('invalid_response');
    const resources = limits.map((raw,index) => {
      const used_percent = percent(raw?.percentage ?? raw?.used_percent);
      const absoluteUsed = number(raw?.currentValue), absoluteTotal = number(raw?.total ?? raw?.usage), absoluteRemaining = number(raw?.remaining);
      const absolute = [absoluteUsed,absoluteTotal,absoluteRemaining].some(n => n !== null);
      let used = absolute ? absoluteUsed : used_percent, total = absolute ? absoluteTotal : used_percent === null ? null : 100;
      let remaining = absolute ? absoluteRemaining : used_percent === null ? null : 100 - used_percent;
      if (total === null && used !== null && remaining !== null) total = finite(used + remaining);
      if (remaining === null && total !== null && used !== null) remaining = finite(total - used);
      const known = ['TIME_LIMIT','TOKENS_LIMIT','TOKEN_LIMIT','CREDIT_LIMIT','SESSION_LIMIT','WEEKLY_LIMIT','WEEK_LIMIT','REQUEST_LIMIT','DAILY_LIMIT'].includes(raw?.type);
      const reportedUnit = Number.isInteger(raw?.unit) && raw.unit >= 1 && raw.unit <= 6 ? raw.unit : null;
      const reportedCount = integer(raw?.number);
      const suffix = known ? `${raw.type.toLowerCase()}${reportedUnit && reportedCount ? `-${reportedUnit}-${reportedCount}` : ''}` : String(index);
      // Unit/number protocol adapted from pi-usage-meters. Calendar months have no fixed duration.
      const units = { 1: 1, 2: 60, 3: 3600, 4: 86400, 5: 604800 };
      const explicitWindow = units[raw?.unit] && integer(raw?.number) ? integer(units[raw.unit] * raw.number) : null;
      return resource(`limit-${suffix}`, 'quota', 'account', `套餐限制 ${index + 1}`, absolute ? '额度单位' : '%', {
        used, total, remaining, used_percent, reset_at: iso(raw?.nextResetTime, true) || iso(raw?.reset_at),
        window_seconds: integer(raw?.window_seconds) || explicitWindow });
    });
    if (new Set(resources.map(row => row.id)).size !== resources.length) fail('invalid_response');
    return observation(resources, checked_at, usable(resources).length < resources.length ? 'partial' : 'available',
      '各套餐限制独立展示；未知窗口不推测为每日或每周。');
  }
  fail('unsupported');
}

export async function queryConnection(connection, credential, checked_at, request) {
  if (new URL(connection.endpoint).origin !== new URL(DEFAULT_ENDPOINTS[connection.provider]).origin)
    return unavailable('unsupported', checked_at, 'unsupported');
  const token = credential.type === 'oauth' ? credential.access : credential.key;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (credential.type === 'oauth' && credential.accountId) headers['ChatGPT-Account-Id'] = credential.accountId;
  const get = url => request(url, { method: 'GET', headers });
  try {
    if (connection.provider === 'openrouter') {
      const [key, credits] = await Promise.allSettled([
        get(ENDPOINTS.openrouter).then(data => parseOpenRouterKey(data, checked_at)),
        get('https://openrouter.ai/api/v1/credits').then(parseOpenRouterCredits),
      ]);
      const resources = [...(key.status === 'fulfilled' ? key.value : []), ...(credits.status === 'fulfilled' ? [credits.value] : [])];
      if (!resources.length) throw key.status === 'rejected' ? key.reason : credits.reason;
      const partial = key.status !== 'fulfilled' || credits.status !== 'fulfilled';
      return observation(resources, checked_at, partial ? 'partial' : 'available',
        partial ? '部分指标未取得：账户余额可能需要额外管理权限；已取得指标仍可用。' : 'Key 消费预算与跨 Key 共享账户余额独立展示。',
        partial ? safeCode(key.status === 'rejected' ? key.reason : credits.reason) : null);
    }
    return parse(connection.provider, await get(ENDPOINTS[connection.provider]), checked_at);
  } catch (error) { return unavailable('error', checked_at, safeCode(error), 'usage_api'); }
}
