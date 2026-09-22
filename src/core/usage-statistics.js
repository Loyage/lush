/** Project-wide, read-only usage projection. Never truncates history at the transcript window. */
import fs from 'node:fs';
import path from 'node:path';
import { check } from './types.js';

const SESSION = /_lush-task-\d+\.jsonl$/;
const MAX_LINE = 16 * 1024 * 1024;
const MAX_BUCKETS = 1500;
const CACHE_ROWS = 100000;
const cache = new Map();
const pending = new Map();
const validNumber = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const num = n => validNumber(n) ? n : 0;
const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

function timestamp(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) && Math.abs(n) <= 8.64e15 ? n : null;
}
function boundary(value, name) {
  if (value === undefined || value === null || value === '') return null;
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value), `${name} must be an ISO timestamp with timezone`);
  const n = timestamp(value);
  check(n !== null, `invalid ${name}`);
  // Date.parse normalizes February 30; calendar dates must actually exist.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(0); date.setUTCFullYear(year, month, 0);
  check(month >= 1 && month <= 12 && day >= 1 && day <= date.getUTCDate(), `invalid ${name}`);
  return n;
}
function normalize(record, model) {
  const m = record?.type === 'message' ? record.message : null;
  if (m?.role !== 'assistant') return null;
  const u = m.usage ?? {};
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const knownTokens = validNumber(u.totalTokens) || fields.some(key => validNumber(u[key]));
  return {
    at: timestamp(record.timestamp) ?? timestamp(m.timestamp),
    provider: typeof m.provider === 'string' ? m.provider.slice(0, 256) : model.provider,
    model: typeof m.model === 'string' ? m.model.slice(0, 256) : model.model,
    input: num(u.input), output: num(u.output), cache_read: num(u.cacheRead), cache_write: num(u.cacheWrite),
    // Reasoning is a subset of output; never add it to the token total again.
    tokens: validNumber(u.totalTokens) ? u.totalTokens : fields.reduce((sum, key) => sum + num(u[key]), 0),
    cost: num(u.cost?.total), unknown_cost: validNumber(u.cost?.total) ? 0 : 1,
    unknown_tokens: knownTokens ? 0 : 1,
  };
}

async function readFile(file, stat) {
  const key = signature(stat);
  const previous = cache.get(file);
  if (previous?.signature === key) {
    cache.delete(file); cache.set(file, previous);
    return previous;
  }
  const result = { signature: key, rows: [], malformed: 0, incomplete: 0 };
  let model = { provider: 'unknown', model: 'unknown' };
  let tail = '', skipping = false;
  const parse = line => {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); } catch { result.malformed++; return; }
    if (record?.type === 'model_change') {
      model = { provider: String(record.provider ?? 'unknown').slice(0, 256), model: String(record.modelId ?? 'unknown').slice(0, 256) };
    }
    const row = normalize(record, model);
    if (row) result.rows.push(row);
  };
  // Snapshot the size: a live agent can keep appending, but one request must still finish.
  if (stat.size) for await (const chunk of fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024, end: stat.size - 1 })) {
    let offset = 0;
    for (;;) {
      const newline = chunk.indexOf('\n', offset);
      const part = chunk.slice(offset, newline < 0 ? undefined : newline);
      if (!skipping) {
        if (tail.length + part.length > MAX_LINE) { tail = ''; skipping = true; result.malformed++; }
        else tail += part;
      }
      if (newline < 0) break;
      if (!skipping) parse(tail);
      tail = ''; skipping = false; offset = newline + 1;
    }
  }
  // Do not count a partially written final JSON line until the writer terminates it.
  if (tail || skipping) result.incomplete++;
  cache.delete(file);
  if (result.rows.length <= CACHE_ROWS) cache.set(file, result);
  let rows = [...cache.values()].reduce((n, value) => n + value.rows.length, 0);
  while (rows > CACHE_ROWS || cache.size > 128) {
    const oldest = cache.keys().next().value;
    rows -= cache.get(oldest).rows.length; cache.delete(oldest);
  }
  return result;
}

async function scan(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return { files: [], codex_threads: 0, unreadable: 0 }; throw error; }
  const result = { files: [], codex_threads: names.filter(name => /^codex-task-\d+\.json$/.test(name)).length, unreadable: 0 };
  const live = new Set(names.filter(name => SESSION.test(name)).map(name => path.join(dir, name)));
  for (const file of cache.keys()) if (path.dirname(file) === dir && !live.has(file)) cache.delete(file);
  for (const file of [...live].sort()) {
    try {
      const stat = await fs.promises.lstat(file);
      // Do not follow session symlinks into another project or the global agent history.
      if (!stat.isFile()) { result.unreadable++; continue; }
      result.files.push(await readFile(file, stat));
    } catch { result.unreadable++; }
  }
  return result;
}

const empty = () => ({ requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0, unknown_cost: 0, unknown_tokens: 0 });
function add(total, row) {
  total.requests++;
  for (const key of Object.keys(total)) if (key !== 'requests') total[key] += row[key];
}
function floor(at, interval) {
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  if (interval !== 'hour') d.setUTCHours(0);
  if (interval === 'month') d.setUTCDate(1);
  return d.getTime();
}
function next(at, interval) {
  if (interval === 'hour') return at + 3600000;
  if (interval === 'day') return at + 86400000;
  const d = new Date(at); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime();
}
function bucketStarts(start, end, interval) {
  const out = [];
  for (let at = floor(start, interval); at < end && out.length <= MAX_BUCKETS; at = next(at, interval)) out.push(at);
  return out;
}

export async function readUsageStatistics(config, options = {}) {
  const start = boundary(options.start, 'start');
  const generated = Date.now();
  // Explicit ranges are half-open; the default includes records written in this same millisecond.
  const end = boundary(options.end, 'end') ?? generated + 1;
  check(start === null || start < end, 'start must be before end');
  const requested = options.interval ?? 'auto';
  check(['auto', 'hour', 'day', 'month'].includes(requested), 'interval must be auto, hour, day or month');
  // Reject absurd explicit ranges before opening any sessions.
  if (start !== null && requested !== 'auto') check(bucketStarts(start, end, requested).length <= MAX_BUCKETS, 'too many time buckets (max 1500); choose a coarser interval or shorter range');
  const dir = path.join(config.home, 'sessions');
  if (!pending.has(dir)) pending.set(dir, scan(dir).finally(() => pending.delete(dir)));
  const source = await pending.get(dir);
  const totals = empty(), models = new Map();
  const coverage = { files: source.files.length, unreadable_files: source.unreadable, malformed_lines: 0, incomplete_files: 0,
    undated_requests: 0, codex_threads: source.codex_threads };
  const unbounded = start === null && (options.end === undefined || options.end === null || options.end === '');
  const included = row => row.at === null ? unbounded : (start === null || row.at >= start) && row.at < end;
  let first = null;
  for (const file of source.files) {
    coverage.malformed_lines += file.malformed; coverage.incomplete_files += file.incomplete;
    for (const row of file.rows) {
      if (row.at === null) coverage.undated_requests++;
      if (!included(row)) continue;
      if (row.at !== null && (first === null || row.at < first)) first = row.at;
      add(totals, row);
      const key = JSON.stringify([row.provider, row.model]);
      if (!models.has(key)) models.set(key, { provider: row.provider, model: row.model, ...empty() });
      const group = models.get(key);
      group.requests++;
      for (const field of Object.keys(totals)) if (field !== 'requests') group[field] += row[field];
    }
  }
  const rangeStart = start ?? first;
  let interval = requested;
  if (interval === 'auto') {
    const span = rangeStart === null ? 0 : end - rangeStart;
    interval = span <= 2 * 86400000 ? 'hour' : span <= 120 * 86400000 ? 'day' : 'month';
  }
  const starts = rangeStart === null ? [] : bucketStarts(rangeStart, end, interval);
  check(starts.length <= MAX_BUCKETS, 'too many time buckets (max 1500); choose a coarser interval or shorter range');
  const buckets = new Map(starts.map(at => [at, { start: new Date(at).toISOString(), end: new Date(next(at, interval)).toISOString(), ...empty() }]));
  for (const file of source.files) for (const row of file.rows) {
    if (row.at === null || !included(row)) continue;
    const bucket = buckets.get(floor(row.at, interval));
    if (bucket) {
      bucket.requests++;
      for (const field of Object.keys(totals)) if (field !== 'requests') bucket[field] += row[field];
    }
  }
  return { project: config.project, currency: 'USD', estimated: true, timezone: 'UTC', generated_at: new Date(generated).toISOString(),
    range: { start: rangeStart === null ? null : new Date(rangeStart).toISOString(), end: new Date(end).toISOString() },
    interval, totals, buckets: [...buckets.values()], models: [...models.values()].sort((a, b) => b.cost - a.cost || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)), coverage };
}
