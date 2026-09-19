import { check, id } from '../../core/types.js';

/** 输入缓存（drafts）的增删改。 */
export const drafts = {
  addDraft(content) {
    const row = this.run('INSERT INTO drafts(content) VALUES (?)', content);
    return this.get('SELECT * FROM drafts WHERE id=?', Number(row.lastInsertRowid));
  },
  draft(draftId) {
    const draft = this.get('SELECT * FROM drafts WHERE id=?', id(draftId));
    check(draft, `draft ${draftId} not found`);
    return draft;
  },
  /** Edit a buffered draft in place; the row keeps its id, so input order stays stable. */
  updateDraft(draftId, content) {
    const draft = this.draft(draftId);
    this.run('UPDATE drafts SET content=? WHERE id=?', content, draft.id);
    return this.draft(draft.id);
  },
  /** Buffered drafts in input order; submitted ones keep their input_id as the audit link. */
  openDrafts() { return this.all('SELECT * FROM drafts WHERE input_id IS NULL ORDER BY id'); },
  draftCount() { return this.get('SELECT count(*) AS n FROM drafts WHERE input_id IS NULL').n; },
};
