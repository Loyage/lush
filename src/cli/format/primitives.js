/**
 * Text primitives shared by every human-readable formatter: aligned `key value`
 * rows, local wall-clock timestamps, one-line values, and the process tree.
 *
 * Text is for people: no JSON punctuation unless the value really is nested.
 * `--json` is the stable machine interface; these formatters are free to change.
 */
import { isPlainObject } from '../../core/types.js';

/** Seconds-resolution duration (`45s`, `2m07s`, `3h05m`) for agent lines. */
export function duration(ms) {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
}

/**
 * One activity line: who is working for this process right now. Idle processes
 * get no line at all — the tree shows activity, not history.
 */
export function agentLine(summary) {
  const running = summary?.agents ?? [];
  if (running.length === 0) return null;
  if (running.length === 1) {
    const [agent] = running;
    return `agent ${agent.id} running · ${duration(agent.elapsed_ms)}${agent.interactive ? ' · tty' : ''}`;
  }
  const shown = running.slice(0, 3).map((agent) => `${agent.id} ${duration(agent.elapsed_ms)}`);
  const more = running.length > shown.length ? ` · +${running.length - shown.length}` : '';
  return `agents ${running.length} running · ${shown.join(' · ')}${more}`;
}

/**
 * One-line variable summary for the text tree: immutable values plain, mutable
 * ones prefixed `~` (the `~` is also the reminder that they can be changed).
 */
export function variableSummary(variables) {
  const parts = [];
  for (const group of ['immutable', 'mutable']) {
    for (const [key, value] of Object.entries(variables?.[group] ?? {})) {
      parts.push(`${group === 'mutable' ? '~' : ''}${key}=${shortValue(value)}`);
    }
  }
  return parts.join(' ');
}

export function shortValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

/** Local wall-clock `YYYY-MM-DD HH:MM:SS` from an ISO timestamp. */
export function stamp(iso) {
  if (typeof iso !== 'string' || iso === '') return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Indent every non-empty line by `depth` levels of two spaces. */
export function indentLines(value, depth = 1) {
  const pad = '  '.repeat(depth);
  return String(value).split('\n').map((line) => (line === '' ? '' : pad + line));
}

/** Aligned `key value` rows, keys padded to the widest one. */
export function alignRows(rows) {
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  return rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`);
}

/**
 * One-line form of a value: scalars as-is, compact arrays/objects as JSON.
 * `null` means "needs a block of its own" (multi-line or too long to inline).
 */
export function inlineText(value) {
  if (typeof value === 'string') return value.includes('\n') ? null : value;
  if (value === null || typeof value !== 'object') return String(value);
  const json = JSON.stringify(value);
  return json.length <= 72 ? json : null;
}

/**
 * Human view of a JSON object: aligned `key  value` for scalars, a `key:` block
 * for anything nested. Shared by `inspect` (state) and `update-state`.
 */
export function objectLines(value, depth = 0) {
  const pad = '  '.repeat(depth);
  const rows = Object.entries(value).map(([key, item]) => [key, inlineText(item), item]);
  const width = rows.reduce((max, [key, text]) => (text === null ? max : Math.max(max, key.length)), 0);
  const lines = [];
  for (const [key, text, item] of rows) {
    if (text !== null) {
      lines.push(`${pad}${key.padEnd(width)}  ${text}`);
    } else if (typeof item === 'string') {
      lines.push(`${pad}${key}:`, ...indentLines(item, depth + 1));
    } else if (isPlainObject(item)) {
      lines.push(`${pad}${key}:`, ...objectLines(item, depth + 1));
    } else {
      lines.push(`${pad}${key}:`, ...indentLines(JSON.stringify(item, null, 2), depth + 1));
    }
  }
  return lines;
}

/** `pid 3 · implement-login · task · running` — one-line identity of a process row. */
export function metadataTitle(row) {
  return `pid ${row.pid} · ${row.name} · ${row.type} · ${row.status}`;
}

/** One event line: `#12 state_updated · 2026-09-17 23:12:30  {"keys":[...]}`. */
export function eventLine(event) {
  const data = event.data === undefined || event.data === null ? '' : `  ${JSON.stringify(event.data)}`;
  return `  #${event.id} ${event.kind} · ${stamp(event.created_at)}${data}`;
}

/**
 * Process tree, root first. `agents` adds one activity line below each process
 * that has a live worker (never a logical process: no PID, never expanded).
 * A process's variables are appended on its own line.
 */
export function treeLines(processes, { agents = true } = {}) {
  const byParent = new Map();
  for (const process of processes) {
    const siblings = byParent.get(process.parent_pid) ?? [];
    siblings.push(process);
    byParent.set(process.parent_pid, siblings);
  }
  const lines = [];
  // Iterative walk avoids recursion limits on deep logical trees. Agent rows use
  // their own key: process rows themselves carry an `agent` field.
  const stack = [...(byParent.get(null) ?? [])].reverse().map((process) => ({ process, prefix: '', branch: '' }));
  while (stack.length) {
    const node = stack.pop();
    if (node.agentRow !== undefined) {
      const line = agentLine(node.agentRow);
      if (line !== null) lines.push(`${node.prefix}${node.branch}${line}`);
      continue;
    }
    const { process, prefix, branch } = node;
    const variables = variableSummary(process.variables);
    lines.push(`${prefix}${branch}${process.name}[${process.pid}]${variables ? ` ${variables}` : ''}`);
    const children = byParent.get(process.pid) ?? [];
    const nextPrefix = prefix + (branch === '└── ' ? '    ' : branch ? '│   ' : '');
    const rows = [
      ...(agents && process.agent?.running ? [{ agentRow: process.agent }] : []),
      ...children.map((child) => ({ process: child })),
    ];
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      stack.push({
        ...rows[index],
        prefix: nextPrefix,
        branch: index === rows.length - 1 ? '└── ' : '├── ',
      });
    }
  }
  return lines;
}
