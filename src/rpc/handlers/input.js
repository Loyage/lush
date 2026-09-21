import { check, id } from '../../core/types.js';

/** input.* / draft.* */
export const handlers = {
  'input.submit'(p, params, actor) { return p.submit(params.content, params.references ?? []); },
  'input.list'(p, params, actor) { return p.inputs(); },
  'input.flow'(p, params, actor) {
    // Agent 省略 id 时判定自己的输入；用户（无 token）可对任意根 task 判定或改判。
    const target = params.id ?? actor;
    check(target !== null && target !== undefined, 'input.flow requires a root task id (agents may omit it to use their own task)');
    check(actor === null || id(target) === actor, 'agents may classify only their own input');
    return p.setInputFlow(id(target), params.flow);
  },
  'draft.add'(p, params, actor) { return p.draft(params.content, params.references ?? []); },
  'draft.list'(p, params, actor) { return p.drafts(); },
  'draft.remove'(p, params, actor) { return p.dropDraft(params.id); },
  'draft.update'(p, params, actor) { return p.editDraft(params.id, params.content, params.references); },
  'draft.commit'(p, params, actor) { return p.commitDrafts(params.ids ?? null); },
};
