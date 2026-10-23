import { check, isPlainObject } from './types.js';

export const DIAGNOSTICS_PARAMS = Object.freeze(['from', 'to', 'connection_id', 'model']);
export const DIAGNOSTICS_RETENTION_MS = 30 * 86400_000;
export const DIAGNOSTICS_LIMITS = Object.freeze({ samples: 20000, runs: 4096, groups: 128, series: 24, points: 96, projects: 128 });
export const diagnosticNumber = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
export const diagnosticText = (s, max = 256) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(s);
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');

/** RPC and both HTTP surfaces share one range/filter contract. No implicit coercion. */
export function diagnosticsQuery(params = {}, now = Date.now(), host = false) {
  check(isPlainObject(params), 'invalid diagnostics query');
  check(Object.keys(params).every(key => [...DIAGNOSTICS_PARAMS, ...(host ? ['project_id'] : [])].includes(key)), 'unknown diagnostics parameter');
  for (const key of ['from','to']) if (Object.hasOwn(params, key)) check(iso(params[key]), `diagnostics ${key} must be UTC ISO time`);
  const to = params.to === undefined ? now : Date.parse(params.to), from = params.from === undefined ? to - 86400_000 : Date.parse(params.from);
  check(from < to && from >= now - DIAGNOSTICS_RETENTION_MS - 5000 && to <= now && to - from <= DIAGNOSTICS_RETENTION_MS, 'diagnostics range must be within the last 30 days');
  if (params.connection_id !== undefined) check(params.connection_id === '@unknown' || /^[a-zA-Z0-9_-]{1,128}$/.test(params.connection_id) && typeof params.connection_id === 'string', 'invalid diagnostics connection');
  if (params.model !== undefined) check(diagnosticText(params.model), 'invalid diagnostics model');
  if (params.project_id !== undefined) check(typeof params.project_id === 'string' && /^[a-f0-9]{16}$/.test(params.project_id), 'invalid diagnostics project');
  const bucket_ms = to - from <= 3600_000 ? 60_000 : to - from <= 86400_000 ? 3600_000 : to - from <= 7 * 86400_000 ? 6 * 3600_000 : 86400_000;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket_ms,
    connection_id: params.connection_id ?? null, model: params.model ?? null, ...(host ? { project_id: params.project_id ?? null } : {}) };
}
export function diagnosticsSearch(search, host = false, now = Date.now()) {
  const params = {};
  for (const [key, value] of search) {
    check([...DIAGNOSTICS_PARAMS, ...(host ? ['project_id'] : [])].includes(key), 'unknown diagnostics parameter');
    check(!Object.hasOwn(params, key), 'duplicate diagnostics parameter'); params[key] = value;
  }
  diagnosticsQuery(params, now, host);
  return params;
}
export function diagnosticsRequest(range) {
  return Object.fromEntries(DIAGNOSTICS_PARAMS.filter(key => range[key] !== null).map(key => [key, range[key]]));
}
export const matchesDiagnostic = (row, range) => (!range.connection_id || (row.connection_id ?? '@unknown') === range.connection_id)
  && (!range.model || (row.model ?? '@unknown') === range.model);

export const DIAGNOSTIC_TOTALS = Object.freeze(['requests','input_tokens','output_tokens','estimated_cost_usd', 'unknown_usage','unknown_cost',
  'text_samples','text_chars','text_ms','response_samples','response_tokens','response_ms','wait_samples','wait_ms','ttft_samples','ttft_ms']);
export const DIAGNOSTIC_COUNTS = Object.freeze(DIAGNOSTIC_TOTALS.filter(key => !['estimated_cost_usd','text_ms','response_ms','wait_ms','ttft_ms'].includes(key)));
export const diagnosticTotals = () => Object.fromEntries(DIAGNOSTIC_TOTALS.map(key => [key, 0]));
export function addDiagnosticTotals(to, row) {
  for (const key of DIAGNOSTIC_TOTALS) {
    check(diagnosticNumber(row[key]) && diagnosticNumber(to[key] + row[key]), 'invalid diagnostics totals'); to[key] += row[key];
  }
  return to;
}
export function diagnosticRates(row, duration) {
  return { ...row, input_per_second: row.input_tokens * 1000 / duration, output_per_second: row.output_tokens * 1000 / duration,
    text_chars_per_second: row.text_ms > 0 ? row.text_chars * 1000 / row.text_ms : null,
    response_tokens_per_second: row.response_ms > 0 ? row.response_tokens * 1000 / row.response_ms : null,
    wait_mean_ms: row.wait_samples ? row.wait_ms / row.wait_samples : null, ttft_mean_ms: row.ttft_samples ? row.ttft_ms / row.ttft_samples : null };
}
export function sampleTotals(sample) {
  const row = diagnosticTotals(); row.requests = 1;
  for (const key of ['input_tokens', 'output_tokens', 'estimated_cost_usd']) row[key] = sample[key] ?? 0;
  row.unknown_usage = Number(sample.input_tokens === null || sample.output_tokens === null);
  row.unknown_cost = Number(sample.estimated_cost_usd === null);
  if (sample.text_ms > 0 && sample.text_chars > 0) { row.text_samples = 1; row.text_ms = sample.text_ms; row.text_chars = sample.text_chars; }
  if (sample.response_ms > 0 && sample.output_tokens !== null) { row.response_samples = 1; row.response_ms = sample.response_ms; row.response_tokens = sample.output_tokens; }
  for (const key of ['wait','ttft']) if (sample[`${key}_ms`] !== null) { row[`${key}_samples`] = 1; row[`${key}_ms`] = sample[`${key}_ms`]; }
  return row;
}
export function emptyDiagnosticQuery(range, now = Date.now()) {
  const start = Date.parse(range.from), end = Date.parse(range.to), first = Math.floor(start / range.bucket_ms) * range.bucket_ms;
  return { version: 1, generated_at: new Date(now).toISOString(), range, retention_days: 30,
    summary: diagnosticTotals(), buckets: Array.from({ length: Math.ceil((end - first) / range.bucket_ms) }, (_, index) => ({
      at: new Date(first + index * range.bucket_ms).toISOString(), ...diagnosticTotals() })), groups: [],
    quota: { series: [], current: [], truncated: false, attribution: 'observed_change_not_lush_consumption', model_filter_applied: false },
    coverage: { complete: false, samples: 0, runs: 0, unknown_runs: 0, dropped_samples: 0, truncated: false, legacy_backfill: false }, projects: [] };
}
export function finishDiagnosticQuery(result) {
  result.coverage.usage_complete = result.coverage.complete;
  result.coverage.response_samples = result.summary.response_samples;
  result.coverage.text_samples = result.summary.text_samples;
  result.coverage.response_coverage = result.summary.requests ? result.summary.response_samples / result.summary.requests : null;
  result.coverage.text_coverage = result.summary.requests ? result.summary.text_samples / result.summary.requests : null;
  result.coverage.complete &&= result.summary.response_samples === result.summary.requests;
  const start = Date.parse(result.range.from), end = Date.parse(result.range.to);
  result.summary = diagnosticRates(result.summary, end - start);
  result.buckets = result.buckets.map(row => diagnosticRates(row, Math.min(end, Date.parse(row.at) + result.range.bucket_ms) - Math.max(start, Date.parse(row.at))));
  result.groups = result.groups.sort((a, b) => b.requests - a.requests || JSON.stringify([a.connection_id,a.model]).localeCompare(JSON.stringify([b.connection_id,b.model])))
    .map(row => diagnosticRates(row, end - start));
  return result;
}

/** Every persisted sample is reconstructed, never spread from a provider object. */
export function diagnosticSample(raw) {
  check(isPlainObject(raw) && iso(raw.at) && (raw.model === null || diagnosticText(raw.model)), 'invalid diagnostics sample');
  const result = { at: new Date(raw.at).toISOString(), model: raw.model, status: ['ok','error','aborted'].includes(raw.status) ? raw.status : 'error' };
  for (const key of ['input_tokens','output_tokens','estimated_cost_usd','response_ms','text_chars','text_ms','wait_ms','ttft_ms']) {
    check(raw[key] === null || diagnosticNumber(raw[key]) && (!['input_tokens','output_tokens','text_chars'].includes(key) || Number.isSafeInteger(raw[key])), 'invalid diagnostics sample metric'); result[key] = raw[key];
  }
  if (result.response_ms !== null) check(result.response_ms <= 86400_000, 'invalid diagnostics duration');
  for (const key of ['text_ms','wait_ms','ttft_ms']) if (result[key] !== null) check(result.response_ms !== null && result[key] <= result.response_ms, 'invalid diagnostics duration');
  return result;
}
