import { check, id, bounded } from '../../core/types.js';

/** task.* */
export const handlers = {
  'task.list'(p, params, actor) {
    const after = Number(params.after ?? 0), limit = Number(params.limit ?? 200);
    check(Number.isSafeInteger(after) && after >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 1000, 'invalid task page');
    return bounded(p.decorate(p.store.summaries('work').filter(task => task.id > after).slice(0, limit)), 900000);
  },
  'task.activity'(p, params, actor) { return p.activity(Number(params.limit ?? 50), params.scope ?? 'work'); },
  'task.page'(p, params, actor) { return p.taskPage(params.before ?? null, Number(params.limit ?? 50), params.scope ?? 'work'); },
  'task.tree'(p, params, actor) { return p.tree(params.id ?? null); },
  'task.ladder'(p, params, actor) { return p.ladder(); },
  'task.inspect'(p, params, actor) { return p.inspect(params.id); },
  'task.history'(p, params, actor) {
    p.store.task(params.id);
    const after = Number(params.after ?? 0);
    check(Number.isSafeInteger(after) && after >= 0, 'invalid history cursor');
    return p.store.history(id(params.id), after);
  },
  'task.history_page'(p, params, actor) {
    const taskId = id(params.id); p.store.task(taskId);
    const before = params.before === null || params.before === undefined ? null : Number(params.before);
    const limit = Number(params.limit ?? 100);
    check(before === null || (Number.isSafeInteger(before) && before > 0), 'invalid history cursor');
    check(Number.isInteger(limit) && limit > 0 && limit <= 200, 'history limit must be 1..200');
    return p.store.historyPage(taskId, before, limit);
  },
  'task.diff'(p, params, actor) { return p.diff(params.id); },
  'task.transcript'(p, params, actor) { return p.transcript(id(params.id), Number(params.after ?? 0), Number(params.limit ?? 100)); },
  'task.transcript_latest'(p, params) {
    return p.transcriptLatest(id(params.id), Number(params.after ?? 0), Number(params.before ?? 0), Number(params.limit ?? 100));
  },
  'task.usage'(p, params, actor) { return p.usage(id(params.id)); },
  'task.transcript_search'(p, params) {
    const { id: taskId, _token, ...options } = params;
    return p.searchTranscript(id(taskId), options);
  },
  'task.transcript_page'(p, params) { return p.transcriptPage(id(params.id), params.seq ?? 1, params.offset ?? 0); },
  'task.transcript_step'(p, params) { return p.transcriptStep(id(params.id), params.seq, params.offset ?? 0); },
  'explanation.start'(p, params) { return p.startExplanation(id(params.id), params.seq, params.quote); },
  'explanation.selection'(p, params) { return p.startSelectionExplanation(params.quote, params.location); },
  'explanation.list'(p, params) { return p.explanations(id(params.id), params.before ?? null); },
  'explanation.get'(p, params) { return p.explanation(id(params.id)); },
  'progress.plan'(p, params, actor) { return p.reportProgressPlan(actor, params.steps); },
  'progress.complete'(p, params, actor) { return p.completeProgressStep(actor, params.step); },
  'task.spawn'(p, params, actor) {
    const parent = params.parent ?? actor;
    check(actor === null || id(parent) === actor, 'agents may delegate only from their own task');
    return p.spawn(parent, params.goal, params.role, params.deps ?? [], params.name ?? null, params.spec ?? null);
  },
  'task.message'(p, params, actor) { return p.message(params.id, params.body, actor); },
  'task.cancel'(p, params, actor) { return p.cancel(params.id); },
  'task.retry'(p, params, actor) { return p.retry(params.id, params.profile ?? null); },
  'task.merge'(p, params, actor) { return p.approveMerge(id(params.id)); },
  'task.merge_many'(p, params, actor) { return p.approveMergeMany(params.ids); },
  'task.verify'(p, params, actor) { return p.verify(id(params.id)); },
  'task.cleanup'(p, params, actor) {
    check(!p.running.has(id(params.id)), 'agent is still stopping; cleanup must wait');
    return p.workspaces.cleanup(id(params.id), { keepBranch: params.keep_branch === true });
  },
  'task.delete'(p, params, actor) { return p.deleteTask(id(params.id)); },
  'task.clear'(p, params, actor) { return p.clear(); },
};
