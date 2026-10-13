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

// Keep only bounded JSON metadata. Oversized string tokens cannot equal any of the
// short discriminator/ownership fields used below. Validate every original escape
// before replacing their content, so a huge tool body can cross read boundaries
// without pinning that body in memory or laundering malformed JSON as valid.
const oversizedString = Buffer.from('"__lush_diagnostics_oversize__"');
function appendJSON(state, bytes, limit) {
  const json = state.json ??= { quoted: false, escape: false, unicode: 0, invalid: false };
  if (json.invalid) return;
  const output = Buffer.alloc(Math.min(limit, state.tail.length + bytes.length + oversizedString.length));
  state.tail.copy(output); let length = state.tail.length;
  const put = byte => { if (length < output.length) output[length++] = byte; else { json.invalid = true; json.limited = true; } };
  const tokenLimit = Math.min(8192, Math.floor(limit / 4));
  for (const byte of bytes) {
    if (!json.quoted) {
      if (byte === 34) { json.quoted = true; json.start = length; json.size = 0; json.overflow = false; }
      put(byte);
    } else {
      let closes = false;
      if (json.unicode) {
        if (!(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102)) json.invalid = true;
        json.unicode--;
      } else if (json.escape) {
        if (byte === 117) json.unicode = 4;
        else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) json.invalid = true;
        json.escape = false;
      } else if (byte === 92) json.escape = true;
      else if (byte === 34) { json.quoted = false; closes = true; }
      else if (byte < 32) json.invalid = true;
      if (!json.overflow) {
        if (!closes && ++json.size > tokenLimit) {
          length = json.start;
          for (const part of oversizedString) put(part);
          json.overflow = true;
        } else put(byte);
      }
    }
    if (json.invalid) break;
  }
  state.tail = json.invalid ? Buffer.from('!') : Buffer.from(output.subarray(0, length));
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
    for (const state of this.files.values()) {
      retained += state.rows.length + (state.recovery?.rows.length ?? 0);
      tailBytes += state.tail.length + (state.recovery?.tail.length ?? 0);
    }
    while (this.files.size > this.maxFiles || retained > this.maxRows || tailBytes > this.maxBytes) {
      const oldest = this.files.keys().next().value, state = this.files.get(oldest);
      retained -= state.rows.length + (state.recovery?.rows.length ?? 0);
      tailBytes -= state.tail.length + (state.recovery?.tail.length ?? 0); this.files.delete(oldest);
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
  consume(state, buffer, taskId, since, rowLimit, ranges) {
    let from = 0;
    for (let newline; (newline = buffer.indexOf(10, from)) >= 0; from = newline + 1) {
      if (state.skip) { state.skip = false; continue; }
      appendJSON(state, buffer.subarray(from, newline), this.fileBytes);
      let record;
      try {
        if (state.json?.invalid || state.json?.quoted) throw new Error('invalid JSON string');
        if (state.tail.length) record = JSON.parse(state.tail.toString('utf8'));
      } catch {
        if (state.json?.limited) state.truncated = true;
        else state.malformed++;
      }
      state.tail = Buffer.alloc(0); state.json = null;
      if (record?.type === 'custom' && record.customType === 'lush.invocation') { state.invocation = record.data; state.trusted = true; }
      const message = record?.type === 'message' ? record.message : null;
      if (message?.role !== 'assistant') continue;
      let attribution = record.lush ?? state.invocation;
      if (attribution?.task_id != null && attribution.task_id !== taskId) continue;
      const at = diagnosticsTime(record.timestamp) ?? (diagnosticsNumber(message.timestamp) ? message.timestamp : diagnosticsTime(message.timestamp));
      if (at === null) { state.undated++; continue; }
      if (at < since) continue;
      // Copied context can follow a new invocation marker. Its earlier timestamp
      // does not become local expenditure merely because replay found that marker.
      const markedRun = !record.lush && ranges.find(run => run.id === attribution?.run_id);
      if (markedRun && markedRun.start !== null && at < markedRun.start) continue;
      if (!state.trusted && attribution?.task_id !== taskId) {
        // A tail without a marker needs a unique recorded local Pi run; fork context
        // and an ambiguous/shared start boundary remain unowned until head replay.
        const matches = ranges.filter(run => run.start !== null && at > run.start && at <= run.end);
        if (matches.length !== 1 || matches[0].provider !== 'pi') continue;
        attribution = { task_id: taskId, run_id: matches[0].id };
      }
      const u = message.usage ?? {}, num = n => diagnosticsNumber(n) ? n : 0;
      state.rows.push({ at, run_id: attribution?.task_id === taskId ? attribution.run_id : null,
        input: num(u.input) + num(u.cacheRead) + num(u.cacheWrite), output: num(u.output), cost: num(u.cost?.total),
        unknown_tokens: diagnosticsNumber(u.input) && diagnosticsNumber(u.output) ? 0 : 1,
        unknown_cost: diagnosticsNumber(u.cost?.total) ? 0 : 1 });
      if (state.rows.length > rowLimit) { state.rows.shift(); state.truncated = true; }
    }
    if (!state.skip) appendJSON(state, buffer.subarray(from), this.fileBytes);
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
      let state = this.files.get(file), existing = !!state;
      if (state) {
        const guard = await read(Math.max(0, state.offset - state.guard.length), state.guard.length);
        const recovery = state.recovery;
        const recoveryGuard = recovery ? await read(Math.max(0, recovery.offset - recovery.guard.length), recovery.guard.length) : null;
        const changed = state.ino !== stat.ino || state.dev !== stat.dev || stat.size < state.offset
          || !head.subarray(0, state.head.length).equals(state.head) || !guard.equals(state.guard)
          || recovery && !recoveryGuard.equals(recovery.guard)
          || stat.size === state.offset && (stat.mtimeMs !== state.mtime || stat.ctimeMs !== state.ctime);
        if (changed) { state = null; existing = false; }
      }
      const parser = () => ({ offset: 0, guard: Buffer.alloc(0), tail: Buffer.alloc(0),
        invocation: null, trusted: true, skip: false, truncated: false, malformed: 0, undated: 0, rows: [] });
      if (!state) {
        const offset = Math.max(0, stat.size - Math.min(this.fileBytes, this.maxBytes - coverage.bytes_read));
        state = { ...parser(), ino: stat.ino, dev: stat.dev, offset, head,
          trusted: offset === 0, skip: offset > 0, truncated: offset > 0, recovery: offset > 0 ? parser() : null };
      }
      state.rows = state.rows.filter(row => row.at >= since);
      if (state.rows.length > rowLimit) { state.rows = state.rows.slice(-rowLimit); state.truncated = true; }
      const length = Math.min(stat.size - state.offset, this.fileBytes, Math.max(0, this.maxBytes - coverage.bytes_read));
      if (state.offset + length < stat.size) coverage.budget_exhausted = true;
      const buffer = await read(state.offset, length);
      if (buffer.length < length) coverage.budget_exhausted = true;
      state.offset += buffer.length;
      this.consume(state, buffer, taskId, since, rowLimit, ranges);
      if (existing && state.recovery) {
        // Tail freshness wins; spend only the remainder of this file's unchanged
        // read budget on forward, continuous replay. Never merge its rows with the
        // tail's provisional rows: replace atomically only after catching up.
        const replay = state.recovery, limit = Math.max(0, rowLimit - state.rows.length);
        replay.rows = replay.rows.filter(row => row.at >= since);
        if (replay.rows.length > limit) { replay.rows = limit ? replay.rows.slice(-limit) : []; replay.truncated = true; }
        const remaining = Math.min(state.offset - replay.offset, this.fileBytes - buffer.length,
          Math.max(0, this.maxBytes - coverage.bytes_read));
        const backfill = await read(replay.offset, remaining);
        replay.offset += backfill.length;
        this.consume(replay, backfill, taskId, since, limit, ranges);
        replay.guard = await read(Math.max(0, replay.offset - 128), Math.min(128, replay.offset));
        if (replay.offset === state.offset) {
          // A complete byte/JSON replay proves coverage and restores marker-based
          // attribution. Real malformed/undated/missing or budget-limited data
          // still survives in the new state and keeps the snapshot incomplete.
          if (!replay.truncated) Object.assign(state, replay, { recovery: null });
          else state.recovery = null; // Row/metadata budget loss: keep the tail subtotal and uncertainty.
        }
      }
      state.guard = await read(Math.max(0, state.offset - 128), Math.min(128, state.offset));
      state.mtime = stat.mtimeMs; state.ctime = stat.ctimeMs;
      this.files.delete(file); this.files.set(file, state);
      return state;
    } finally { await fd.close(); }
  }
}
