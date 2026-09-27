import { check, id, bounded } from '../../core/types.js';

/** ap.* */
export const handlers = {
  'ap.graph'(p) { return p.apGraph(); },
  'ap.list'(p, params, actor) {
    const after = Number(params.after ?? 0), limit = Number(params.limit ?? 200);
    check(Number.isSafeInteger(after) && after >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 1000, 'invalid AP page');
    return bounded(p.decorate(p.store.summaries('work').filter(ap => ap.id > after).slice(0, limit)), 900000);
  },
  'ap.activity'(p, params, actor) { return p.activity(Number(params.limit ?? 50), params.scope ?? 'work'); },
  'ap.page'(p, params, actor) { return p.apPage(params.before ?? null, Number(params.limit ?? 50), params.scope ?? 'work'); },
  'ap.tree'(p, params, actor) { return p.tree(params.id ?? null); },
  'ap.ladder'(p, params, actor) { return p.ladder(); },
  'ap.inspect'(p, params, actor) { return p.inspect(params.id); },
  'ap.history'(p, params, actor) {
    p.store.ap(params.id);
    const after = Number(params.after ?? 0);
    check(Number.isSafeInteger(after) && after >= 0, 'invalid history cursor');
    return p.store.history(id(params.id), after);
  },
  'ap.history_page'(p, params, actor) {
    const apId = id(params.id); p.store.ap(apId);
    const before = params.before === null || params.before === undefined ? null : Number(params.before);
    const limit = Number(params.limit ?? 100);
    check(before === null || (Number.isSafeInteger(before) && before > 0), 'invalid history cursor');
    check(Number.isInteger(limit) && limit > 0 && limit <= 200, 'history limit must be 1..200');
    return p.store.historyPage(apId, before, limit);
  },
  'ap.diff'(p, params, actor) { return p.diff(params.id); },
  'ap.transcript'(p, params, actor) { return p.transcript(id(params.id), Number(params.after ?? 0), Number(params.limit ?? 100)); },
  'ap.transcript_latest'(p, params) {
    return p.transcriptLatest(id(params.id), Number(params.after ?? 0), Number(params.before ?? 0), Number(params.limit ?? 100));
  },
  'ap.usage'(p, params, actor) { return p.usage(id(params.id)); },
  'ap.transcript_search'(p, params) {
    const { id: apId, _token, ...options } = params;
    return p.searchTranscript(id(apId), options);
  },
  'ap.transcript_page'(p, params) { return p.transcriptPage(id(params.id), params.seq ?? 1, params.offset ?? 0); },
  'ap.transcript_step'(p, params) { return p.transcriptStep(id(params.id), params.seq, params.offset ?? 0); },
  'explanation.start'(p, params) { return p.startExplanation(id(params.id), params.seq, params.quote); },
  'explanation.list'(p, params) { return p.explanations(id(params.id), params.before ?? null); },
  'explanation.get'(p, params) { return p.explanation(id(params.id)); },
  'intro.start'(p, params) { return p.startIntro(params.quote, params.location); },
  'intro.list'(p, params) { return p.introductions(id(params.id), params.before ?? null); },
  'intro.get'(p, params) { return p.introduction(id(params.id)); },
  'intro.config'(p) { return p.introConfig(); },
  'intro.configure'(p, params) { return p.configureIntro(params.config); },
  'progress.plan'(p, params, actor) { return p.reportProgressPlan(actor, params.steps); },
  'progress.complete'(p, params, actor) { return p.completeProgressStep(actor, params.step); },
  'ap.spawn'(p, params, actor) {
    const parent = params.parent ?? actor;
    check(actor === null || id(parent) === actor, 'agents may delegate only from their own AP');
    check(['say','child'].includes(p.store.ap(id(parent)).ap_kind), 'only say/child APs can delegate');
    return p.spawn(parent, params.goal, 'agent', [], params.name ?? null);
  },
  'ap.integrate'(p, params, actor) { return p.integrateChild(actor, params.id, params.commit); },
  'ap.reserve'(p, params) { check(params.kind === 'merge', 'only merge delivery is supported'); return p.reserveAP(params.id, 'merge'); },
  'ap.resolve'(p, params) { return p.resolveAP(params.id); },
  'ap.resolve_divergence'(p, params) { return p.resolveSayDivergence(params.id); },
  'ap.analyze'(p, params) { return p.analyze(params.id, params.question); },
  'ap.resolve_child_divergence'(p, params, actor) { return p.resolveChildDivergence(actor, params.id); },
  'ap.unreserve'(p, params) { return p.unreserveAP(params.id); },
  'ap.approve_merge'(p, params) { return p.approveReservedMerge(params.id, params.commit, params.baseline); },
  'ap.message'(p, params, actor) { return p.message(params.id, params.body, actor); },
  'ap.cancel'(p, params, actor) { return p.cancel(params.id); },
  'ap.retry'(p, params, actor) { return p.retry(params.id, params.profile ?? null); },
  'ap.merge'(p, params, actor) { return p.approveMerge(id(params.id)); },
  'ap.merge_many'(p, params, actor) { return p.approveMergeMany(params.ids); },
  'ap.verify'(p, params, actor) { return p.verify(id(params.id)); },
  'ap.cleanup'(p, params, actor) {
    check(!p.running.has(id(params.id)), 'agent is still stopping; cleanup must wait');
    const ap = p.store.ap(id(params.id));
    if (ap.branch) p.assertBranchWritable(ap.branch, 'clean up its workspace');
    return p.workspaces.cleanup(id(params.id), { keepBranch: params.keep_branch === true });
  },
  'ap.delete'(p, params, actor) { return p.deleteAP(id(params.id)); },
  'ap.clear'(p, params, actor) { return p.clear(); },
};
