import { check, id } from '../../core/types.js';

/** User-only, project-owned reading assistance; never creates a Worker. */
export const handlers = {
  'quick_explain.config'(p, params) { return p.quickExplanationConfig(params.scope); },
  'quick_explain.configure'(p, params) { return p.configureQuickExplanation(params.config, params.scope); },
  'quick_explain.start'(p, params) { return p.startQuickExplanation(params.quote, params.location); },
  'quick_explain.followup'(p, params) { return p.followUpQuickExplanation(id(params.id), params.question); },
  'quick_explain.get'(p, params) { return p.quickExplanation(id(params.id)); },
  'quick_explain.delete'(p, params) { return p.deleteExplanation(id(params.id)); },
  'quick_explain.list'(p, params) {
    const before = params.before ?? null, limit = params.limit ?? 30;
    check(before === null || Number.isSafeInteger(before) && before > 0, 'invalid explanation cursor');
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'explanation limit must be 1..50');
    return p.quickExplanations(before, limit);
  },
};
