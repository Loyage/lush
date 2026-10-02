import { check, id } from '../../core/types.js';

/** 输入缓存（drafts）的增删改。 */
export const drafts = {
  addDraft(content) {
    return this.transaction(() => {
      // Deleted drafts must not reuse an identity: a stale tab may still hold id + revision.
      const high = Number(this.get("SELECT value FROM meta WHERE key='draft_id_high'")?.value ?? 0);
      const draftId = Math.max(high, this.get('SELECT coalesce(max(id),0) AS n FROM drafts').n) + 1;
      this.run("INSERT INTO meta(key,value) VALUES ('draft_id_high',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(draftId));
      this.run('INSERT INTO drafts(id,content) VALUES (?,?)', draftId, content);
      return this.draft(draftId);
    });
  },
  draft(draftId) {
    const draft = this.get('SELECT * FROM drafts WHERE id=?', id(draftId));
    check(draft, `draft ${draftId} not found`);
    return draft;
  },
  /** Edit a buffered draft in place; the row keeps its id, so input order stays stable. */
  updateDraft(draftId, content) {
    const draft = this.draft(draftId);
    this.run('UPDATE drafts SET content=?,revision=coalesce(revision,0)+1 WHERE id=?', content, draft.id);
    return this.draft(draft.id);
  },
  /** Buffered drafts in input order; submitted ones keep their input_id as the audit link. */
  openDrafts() { return this.all('SELECT * FROM drafts WHERE input_id IS NULL ORDER BY id'); },
  draftCount() { return this.get('SELECT count(*) AS n FROM drafts WHERE input_id IS NULL').n; },
};
