import { check, id, text, bounded } from '../types.js';

/** Buffered drafts are a cache, not a queue: bounded so a forgotten tab cannot grow the db forever. */
const MAX_DRAFTS = 500;
/** A batch keeps every utterance identifiable; a single draft stays verbatim. */
function batchContent(drafts) {
  if (drafts.length === 1) return drafts[0].content;
  return [`用户在一次提交中给了 ${drafts.length} 条，按输入顺序：`,
    ...drafts.map((draft, index) => `${index + 1}) ${draft.content}`)].join('\n');
}

/** 输入缓存（增删改、整体提交成一批）。 */
export default {
  /** Buffering is user-only: agents submit work through task.spawn, never through the input buffer. */
  draft(content) {
    text(content, 'draft');
    check(this.store.draftCount() < MAX_DRAFTS, 'too many buffered drafts; submit or remove some first');
    return this.store.addDraft(content);
  },

  drafts() { return bounded(this.store.openDrafts(), 400000); },

  dropDraft(draftId) {
    const draft = this.store.draft(draftId);
    check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}; inputs are never removed`);
    this.store.run('DELETE FROM drafts WHERE id=?', draft.id);
    return { id: draft.id };
  },

  /** Edit a buffered draft in place. Submitted drafts are the audit chain of an input and never change. */
  editDraft(draftId, content) {
    text(content, 'draft');
    const draft = this.store.draft(draftId);
    check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}; inputs are never changed`);
    return this.store.updateDraft(draft.id, content);
  },

  /**
   * Hands buffered drafts to one planner as a single batch. ids omitted: every open draft.
   * With ids: only the selected subset, ascending by id (= input order); unselected drafts stay buffered.
   * 锚点要等 Git 建好才落库：失败时草稿一条也不动，仍在缓存里等下一次提交。
   */
  async commitDrafts(ids = null, branch = null) {
    let drafts;
    if (ids === null || ids === undefined) {
      drafts = this.store.openDrafts();
    } else {
      check(Array.isArray(ids), 'commit ids must be an array of draft ids');
      check(ids.length > 0, 'select at least one draft to submit');
      check(ids.length <= MAX_DRAFTS, 'too many drafts in one commit');
      const selected = new Set();
      for (const raw of ids) {
        const draftId = id(raw);
        check(!selected.has(draftId), `draft ${draftId} listed twice`);
        selected.add(draftId);
      }
      drafts = [...selected].sort((a, b) => a - b).map(draftId => {
        const draft = this.store.draft(draftId);
        check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}; inputs are never committed twice`);
        return draft;
      });
    }
    check(drafts.length > 0, 'no buffered drafts to submit');
    const content = batchContent(drafts);
    const result = await this.createInput(content, task => {
      for (const draft of drafts) this.store.run('UPDATE drafts SET input_id=? WHERE id=?', task.input_id, draft.id);
      this.store.event(task.id, 'input.batch', { draft_ids: drafts.map(draft => draft.id) });
    }, branch);
    this.kick();
    return { ...result, drafts: drafts.map(draft => draft.id) };
  }
};
