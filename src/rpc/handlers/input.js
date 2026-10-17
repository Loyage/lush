import { check } from '../../core/types.js';

import { INPUT_OPTION_KEYS as DRAFT_OPTIONS } from '../../core/input-option-keys.js';
function draftOptions(params) {
  return Object.fromEntries(DRAFT_OPTIONS.filter(key => Object.hasOwn(params, key)).map(key => [key, params[key]]));
}
function emissionOptions(params) {
  const options = Object.fromEntries(Object.entries(params).filter(([key]) => !['_token', 'start', 'defer'].includes(key)));
  if (Object.hasOwn(options, 'draft_id')) {
    check(!['content', 'references', 'branch', ...DRAFT_OPTIONS].some(key => Object.hasOwn(options, key)),
      'draft_id cannot be combined with content, references, branch or input options; edit the draft first');
  } else check(!Object.hasOwn(options, 'expected_revision'), 'expected_revision requires draft_id');
  return options;
}

/** input.* / draft.* */
export const handlers = {
  'order.submit'(p, params) {
    check(params.start === undefined || typeof params.start === 'boolean', 'start must be boolean');
    check(params.defer === undefined || typeof params.defer === 'boolean', 'defer must be boolean');
    check(params.profile === undefined || (params.profile !== null && typeof params.profile === 'object' && !Array.isArray(params.profile)), 'invalid profile');
    if (Object.hasOwn(params, 'draft_id')) {
      check(!['content','references','branch'].some(key => Object.hasOwn(params, key)),
        'draft_id cannot be combined with content, references or branch; edit the draft first');
      if (params.start !== false) return p.emitBufferedInput(emissionOptions(params));
      check(params.defer === true || !Object.hasOwn(params, 'profile'), 'draft_id cannot be combined with profile without defer:true');
      return p.submitBufferedDraft(params.draft_id, params.expected_revision, params.start !== false, params.defer === true, params.profile ?? null);
    }
    check(!Object.hasOwn(params, 'expected_revision'), 'expected_revision requires draft_id');
    check(params.branch === undefined || (typeof params.branch === 'string' && params.branch.trim().length > 0 && params.branch.length <= 512), 'invalid branch');
    if (params.start !== false) return p.emitBufferedInput(emissionOptions(params));
    // Explicit start:false remains a compatibility creation primitive, not emission.
    return p.order(params.content, params.branch ?? null, params.references === undefined ? [] : params.references, null, params.start !== false, undefined, params.profile, params.defer === true);
  },
  'input.history'(p, params) { return p.inputHistory(params); },
  'input.get'(p, params) { return p.inputGet(params.kind, params.id); },
  'input.parents'(p) { return p.inputParents(); },
  'input.emit'(p, params) { return p.emitBufferedInput(emissionOptions(params)); },
  'input.emission_cancel'(p, params) { return p.cancelInputEmission(params.draft_id, params.expected_revision); },
  'input.exclusive_release'(p, params) { return p.releaseInputExclusive(params.draft_id, params.expected_revision); },
  'input.submit'(p, params, actor) {
    if (Object.hasOwn(params, 'draft_id')) {
      check(!Object.hasOwn(params, 'content') && !Object.hasOwn(params, 'references'),
        'draft_id cannot be combined with content or references');
      return p.submitDraft(params.draft_id, params.branch ?? null);
    }
    return p.submit(params.content, params.branch ?? null, params.references ?? []);
  },
  'input.list'(p, params, actor) { return p.inputs(); },
  'draft.add'(p, params) { return p.addBufferedDraft(params.content, params.references === undefined ? [] : params.references, params.branch, draftOptions(params)); },
  'draft.list'(p, params, actor) { return p.drafts(); },
  'draft.remove'(p, params) { return p.removeBufferedDraft(params.id, params.expected_revision); },
  'draft.update'(p, params) { return p.updateBufferedDraft(params.id, params.content, params.references, params.branch, params.expected_revision, draftOptions(params)); },
  'draft.commit'(p, params, actor) { return p.commitDrafts(params.ids ?? null, params.branch ?? null); },
};
