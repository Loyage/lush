import { check, id, bounded } from '../../core/types.js';

/** worker.* (persistent Task data and internal methods keep their names). */
export const handlers = {
  'worker.lookup'(p, params) { return p.store.lookupWorker(params.number); },
  'worker.graph'(p) { return p.taskGraph(); },
  'worker.list'(p, params, actor) {
    const after = Number(params.after ?? 0), limit = Number(params.limit ?? 200);
    check(Number.isSafeInteger(after) && after >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 1000, 'invalid worker page');
    return bounded(p.decorate(p.store.summaries('work').filter(task => task.id > after).slice(0, limit)), 900000);
  },
  'worker.activity'(p, params, actor) { return p.activity(Number(params.limit ?? 50), params.scope ?? 'work'); },
  'worker.page'(p, params, actor) { return p.taskPage(params.before ?? null, Number(params.limit ?? 50), params.scope ?? 'work'); },
  'worker.tree'(p, params, actor) { return p.tree(params.id ?? null); },
  'worker.ladder'(p, params, actor) { return p.ladder(); },
  'worker.inspect': async (p, params) => {
    const task = p.inspect(params.id);
    if (!task.branch) return task;
    // 归档按钮的可用性预判只在 Web 详情这种异步 RPC 路径上附加，保持核心 inspect 同步。
    const [archive, relation] = await Promise.all([
      p.branchArchivability([task.branch]),
      ['order', 'child'].includes(task.task_kind) ? p.workspaces.parentRelation(task) : null,
    ]);
    const info = archive.get(task.branch);
    return { ...task, ...(info ? { branch_archive: info } : {}),
      ...(relation ? { parent_relation: relation } : {}) };
  },
  'worker.history'(p, params, actor) {
    p.store.task(params.id);
    const after = Number(params.after ?? 0);
    check(Number.isSafeInteger(after) && after >= 0, 'invalid history cursor');
    return p.store.history(id(params.id), after);
  },
  'worker.history_page'(p, params, actor) {
    const taskId = id(params.id); p.store.task(taskId);
    const before = params.before === null || params.before === undefined ? null : Number(params.before);
    const limit = Number(params.limit ?? 100);
    check(before === null || (Number.isSafeInteger(before) && before > 0), 'invalid history cursor');
    check(Number.isInteger(limit) && limit > 0 && limit <= 200, 'history limit must be 1..200');
    return p.store.historyPage(taskId, before, limit);
  },
  /** 详情窗口之外的继续读取：只读用户方法，旧全量 `inspect` 字段保持兼容。 */
  'worker.runs_page'(p, params) {
    const taskId = id(params.id); p.store.task(taskId);
    return p.store.runsPage(taskId, { before: params.before ?? null, limit: params.limit ?? 50 });
  },
  'worker.artifacts_page'(p, params) {
    const taskId = id(params.id); p.store.task(taskId);
    return p.store.artifactsPage(taskId, { before: params.before ?? null, limit: params.limit ?? 50 });
  },
  'worker.artifact'(p, params) { return p.store.artifact(id(params.id)); },
  'worker.diff'(p, params, actor) { return p.diff(params.id); },
  'worker.code_state'(p, { id: taskId, _token, ...options }) { return p.codeState(id(taskId), options); },
  'worker.code_tree'(p, { id: taskId, _token, ...options }) { return p.codeTree(id(taskId), options); },
  'worker.code_file'(p, { id: taskId, _token, ...options }) { return p.codeFile(id(taskId), options); },
  'worker.transcript'(p, params, actor) { return p.transcript(id(params.id), Number(params.after ?? 0), Number(params.limit ?? 100)); },
  'worker.transcript_latest'(p, params) {
    return p.transcriptLatest(id(params.id), Number(params.after ?? 0), Number(params.before ?? 0), Number(params.limit ?? 100));
  },
  'worker.usage'(p, params, actor) { return p.usage(id(params.id)); },
  'worker.transcript_search'(p, params) {
    const { id: taskId, _token, ...options } = params;
    return p.searchTranscript(id(taskId), options);
  },
  'worker.transcript_page'(p, params) { return p.transcriptPage(id(params.id), params.seq ?? 1, params.offset ?? 0); },
  'worker.transcript_step'(p, params) { return p.transcriptStep(id(params.id), params.seq, params.offset ?? 0); },
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
  'worker.spawn'(p, params, actor) {
    const parent = params.parent ?? actor;
    check(actor === null || id(parent) === actor, 'agents may delegate only from their own worker');
    check(['order','child'].includes(p.store.task(id(parent)).task_kind), 'only order/child Workers can delegate');
    return p.spawn(parent, params.goal, 'agent', [], params.name ?? null);
  },
  'worker.integrate'(p, params, actor) { return p.integrateChild(actor, params.id, params.commit); },
  'worker.reserve'(p, params) { check(params.kind === 'merge', 'only merge delivery is supported'); return p.reserveTask(params.id, 'merge'); },
  'worker.reserve_all'(p, params) { return p.reserveMergeAll(params.branch); },
  'worker.auto_merge'(p, params) { return p.setTaskAutoMerge(params.id, params.enabled); },
  'worker.resolve'(p, params) { return p.resolveTask(params.id); },
  'worker.accept'(p, params, actor) { return p.acceptTask(params.id, actor); },
  'worker.reopen'(p, params) { return p.reopenTask(params.id); },
  'worker.sync_parent'(p, params) { return p.syncTaskParent(params.id); },
  'worker.resolve_sync'(p, params) { return p.resolveTaskSync(params.id); },
  'worker.resolve_divergence'(p, params) { return p.resolveOrderDivergence(params.id); },
  'worker.analyze'(p, params) { return p.analyze(params.id, params.question); },
  'worker.resolve_child_divergence'(p, params, actor) { return p.resolveChildDivergence(actor, params.id); },
  'worker.unreserve'(p, params) { return p.unreserveTask(params.id); },
  'worker.approve_merge'(p, params) { return p.approveReservedMerge(params.id, params.commit, params.baseline); },
  'worker.message'(p, params, actor) { return p.message(params.id, params.body, actor); },
  'worker.cancel'(p, params, actor) { return p.cancel(params.id); },
  'worker.interrupt'(p, params, actor) { return p.interrupt(id(params.id)); },
  'worker.resume'(p, params, actor) { return p.resumeTask(id(params.id), params.profile ?? null); },
  'worker.configure'(p, params, actor) {
    check(!(Object.hasOwn(params, 'profile') && Object.hasOwn(params, 'model_selection')), 'profile and model_selection are mutually exclusive');
    return Object.hasOwn(params, 'model_selection')
      ? p.configureTaskModelSelection(id(params.id), params.model_selection)
      : p.configureTask(id(params.id), params.profile ?? null);
  },
  'worker.retry'(p, params, actor) { return p.retry(params.id, params.profile ?? null); },
  'worker.clear_override'(p, params) { return p.clearTaskProfile(params.id); },
  'worker.merge'(p, params, actor) { return p.approveMerge(id(params.id)); },
  'worker.merge_many'(p, params, actor) { return p.approveMergeMany(params.ids); },
  'worker.verify'(p, params, actor) { return p.verify(id(params.id)); },
  'worker.cleanup'(p, params, actor) {
    check(!p.running.has(id(params.id)), 'agent is still stopping; cleanup must wait');
    const task = p.store.task(id(params.id));
    if (task.branch) p.assertBranchWritable(task.branch, 'clean up its workspace');
    return p.workspaces.cleanup(id(params.id), { keepBranch: params.keep_branch === true });
  },
  'worker.delete_preview'(p, params) { return p.deleteTaskPreview(id(params.id)); },
  'worker.delete'(p, params) {
    check(params.confirm === true, 'deletion requires explicit confirmation');
    check(typeof params.revision === 'string' && params.revision.length > 0 && params.revision.length <= 256,
      'deletion requires a preview revision');
    return p.deleteTask(id(params.id), { revision: params.revision, confirm: true });
  },
  'worker.clear'(p, params, actor) { return p.clear(); },
};
