/** input.* / draft.* */
export const handlers = {
  'input.submit'(p, params, actor) { return p.submit(params.content, params.branch ?? null, params.references ?? []); },
  'input.list'(p, params, actor) { return p.inputs(); },
  'draft.add'(p, params, actor) { return p.draft(params.content, params.references ?? []); },
  'draft.list'(p, params, actor) { return p.drafts(); },
  'draft.remove'(p, params, actor) { return p.dropDraft(params.id); },
  'draft.update'(p, params, actor) { return p.editDraft(params.id, params.content, params.references); },
  'draft.commit'(p, params, actor) { return p.commitDrafts(params.ids ?? null, params.branch ?? null); },
};
