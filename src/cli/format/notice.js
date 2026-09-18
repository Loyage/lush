/**
 * Human-readable output for the `notice` group: the user's inbox of agent
 * reports.
 *
 * Text is for people — the answer form is printed field by field so it is
 * obvious what `notice answer --set` accepts; `--json` is the exact interface.
 */
import { alignRows, excerpt, stamp } from './primitives.js';

/** `#7 [decision/open] 需要你选一个方案 · task#3 project-manager[2]` */
export function noticeLine(notice) {
  const where = notice.task_id === null ? `sid ${notice.sid}` : `task#${notice.task_id} ${notice.service_name}[${notice.sid}]`;
  // Only an open notice is still waiting: once settled, nothing is parked on it.
  const waited = notice.wait && notice.status === 'open' ? ' · 等待答复' : '';
  return `#${notice.id} [${notice.kind}/${notice.status}]${waited} ${notice.title} · ${where}`;
}

export function formatNoticeList(rows) {
  if (rows.length === 0) return '没有 notice';
  return rows.map(noticeLine).join('\n');
}

/** Everything about one notice: who reported it, what it asks, how to answer. */
export function formatNotice(notice) {
  const where = notice.task_id === null
    ? `service ${notice.service_name}[${notice.sid}]`
    : `task#${notice.task_id} on ${notice.service_name}[${notice.sid}]`;
  const wait = notice.wait
    ? `yes (the reporter ${notice.status === 'open'
      ? 'is parked in awaiting until this is settled'
      : 'was parked in awaiting until this was settled'})`
    : 'no (a record only; nothing comes back)';
  const rows = [
    ['notice', `#${notice.id}`],
    ['kind', notice.kind],
    ['status', notice.status],
    ['wait', wait],
    ['reporter', where],
    ['created', stamp(notice.created_at)],
    ['answered', stamp(notice.answered_at)],
  ];
  if (notice.task_goal !== null && notice.task_goal !== undefined) rows.push(['goal', notice.task_goal]);
  const lines = alignRows(rows);
  lines.push('', notice.title);
  if (notice.body !== '') lines.push('', excerpt(notice.body, 4000));
  if (notice.fields.length > 0) {
    lines.push('', '需要填写：');
    for (const field of notice.fields) {
      const options = field.options === undefined ? '' : ` (${field.options.join(' | ')})`;
      const required = field.required ? ' *必填' : '';
      const fallback = field.default === undefined ? '' : ` [默认 ${JSON.stringify(field.default)}]`;
      lines.push(`  ${field.name} <${field.type}>${options}${required}${fallback}  ${field.label}`);
    }
    lines.push('', `lush notice answer ${notice.id} --set ${notice.fields[0].name}=...`);
  }
  if (notice.status === 'answered') lines.push('', '回答：', JSON.stringify(notice.answer, null, 2));
  if (notice.status === 'dismissed' && notice.note !== null) lines.push('', `忽略原因：${notice.note}`);
  return lines.join('\n');
}
