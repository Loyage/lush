import fs from 'node:fs';
import path from 'node:path';
import { diagnosticNumber, diagnosticText, diagnosticSample, DIAGNOSTICS_RETENTION_MS } from '../core/diagnostics-query.js';

export const MAX_DIAGNOSTIC_SAMPLES = 1024;
export const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;

/** Only expired disposable invocation directories; never sessions, runs or original quota history. */
export async function prunePiDiagnostics(config, now = Date.now()) {
  const root = path.join(config.home, 'sessions'); let inspected = 0;
  try {
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
    const directory = await fs.promises.opendir(root);
    for await (const entry of directory) {
      if (++inspected > 4096) break;
      if (!/^\.diagnostics-[a-zA-Z0-9]{6}$/.test(entry.name) || !entry.isDirectory()) continue;
      const dir = path.join(root, entry.name), stat = await fs.promises.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.mtimeMs >= now - DIAGNOSTICS_RETENTION_MS) continue;
      const handle = await fs.promises.opendir(dir); const files = [];
      for await (const file of handle) {
        if (files.length >= 4 || !/^samples\.json(?:\.\d+\.tmp)?$/.test(file.name) || !file.isFile()) { files.push(null); break; }
        files.push(path.join(dir, file.name));
      }
      if (files.includes(null)) continue;
      for (const file of files) await fs.promises.unlink(file);
      await fs.promises.rmdir(dir);
    }
  } catch { /* A late file change or inaccessible directory never changes execution. */ }
}

/** Passive foreground observer. No text, prompts, headers, tools or credentials are retained. */
export function installPiDiagnostics(pi, file, { clock = () => performance.now(), now = Date.now } = {}) {
  if (!file) return;
  let active = null, dropped = 0, rows = [];
  const save = () => {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      let encoded = JSON.stringify({ version: 1, rows, dropped });
      while (Buffer.byteLength(encoded) > MAX_DIAGNOSTIC_BYTES && rows.length) {
        rows.pop(); dropped++; encoded = JSON.stringify({ version: 1, rows, dropped });
      }
      fs.writeFileSync(temporary, encoded, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch { /* Missing metadata remains unknown at the daemon; never fail a model invocation. */ }
    finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
  };
  pi.on('session_start', save);
  pi.on('before_provider_request', () => {
    // Multiple requests without a finalized message (retry/nested request) cannot prove a clean duration.
    active = { start: clock(), ambiguous: active !== null, first: null, textFirst: null, last: null, index: null, chars: 0, ms: 0 };
  });
  pi.on('message_update', ({ assistantMessageEvent: event }) => {
    if (!active || !event) return;
    const at = clock();
    if (['text_delta','thinking_delta','toolcall_delta'].includes(event.type) && typeof event.delta === 'string' && event.delta.length) active.first ??= at;
    if (event.type === 'text_delta' && typeof event.delta === 'string' && event.delta.length) {
      active.textFirst ??= at;
      if (active.last !== null && active.index === event.contentIndex && at > active.last) {
        // Exclude the first chunk of each contiguous text segment: its generation time is unobserved.
        active.chars += Array.from(event.delta).length; active.ms += at - active.last;
      }
      active.last = at; active.index = event.contentIndex;
    } else if (event.type !== 'text_start') { active.last = null; active.index = null; }
  });
  pi.on('message_end', ({ message }) => {
    if (message.role !== 'assistant') return;
    const state = active; active = null;
    const at = clock(), usage = message.usage, num = n => diagnosticNumber(n) ? n : null;
    const ok = !['error','aborted'].includes(message.stopReason);
    const duration = state && !state.ambiguous && ok && at > state.start && at - state.start <= 86400_000 ? at - state.start : null;
    const model = diagnosticText(message.provider, 128) && diagnosticText(message.model) ? `${message.provider}/${message.model}` : null;
    // Pi initializes failed messages with zero usage; that is not evidence of zero provider expenditure.
    const hasUsage = ok || ['input','output','cacheRead','cacheWrite'].some(key => num(usage?.[key]) > 0);
    const inputs = ['input','cacheRead','cacheWrite'].map(key => num(usage?.[key]));
    const row = { at: new Date(now()).toISOString(), model: diagnosticText(model) ? model : null,
      status: ok ? 'ok' : message.stopReason === 'aborted' ? 'aborted' : 'error',
      input_tokens: hasUsage && inputs.every(n => n !== null) ? inputs.reduce((a,b) => a+b, 0) : null,
      output_tokens: hasUsage ? num(usage?.output) : null, estimated_cost_usd: ok || num(usage?.cost?.total) > 0 ? num(usage?.cost?.total) : null, response_ms: duration,
      text_chars: duration && state.ms > 0 ? state.chars : null, text_ms: duration && state.ms > 0 ? state.ms : null,
      wait_ms: duration && state.first !== null ? state.first - state.start : null,
      ttft_ms: duration && state.textFirst !== null ? state.textFirst - state.start : null };
    try { if (rows.length < MAX_DIAGNOSTIC_SAMPLES) rows.push(diagnosticSample(row)); else dropped++; }
    catch { dropped++; }
    save();
  });
  pi.on('session_shutdown', () => { if (active) { dropped++; active = null; } save(); });
}

/** Exit-time import of a daemon-owned invocation file; no session replay/fork expenditure. */
export function readPiDiagnostics(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > MAX_DIAGNOSTIC_BYTES) return null;
    const buffer = Buffer.alloc(stat.size + 1); let length = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count; if (length === buffer.length) return null;
    }
    const after = fs.fstatSync(fd);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return null;
    const value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (value.version !== 1 || !Array.isArray(value.rows) || value.rows.length > MAX_DIAGNOSTIC_SAMPLES
      || !Number.isSafeInteger(value.dropped) || value.dropped < 0) return null;
    return { rows: value.rows.map(diagnosticSample), dropped: value.dropped };
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
