/**
 * Human-readable output for the `intent` group: the user's own words, and what
 * the top-level parser made of them.
 *
 * Text is for people — the queue view has to answer "what did I say, where is
 * it, and who is waiting on whom" at a glance; `--json` is the exact interface.
 */
import { alignRows, excerpt, stamp } from './primitives.js';

/** One line of the queue: what it is, where it got, and who it is waiting for. */
export function intensionLine(row) {
  const target = row.sid === null
    ? 'target 未指定'
    : `target ${row.service_name ?? `sid ${row.sid}`}[${row.sid}]`;
  const waiting = row.status === 'awaiting'
    ? ' · 等你裁决冲突'
    : row.status === 'queued' && row.blocked_by_task_id !== null ? ` · 等 task#${row.blocked_by_task_id} 结束` : '';
  const parse = row.parse_task_id === null ? '' : ` · 解析 task#${row.parse_task_id}`;
  return `#${row.id} [${row.status}]${waiting} ${headline(row.content)} · ${target}${parse}`;
}

/** The user's words as one line: the queue is a list, so newlines cannot win. */
function headline(content) {
  return excerpt(content.replace(/\s+/g, ' ').trim(), 60);
}

export function formatIntensionList(rows) {
  if (rows.length === 0) return '队列里没有 intension';
  return rows.map(intensionLine).join('\n');
}

/** Everything about one input: the words, the parse task, the outcome, the questions. */
export function formatIntension(row) {
  const rows = [
    ['intension', `#${row.id}`],
    ['status', row.status],
    ['target', row.sid === null ? '未指定（由解析器判断）' : `${row.service_name ?? ''}[${row.sid}] ${row.service_status ?? ''}`],
    ['source', row.source],
    ['attempts', String(row.attempts)],
    ['parse task', row.parse_task_id === null ? '—' : `#${row.parse_task_id} (${row.parse_task_status ?? 'gone'})`],
    ['created', stamp(row.created_at)],
    ['settled', stamp(row.settled_at)],
  ];
  if (row.blocked_by_task_id !== null) rows.push(['waiting for', `task#${row.blocked_by_task_id} to finish`]);
  if (row.resolution !== null) rows.push(['resolution', JSON.stringify(row.resolution)]);
  const lines = alignRows(rows);
  lines.push('', '用户原话：', excerpt(row.content, 4000));
  if (row.response !== null) lines.push('', '结论：', excerpt(row.response, 4000));
  if (Array.isArray(row.notices) && row.notices.length > 0) {
    lines.push('', '与用户的过程：');
    for (const notice of row.notices) {
      lines.push(`  notice#${notice.id} [${notice.kind}/${notice.status}] ${notice.title}`);
    }
  }
  if (row.status === 'queued' || row.status === 'parsing' || row.status === 'awaiting') {
    lines.push('', `观察：lush intent show ${row.id} --json / lush intent context ${row.id}`);
  }
  return lines.join('\n');
}
