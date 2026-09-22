import { check, id, bounded } from '../../core/types.js';

/** notice.* */
export const handlers = {
  'notice.list'(p, params, actor) { return bounded(p.store.all("SELECT * FROM notices ORDER BY (status='open') DESC, id DESC LIMIT 200"), 900000); },
  'notice.page'(p, { status = 'all', before = null, limit = 30 }) {
    check(['all','open','answered','dismissed','sent'].includes(status), 'invalid notice status');
    check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'limit must be 1..100');
    if (before !== null) before = id(before);
    const where = [], args = [];
    if (status !== 'all') { where.push('status=?'); args.push(status); }
    if (before !== null) { where.push('id<?'); args.push(before); }
    const rows = p.store.all(`SELECT * FROM notices${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...args, limit + 1);
    // Bound by bytes too, without dropping the cursor for omitted records.
    const notices = []; let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (notices.length && bytes + size > 900000) break;
      notices.push(row); bytes += size;
    }
    return { notices, cursor: notices.at(-1)?.id ?? null, has_more: rows.length > notices.length, limit };
  },
  'notice.post'(p, params, actor) {
    const task = params.task ?? actor;
    check(actor === null || id(task) === actor, 'agents may post notices only for their own task');
    return p.notice(task, params.title, params.body, 'question', params.questions);
  },
  'notice.answer'(p, params, actor) { return p.answer(params.id, params.answer); },
  'notice.dismiss'(p, params, actor) { return p.answer(params.id, '', true); },
};
