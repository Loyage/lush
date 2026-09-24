import { check, id, text, bounded } from '../types.js';
import { matchInputRoute } from '../input-routes.js';

/** Buffered drafts are a cache, not a queue: bounded so a forgotten tab cannot grow the db forever. */
const MAX_DRAFTS = 500;

/** 输入缓存（增删改、逐条提交）。 */
export default {
  /** Buffering is user-only: agents submit work through task.spawn, never through the input buffer. */
  draft(content, references = []) {
    text(content, 'draft');
    const normalized = this.normalizeReferences(references);
    check(this.store.draftCount() < MAX_DRAFTS, 'too many buffered drafts; submit or remove some first');
    return this.store.transaction(() => {
      const draft = this.store.addDraft(content);
      this.store.setDraftReferences(draft.id, normalized);
      return { ...draft, references: normalized };
    });
  },

  drafts() { return bounded(this.store.openDrafts().map(draft => ({ ...draft, references: this.store.draftReferences(draft.id) })), 400000); },

  dropDraft(draftId) {
    const draft = this.store.draft(draftId);
    check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}; inputs are never removed`);
    this.store.run('DELETE FROM drafts WHERE id=?', draft.id);
    return { id: draft.id };
  },

  /** Edit a buffered draft in place. Submitted drafts are the audit chain of an input and never change. */
  editDraft(draftId, content, references = undefined) {
    text(content, 'draft');
    const draft = this.store.draft(draftId);
    check(draft.input_id === null, `draft ${draft.id} was already submitted as input ${draft.input_id}; inputs are never changed`);
    const normalized = references === undefined ? null : this.normalizeReferences(references);
    return this.store.transaction(() => {
      const updated = this.store.updateDraft(draft.id, content);
      if (normalized !== null) this.store.setDraftReferences(draft.id, normalized);
      return { ...updated, references: normalized ?? this.store.draftReferences(draft.id) };
    });
  },

  /**
   * 逐条提交缓存草稿，每条各自成为一个独立输入与 planner。ids 省略：全部 open drafts。
   * 有 ids：只提交选中的子集，按 id 升序（= 输入顺序），未选中的继续留在缓存。
   * 每条草稿正文逐字提交、引用以 segment 1 复制、单独建输入并回写它的 input_id；
   * 命中快速路由前缀的那条不再建 planner 而按前缀派活。锚点要等 Git 建好才落库：
   * 任一条创建失败即抛出，已提交的前几条保留，失败的及之后的草稿仍未提交。
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
    const inputs = [];
    for (const draft of drafts) {
      const references = this.store.draftReferences(draft.id).map(reference => ({ segment: 1, reference }));
      const match = matchInputRoute(this.config.inputRoutes, draft.content);
      let worker = null;
      const result = await this.createInput(draft.content, task => {
        this.store.run('UPDATE drafts SET input_id=? WHERE id=?', task.input_id, draft.id);
        this.store.setInputReferences(task.input_id, references);
        this.store.event(task.id, 'input.draft', { draft_ids: [draft.id] });
        if (match) worker = this.routeInput(task, match);
      }, branch);
      const output = { ...result, references: references.map(value => ({ segment: value.segment, ...value.reference })), draft: draft.id };
      if (match) {
        output.task = this.store.task(output.task.id);
        output.route = { prefix: match.prefix, target: match.target };
        if (match.target === 'worker') output.worker = worker; else output.research = worker;
      }
      inputs.push(output);
    }
    this.kick();
    return { inputs, drafts: drafts.map(draft => draft.id) };
  }
};
