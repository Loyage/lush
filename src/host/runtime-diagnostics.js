import { diagnosticsNumber, diagnosticsTime, emptyDiagnostics } from '../core/runtime-diagnostics.js';

const FIELDS = ['input','output','cost','unknown_tokens','unknown_cost'];
const COUNTS = ['requests','unknown_tokens','unknown_cost'];
const safeRow = row => row && FIELDS.every(key => diagnosticsNumber(row[key]))
  && ['unknown_tokens','unknown_cost'].every(key => Number.isSafeInteger(row[key]));

/** Strict display whitelist. Old/malformed/stale source responses cannot become complete zeros. */
export function diagnosticsView(value, now) {
  const at = diagnosticsTime(value?.generated_at);
  if (value?.version !== 1 || value.currency !== 'USD' || value.estimated !== true || at === null
    || now - at > 15_000 || at > now + 5000 || typeof value.coverage?.complete !== 'boolean'
    || !Array.isArray(value.windows) || value.windows.length !== 2 || !Array.isArray(value.buckets) || value.buckets.length !== 60) return null;
  const expected = emptyDiagnostics(at), windows = [];
  for (const seconds of [60, 300]) {
    const row = value.windows.find(w => w?.seconds === seconds);
    if (!safeRow(row) || !COUNTS.every(key => Number.isSafeInteger(row[key]) && diagnosticsNumber(row[key]))
      || !['input_per_second','output_per_second','cost_per_minute'].every(key => diagnosticsNumber(row[key]))
      || typeof row.complete !== 'boolean'
      || Math.abs(row.input_per_second - row.input / seconds) > 1e-8
      || Math.abs(row.output_per_second - row.output / seconds) > 1e-8
      || Math.abs(row.cost_per_minute - row.cost * 60 / seconds) > 1e-8
      || row.complete && (row.unknown_tokens || row.unknown_cost)) return null;
    windows.push(Object.fromEntries(['seconds', ...FIELDS, 'requests','input_per_second','output_per_second','cost_per_minute','complete'].map(key => [key, row[key]])));
  }
  const buckets = [];
  for (let i = 0; i < 60; i++) {
    const row = value.buckets[i];
    if (!safeRow(row) || row.at !== expected.buckets[i].at) return null;
    buckets.push({ at: row.at, ...Object.fromEntries(FIELDS.map(key => [key, row[key]])) });
  }
  if (value.coverage.complete && (windows.some(w => !w.complete) || buckets.some(b => b.unknown_tokens || b.unknown_cost))) return null;
  return { ...expected, windows, buckets, coverage: { complete: value.coverage.complete } };
}

export class HostRuntimeDiagnostics {
  constructor(sources, { now = Date.now, timeoutMs = 1500, budgetMs = 5000, concurrency = 4, throttleMs = 2000 } = {}) {
    Object.assign(this, { sources, now, timeoutMs, budgetMs, concurrency, throttleMs });
    this.pending = null; this.cached = null; this.key = null;
  }
  async read() {
    const sources = this.sources(), key = JSON.stringify(sources.map(row => row.id));
    if (this.pending) {
      await this.pending;
      const currentKey = JSON.stringify(this.sources().map(row => row.id));
      return this.key === currentKey ? structuredClone(this.cached) : this.read();
    }
    if (this.key === key && this.cached && this.now() - Date.parse(this.cached.generated_at) < this.throttleMs) return structuredClone(this.cached);
    this.pending = this.collect(sources).then(result => { this.key = key; this.cached = result; return result; }).finally(() => { this.pending = null; });
    const result = await this.pending;
    // Registration/permission can change while sockets are being sampled; never return removed sources.
    return JSON.stringify(this.sources().map(row => row.id)) === key ? structuredClone(result) : this.read();
  }
  async collect(sources) {
    const now = this.now(), result = emptyDiagnostics(now), deadline = Date.now() + this.budgetMs;
    const projects = new Array(sources.length), reports = new Array(sources.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(this.concurrency, sources.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= sources.length) return;
        const source = sources[index], row = { id: source.id, name: source.name, state: 'unavailable', generated_at: null };
        projects[index] = row;
        if (Date.now() >= deadline || index >= 256) { row.error = 'diagnostics_budget_exhausted'; continue; }
        const controller = new AbortController(); let timer;
        try {
          const raw = await Promise.race([
            source.read(controller.signal),
            new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, Math.min(this.timeoutMs, deadline - Date.now())); }),
          ]);
          if (raw === null) { row.state = 'offline'; continue; }
          const view = diagnosticsView(raw, this.now());
          if (!view) { row.error = 'invalid_or_stale_diagnostics'; continue; }
          row.state = 'online'; row.generated_at = view.generated_at; reports[index] = view;
        } catch (error) {
          row.state = error.code === -32601 ? 'unsupported' : 'unavailable';
          row.error = row.state === 'unsupported' ? 'diagnostics_unsupported' : 'diagnostics_unavailable';
        } finally { clearTimeout(timer); controller.abort(); }
      }
    }));
    let reporting = 0;
    for (let i = 0; i < reports.length; i++) {
      const report = reports[i];
      if (!report) continue;
      // Reject the entire source on numeric overflow, rather than emitting Infinity or partial sums.
      const candidate = structuredClone(result);
      for (let w = 0; w < 2; w++) for (const key of [...FIELDS, 'requests']) candidate.windows[w][key] += report.windows[w][key];
      const byAt = new Map(report.buckets.map(bucket => [bucket.at, bucket]));
      for (const bucket of candidate.buckets) {
        const observed = byAt.get(bucket.at);
        if (!observed) { bucket.unknown_tokens++; bucket.unknown_cost++; }
        else for (const key of FIELDS) bucket[key] += observed[key];
      }
      if ([...candidate.windows, ...candidate.buckets].some(row => !safeRow(row) || row.requests != null && !diagnosticsNumber(row.requests))) {
        projects[i].state = 'unavailable'; projects[i].generated_at = null; projects[i].error = 'invalid_diagnostics_totals'; reports[i] = null; continue;
      }
      result.windows = candidate.windows; result.buckets = candidate.buckets; reporting++;
    }
    const complete = sources.length > 0 && reporting === sources.length && reports.every(report => report?.coverage.complete)
      && result.buckets.every(bucket => !bucket.unknown_tokens && !bucket.unknown_cost);
    for (const window of result.windows) {
      // Missing projects are explicit unknown contributors, not fabricated expenditure.
      window.unknown_tokens += sources.length - reporting; window.unknown_cost += sources.length - reporting;
      window.input_per_second = window.input / window.seconds;
      window.output_per_second = window.output / window.seconds;
      window.cost_per_minute = window.cost * 60 / window.seconds;
      window.complete = complete && !window.unknown_tokens && !window.unknown_cost;
    }
    for (const bucket of result.buckets) { bucket.unknown_tokens += sources.length - reporting; bucket.unknown_cost += sources.length - reporting; }
    result.coverage = { projects_total: sources.length, projects_online: projects.filter(p => ['online','unsupported'].includes(p.state)).length,
      projects_reporting: reporting, complete };
    result.projects = projects;
    return result;
  }
}
