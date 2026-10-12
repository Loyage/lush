import fs from 'node:fs';
import path from 'node:path';

const SESSION = /_lush-(?:task|manager)-(\d+)(?:-pi)?\.jsonl$/;
const HORIZON = 600_000;
export const diagnosticsNumber = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
export const diagnosticsTime = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const zero = () => ({ input: 0, output: 0, cost: 0, unknown_tokens: 0, unknown_cost: 0 });
const add = (to, row) => {
  for (const key of ['input','output','cost']) {
    const sum = to[key] + row[key];
    if (diagnosticsNumber(sum)) to[key] = sum;
    else to[key === 'cost' ? 'unknown_cost' : 'unknown_tokens']++;
  }
  to.unknown_tokens += row.unknown_tokens; to.unknown_cost += row.unknown_cost;
};

/** Fixed UTC-aligned ten-second buckets; the last bucket is sampled only up to now. */
export function emptyDiagnostics(now) {
  const last = Math.floor(now / 10_000) * 10_000;
  return { version: 1, generated_at: new Date(now).toISOString(), currency: 'USD', estimated: true,
    windows: [60, 300].map(seconds => ({ seconds, ...zero(), requests: 0,
      input_per_second: 0, output_per_second: 0, cost_per_minute: 0, complete: false })),
    buckets: Array.from({ length: 60 }, (_, i) => ({ at: new Date(last - (59 - i) * 10_000).toISOString(), ...zero() })),
    coverage: { complete: false } };
}

/** Per-project, read-only and bounded. Parsed rows retain only numbers/attribution;
 * bounded undecoded tails and byte checkpoints support append/rotation detection. */
export class RuntimeDiagnostics {
  constructor(config, { now = Date.now, runs = () => ({ rows: [], truncated: false }), throttleMs = 2000,
    maxBytes = 2 * 1024 * 1024, fileBytes = 512 * 1024, maxFiles = 256, maxEntries = 4096, maxRows = 20_000 } = {}) {
    Object.assign(this, { config, now, runs, throttleMs, maxBytes, fileBytes, maxFiles, maxEntries, maxRows });
    this.files = new Map(); this.pending = null; this.cached = null;
  }
  read() {
    if (this.pending) return this.pending.then(structuredClone);
    if (this.cached && this.now() - Date.parse(this.cached.generated_at) < this.throttleMs) return Promise.resolve(structuredClone(this.cached));
    this.pending = this.collect().then(result => { this.cached = result; return result; }).finally(() => { this.pending = null; });
    return this.pending.then(structuredClone);
  }
  async collect() {
    const now = this.now(), result = emptyDiagnostics(now), since = Date.parse(result.buckets[0].at);
    const coverage = { complete: true, files: 0, bytes_read: 0, skipped_files: 0, unreadable_files: 0,
      malformed_lines: 0, partial_files: 0, truncated_files: 0, undated_requests: 0, future_requests: 0, missing_runs: 0, budget_exhausted: false };
    const source = this.runs(now), active = new Set(source.rows.map(row => row.task_id)), ranges = new Map();
    for (const run of source.rows) {
      const group = ranges.get(run.task_id) ?? [];
      group.push({ id: run.id, provider: run.provider, start: diagnosticsTime(run.started_at), end: diagnosticsTime(run.ended_at) ?? now });
      ranges.set(run.task_id, group);
    }
    coverage.budget_exhausted = source.truncated === true;
    const dir = path.join(this.config.home, 'sessions'), live = new Set(), candidates = [];
    let entries = 0;
    try {
      const directory = await fs.promises.lstat(dir);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('unsafe session directory');
      const handle = await fs.promises.opendir(dir);
      for await (const entry of handle) {
        if (++entries > this.maxEntries) { coverage.budget_exhausted = true; break; }
        const match = SESSION.exec(entry.name);
        if (!match) continue;
        const file = path.join(dir, entry.name); live.add(file);
        try {
          const stat = await fs.promises.lstat(file);
          if (!stat.isFile()) { coverage.unreadable_files++; continue; }
          if (stat.mtimeMs < since && !active.has(Number(match[1]))) { this.files.delete(file); continue; }
          candidates.push({ file, stat, taskId: Number(match[1]) });
        } catch { coverage.unreadable_files++; }
      }
    } catch (error) { if (error.code !== 'ENOENT' || active.size) coverage.unreadable_files++; }
    // Deleted or rotated paths must not contribute stale rows.
    for (const file of this.files.keys()) if (!live.has(file)) this.files.delete(file);
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.file.localeCompare(b.file));
    const observed = new Set(), rows = [];
    for (const { file, stat, taskId } of candidates.slice(0, this.maxFiles)) {
      if (coverage.bytes_read >= this.maxBytes || rows.length >= this.maxRows) { coverage.budget_exhausted = true; break; }
      try {
        const state = await this.readFile(file, stat, taskId, since, coverage, this.maxRows - rows.length,
          source.truncated ? [] : ranges.get(taskId) ?? []);
        coverage.files++;
        coverage.malformed_lines += state.malformed;
        coverage.undated_requests += state.undated;
        coverage.partial_files += state.tail.length ? 1 : 0;
        coverage.truncated_files += state.truncated ? 1 : 0;
        for (const row of state.rows) {
          if (row.run_id != null) observed.add(row.run_id);
          else {
            // Untagged legacy rows establish coverage only for a unique time-matching invocation,
            // never for every wake of a Worker merely because one old response exists.
            const matches = (ranges.get(taskId) ?? []).filter(run => run.start !== null && row.at >= run.start && row.at <= run.end);
            if (matches.length === 1) observed.add(matches[0].id);
          }
          rows.push(row);
        }
      } catch { coverage.unreadable_files++; this.files.delete(file); }
    }
    coverage.skipped_files = Math.max(0, candidates.length - coverage.files - coverage.unreadable_files);
    coverage.budget_exhausted ||= candidates.length > this.maxFiles;
    let retained = 0, tailBytes = 0;
    for (const state of this.files.values()) { retained += state.rows.length; tailBytes += state.tail.length; }
    while (this.files.size > this.maxFiles || retained > this.maxRows || tailBytes > this.maxBytes) {
      const oldest = this.files.keys().next().value, state = this.files.get(oldest);
      retained -= state.rows.length; tailBytes -= state.tail.length; this.files.delete(oldest);
    }
    // A run with no local request expenditure (including Codex) is unknown, not idle zero.
    for (const run of source.rows) {
      if (observed.has(run.id)) continue;
      coverage.missing_runs++;
      const start = diagnosticsTime(run.started_at), end = diagnosticsTime(run.ended_at) ?? now;
      const at = Math.min(now, Math.max(since, end));
      rows.push({ at, ...zero(), unknown_tokens: 1, unknown_cost: 1, missing: true, start, end });
    }
    coverage.complete = !coverage.budget_exhausted && !['skipped_files','unreadable_files','malformed_lines','partial_files','truncated_files','undated_requests','missing_runs'].some(key => coverage[key]);
    for (const row of rows) {
      if (row.missing) {
        // Missing usage is not an event at invocation end: it could have occurred anywhere
        // in that invocation. Preserve known flow and mark every intersecting range unknown.
        for (const bucket of result.buckets) {
          const at = Date.parse(bucket.at);
          if (row.end >= at && (row.start === null || row.start < Math.min(at + 10_000, now + 1))) add(bucket, row);
        }
        for (const window of result.windows) {
          if (row.end >= now - window.seconds * 1000 && (row.start === null || row.start <= now)) add(window, row);
        }
        continue;
      }
      if (row.at > now) { coverage.future_requests++; coverage.complete = false; continue; }
      const index = Math.floor((row.at - since) / 10_000);
      if (index >= 0 && index < 60) add(result.buckets[index], row);
      for (const window of result.windows) {
        if (row.at < now - window.seconds * 1000) continue;
        window.requests++;
        add(window, row);
      }
    }
    // Undated/unreadable/truncated data cannot be assigned to a time bin. Mark every affected
    // range as uncertain while preserving the known subtotal (unknown counts are contributors).
    const uncertain = coverage.skipped_files + coverage.unreadable_files + coverage.malformed_lines
      + coverage.partial_files + coverage.truncated_files + coverage.undated_requests + coverage.future_requests + Number(coverage.budget_exhausted);
    for (const bucket of result.buckets) { bucket.unknown_tokens += uncertain; bucket.unknown_cost += uncertain; }
    for (const window of result.windows) {
      window.unknown_tokens += uncertain; window.unknown_cost += uncertain;
      window.input_per_second = window.input / window.seconds;
      window.output_per_second = window.output / window.seconds;
      window.cost_per_minute = window.cost * 60 / window.seconds;
      window.complete = coverage.complete && window.unknown_tokens === 0 && window.unknown_cost === 0;
    }
    coverage.complete &&= result.windows.every(window => window.complete) && result.buckets.every(b => !b.unknown_tokens && !b.unknown_cost);
    result.coverage = coverage;
    return result;
  }
  async readFile(file, stat, taskId, since, coverage, rowLimit, ranges) {
    const fd = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const actual = await fd.stat();
      if (actual.ino !== stat.ino || actual.dev !== stat.dev) throw new Error('replaced');
      const read = async (at, length) => {
        const size = Math.min(length, Math.max(0, this.maxBytes - coverage.bytes_read));
        if (size < length) coverage.budget_exhausted = true;
        const buffer = Buffer.alloc(size), { bytesRead } = await fd.read(buffer, 0, size, at);
        coverage.bytes_read += bytesRead;
        return buffer.subarray(0, bytesRead);
      };
      const head = await read(0, Math.min(stat.size, 256));
      let state = this.files.get(file);
      if (state) {
        const guard = await read(Math.max(0, state.offset - state.guard.length), state.guard.length);
        const changed = state.ino !== stat.ino || state.dev !== stat.dev || stat.size < state.offset
          || !head.subarray(0, state.head.length).equals(state.head) || !guard.equals(state.guard)
          || stat.size === state.offset && (stat.mtimeMs !== state.mtime || stat.ctimeMs !== state.ctime);
        if (changed) state = null;
      }
      if (!state) {
        const offset = Math.max(0, stat.size - Math.min(this.fileBytes, this.maxBytes - coverage.bytes_read));
        state = { ino: stat.ino, dev: stat.dev, offset, head, guard: Buffer.alloc(0), tail: Buffer.alloc(0),
          invocation: null, trusted: offset === 0, skip: offset > 0, truncated: offset > 0, malformed: 0, undated: 0, rows: [] };
      }
      state.rows = state.rows.filter(row => row.at >= since);
      if (state.rows.length > rowLimit) { state.rows = state.rows.slice(-rowLimit); state.truncated = true; }
      const length = Math.min(stat.size - state.offset, this.fileBytes, Math.max(0, this.maxBytes - coverage.bytes_read));
      if (state.offset + length < stat.size) { state.truncated = true; coverage.budget_exhausted = true; }
      const buffer = await read(state.offset, length);
      if (buffer.length < length) state.truncated = true;
      state.offset += buffer.length;
      const data = Buffer.concat([state.tail, buffer]);
      let from = 0;
      for (let newline; (newline = data.indexOf(10, from)) >= 0; from = newline + 1) {
        if (state.skip) { state.skip = false; continue; }
        const line = data.subarray(from, newline);
        if (!line.length) continue;
        let record;
        try { record = JSON.parse(line.toString('utf8')); } catch { state.malformed++; continue; }
        if (record?.type === 'custom' && record.customType === 'lush.invocation') { state.invocation = record.data; state.trusted = true; }
        const message = record?.type === 'message' ? record.message : null;
        if (message?.role !== 'assistant') continue;
        let attribution = record.lush ?? state.invocation;
        if (attribution?.task_id != null && attribution.task_id !== taskId) continue;
        const at = diagnosticsTime(record.timestamp) ?? (diagnosticsNumber(message.timestamp) ? message.timestamp : diagnosticsTime(message.timestamp));
        if (at === null) { state.undated++; continue; }
        if (at < since) continue;
        if (!state.trusted && attribution?.task_id !== taskId) {
          // Pi does not annotate each message. When its invocation marker lies before the
          // bounded tail, recover only rows uniquely inside this Worker's recorded Pi run,
          // strictly after its start (a shared millisecond is not ownership evidence).
          // Copied fork context predates the local run; explicit foreign markers above
          // always win. Missing/ambiguous/budget-limited run metadata is not proof.
          const matches = ranges.filter(run => run.start !== null && at > run.start && at <= run.end);
          if (matches.length !== 1 || matches[0].provider !== 'pi') continue;
          attribution = { task_id: taskId, run_id: matches[0].id };
        }
        const u = message.usage ?? {}, num = n => diagnosticsNumber(n) ? n : 0;
        const row = { at, run_id: attribution?.task_id === taskId ? attribution.run_id : null,
          input: num(u.input) + num(u.cacheRead) + num(u.cacheWrite), output: num(u.output), cost: num(u.cost?.total),
          unknown_tokens: diagnosticsNumber(u.input) && diagnosticsNumber(u.output) ? 0 : 1,
          unknown_cost: diagnosticsNumber(u.cost?.total) ? 0 : 1 };
        state.rows.push(row);
        if (state.rows.length > rowLimit) { state.rows.shift(); state.truncated = true; }
      }
      // Copy the small suffix so a one-byte partial line does not pin a whole read buffer.
      state.tail = Buffer.from(data.subarray(from));
      if (state.tail.length > this.fileBytes) { state.tail = Buffer.alloc(0); state.skip = true; state.truncated = true; }
      state.guard = await read(Math.max(0, state.offset - 128), Math.min(128, state.offset));
      state.mtime = stat.mtimeMs; state.ctime = stat.ctimeMs;
      this.files.delete(file); this.files.set(file, state);
      return state;
    } finally { await fd.close(); }
  }
}
