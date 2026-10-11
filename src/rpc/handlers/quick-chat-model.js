/** Compatibility setting names only; old explanation execution/history methods are retired. */
export const handlers = {
  'quick_explain.config'(p, params) { return p.quickExplanationConfig(params.scope); },
  'quick_explain.configure'(p, params) { return p.configureQuickExplanation(params.config, params.scope); },
};
