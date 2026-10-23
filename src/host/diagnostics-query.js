import { check } from '../core/types.js';
import { diagnosticsQuery, diagnosticsRequest, emptyDiagnosticQuery, finishDiagnosticQuery, diagnosticTotals,
  addDiagnosticTotals, DIAGNOSTIC_TOTALS, DIAGNOSTIC_COUNTS, DIAGNOSTICS_LIMITS, diagnosticNumber, diagnosticText } from '../core/diagnostics-query.js';
import { normalizeConnectionObservation, validConnectionHash, validConnectionId, connectionErrorCode } from '../persistence/store/agent-connections.js';

const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const signed = n => n === null || typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER;
const identity = value => value === null || diagnosticText(value);
function totals(row) {
  check(row && DIAGNOSTIC_TOTALS.every(key => diagnosticNumber(row[key])) && DIAGNOSTIC_COUNTS.every(key => Number.isSafeInteger(row[key]))
    && ['response_samples','text_samples','wait_samples','ttft_samples'].every(key => row[key] <= row.requests), 'invalid diagnostics totals');
  return Object.fromEntries(DIAGNOSTIC_TOTALS.map(key => [key, row[key]]));
}
function quotaView(raw) {
  check(raw && Array.isArray(raw.series) && raw.series.length <= DIAGNOSTICS_LIMITS.series && Array.isArray(raw.current) && raw.current.length <= 50, 'invalid diagnostics quota');
  const series = raw.series.map(row => {
    check(validConnectionHash(row.id) && validConnectionId(row.connection_id) && validConnectionHash(row.account_key) && validConnectionHash(row.source_key)
      && diagnosticText(row.provider, 80) && identity(row.label) && identity(row.unit) && ['balance','quota',null].includes(row.kind)
      && ['account','key','model'].includes(row.scope) && (row.window_seconds === null || diagnosticNumber(row.window_seconds))
      && Array.isArray(row.models) && row.models.length <= 50 && row.models.every(model => diagnosticText(model))
      && diagnosticNumber(row.sample_count) && typeof row.sample_count_lower_bound === 'boolean' && typeof row.sampled === 'boolean' && Array.isArray(row.points) && row.points.length <= DIAGNOSTICS_LIMITS.points, 'invalid diagnostics quota series');
    const points = row.points.map(point => {
      check(time(point.at) && (point.reset_at === null || time(point.reset_at)) && typeof point.reset === 'boolean'
        && ['available','partial','unknown','error','unsupported','unconfigured'].includes(point.status)
        && ['usage_api','client_rpc','response_headers','none'].includes(point.source)
        && ['remaining','total','used','used_percent','remaining_change'].every(key => signed(point[key])), 'invalid diagnostics quota point');
      return { at: point.at, reset_at: point.reset_at, reset: point.reset, status: point.status, source: point.source, error_code: connectionErrorCode(point.error_code),
        ...Object.fromEntries(['remaining','total','used','used_percent','remaining_change'].map(key => [key, point[key]])) };
    });
    return { ...Object.fromEntries(['id','connection_id','provider','account_key','source_key','kind','scope','label','unit','window_seconds','sample_count','sample_count_lower_bound','sampled'].map(key => [key,row[key]])),
      models: [...row.models], points };
  });
  const current = raw.current.map(row => {
    check(validConnectionId(row.connection_id) && diagnosticText(row.label, 256), 'invalid diagnostics current quota');
    return { connection_id: row.connection_id, label: row.label, observation: normalizeConnectionObservation(row.observation),
      last_success: row.last_success && time(row.last_success.checked_at) ? { checked_at: row.last_success.checked_at,
        observation: normalizeConnectionObservation(row.last_success.observation) } : null };
  });
  return { series, current, truncated: raw.truncated === true, current_status: raw.current_status === 'available' ? 'available' : 'unavailable' };
}

/** Strict projection of project-owned facts. No raw errors, paths, credentials or arbitrary extra fields. */
export function diagnosticQueryView(raw, range, now = Date.now()) {
  check(raw?.version === 1 && time(raw.generated_at) && Math.abs(now - Date.parse(raw.generated_at)) <= 15000
    && ['from','to','bucket_ms','connection_id','model'].every(key => raw.range?.[key] === range[key]), 'invalid diagnostics range');
  const result = emptyDiagnosticQuery(range, now);
  check(Array.isArray(raw.buckets) && raw.buckets.length === result.buckets.length && Array.isArray(raw.groups)
    && raw.groups.length <= DIAGNOSTICS_LIMITS.groups, 'invalid diagnostics groups');
  result.summary = totals(raw.summary);
  result.buckets = result.buckets.map((row, index) => {
    check(raw.buckets[index]?.at === row.at, 'invalid diagnostics bucket'); return { at: row.at, ...totals(raw.buckets[index]) };
  });
  const sum = diagnosticTotals(); for (const bucket of result.buckets) addDiagnosticTotals(sum, bucket);
  check(DIAGNOSTIC_TOTALS.every(key => Math.abs(sum[key] - result.summary[key]) <= Math.max(1e-7, sum[key] * 1e-12)), 'inconsistent diagnostics summary');
  const seen = new Set();
  result.groups = raw.groups.map(row => {
    const key = JSON.stringify([row.connection_id,row.model]);
    check(identity(row.connection_id) && identity(row.model) && !seen.has(key), 'invalid diagnostics group'); seen.add(key);
    return { connection_id: row.connection_id, model: row.model, ...totals(row) };
  });
  const coverage = raw.coverage;
  check(coverage && ['samples','runs','unknown_runs','dropped_samples'].every(key => Number.isSafeInteger(coverage[key]) && diagnosticNumber(coverage[key]))
    && typeof coverage.complete === 'boolean' && typeof coverage.usage_complete === 'boolean' && typeof coverage.truncated === 'boolean', 'invalid diagnostics coverage');
  result.coverage = Object.fromEntries(['samples','runs','unknown_runs','dropped_samples','complete','usage_complete','truncated'].map(key => [key,coverage[key]]));
  result.coverage.legacy_backfill = false;
  Object.assign(result.quota, quotaView(raw.quota));
  return result;
}

export class HostDiagnosticQuery {
  constructor(sources, { timeoutMs = 1500, budgetMs = 6000, concurrency = 4 } = {}) {
    Object.assign(this, { sources, timeoutMs, budgetMs, concurrency }); this.active = 0;
  }
  async read(params = {}, signal = null) {
    check(this.active < 4, 'diagnostics query busy'); this.active++;
    try { return await this.collect(params, signal); } finally { this.active--; }
  }
  async collect(params, signal) {
    const now = Date.now(), range = diagnosticsQuery(params, now, true), result = emptyDiagnosticQuery(range, now);
    const all = this.sources();
    check(!range.project_id || all.some(row => row.id === range.project_id), 'unknown diagnostics project');
    const selected = all.filter(row => !range.project_id || row.id === range.project_id), sources = selected.slice(0, DIAGNOSTICS_LIMITS.projects);
    const reports = new Array(sources.length), projects = new Array(sources.length), deadline = Date.now() + this.budgetMs;
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(this.concurrency, sources.length) }, async () => {
      for (;;) {
        const index = cursor++; if (index >= sources.length) return;
        const source = sources[index], project = { id: source.id, name: source.name, state: 'unavailable', generated_at: null };
        projects[index] = project;
        if (signal?.aborted || Date.now() >= deadline) { project.error = 'diagnostics_budget_exhausted'; continue; }
        const controller = new AbortController(); let timer, abort;
        try {
          const raw = await Promise.race([source.query(diagnosticsRequest(range), controller.signal), new Promise((_, reject) => {
            abort = () => { controller.abort(); reject(new Error('cancelled')); };
            signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(abort, Math.min(this.timeoutMs, Math.max(1, deadline - Date.now())));
            if (signal?.aborted) abort();
          })]);
          if (raw === null) { project.state = 'offline'; continue; }
          reports[index] = diagnosticQueryView(raw, range);
          project.state = 'online'; project.generated_at = raw.generated_at;
        } catch (error) {
          project.state = error.code === -32601 ? 'unsupported' : 'unavailable'; project.error = 'diagnostics_unavailable';
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
      }
    }));
    const live = new Set(this.sources().map(row => row.id)), groups = new Map();
    let reporting = 0, complete = sources.length > 0 && selected.length === sources.length;
    result.quota.current_status = 'available';
    for (let index = 0; index < projects.length; index++) {
      const project = projects[index], report = reports[index];
      // A removed/unauthorized registration is never returned from an in-flight read.
      if (!live.has(project.id)) { complete = false; continue; }
      result.projects.push(project);
      if (!report) { complete = false; continue; }
      // Reject numeric overflow atomically before touching the aggregate.
      const summary = { ...result.summary }, buckets = result.buckets.map(row => ({ ...row }));
      try { addDiagnosticTotals(summary, report.summary); buckets.forEach((row, i) => addDiagnosticTotals(row, report.buckets[i])); }
      catch { project.state = 'unavailable'; complete = false; continue; }
      result.summary = summary; result.buckets = buckets; reporting++; complete &&= report.coverage.usage_complete;
      for (const key of ['samples','runs','unknown_runs','dropped_samples']) result.coverage[key] += report.coverage[key];
      result.coverage.truncated ||= report.coverage.truncated;
      for (const group of report.groups) {
        const key = JSON.stringify([group.connection_id,group.model]);
        if (!groups.has(key) && groups.size < DIAGNOSTICS_LIMITS.groups) groups.set(key, { connection_id: group.connection_id, model: group.model, ...diagnosticTotals() });
        if (groups.has(key)) addDiagnosticTotals(groups.get(key), group); else result.coverage.truncated = true;
      }
      // Quota observations stay project-scoped; shared accounts are never summed or apportioned.
      for (const series of report.quota.series) {
        if (result.quota.series.length < DIAGNOSTICS_LIMITS.series) result.quota.series.push({ project_id: project.id, ...series });
        else result.quota.truncated = true;
      }
      for (const current of report.quota.current) {
        if (result.quota.current.length < 50) result.quota.current.push({ project_id: project.id, ...current }); else result.quota.truncated = true;
      }
      result.quota.truncated ||= report.quota.truncated;
      if (report.quota.current_status !== 'available') result.quota.current_status = 'partial';
    }
    result.groups = [...groups.values()];
    if (!reporting) result.quota.current_status = 'unavailable';
    else if (reporting < selected.length) result.quota.current_status = 'partial';
    result.coverage.truncated ||= selected.length > sources.length;
    Object.assign(result.coverage, { projects_total: selected.length, projects_reporting: reporting,
      complete: complete && reporting === sources.length && !result.coverage.truncated });
    finishDiagnosticQuery(result);
    while (Buffer.byteLength(JSON.stringify(result)) > 850000 && result.quota.series.length) { result.quota.series.pop(); result.quota.truncated = true; }
    while (Buffer.byteLength(JSON.stringify(result)) > 850000 && result.quota.current.length) { result.quota.current.pop(); result.quota.truncated = true; }
    return result;
  }
}
