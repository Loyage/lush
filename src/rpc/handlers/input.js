import { check } from '../../core/types.js';

/** input.* / draft.* */
export const handlers = {
  'say.submit'(p, params) {
    if (Object.hasOwn(params, 'draft_id')) {
      check(!Object.hasOwn(params, 'content') && !Object.hasOwn(params, 'references'),
        'draft_id cannot be combined with content or references');
      return p.say(undefined, params.branch ?? null, [], params.draft_id);
    }
    return p.say(params.content, params.branch ?? null, params.references ?? []);
  },
  'input.submit'(p, params, actor) {
    if (Object.hasOwn(params, 'draft_id')) {
      check(!Object.hasOwn(params, 'content') && !Object.hasOwn(params, 'references'),
        'draft_id cannot be combined with content or references');
      return p.submitDraft(params.draft_id, params.branch ?? null);
    }
    return p.submit(params.content, params.branch ?? null, params.references ?? []);
  },
  'input.list'(p, params, actor) { return p.inputs(); },
  'draft.add'(p, params, actor) { return p.draft(params.content, params.references ?? []); },
  'draft.list'(p, params, actor) { return p.drafts(); },
  'draft.remove'(p, params, actor) { return p.dropDraft(params.id); },
  'draft.update'(p, params, actor) { return p.editDraft(params.id, params.content, params.references); },
  'draft.commit'(p, params, actor) { return p.commitDrafts(params.ids ?? null, params.branch ?? null); },
};
